/**
 * The endpoint behind the app's Send button.
 *
 * It exists for one reason: so that someone reviewing Time Series Explorer can
 * report a bug with a screenshot without a GitHub account and without a mail
 * client. It holds a GitHub token the page must never see, commits the
 * attachments to a branch of the repository, and opens the issue.
 *
 * Deploying it: server/feedback-worker/README.md.
 *
 * It runs on Cloudflare's free plan, which allows 10 ms of CPU per request.
 * Waiting on GitHub costs nothing against that, but touching megabytes does,
 * which is why the attachments are never parsed or decoded here -- see the
 * wire format in src/report.js.
 */
import {
    MAX_TOTAL_BYTES,
    ReportError,
    buildIssueBody,
    buildIssueTitle,
    contentsApiBody,
    corsHeaders,
    makeReference,
    parseReportBody,
} from './report.js';

const GITHUB_API = 'https://api.github.com';
const USER_AGENT = 'timeseries-explorer-feedback-worker';

// Base64 is a third larger than the bytes it carries, and the metadata line
// adds a little; anything past this is refused before the body is read.
const MAX_REQUEST_BYTES = Math.ceil(MAX_TOTAL_BYTES * 1.4) + 64 * 1024;

// Per isolate, not per request: once the branch is known to exist it stays
// known for as long as this isolate lives, which saves a subrequest on nearly
// every report.
let branchVerified = false;

function json(body, status, origin, allowed) {
    return new Response(JSON.stringify(body), {
        status,
        headers: {
            'Content-Type': 'application/json;charset=UTF-8',
            'Cache-Control': 'no-store',
            ...corsHeaders(origin, allowed),
        },
    });
}

function githubHeaders(env) {
    return {
        Authorization: `Bearer ${env.GITHUB_TOKEN}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': USER_AGENT,
        'Content-Type': 'application/json',
    };
}

async function githubFetch(env, path, init = {}) {
    const response = await fetch(`${GITHUB_API}${path}`, { ...init, headers: githubHeaders(env) });
    if (!response.ok && response.status !== 404) {
        const detail = (await response.text().catch(() => '')).slice(0, 300);
        throw new ReportError(502, `GitHub ${response.status} on ${path}: ${detail}`);
    }
    return response;
}

/**
 * The attachments live on a branch of their own so a report never lands in
 * the code history. It is created from the default branch the first time a
 * report with an attachment arrives.
 */
async function ensureAssetBranch(env, branch) {
    if (branchVerified) return;
    const existing = await githubFetch(env, `/repos/${env.GITHUB_REPO}/git/ref/heads/${encodeURIComponent(branch)}`);
    if (existing.ok) {
        branchVerified = true;
        return;
    }
    const repo = await githubFetch(env, `/repos/${env.GITHUB_REPO}`);
    if (!repo.ok) throw new ReportError(502, 'Cannot read the repository');
    const defaultBranch = (await repo.json()).default_branch;
    const head = await githubFetch(env, `/repos/${env.GITHUB_REPO}/git/ref/heads/${encodeURIComponent(defaultBranch)}`);
    if (!head.ok) throw new ReportError(502, 'Cannot read the default branch');
    const sha = (await head.json()).object?.sha;
    const created = await fetch(`${GITHUB_API}/repos/${env.GITHUB_REPO}/git/refs`, {
        method: 'POST',
        headers: githubHeaders(env),
        body: JSON.stringify({ ref: `refs/heads/${branch}`, sha }),
    });
    // 422 is "it exists already": two reports arriving together both tried.
    if (!created.ok && created.status !== 422) {
        throw new ReportError(502, `Cannot create the attachment branch (${created.status})`);
    }
    branchVerified = true;
}

async function uploadAsset(env, branch, path, attachment, reference) {
    const encodedPath = path.split('/').map(encodeURIComponent).join('/');
    const response = await fetch(`${GITHUB_API}/repos/${env.GITHUB_REPO}/contents/${encodedPath}`, {
        method: 'PUT',
        headers: githubHeaders(env),
        body: contentsApiBody({
            message: `Feedback attachment ${reference}/${attachment.name}`,
            content: attachment.data,
            branch,
        }),
    });
    if (!response.ok) {
        const detail = (await response.text().catch(() => '')).slice(0, 200);
        throw new ReportError(502, `Cannot store ${attachment.name}: ${response.status} ${detail}`);
    }
    const stored = await response.json();
    return {
        name: attachment.name,
        // download_url is the raw URL GitHub itself hands out, so it stays
        // right if the repository is ever renamed or moved.
        url: stored?.content?.download_url
            || `https://raw.githubusercontent.com/${env.GITHUB_REPO}/${branch}/${encodedPath}`,
    };
}

