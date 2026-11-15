// Is a newer build of the web app deployed than the one running? (#374)
//
// GitHub Pages serves every file, index.html included, with
// `Cache-Control: max-age=600`. After a deploy the browser keeps reusing the
// old index.html, which names the old hashed bundles, so the old app keeps
// starting until the user force-reloads (Ctrl+Shift+R) -- which on a phone
// nobody knows how to do. The build therefore publishes its commit in
// `version.json` (vite.config.js), and the app compares it with its own.
//
// This module is the logic only: what the published file says, whether to
// look now, and what to do about a difference. It touches no DOM, so it runs
// in Node (scripts/test-version-check.mjs). The app's side -- the fetch, the
// reload and the banner -- is src/app/methods/version-check-methods.js.

/** The query parameter a reload to a new build carries (see reloadUrl). */
export const RELOAD_PARAM = 'build';
/** Where the loop guard lives in sessionStorage. */
export const RELOAD_GUARD_KEY = 'omv_version_reload';
/** At most one look per this long when the tab comes back into view. */
export const RECHECK_INTERVAL_MS = 15 * 60 * 1000;
/**
 * How long an automatic reload to one build stays "already tried". Long enough
 * that a CDN still handing out the old page can never cause a loop (one reload,
 * then nothing); short enough that a tab left open for hours tries once more.
 */
export const RELOAD_RETRY_MS = 30 * 60 * 1000;
/** A check that has no answer by then is a check that failed. */
export const FETCH_TIMEOUT_MS = 10 * 1000;

/** A commit as the builds write it: 7 to 40 hex digits, lower case. '' if it is not one. */
export function normalizeSha(value) {
    const text = String(value ?? '').trim().toLowerCase();
    return /^[0-9a-f]{7,40}$/.test(text) ? text : '';
}

/**
 * Two builds are the same build when one sha is a prefix of the other: CI
 * writes 7 digits, a local `git rev-parse --short` may write more.
 */
export function sameBuild(a, b) {
    const x = normalizeSha(a);
    const y = normalizeSha(b);
    if (!x || !y) return false;
    return x.length <= y.length ? y.startsWith(x) : x.startsWith(y);
}

/** What `version.json` says, or null when it says nothing usable. */
export function parseVersionPayload(payload) {
    if (!payload || typeof payload !== 'object') return null;
    const sha = normalizeSha(payload.sha);
    if (!sha) return null;
    return { sha, date: typeof payload.date === 'string' ? payload.date : '' };
}

/** The address to fetch: beside the page, with a query no cache has seen. */
export function versionUrl(baseHref, now = Date.now()) {
    const url = new URL('version.json', baseHref);
    url.searchParams.set('t', String(now));
    return url.toString();
}

/**
 * Fetch and read `version.json`. Every way of failing -- offline, a 404, a
 * dev server answering with its HTML page, a timeout -- is the same answer:
 * null, and no check. The app must never complain about this.
 */
export async function fetchRemoteVersion({ fetchImpl = globalThis.fetch, url, timeoutMs = FETCH_TIMEOUT_MS } = {}) {
    if (typeof fetchImpl !== 'function' || !url) return null;
    let timer = null;
    const controller = typeof AbortController === 'function' ? new AbortController() : null;
    try {
        if (controller) timer = setTimeout(() => controller.abort(), timeoutMs);
        // `no-store` keeps the browser's cache out of it; the query in `url`
        // keeps the CDN's out, which a request header cannot.
        const response = await fetchImpl(url, { cache: 'no-store', signal: controller?.signal });
        if (!response?.ok) return null;
        return parseVersionPayload(await response.json());
    } catch {
        return null;
    } finally {
        if (timer) clearTimeout(timer);
    }
}

/** Whether a look is due: always the first time, then once per interval. */
export function shouldCheckNow({ now = Date.now(), lastCheckAt = 0, intervalMs = RECHECK_INTERVAL_MS, force = false } = {}) {
    if (force || !lastCheckAt) return true;
    return now - lastCheckAt >= intervalMs;
}

