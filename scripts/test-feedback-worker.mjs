// The endpoint that turns a Send into a GitHub issue (server/feedback-worker).
//
// It is the one piece of this feature that strangers can reach directly, so it
// is exercised whole here -- the handler, against a stubbed GitHub -- rather
// than only in the parts. What it must get right: refuse what the form would
// have refused (a page's limit is not a limit), never let a reporter's
// filename become a path of its own, and never let a reporter's text act as
// markup in the issue it lands in.
import assert from 'node:assert/strict';

import worker from '../server/feedback-worker/src/worker.js';
import {
    MAX_ATTACHMENT_BYTES,
    base64ByteLength,
    buildIssueBody,
    buildIssueTitle,
    contentsApiBody,
    corsHeaders,
    makeReference,
    obfuscateEmail,
    parseReportBody,
    sanitizeAssetName,
} from '../server/feedback-worker/src/report.js';

const ENV = {
    GITHUB_TOKEN: 'ghp_test',
    GITHUB_REPO: 'owner/repo',
    ASSET_BRANCH: 'feedback-attachments',
    ISSUE_LABELS: 'feedback',
};

const head = (overrides = {}, attachments = []) => JSON.stringify({
    schema: 1,
    category: 'bug',
    summary: 'The cursor jumps',
    details: 'Opened a csv and dragged.',
    expected: '',
    contact: '',
    app: { version: '0.4.1', commit: 'abc1234', url: 'https://www.unditas.com/', userAgent: 'TestAgent' },
    attachments,
    ...overrides,
});

const post = (body, env = ENV, headers = {}) => worker.fetch(
    new Request('https://feedback.example/', {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain', Origin: 'https://www.unditas.com', ...headers },
        body,
    }),
    env,
);

// A GitHub that records what it was asked, and answers however the test says.
function stubGitHub({ branchExists = true } = {}) {
    const calls = [];
    globalThis.fetch = async (url, init = {}) => {
        const path = String(url).replace('https://api.github.com', '');
        calls.push({ path, method: init.method || 'GET', body: init.body, headers: init.headers });
        if (path.startsWith('/repos/owner/repo/git/ref/heads/')) {
            // The default branch always exists; the asset branch only once it
            // has been created.
            const isAssetBranch = path.endsWith('/feedback-attachments');
            return !isAssetBranch || branchExists
                ? new Response(JSON.stringify({ object: { sha: 'deadbeef' } }), { status: 200 })
                : new Response('{}', { status: 404 });
        }
        if (path === '/repos/owner/repo') {
            return new Response(JSON.stringify({ default_branch: 'main' }), { status: 200 });
        }
        if (path === '/repos/owner/repo/git/refs') return new Response('{}', { status: 201 });
        if (path.startsWith('/repos/owner/repo/contents/')) {
            const name = decodeURIComponent(path.split('/').pop());
            return new Response(JSON.stringify({
                content: { download_url: `https://raw.githubusercontent.com/owner/repo/feedback-attachments/${name}` },
            }), { status: 201 });
        }
        if (path === '/repos/owner/repo/issues') {
            return new Response(JSON.stringify({ html_url: 'https://github.com/owner/repo/issues/12', number: 12 }), { status: 201 });
        }
        throw new Error(`Unexpected GitHub call: ${path}`);
    };
    return calls;
}

// ── The pieces ──────────────────────────────────────────────────────────────
assert.equal(base64ByteLength('aGk='), 2);
assert.equal(base64ByteLength(''), 0);
assert.equal(base64ByteLength(Buffer.from(new Uint8Array(3000)).toString('base64')), 3000);

// A filename becomes a path in a git repository, so it may not carry one.
const used = new Set();
assert.equal(sanitizeAssetName('../../../etc/passwd.png', used), 'etc-passwd.png');
assert.equal(sanitizeAssetName('shot.png', used), 'shot.png');
assert.equal(sanitizeAssetName('shot.png', used), 'shot-2.png', 'a repeated name does not overwrite the first');
assert.equal(sanitizeAssetName('.hidden.txt', used), 'hidden.txt');
assert.equal(sanitizeAssetName('a b&c;.png', used), 'a-b-c.png', 'spaces and punctuation collapse to one dash');
assert.throws(() => sanitizeAssetName('payload.exe', new Set()), /not accepted/);
assert.throws(() => sanitizeAssetName('no-extension', new Set()), /not accepted/);

assert.equal(obfuscateEmail('someone@example.com'), 'someone [at] example [dot] com',
    'a public issue is harvested; the maintainer can still read this');
