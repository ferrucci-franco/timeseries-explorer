// The web app switches itself to a newer deployed build (#374).
//
// On start, and when the tab comes back into view (at most once every
// RECHECK_INTERVAL_MS), the app reads the deployed `version.json` and compares
// its commit with its own. A different commit with nothing open reloads at
// once, onto the new build; with files open, a small notice offers the reload
// instead, since a reload closes them. The decisions are in
// src/app/version-check.js; this file is the fetch, the address bar, the
// reload and the notice.
//
// Not in Full Desktop, which updates through its own releases and loads its
// page from the app, nor in the guide's frame (the app around it has its own
// check), nor on file:// (the portable page has no server to ask).
import i18n from '../../i18n/index.js';
import { BUILD_SHA } from '../constants.js';
import { DEMO_MODE } from '../demo-mode.js';
import {
    clearReloadAttempt,
    cleanReloadUrl,
    decideVersionAction,
    fetchRemoteVersion,
    markReloadAttempt,
    normalizeSha,
    readReloadAttempt,
    reloadUrl,
    shouldCheckNow,
    versionUrl,
} from '../version-check.js';

const NOTICE_ID = 'version-update-notice';
// The refresh of the cached page before a reload (see _reloadToVersion) is a
// courtesy; the reload does not wait longer than this for it.
const PAGE_REFRESH_TIMEOUT_MS = 3000;
// Anything open that a reload would throw away. Files are the main thing; a
// dialog may hold typed text (the Feedback form) or a choice half made (the
// CSV preview), and a load in progress is a file about to be open.
const BUSY_SELECTORS = [
    '.modal-overlay',
    '.csv-preview-overlay',
    '.mode-change-warning-overlay',
    '#file-loading-overlay',
    '.example-loading-overlay',
].join(', ');

function sessionStore() {
    try {
        return globalThis.sessionStorage || null;
    } catch {
        return null;
    }
}

export function installVersionCheckMethods(TargetClass) {
    const proto = TargetClass.prototype;

proto._versionCheckSupported = function() {
    if (DEMO_MODE) return false;
    if (this.capabilities?.isDesktop || globalThis.omvDesktop) return false;
    const protocol = globalThis.location?.protocol;
    if (protocol !== 'http:' && protocol !== 'https:') return false;
    if (typeof globalThis.fetch !== 'function') return false;
    // A build made without git ('unknown'), or code run outside Vite ('dev'),
    // has nothing to compare.
    return !!normalizeSha(BUILD_SHA);
};

proto.initVersionCheck = function() {
    if (this._versionCheckInitialized || !this._versionCheckSupported()) return;
    this._versionCheckInitialized = true;
    this._versionLastCheckAt = 0;
    this._versionDismissedSha = '';
    // A page reached through _reloadToVersion carries the build it was meant
    // to be in its address. Read it, then take it out of the address bar: it
    // has done its job, and a bookmark or a shared link should not carry it.
    try {
        const cleaned = cleanReloadUrl(globalThis.location.href);
        this._versionArrivedSha = cleaned.arrivedSha;
        if (cleaned.changed) globalThis.history?.replaceState?.(globalThis.history.state, '', cleaned.url);
    } catch {
        this._versionArrivedSha = '';
    }
    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') this._checkForNewVersion();
    });
    this._checkForNewVersion();
};

/** Anything open that a reload would lose. */
proto._versionCheckBusy = function() {
    if (this.files?.size > 0) return true;
    if (this._exampleLoading || this._fileLoadingToken) return true;
    return !!document.querySelector(BUSY_SELECTORS);
};

/**
 * Look for a newer build. Resolves to the action taken ('none', 'reload',
 * 'banner'), or null when no look was due. One look at a time.
 */
proto._checkForNewVersion = function({ force = false } = {}) {
    if (!this._versionCheckInitialized) return Promise.resolve(null);
    if (this._versionCheckInFlight) return this._versionCheckInFlight;
    const now = Date.now();
    if (!shouldCheckNow({ now, lastCheckAt: this._versionLastCheckAt, force })) return Promise.resolve(null);
    this._versionLastCheckAt = now;
    this._versionCheckInFlight = (async () => {
        const remote = await fetchRemoteVersion({ url: versionUrl(document.baseURI, now) });
        if (!remote) return 'none';
        const storage = sessionStore();
        // The address's own guard counts once, for the page it brought here;
        // after that the stored one, which expires, decides.
        const attemptedSha = readReloadAttempt(storage) || this._versionArrivedSha || '';
        this._versionArrivedSha = '';
        const decision = decideVersionAction({
            runningSha: BUILD_SHA,
            remoteSha: remote.sha,
            busy: this._versionCheckBusy(),
            attemptedSha,
            dismissedSha: this._versionDismissedSha,
        });
        if (decision.reason === 'current') {
            clearReloadAttempt(storage);
            this._hideVersionNotice();
        }
        if (decision.action === 'reload') return this._reloadToVersion(remote.sha, { automatic: true });
        if (decision.action === 'banner') this._showVersionNotice(remote.sha);
        return decision.action;
    })().finally(() => {
        this._versionCheckInFlight = null;
    });
    return this._versionCheckInFlight;
};

