// The Send button's half of the conversation.
//
// The form used to end with homework: download your screenshots, open GitHub,
// sign in, drag them into an issue -- or open a mail client that most people
// reviewing a web app do not have configured. One button now posts the report
// to an endpoint that files the issue (server/feedback-worker). What that
// request looks like, and what each failure means, is asserted here; the
// endpoint's side is scripts/test-feedback-worker.mjs.
import assert from 'node:assert/strict';

import {
    buildFeedbackHandoffUrl,
    readFeedbackHandoff,
    FEEDBACK_MAX_ATTACHMENTS,
    FEEDBACK_MAX_ATTACHMENT_BYTES,
    FEEDBACK_MAX_TOTAL_BYTES,
    FeedbackSendError,
    bytesToBase64,
    buildFeedbackReport,
    checkFeedbackAttachments,
    feedbackFileExtension,
    sendFeedbackReport,
    serializeFeedbackReport,
    shrinkScreenshot,
} from '../src/app/feedback-transport.js';

const fileOf = (name, bytes, type = 'image/png') => new File([new Uint8Array(bytes)], name, { type });
const feedback = {
    category: 'bug',
    summary: 'The cursor jumps',
    details: 'Opened a csv, dragged the cursor.',
    expected: 'It should follow the pointer.',
    contact: 'someone@example.com',
    appVersion: '0.4.1',
    buildSha: 'abc1234',
    buildDate: '2026-10-19T10:00:00Z',
    pageUrl: 'https://www.unditas.com/',
    userAgent: 'TestAgent/1.0',
    language: 'es',
    createdAt: '2026-10-19T10:01:00Z',
};

// ── base64 ──────────────────────────────────────────────────────────────────
assert.equal(bytesToBase64(new Uint8Array([104, 105])), 'aGk=');
// Past the argument limit of String.fromCharCode, which is where the naive
// spread form throws instead of encoding.
const big = new Uint8Array(200_000).fill(65);
assert.equal(Buffer.from(bytesToBase64(big), 'base64').length, big.length, 'a large buffer still encodes');
assert.equal(feedbackFileExtension('A Screenshot.PNG'), 'png');
assert.equal(feedbackFileExtension('no-extension'), '');

// ── The limits the form shows before spending an upload ─────────────────────
assert.equal(checkFeedbackAttachments([]).ok, true, 'a report with nothing attached is fine');
assert.equal(checkFeedbackAttachments([{ file: fileOf('a.png', 10) }]).ok, true);

const tooMany = Array.from({ length: FEEDBACK_MAX_ATTACHMENTS + 1 }, (_, i) => ({ file: fileOf(`s${i}.png`, 10) }));
assert.equal(checkFeedbackAttachments(tooMany).reason, 'count');

const oneTooBig = [{ file: fileOf('huge.png', FEEDBACK_MAX_ATTACHMENT_BYTES + 1) }];
assert.equal(checkFeedbackAttachments(oneTooBig).reason, 'file');
assert.equal(checkFeedbackAttachments(oneTooBig).name, 'huge.png', 'the message can name the file');

const overTotal = Array.from({ length: 3 }, (_, i) => ({ file: fileOf(`s${i}.png`, FEEDBACK_MAX_ATTACHMENT_BYTES) }));
assert.ok(overTotal.length * FEEDBACK_MAX_ATTACHMENT_BYTES > FEEDBACK_MAX_TOTAL_BYTES);
assert.equal(checkFeedbackAttachments(overTotal).reason, 'total');

assert.equal(checkFeedbackAttachments([{ file: fileOf('run.exe', 10) }]).reason, 'type',
    'an executable is not something to commit to a public repository');
assert.equal(checkFeedbackAttachments([{ file: fileOf('run.mat', 10) }]).ok, true,
    'the formats a report about this app would carry are accepted');

// ── The report, and the wire format ─────────────────────────────────────────
const report = await buildFeedbackReport(feedback, [{ file: fileOf('shot.png', 3) }]);
assert.equal(report.schema, 1);
assert.equal(report.summary, 'The cursor jumps');
assert.equal(report.app.version, '0.4.1');
assert.equal(report.app.userAgent, 'TestAgent/1.0', 'the browser travels with the report, to reproduce it');
assert.equal(report.attachments.length, 1);
assert.equal(report.attachments[0].data, bytesToBase64(new Uint8Array(3)));