assert.equal(obfuscateEmail(''), '');

assert.equal(buildIssueTitle({ category: 'bug', summary: 'It breaks' }), '[Bug] It breaks');
assert.equal(buildIssueTitle({ category: 'idea', summary: 'Add a button' }), '[Idea] Add a button');

assert.match(makeReference(new Date('2026-10-19T00:00:00Z'), () => 0.5), /^2026-10-19-[0-9a-f]{6}$/);

// The body built by concatenation has to be the JSON that stringify would have
// produced -- that is the whole bet the CPU budget rests on.
const spliced = contentsApiBody({ message: 'msg "quoted"', content: 'AAAA', branch: 'b' });
assert.deepEqual(JSON.parse(spliced), { message: 'msg "quoted"', branch: 'b', content: 'AAAA' });

// ── Parsing, and every limit ────────────────────────────────────────────────
const parsed = parseReportBody(`${head({}, [{ name: 'shot.png' }])}\nAAAA`);
assert.equal(parsed.report.summary, 'The cursor jumps');
assert.equal(parsed.attachments[0].name, 'shot.png');
assert.equal(parsed.attachments[0].data, 'AAAA', 'the payload is passed through, never decoded');

assert.throws(() => parseReportBody(''), /Empty/);
assert.throws(() => parseReportBody('not json'), /not valid JSON/);
assert.throws(() => parseReportBody(head({ schema: 2 })), /schema/);
assert.throws(() => parseReportBody(head({ summary: '   ' })), /summary is required/);
assert.throws(() => parseReportBody(head({ details: '' })), /Details are required/);
assert.throws(
    () => parseReportBody(head({}, Array.from({ length: 11 }, (_, i) => ({ name: `s${i}.png` })))),
    /At most 10/,
);
const oversized = 'A'.repeat(Math.ceil((MAX_ATTACHMENT_BYTES + 1024) * 4 / 3));
assert.throws(() => parseReportBody(`${head({}, [{ name: 'big.png' }])}\n${oversized}`), /Attachment over/);
assert.throws(() => parseReportBody(`${head({}, [{ name: 'a.png' }])}\n`), /Empty attachment line/);

// Text is clamped, and control characters -- a classic way to make a line
// display as something it is not -- never reach the issue.
const clamped = parseReportBody(head({ summary: `x${'y'.repeat(400)}`, details: 'a\u0000b\u001bc' }));
assert.ok(clamped.report.summary.length <= 141);
assert.equal(clamped.report.details, 'abc');
assert.equal(parseReportBody(head({ category: 'nonsense' })).report.category, 'bug');