/**
 * Load build `sha`, for certain.
 *
 * Two steps. First the page's own address is fetched with `cache: 'reload'`,
 * which goes past the browser's cache and stores what comes back: the next
 * plain visit to the site in another tab then starts on the new build, rather
 * than on the old index.html the browser would otherwise reuse for up to 10
 * minutes. It is not what this reload relies on, because the CDN in front of
 * GitHub Pages caches index.html for those same 10 minutes and may answer
 * with the old one. The second step is: the page is opened again at its own
 * address plus `?build=<sha>`, a query no cache has seen, so the CDN passes it
 * to the origin, which has the new index.html. `location.replace` keeps the
 * old build out of the history, so Back does not return to it.
 *
 * The attempt is written down before the page is left (markReloadAttempt), so
 * a page that still comes back old does not reload again.
 */
proto._reloadToVersion = async function(sha, { automatic = false } = {}) {
    const location = globalThis.location;
    try {
        const page = new URL(location.href);
        page.search = '';
        page.hash = '';
        const controller = typeof AbortController === 'function' ? new AbortController() : null;
        const timer = controller ? setTimeout(() => controller.abort(), PAGE_REFRESH_TIMEOUT_MS) : null;
        // Read to the end: a response left unread may never be stored whole.
        await globalThis.fetch(page.toString(), { cache: 'reload', signal: controller?.signal })
            .then(response => response.arrayBuffer())
            .catch(() => null);
        if (timer) clearTimeout(timer);
    } catch {
        // The reload below does not depend on it.
    }
    // Something may have been opened while the page was being fetched.
    if (automatic && this._versionCheckBusy()) {
        this._showVersionNotice(sha);
        return 'banner';
    }
    markReloadAttempt(sessionStore(), sha);
    this._navigateToVersion(reloadUrl(location.href, sha));
    return 'reload';
};

// The one place the page is left.
proto._navigateToVersion = function(url) {
    globalThis.location.replace(url);
};

proto._hideVersionNotice = function() {
    document.getElementById(NOTICE_ID)?.remove();
};

/** The offer, when a reload would close what the user has open. */
proto._showVersionNotice = function(sha) {
    const existing = document.getElementById(NOTICE_ID);
    if (existing?.dataset.sha === sha) return;
    existing?.remove();

    const notice = document.createElement('div');
    notice.id = NOTICE_ID;
    notice.className = 'dismissible-notice version-update-notice';
    notice.dataset.sha = sha;
    notice.setAttribute('role', 'status');
    notice.setAttribute('aria-live', 'polite');

    const content = document.createElement('div');
    content.className = 'dismissible-notice-content';
    const title = document.createElement('div');
    title.className = 'dismissible-notice-title';
    title.setAttribute('data-i18n', 'updateNoticeTitle');
    const body = document.createElement('div');
    body.className = 'dismissible-notice-body';
    body.setAttribute('data-i18n', 'updateNoticeBody');

    const actions = document.createElement('div');
    actions.className = 'dismissible-notice-actions';
    const reload = document.createElement('button');
    reload.type = 'button';
    reload.className = 'dismissible-notice-action primary version-update-reload';
    reload.setAttribute('data-i18n', 'updateNoticeReload');
    reload.addEventListener('click', () => {
        reload.disabled = true;
        this._reloadToVersion(sha);
    });
    const later = document.createElement('button');
    later.type = 'button';
    later.className = 'dismissible-notice-action version-update-later';
    later.setAttribute('data-i18n', 'updateNoticeLater');
    const dismiss = () => {
        // Not offered again for this build; a newer one is offered anew.
        this._versionDismissedSha = sha;
        notice.remove();
    };
    later.addEventListener('click', dismiss);
    actions.append(reload, later);
    content.append(title, body, actions);

    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'dismissible-notice-close';
    close.textContent = '×';
    close.setAttribute('data-i18n-title', 'dismiss');
    close.setAttribute('data-i18n-aria-label', 'dismiss');
    close.addEventListener('click', dismiss);
    notice.append(content, close);
    document.body.appendChild(notice);
    this._refreshVersionNoticeTexts();
    requestAnimationFrame(() => notice.classList.add('show'));
};

// Marked up with the data-i18n attributes, so the sweep a language change
// makes (i18n.updateDOM) rewrites it like the rest of the page.
proto._refreshVersionNoticeTexts = function() {
    const notice = document.getElementById(NOTICE_ID);
    if (!notice) return;
    notice.querySelectorAll('[data-i18n]').forEach(el => { el.textContent = i18n.t(el.getAttribute('data-i18n')); });
    notice.querySelectorAll('[data-i18n-title]').forEach(el => { el.title = i18n.t(el.getAttribute('data-i18n-title')); });
    notice.querySelectorAll('[data-i18n-aria-label]').forEach(el => {
        el.setAttribute('aria-label', i18n.t(el.getAttribute('data-i18n-aria-label')));
    });
};

}
