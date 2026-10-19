/**
 * Everything the feedback endpoint does that is not a network call.
 *
 * Kept apart from worker.js so the whole of it runs under `node --test`-style
 * assertions in scripts/test-feedback-worker.mjs: parsing, every limit, the
 * sanitising of a filename that becomes a path in a git repository, and the
 * issue text a stranger's words end up inside.
 */

// The same two numbers the form enforces (src/app/feedback-transport.js).
// A limit checked only in the page is not a limit: anyone can POST here.
export const MAX_ATTACHMENT_BYTES = 4 * 1024 * 1024;
export const MAX_TOTAL_BYTES = 8 * 1024 * 1024;
export const MAX_ATTACHMENTS = 10;

export const MAX_SUMMARY_CHARS = 140;
export const MAX_DETAILS_CHARS = 8000;
export const MAX_EXPECTED_CHARS = 4000;
export const MAX_CONTACT_CHARS = 200;

export const ALLOWED_EXTENSIONS = [
    'png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp',
    'txt', 'log', 'md', 'json', 'csv', 'tsv', 'yml', 'yaml',
    'zip', 'mat', 'parquet', 'nc', 'nc4', 'cdf', 'pkl', 'pickle',
    'xlsx', 'xls', 'ods', 'mo', 'pdf',
];

const IMAGE_EXTENSIONS = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp'];
const CATEGORIES = ['bug', 'idea', 'question'];

/**
 * A refusal the reporter is meant to read.
 *
 * `code` is what the app matches on to show the refusal in the reporter's own
 * language; `message` is the English fallback for anything -- curl, a log, an
 * app older than the code -- that has no translation of its own.
 */
export class ReportError extends Error {
    constructor(status, message, code = '') {
        super(message);
        this.name = 'ReportError';
        this.status = status;
        this.code = code;
    }
}

export function extensionOf(name) {
    const match = /\.([A-Za-z0-9]{1,8})$/.exec(String(name || ''));
    return match ? match[1].toLowerCase() : '';
}

export function isImageName(name) {
    return IMAGE_EXTENSIONS.includes(extensionOf(name));
}

/** The decoded length of a base64 string, without decoding it. */
export function base64ByteLength(data) {
    const text = String(data || '');
    if (!text) return 0;
    const padding = text.endsWith('==') ? 2 : text.endsWith('=') ? 1 : 0;
    return Math.floor((text.length * 3) / 4) - padding;
}

function clamp(value, max) {
    const text = typeof value === 'string' ? value : value == null ? '' : String(value);
    // Control characters other than tab and newline have no business in an
    // issue body and are a classic way to make text display as something else.
    // eslint-disable-next-line no-control-regex
    const cleaned = text.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '');
    return cleaned.length > max ? `${cleaned.slice(0, max)}…` : cleaned;
}

/**
 * A filename that is safe as a path component in a git repository: no
 * directory traversal, no leading dot, nothing a shell or a URL would read as
 * punctuation, and an extension from the allow list.
 */
export function sanitizeAssetName(name, used = new Set()) {
    const extension = extensionOf(name);
    if (!ALLOWED_EXTENSIONS.includes(extension)) {
        throw new ReportError(415, `Attachment type not accepted: ${String(name).slice(0, 60)}`, 'type-rejected');
    }
    const base = String(name)
        .slice(0, 100)
        .replace(/\.[A-Za-z0-9]{1,8}$/, '')
        .replace(/[^A-Za-z0-9._-]+/g, '-')
        .replace(/^[.-]+/, '')
        .replace(/-+/g, '-')
        .replace(/-$/, '') || 'attachment';
    let candidate = `${base}.${extension}`;
    let index = 2;
    while (used.has(candidate.toLowerCase())) {
        candidate = `${base}-${index}.${extension}`;
        index += 1;
    }
    used.add(candidate.toLowerCase());
    return candidate;
}

/**
 * The wire format, taken apart: one JSON line, then one base64 line per
 * attachment. The attachment payloads are never parsed or decoded here --
 * they are handed to GitHub as the substrings they already are, which is what
 * keeps this inside the free plan's 10 ms of CPU.
 */