// ── The issue body ──────────────────────────────────────────────────────────
const body = buildIssueBody(
    {
        category: 'bug',
        summary: 'Cursor **jumps**',
        details: 'Here is my log:\n```\nsecret fence\n```',
        expected: 'It follows the pointer',
        contact: 'someone@example.com',
        app: { version: '0.4.1', commit: 'abc1234', url: 'https://x/', userAgent: 'TestAgent' },
    },
    [
        { name: 'shot.png', url: 'https://raw.example/shot.png' },
        { name: 'run.mat', url: 'https://raw.example/run.mat' },
    ],
    '2026-10-19-abc123',
);
assert.match(body, /!\[shot\.png\]\(https:\/\/raw\.example\/shot\.png\)/, 'a screenshot shows in the issue itself');
assert.match(body, /- \[run\.mat\]\(https:\/\/raw\.example\/run\.mat\)/, 'anything else is a link');
assert.doesNotMatch(body, /```\nsecret fence\n```/, 'a fence inside the report cannot close the block around it');
assert.match(body, /'''/, 'it is defused rather than dropped');
assert.doesNotMatch(body, /\*\*jumps\*\*/, 'the summary line is not markup either');
assert.match(body, /someone \[at\] example \[dot\] com/);
assert.match(body, /\| Version \| 0\.4\.1 \|/);
assert.match(body, /\| Reference \| 2026-10-19-abc123 \|/);

// ── CORS ────────────────────────────────────────────────────────────────────
assert.equal(corsHeaders('https://a.test', '')['Access-Control-Allow-Origin'], '*', 'unset means any origin');
assert.equal(corsHeaders('https://a.test', 'https://a.test')['Access-Control-Allow-Origin'], 'https://a.test');
assert.equal(corsHeaders('https://evil.test', 'https://a.test')['Access-Control-Allow-Origin'], undefined);

// ── The handler, end to end ─────────────────────────────────────────────────
const preflight = await worker.fetch(new Request('https://feedback.example/', { method: 'OPTIONS' }), ENV);
assert.equal(preflight.status, 204);
assert.equal(preflight.headers.get('Access-Control-Allow-Methods'), 'POST, OPTIONS');

const health = await worker.fetch(new Request('https://feedback.example/'), ENV);
assert.equal(health.status, 200);
assert.equal((await health.json()).ok, true);

// A report with an attachment, on a repository that has no asset branch yet.
let calls = stubGitHub({ branchExists: false });
let response = await post(`${head({ contact: 'me@example.com' }, [{ name: 'shot.png' }])}\nQUJD`);
assert.equal(response.status, 200);
let payload = await response.json();
assert.equal(payload.ok, true);
assert.equal(payload.issueUrl, 'https://github.com/owner/repo/issues/12');
assert.equal(payload.issueNumber, 12);
assert.match(payload.reference, /^\d{4}-\d{2}-\d{2}-[0-9a-f]{6}$/);

assert.ok(calls.some(call => call.path === '/repos/owner/repo/git/refs' && call.method === 'POST'),
    'the attachment branch is created when it is missing');
const upload = calls.find(call => call.path.startsWith('/repos/owner/repo/contents/'));
assert.match(upload.path, /\/contents\/reports\/\d{4}-\d{2}-\d{2}-[0-9a-f]{6}\/shot\.png$/,
    'attachments live under a folder of their own, per report');
assert.equal(JSON.parse(upload.body).content, 'QUJD', 'the payload reaches GitHub byte for byte');
assert.equal(JSON.parse(upload.body).branch, 'feedback-attachments', 'never the default branch');
const issueCall = calls.find(call => call.path === '/repos/owner/repo/issues');
assert.deepEqual(JSON.parse(issueCall.body).labels, ['feedback']);
assert.match(JSON.parse(issueCall.body).body, /!\[shot\.png\]/);
assert.match(issueCall.headers.Authorization, /^Bearer /, 'the token the page must never see');

// The second report does not pay for the branch check again: the isolate
// remembers that the branch exists.
calls = stubGitHub();
response = await post(head());
assert.equal(response.status, 200);
assert.equal(calls.filter(call => call.path.includes('/git/ref')).length, 0);
assert.equal(calls.length, 1, 'a report with no attachment is a single call to GitHub');

// What it refuses, with a message the form can show as it is.
calls = stubGitHub();
response = await post(`${head({}, [{ name: 'payload.exe' }])}\nQUJD`);
assert.equal(response.status, 415);
const refusal = await response.json();
assert.match(refusal.error, /not accepted/);
// The code is what lets the app say this in the reporter's own language; the
// English sentence beside it is the fallback for a code it does not know.
assert.equal(refusal.code, 'type-rejected');
assert.equal(calls.length, 0, 'nothing was written to the repository');

response = await post(head({ summary: '' }));
assert.equal(response.status, 400);

response = await post('not json at all');
assert.equal(response.status, 400);

// A deployment with no token says so rather than failing obscurely.
response = await post(head(), { ...ENV, GITHUB_TOKEN: '' });
assert.equal(response.status, 500);
assert.match((await response.json()).error, /not configured/);

// A GitHub that is having a bad day becomes a 502 with nothing internal in it.
globalThis.fetch = async () => new Response('{"message":"Bad credentials"}', { status: 401 });
const originalError = console.error;
console.error = () => {};
response = await post(head());
console.error = originalError;
assert.equal(response.status, 502);
assert.doesNotMatch((await response.json()).error, /credentials|ghp_|Bearer/i,
    'the reply to a stranger carries no internals');

// Rate limiting, when a KV namespace is bound.
const store = new Map();
const kvEnv = {
    ...ENV,
    MAX_REPORTS_PER_HOUR: '2',
    FEEDBACK_KV: {
        async get(key) { return store.get(key) ?? null; },
        async put(key, value) { store.set(key, value); },
    },
};
stubGitHub();
const fromOneAddress = () => post(head(), kvEnv, { 'CF-Connecting-IP': '203.0.113.9' });
assert.equal((await fromOneAddress()).status, 200);
assert.equal((await fromOneAddress()).status, 200);
const third = await fromOneAddress();
assert.equal(third.status, 429);
const limited = await third.json();
assert.match(limited.error, /Too many/);
assert.equal(limited.code, 'rate-limited');
// Someone else is unaffected.
assert.equal((await post(head(), kvEnv, { 'CF-Connecting-IP': '198.51.100.4' })).status, 200);

console.log('Feedback worker checks passed.');