const wire = serializeFeedbackReport(report);
const lines = wire.split('\n');
assert.equal(lines.length, 2, 'one head line, then one line per attachment');
const head = JSON.parse(lines[0]);
assert.equal(head.attachments[0].name, 'shot.png');
assert.equal(head.attachments[0].data, undefined, 'the payload is never inside the JSON head');
assert.equal(lines[1], report.attachments[0].data);
// The framing is only unambiguous because base64 has no newline in it.
assert.throws(
    () => serializeFeedbackReport({ ...report, attachments: [{ name: 'x.png', data: 'AA\nBB' }] }),
    /newline/,
);

// ── Full Desktop hands the form to the browser ──────────────────────────────
// That edition cancels every external request on purpose, so rather than cut a
// hole in the promise for one feature, Feedback there opens the web build in
// the user's own browser -- carrying the desktop build's identity, because
// that is what the report is about.
const handoffUrl = buildFeedbackHandoffUrl('https://www.unditas.com/', {
    version: '0.4.1',
    commit: 'abc1234',
    platform: 'win32',
});
assert.equal(handoffUrl, 'https://www.unditas.com/?feedback=1&from=desktop&v=0.4.1&c=abc1234&p=win32');
assert.equal(
    buildFeedbackHandoffUrl('https://www.unditas.com/', {}),
    'https://www.unditas.com/?feedback=1&from=desktop',
    'a build that knows nothing about itself still opens the form',
);

const handoff = readFeedbackHandoff(new URL(handoffUrl).search);
assert.equal(handoff.requested, true);
assert.equal(handoff.reportedFrom, 'Full Desktop 0.4.1 · win32 · commit abc1234');
assert.equal(readFeedbackHandoff('').requested, false, 'an ordinary visit opens no form');
assert.equal(readFeedbackHandoff('?other=1').requested, false);
assert.equal(readFeedbackHandoff('?feedback=1').reportedFrom, '', 'the web asking for itself reports no edition');
// It arrived in a URL, so it is a stranger's text: it may not become markup,
// a link, or a paragraph of its own inside the issue.
const hostile = readFeedbackHandoff('?feedback=1&from=desktop&v=' + encodeURIComponent('0.4.1](http://evil "x")\n# heading'));
// Every bracket, slash, quote and newline is gone, and what is left is cut to
// twenty characters.
assert.equal(hostile.reportedFrom, 'Full Desktop 0.4.1httpevil x head');
assert.ok(readFeedbackHandoff(`?feedback=1&from=desktop&v=${'9'.repeat(80)}`).reportedFrom.length < 60,
    'and it cannot be long enough to bury the report');

const handedOff = await buildFeedbackReport({ ...feedback, reportedFrom: 'Full Desktop 0.4.1 · win32' }, []);
assert.equal(handedOff.app.reportedFrom, 'Full Desktop 0.4.1 · win32');
assert.equal(report.app.reportedFrom, '', 'a report typed in the web app says nothing about an edition');

// ── One POST, and what each failure means ───────────────────────────────────
const replying = (status, body) => async () => ({
    ok: status >= 200 && status < 300,
    status,
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
});

const sendWith = (fetchImpl, options = {}) => sendFeedbackReport({
    endpoint: 'https://feedback.example/report',
    report,
    fetchImpl,
    ...options,
});

let seen = null;
const ok = await sendWith(async (url, init) => {
    seen = { url, init };
    return (await replying(200, { ok: true, issueUrl: 'https://github.com/o/r/issues/7', issueNumber: 7, reference: '2026-10-19-aaaaaa' })())
});
assert.deepEqual(ok, { issueUrl: 'https://github.com/o/r/issues/7', issueNumber: 7, reference: '2026-10-19-aaaaaa' });
assert.equal(seen.url, 'https://feedback.example/report');
assert.equal(seen.init.method, 'POST');
// text/plain is what keeps this a simple CORS request: no preflight, and it
// reaches the endpoint from the desktop build, whose origin is null.
assert.match(seen.init.headers['Content-Type'], /^text\/plain/);
assert.equal(seen.init.credentials, 'omit', 'no cookie of the user travels to the endpoint');
assert.equal(seen.init.body, wire);