export function parseReportBody(bodyText) {
    const text = String(bodyText || '');
    if (!text) throw new ReportError(400, 'Empty request body', 'invalid');

    const firstBreak = text.indexOf('\n');
    const headText = firstBreak === -1 ? text : text.slice(0, firstBreak);
    let head;
    try {
        head = JSON.parse(headText);
    } catch {
        throw new ReportError(400, 'First line is not valid JSON', 'invalid');
    }
    if (head?.schema !== 1) throw new ReportError(400, 'Unsupported report schema', 'invalid');

    const summary = clamp(head.summary, MAX_SUMMARY_CHARS).trim();
    const details = clamp(head.details, MAX_DETAILS_CHARS).trim();
    if (!summary) throw new ReportError(400, 'A summary is required', 'invalid');
    if (!details) throw new ReportError(400, 'Details are required', 'invalid');

    const declared = Array.isArray(head.attachments) ? head.attachments : [];
    if (declared.length > MAX_ATTACHMENTS) {
        throw new ReportError(413, `At most ${MAX_ATTACHMENTS} attachments per report`, 'too-large');
    }

    const used = new Set();
    const attachments = [];
    let cursor = firstBreak === -1 ? text.length : firstBreak + 1;
    let total = 0;
    for (const entry of declared) {
        if (cursor > text.length) throw new ReportError(400, 'Fewer attachment lines than the report declares', 'invalid');
        const nextBreak = text.indexOf('\n', cursor);
        const data = (nextBreak === -1 ? text.slice(cursor) : text.slice(cursor, nextBreak)).trim();
        cursor = nextBreak === -1 ? text.length + 1 : nextBreak + 1;
        if (!data) throw new ReportError(400, 'Empty attachment line', 'invalid');
        // The payload is not validated character by character: that scan costs
        // as much as the decode this format exists to avoid. A malformed
        // payload is GitHub's 422, which is surfaced as a 502.
        if (!/^[A-Za-z0-9+/=]{1,64}/.test(data)) throw new ReportError(400, 'Attachment line is not base64', 'invalid');
        const size = base64ByteLength(data);
        if (size > MAX_ATTACHMENT_BYTES) {
            throw new ReportError(413, `Attachment over ${Math.round(MAX_ATTACHMENT_BYTES / 1024 / 1024)} MB`, 'too-large');
        }
        total += size;
        if (total > MAX_TOTAL_BYTES) {
            throw new ReportError(413, `Attachments over ${Math.round(MAX_TOTAL_BYTES / 1024 / 1024)} MB in total`, 'too-large');
        }
        attachments.push({ name: sanitizeAssetName(entry?.name, used), size, data });
    }

    const app = head.app && typeof head.app === 'object' ? head.app : {};
    return {
        report: {
            category: CATEGORIES.includes(head.category) ? head.category : 'bug',
            summary,
            details,
            expected: clamp(head.expected, MAX_EXPECTED_CHARS).trim(),
            contact: clamp(head.contact, MAX_CONTACT_CHARS).trim(),
            app: {
                version: clamp(app.version, 40),
                commit: clamp(app.commit, 40),
                buildDate: clamp(app.buildDate, 40),
                url: clamp(app.url, 300),
                userAgent: clamp(app.userAgent, 400),
                language: clamp(app.language, 20),
                // Set when Full Desktop handed the form to the browser: the
                // report is about that build, not about the page it was typed
                // on, and the issue has to say which.
                reportedFrom: clamp(app.reportedFrom, 120),
                createdAt: clamp(app.createdAt, 40),
            },
        },
        attachments,
        totalBytes: total,
    };
}

/** `2026-10-19-3f8a2c` -- sortable, unique, and safe in a path. */
export function makeReference(now = new Date(), random = Math.random) {
    const stamp = new Date(now).toISOString().slice(0, 10);
    const suffix = Math.floor(random() * 0xffffff).toString(16).padStart(6, '0');
    return `${stamp}-${suffix}`;
}

