// The logic behind "a newer build is deployed: switch to it" (#374), in Node:
// what version.json may say, when to look, and what to do about a difference
// -- above all, that a server still handing out the old page can never make
// the app reload in a loop. The browser side is scripts/e2e-version-check.mjs.
import assert from 'node:assert/strict';

import {
    RECHECK_INTERVAL_MS,
    RELOAD_GUARD_KEY,
    RELOAD_PARAM,
    RELOAD_RETRY_MS,
    clearReloadAttempt,
    cleanReloadUrl,
    decideVersionAction,
    fetchRemoteVersion,
    markReloadAttempt,
    normalizeSha,
    parseVersionPayload,
    readReloadAttempt,
    reloadUrl,
    sameBuild,
    shouldCheckNow,
    versionUrl,
} from '../src/app/version-check.js';

// ── Shas ────────────────────────────────────────────────────────────────────
assert.equal(normalizeSha(' ABC1234 '), 'abc1234');
assert.equal(normalizeSha('abc123'), '', 'six digits is not a commit');
assert.equal(normalizeSha('unknown'), '', 'a build without git has no sha');
assert.equal(normalizeSha('dev'), '');
assert.equal(normalizeSha(null), '');
assert.equal(normalizeSha('a'.repeat(41)), '');
assert.equal(sameBuild('abc1234', 'abc1234'), true);
assert.equal(sameBuild('abc1234', 'ABC1234ef'), true, 'a longer short sha of the same commit is the same build');
assert.equal(sameBuild('abc1234ef', 'abc1234'), true);
assert.equal(sameBuild('abc1234', 'abc1235'), false);
assert.equal(sameBuild('', 'abc1234'), false);

// ── version.json ────────────────────────────────────────────────────────────
assert.deepEqual(parseVersionPayload({ sha: 'ABC1234', date: '2026-11-15T10:00:00Z' }), { sha: 'abc1234', date: '2026-11-15T10:00:00Z' });
assert.deepEqual(parseVersionPayload({ sha: 'abc1234' }), { sha: 'abc1234', date: '' });
assert.equal(parseVersionPayload({ sha: 'unknown' }), null);
assert.equal(parseVersionPayload('abc1234'), null);
assert.equal(parseVersionPayload(null), null);

{
    const url = new URL(versionUrl('https://www.unditas.com/index.html?lang=fr#x', 42));
    assert.equal(url.pathname, '/version.json', 'beside the page');
    assert.equal(url.searchParams.get('t'), '42', 'with a query no cache has seen');
    assert.equal(url.searchParams.get('lang'), null, "the page's own query stays with the page");
    assert.equal(new URL(versionUrl('https://user.github.io/repo/', 1)).pathname, '/repo/version.json', 'under a project path too');
}

// Every failure is the same silent answer.
{
    const ok = (body) => async () => ({ ok: true, json: async () => body });
    let seen = null;
    const recording = async (url, init) => { seen = { url, init }; return { ok: true, json: async () => ({ sha: 'def5678' }) }; };
    assert.deepEqual(await fetchRemoteVersion({ fetchImpl: recording, url: 'https://x/version.json?t=1' }), { sha: 'def5678', date: '' });
    assert.equal(seen.init.cache, 'no-store', 'past the browser cache');
    assert.equal(await fetchRemoteVersion({ fetchImpl: ok({ sha: 'nope' }), url: 'u' }), null);
    assert.equal(await fetchRemoteVersion({ fetchImpl: async () => ({ ok: false, status: 404 }), url: 'u' }), null, 'a 404');
    assert.equal(await fetchRemoteVersion({ fetchImpl: async () => { throw new TypeError('Failed to fetch'); }, url: 'u' }), null, 'offline');
    assert.equal(await fetchRemoteVersion({
        fetchImpl: async () => ({ ok: true, json: async () => { throw new SyntaxError('Unexpected token <'); } }),
        url: 'u',
    }), null, 'a dev server answering with its HTML page');
    assert.equal(await fetchRemoteVersion({ fetchImpl: undefined, url: 'u' }), null);
    // A request that never answers is given up on.
    const hanging = (url, { signal }) => new Promise((_, reject) => signal.addEventListener('abort', () => reject(new Error('aborted'))));
    const started = Date.now();
    assert.equal(await fetchRemoteVersion({ fetchImpl: hanging, url: 'u', timeoutMs: 30 }), null, 'a timeout');
    assert.ok(Date.now() - started < 2000);
}