/**
 * What to do, given what is running, what is deployed and what the user has.
 *
 * - `none`: nothing to do (no answer, a build with no sha, the same build, the
 *   banner was dismissed for this build, or a reload to it was already tried).
 * - `reload`: a newer build, and nothing open that a reload would lose.
 * - `banner`: a newer build, and the user has work open: offer, do not impose.
 *
 * A reload already tried and still landing on the old build means the server
 * is still handing out the old page; reloading again would loop, and a banner
 * whose button does the same thing would only be a broken promise. So the
 * answer then is nothing, until the guard expires.
 */
export function decideVersionAction({ runningSha, remoteSha, busy = false, attemptedSha = '', dismissedSha = '' } = {}) {
    const running = normalizeSha(runningSha);
    const remote = normalizeSha(remoteSha);
    if (!running || !remote) return { action: 'none', reason: 'unknown' };
    if (sameBuild(running, remote)) return { action: 'none', reason: 'current' };
    if (attemptedSha && sameBuild(attemptedSha, remote)) return { action: 'none', reason: 'already-tried' };
    if (dismissedSha && sameBuild(dismissedSha, remote)) return { action: 'none', reason: 'dismissed' };
    return busy ? { action: 'banner', reason: 'busy' } : { action: 'reload', reason: 'idle' };
}

/**
 * The address that loads build `sha` for certain.
 *
 * A plain `location.reload()` is not enough. Browsers do revalidate the page
 * on a reload, but a revalidation is answered by the CDN, which caches
 * index.html for the same 10 minutes and may still hold the old one -- and a
 * fresh visit (a new tab, a link) does not even revalidate. A URL with a query
 * that has never been asked for is in no cache at all, the browser's or the
 * CDN's, so it is fetched from the origin, where the new index.html already
 * is; that page names the new hashed bundles. The query also tells the new
 * page it is the result of this reload (cleanReloadUrl), and the app's other
 * parameters ride along untouched.
 */
export function reloadUrl(href, sha) {
    const url = new URL(href);
    url.searchParams.set(RELOAD_PARAM, normalizeSha(sha) || String(sha || ''));
    return url.toString();
}

/**
 * The page's address without the reload's query, and the build it named.
 * `changed` says whether the address bar needs rewriting.
 */
export function cleanReloadUrl(href) {
    const url = new URL(href);
    if (!url.searchParams.has(RELOAD_PARAM)) return { url: url.toString(), changed: false, arrivedSha: '' };
    const arrivedSha = normalizeSha(url.searchParams.get(RELOAD_PARAM));
    url.searchParams.delete(RELOAD_PARAM);
    return { url: url.toString(), changed: true, arrivedSha };
}

/** The build a reload was last tried to, if that was recent; '' otherwise. */
export function readReloadAttempt(storage, now = Date.now(), retryMs = RELOAD_RETRY_MS) {
    try {
        const saved = JSON.parse(storage?.getItem(RELOAD_GUARD_KEY) || 'null');
        const sha = normalizeSha(saved?.sha);
        const at = Number(saved?.at);
        if (!sha || !Number.isFinite(at) || now - at >= retryMs || at > now) return '';
        return sha;
    } catch {
        return '';
    }
}

/**
 * Remember a reload before it starts. Returns false when there is nowhere to
 * remember it (storage blocked); the reload's own query is then the guard.
 */
export function markReloadAttempt(storage, sha, now = Date.now()) {
    try {
        if (!storage) return false;
        storage.setItem(RELOAD_GUARD_KEY, JSON.stringify({ sha: normalizeSha(sha), at: now }));
        return true;
    } catch {
        return false;
    }
}

export function clearReloadAttempt(storage) {
    try {
        storage?.removeItem(RELOAD_GUARD_KEY);
    } catch {
        // Nothing stored, nothing to clear.
    }
}