export function buildIssueTitle(report) {
    const prefix = report.category === 'idea' ? 'Idea' : report.category === 'question' ? 'Question' : 'Bug';
    return `[${prefix}] ${report.summary.replace(/\s+/g, ' ')}`.slice(0, 180);
}

/**
 * An address nobody has to publish to be able to answer.
 *
 * The issue is public, and an address written plainly in one is harvested
 * within the day. The maintainer can still read it; a scraper's regex cannot.
 */
export function obfuscateEmail(contact) {
    const text = String(contact || '').trim();
    if (!text) return '';
    return text.replace(/@/g, ' [at] ').replace(/\.([A-Za-z]{2,})$/, ' [dot] $1');
}

/**
 * The issue body.
 *
 * Everything the reporter typed goes inside a fenced block, with any fence of
 * its own defused. They are a stranger to this repository: their text should
 * read as what they wrote, not act as markup that rewrites the report around
 * it.
 */
export function buildIssueBody(report, assets = [], reference = '') {
    const fence = text => `\`\`\`text\n${String(text || '-').replace(/```/g, "'''")}\n\`\`\``;
    const app = report.app || {};
    const lines = [
        `**Summary:** ${report.summary.replace(/[`*_~<>|\\]/g, '')}`,
        '',
        '### Details and steps to reproduce',
        fence(report.details),
    ];
    if (report.expected) {
        lines.push('', '### Expected result or context', fence(report.expected));
    }
    if (assets.length) {
        lines.push('', '### Attachments');
        for (const asset of assets) {
            lines.push(isImageName(asset.name) ? `![${asset.name}](${asset.url})` : `- [${asset.name}](${asset.url})`);
        }
    }
    lines.push(
        '',
        '### Build',
        '',
        '| | |',
        '| --- | --- |',
        ...(app.reportedFrom ? [`| Reported from | ${app.reportedFrom} |`] : []),
        `| Version | ${app.version || '-'} |`,
        `| Commit | ${app.commit || '-'} |`,
        `| Build date | ${app.buildDate || '-'} |`,
        `| Page | ${app.url || '-'} |`,
        `| Language | ${app.language || '-'} |`,
        `| Browser | ${app.userAgent || '-'} |`,
        `| Sent | ${app.createdAt || '-'} |`,
        `| Reference | ${reference || '-'} |`,
        `| Contact | ${obfuscateEmail(report.contact) || 'not provided'} |`,
        '',
        '<sub>Filed by the in-app Feedback form. The reporter has no GitHub account unless they say so.</sub>',
    );
    return lines.join('\n');
}

/**
 * CORS for a public endpoint.
 *
 * This is not the security boundary -- anyone can reach this worker with curl,
 * and the headers below do not change that. What protects it is the limits
 * above, the rate limit, and a token that can only write issues and one
 * directory of one repository. The headers exist so the app can read the
 * reply; `null` is what the desktop build sends.
 */
export function corsHeaders(origin, allowed = '') {
    const list = String(allowed || '').split(',').map(entry => entry.trim()).filter(Boolean);
    const open = list.length === 0 || list.includes('*');
    const allowOrigin = open ? '*' : (list.includes(origin) ? origin : '');
    const headers = {
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
        'Access-Control-Max-Age': '86400',
        Vary: 'Origin',
    };
    if (allowOrigin) headers['Access-Control-Allow-Origin'] = allowOrigin;
    return headers;
}

/**
 * The GitHub Contents API body, built by concatenation rather than
 * JSON.stringify.
 *
 * stringify would scan every one of the base64 megabytes looking for
 * characters to escape. Base64 has none -- its alphabet is A-Z a-z 0-9 + / =
 * -- so splicing the payload between two constant strings produces the same
 * JSON for a fraction of the CPU the free plan allows. The surrounding fields
 * are stringified normally: they are short and they are not trusted.
 */
export function contentsApiBody({ message, content, branch }) {
    const head = JSON.stringify({ message, branch }).slice(0, -1);
    return `${head},"content":"${content}"}`;
}