// ── When to look ────────────────────────────────────────────────────────────
assert.equal(shouldCheckNow({ now: 1000, lastCheckAt: 0 }), true, 'the first look is always due');
assert.equal(shouldCheckNow({ now: 1000 + RECHECK_INTERVAL_MS - 1, lastCheckAt: 1000 }), false, 'then not before the interval');
assert.equal(shouldCheckNow({ now: 1000 + RECHECK_INTERVAL_MS, lastCheckAt: 1000 }), true);
assert.equal(shouldCheckNow({ now: 1001, lastCheckAt: 1000, force: true }), true);
assert.ok(RECHECK_INTERVAL_MS >= 10 * 60 * 1000 && RECHECK_INTERVAL_MS <= 30 * 60 * 1000, 'every 10 to 30 minutes, as the issue asks');

// ── What to do ──────────────────────────────────────────────────────────────
const decide = (args) => decideVersionAction({ runningSha: 'aaaaaaa', remoteSha: 'bbbbbbb', ...args });
assert.deepEqual(decide({}), { action: 'reload', reason: 'idle' }, 'a newer build, nothing open: reload');
assert.deepEqual(decide({ busy: true }), { action: 'banner', reason: 'busy' }, 'files open: offer, never impose');
assert.deepEqual(decide({ remoteSha: 'aaaaaaa' }), { action: 'none', reason: 'current' });
assert.deepEqual(decide({ remoteSha: 'AAAAAAA', busy: true }), { action: 'none', reason: 'current' });
assert.deepEqual(decide({ remoteSha: '' }), { action: 'none', reason: 'unknown' }, 'no answer, no action');
assert.deepEqual(decide({ runningSha: 'dev' }), { action: 'none', reason: 'unknown' }, 'nothing to compare in a build without a sha');
assert.deepEqual(decide({ attemptedSha: 'bbbbbbb' }), { action: 'none', reason: 'already-tried' }, 'one reload to a build, never two');
assert.deepEqual(decide({ attemptedSha: 'bbbbbbb', busy: true }), { action: 'none', reason: 'already-tried' }, 'nor a banner that would do the same');
assert.deepEqual(decide({ attemptedSha: 'ccccccc' }), { action: 'reload', reason: 'idle' }, 'a still newer build is tried anew');
assert.deepEqual(decide({ dismissedSha: 'bbbbbbb', busy: true }), { action: 'none', reason: 'dismissed' }, '"Later" holds for that build');
assert.deepEqual(decide({ dismissedSha: 'ccccccc', busy: true }), { action: 'banner', reason: 'busy' });

// ── The reload's address ────────────────────────────────────────────────────
{
    const href = 'https://www.unditas.com/?lang=fr&feedback=1&v=0.7.0#guide';
    const target = new URL(reloadUrl(href, 'BBBBBBB'));
    assert.equal(target.searchParams.get(RELOAD_PARAM), 'bbbbbbb');
    assert.equal(RELOAD_PARAM === 'v', false, "not the Feedback handover's `v` (src/app/feedback-transport.js)");
    assert.equal(target.searchParams.get('lang'), 'fr', "the page's other parameters ride along");
    assert.equal(target.searchParams.get('v'), '0.7.0');
    assert.equal(target.hash, '#guide');
    assert.equal(target.pathname, '/');
    // Once more replaces, never stacks.
    assert.equal(new URL(reloadUrl(target.toString(), 'ccccccc')).searchParams.getAll(RELOAD_PARAM).length, 1);

    const cleaned = cleanReloadUrl(target.toString());
    assert.equal(cleaned.changed, true);
    assert.equal(cleaned.arrivedSha, 'bbbbbbb');
    assert.equal(new URL(cleaned.url).searchParams.has(RELOAD_PARAM), false);
    assert.equal(new URL(cleaned.url).searchParams.get('lang'), 'fr');
    assert.equal(new URL(cleaned.url).hash, '#guide');
    assert.deepEqual(cleanReloadUrl('https://www.unditas.com/'), { url: 'https://www.unditas.com/', changed: false, arrivedSha: '' });
    assert.equal(cleanReloadUrl('https://www.unditas.com/?build=junk').arrivedSha, '', 'a junk value guards nothing but is still removed');
    assert.equal(cleanReloadUrl('https://www.unditas.com/?build=junk').changed, true);
}