const failsWith = async (fetchImpl, kind, options) => {
    const error = await sendWith(fetchImpl, options).then(() => null, err => err);
    assert.ok(error instanceof FeedbackSendError, `expected a FeedbackSendError for ${kind}`);
    assert.equal(error.kind, kind);
    return error;
};

// A 4xx is about this report and the user can act on it, so the endpoint's own
// words are kept for the message -- and its `code`, which is what lets the
// form say the same thing in the reporter's language.
const rejected = await failsWith(replying(413, { ok: false, error: 'Attachments over 8 MB in total', code: 'too-large' }), 'rejected');
assert.equal(rejected.detail, 'Attachments over 8 MB in total');
assert.equal(rejected.code, 'too-large');
assert.equal(rejected.status, 413);
const uncoded = await failsWith(replying(429, { ok: false, error: 'Slow down' }), 'rejected');
assert.equal(uncoded.code, '', 'an endpoint with no code for it still hands over its sentence');

await failsWith(replying(500, { ok: false, error: 'boom' }), 'server');
await failsWith(replying(200, { ok: false, error: 'half-filed' }), 'server', {});
await failsWith(replying(200, 'not json at all'), 'server');
await failsWith(async () => { throw new TypeError('Failed to fetch'); }, 'offline');
await failsWith(async () => { const e = new Error('aborted'); e.name = 'AbortError'; throw e; }, 'timeout');

const unconfigured = await sendFeedbackReport({ endpoint: '', report, fetchImpl: replying(200, { ok: true }) })
    .then(() => null, err => err);
assert.equal(unconfigured.kind, 'not-configured', 'a build with no endpoint says so instead of failing obscurely');

// A hung endpoint ends the wait rather than spinning forever.
const timedOut = await sendWith(
    (url, init) => new Promise((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => {
            const error = new Error('aborted');
            error.name = 'AbortError';
            reject(error);
        });
    }),
    { timeoutMs: 20 },
).then(() => null, err => err);
assert.equal(timedOut.kind, 'timeout');

// ── Screenshots are shrunk before they are sent ─────────────────────────────
// Browser-only APIs, stubbed: what matters here is the decision, not the pixels.
const stubs = (encodedSize) => ({
    createBitmap: async () => ({ width: 3000, height: 2000, close() {} }),
    CanvasCtor: class {
        constructor(width, height) { this.width = width; this.height = height; }
        getContext() { return { drawImage() {} }; }
        async convertToBlob() { return new Blob([new Uint8Array(encodedSize)], { type: 'image/jpeg' }); }
    },
    FileCtor: File,
});

const huge = fileOf('screenshot-1.png', 2 * 1024 * 1024);
const shrunk = await shrinkScreenshot(huge, stubs(150 * 1024));
assert.notEqual(shrunk, huge, 'a two-megabyte screenshot is re-encoded');
assert.equal(shrunk.type, 'image/jpeg');
assert.equal(shrunk.name, 'screenshot-1.jpg', 'the name follows the format it ended up in');
assert.ok(shrunk.size < huge.size);

const small = fileOf('small.png', 1024);
assert.equal(await shrinkScreenshot(small, stubs(512)), small, 'a small screenshot is left alone');
// Flat UI colour can compress worse as JPEG than as PNG; keep whichever won.
assert.equal(await shrinkScreenshot(huge, stubs(4 * 1024 * 1024)), huge, 'a bigger re-encoding is discarded');
const data = fileOf('run.mat', 2 * 1024 * 1024, 'application/octet-stream');
assert.equal(await shrinkScreenshot(data, stubs(10)), data, 'only images are re-encoded');
// Nothing here may throw on a browser that lacks OffscreenCanvas: the send has
// to work, smaller or not.
assert.equal(await shrinkScreenshot(huge, { createBitmap: null, CanvasCtor: null }), huge);
assert.equal(
    await shrinkScreenshot(huge, { ...stubs(10), createBitmap: async () => { throw new Error('decode failed'); } }),
    huge,
    'a failed re-encoding falls back to the original',
);

console.log('Feedback transport checks passed.');