/**
 * A fixed window per address, and only when a KV namespace is bound. Two
 * requests in the same millisecond can both read the old count, which is
 * acceptable: this exists to stop a loop, not a determined attacker. The
 * limits in report.js are what bound the damage either way.
 */
async function withinRateLimit(env, ip) {
    const kv = env.FEEDBACK_KV;
    if (!kv || !ip) return true;
    const limit = Number(env.MAX_REPORTS_PER_HOUR || 10);
    const key = `rl:${ip}:${Math.floor(Date.now() / 3_600_000)}`;
    const count = Number(await kv.get(key)) || 0;
    if (count >= limit) return false;
    await kv.put(key, String(count + 1), { expirationTtl: 3600 });
    return true;
}

export default {
    async fetch(request, env) {
        const origin = request.headers.get('Origin') || '';
        const allowed = env.ALLOWED_ORIGINS || '';
        const reply = (body, status) => json(body, status, origin, allowed);

        if (request.method === 'OPTIONS') {
            return new Response(null, { status: 204, headers: corsHeaders(origin, allowed) });
        }
        if (request.method === 'GET') {
            return reply({ ok: true, service: 'timeseries-explorer-feedback' }, 200);
        }
        if (request.method !== 'POST') return reply({ ok: false, error: 'Method not allowed' }, 405);

        if (!env.GITHUB_TOKEN || !env.GITHUB_REPO) {
            return reply({ ok: false, error: 'The endpoint is not configured' }, 500);
        }

        const declaredLength = Number(request.headers.get('Content-Length') || 0);
        if (declaredLength > MAX_REQUEST_BYTES) {
            return reply({ ok: false, error: 'Report too large', code: 'too-large' }, 413);
        }

        const ip = request.headers.get('CF-Connecting-IP') || '';
        if (!await withinRateLimit(env, ip)) {
            return reply({ ok: false, error: 'Too many reports from this connection in the last hour', code: 'rate-limited' }, 429);
        }

        try {
            const bodyText = await request.text();
            if (bodyText.length > MAX_REQUEST_BYTES) return reply({ ok: false, error: 'Report too large', code: 'too-large' }, 413);

            const { report, attachments } = parseReportBody(bodyText);
            const reference = makeReference();
            const branch = env.ASSET_BRANCH || 'feedback-attachments';

            const assets = [];
            if (attachments.length) {
                await ensureAssetBranch(env, branch);
                for (const attachment of attachments) {
                    // One at a time: each is a commit on the same branch, and
                    // parallel commits race for the same ref and fail.
                    assets.push(await uploadAsset(
                        env,
                        branch,
                        `reports/${reference}/${attachment.name}`,
                        attachment,
                        reference,
                    ));
                }
            }

            const labels = String(env.ISSUE_LABELS || 'feedback')
                .split(',').map(label => label.trim()).filter(Boolean);
            const created = await fetch(`${GITHUB_API}/repos/${env.GITHUB_REPO}/issues`, {
                method: 'POST',
                headers: githubHeaders(env),
                body: JSON.stringify({
                    title: buildIssueTitle(report),
                    body: buildIssueBody(report, assets, reference),
                    labels,
                }),
            });
            if (!created.ok) {
                const detail = (await created.text().catch(() => '')).slice(0, 200);
                throw new ReportError(502, `Cannot open the issue: ${created.status} ${detail}`);
            }
            const issue = await created.json();
            return reply({
                ok: true,
                issueUrl: issue.html_url,
                issueNumber: issue.number,
                reference,
            }, 200);
        } catch (error) {
            // The message of a ReportError is written to be read by the person
            // who sent the report. Anything else could carry internals, so it
            // is logged (wrangler tail) and answered generically.
            if (error instanceof ReportError && error.status < 500) {
                return reply({ ok: false, error: error.message, code: error.code || 'invalid' }, error.status);
            }
            console.error('Feedback report failed:', error?.stack || error);
            return reply({ ok: false, error: 'The report could not be filed. Please try again.', code: 'github' }, 502);
        }
    },
};