// ── The loop guard ──────────────────────────────────────────────────────────
{
    const memory = () => {
        const map = new Map();
        return { getItem: k => (map.has(k) ? map.get(k) : null), setItem: (k, v) => map.set(k, String(v)), removeItem: k => map.delete(k), map };
    };
    const store = memory();
    assert.equal(readReloadAttempt(store, 1000), '');
    assert.equal(markReloadAttempt(store, 'BBBBBBB', 1000), true);
    assert.ok(store.map.has(RELOAD_GUARD_KEY));
    assert.equal(readReloadAttempt(store, 1000 + 5000), 'bbbbbbb', 'remembered across the reload');
    assert.equal(readReloadAttempt(store, 1000 + RELOAD_RETRY_MS - 1), 'bbbbbbb');
    assert.equal(readReloadAttempt(store, 1000 + RELOAD_RETRY_MS), '', 'then forgotten, so a tab left open tries once more');
    assert.equal(readReloadAttempt(store, 999), '', 'a guard from the future (clock change) is no guard');
    clearReloadAttempt(store);
    assert.equal(readReloadAttempt(store, 1001), '');

    store.setItem(RELOAD_GUARD_KEY, '{not json');
    assert.equal(readReloadAttempt(store, 1000), '');

    // Storage that refuses (a private window, a policy) breaks nothing.
    const refusing = { getItem() { throw new Error('SecurityError'); }, setItem() { throw new Error('QuotaExceeded'); }, removeItem() { throw new Error('SecurityError'); } };
    assert.equal(readReloadAttempt(refusing), '');
    assert.equal(markReloadAttempt(refusing, 'bbbbbbb'), false);
    assert.doesNotThrow(() => clearReloadAttempt(refusing));
    assert.equal(markReloadAttempt(null, 'bbbbbbb'), false);
}

// ── A whole scenario: the CDN keeps serving the old page ────────────────────
// Page A (old build) sees B deployed, nothing open: reload, guarded. The page
// that comes back is A again. Its check must not reload a second time.
{
    const map = new Map();
    const store = { getItem: k => (map.has(k) ? map.get(k) : null), setItem: (k, v) => map.set(k, v), removeItem: k => map.delete(k) };
    let reloads = 0;
    const visit = (now, arrivedSha = '') => {
        const attemptedSha = readReloadAttempt(store, now) || arrivedSha;
        const { action } = decideVersionAction({ runningSha: 'aaaaaaa', remoteSha: 'bbbbbbb', attemptedSha });
        if (action === 'reload') {
            markReloadAttempt(store, 'bbbbbbb', now);
            reloads += 1;
            return 'bbbbbbb';
        }
        return '';
    };
    let arrived = visit(0);
    for (let i = 1; i <= 5; i++) arrived = visit(i * 1000, arrived);
    assert.equal(reloads, 1, 'one reload, however long the old page keeps coming back');
    // Without storage the address's own query is the guard for the page it brought.
    map.clear();
    const { action } = decideVersionAction({ runningSha: 'aaaaaaa', remoteSha: 'bbbbbbb', attemptedSha: cleanReloadUrl('https://x/?build=bbbbbbb').arrivedSha });
    assert.equal(action, 'none');
}

console.log('version-check: all assertions passed');
