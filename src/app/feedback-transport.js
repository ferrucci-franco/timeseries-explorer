/**
 * What the Send button does.
 *
 * A static page cannot open a GitHub issue for someone who has no GitHub
 * account, and `mailto:` only works on a machine where a mail client is set
 * up -- which, for most people reviewing a web app, it is not. Both paths
 * ended with the reporter doing the maintainer's filing work: download the
 * screenshots, find the issue page, drag them in, sign in.
 *
 * So the report is POSTed to a small endpoint that holds a GitHub token and
 * files the issue itself (server/feedback-worker). This module is everything
 * about that request that does not touch the DOM: the limits, the wire
 * format, the one fetch, and the classification of what went wrong. It is
 * pure, so it is tested in Node without a browser.
 */

// Per attachment, and for the whole report. The worker enforces the same two
// numbers, because a limit checked only in the page is not a limit.
// Screenshots are tens to hundreds of kilobytes once shrunk below, so this is
// generous for the case it exists to serve.
export const FEEDBACK_MAX_ATTACHMENT_BYTES = 4 * 1024 * 1024;
export const FEEDBACK_MAX_TOTAL_BYTES = 8 * 1024 * 1024;
export const FEEDBACK_MAX_ATTACHMENTS = 10;

// Long enough for a slow phone on mobile data, short enough that a dead
// endpoint says so instead of spinning forever.
export const FEEDBACK_SEND_TIMEOUT_MS = 60_000;

// A screenshot above this is re-encoded before it is sent. Below it, the file
// goes as it is: re-encoding a small PNG only makes it blurrier.
export const FEEDBACK_SHRINK_ABOVE_BYTES = 600 * 1024;
export const FEEDBACK_SHRINK_MAX_EDGE = 2000;
export const FEEDBACK_SHRINK_QUALITY = 0.85;

// What may be committed to the repository the issue lives in. The worker keeps
// the same list; this copy exists so the form can refuse a file before
// spending an upload on it. Screenshots are the point, and the rest are the
// formats a report about this app would carry.
export const FEEDBACK_ALLOWED_EXTENSIONS = [
    'png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp',
    'txt', 'log', 'md', 'json', 'csv', 'tsv', 'yml', 'yaml',
    'zip', 'mat', 'parquet', 'nc', 'nc4', 'cdf', 'pkl', 'pickle',
    'xlsx', 'xls', 'ods', 'mo', 'pdf',
];

/**
 * Why a send failed, in the one word the form needs to pick a message.
 *
 * `kind` is what the user is told; `detail` is what the console carries. A
 * thrown TypeError from fetch means the request never left the machine
 * (offline, DNS, CORS, an extension): the browser deliberately does not say
 * which, so neither do we.
 */
export class FeedbackSendError extends Error {
    constructor(kind, { detail = '', status = 0, code = '' } = {}) {
        super(detail || kind);
        this.name = 'FeedbackSendError';
        this.kind = kind;
        this.detail = detail;
        this.status = status;
        // What the endpoint called the refusal, when it had a word for it
        // ('rate-limited', 'too-large', …). The form shows the refusal in the
        // reporter's language from this, and falls back to `detail` -- the
        // endpoint's English -- for a code it does not know.
        this.code = code;
    }
}

export function bytesToBase64(bytes) {
    const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    // One String.fromCharCode call per chunk: the spread form blows the
    // argument limit somewhere above a hundred thousand bytes, and a
    // four-megabyte attachment is well past that.
    const CHUNK = 0x8000;
    let binary = '';
    for (let offset = 0; offset < view.length; offset += CHUNK) {
        binary += String.fromCharCode(...view.subarray(offset, offset + CHUNK));
    }
    return btoa(binary);
}

export function feedbackFileExtension(name) {
    const match = /\.([A-Za-z0-9]{1,8})$/.exec(String(name || ''));
    return match ? match[1].toLowerCase() : '';
}

/**
 * Whether this set of attachments can be sent, and if not, which limit stopped
 * it. Returned rather than thrown: the form shows it beside the file list
 * while the user is still choosing, not as an error at the end.
 */
export function checkFeedbackAttachments(attachments) {
    const files = (attachments || []).map(entry => entry?.file ?? entry).filter(Boolean);
    const total = files.reduce((sum, file) => sum + (file.size || 0), 0);
    if (files.length > FEEDBACK_MAX_ATTACHMENTS) {
        return { ok: false, reason: 'count', limit: FEEDBACK_MAX_ATTACHMENTS, total };
    }
    const tooBig = files.find(file => (file.size || 0) > FEEDBACK_MAX_ATTACHMENT_BYTES);
    if (tooBig) {
        return { ok: false, reason: 'file', limit: FEEDBACK_MAX_ATTACHMENT_BYTES, name: tooBig.name, total };
    }
    if (total > FEEDBACK_MAX_TOTAL_BYTES) {
        return { ok: false, reason: 'total', limit: FEEDBACK_MAX_TOTAL_BYTES, total };
    }
    const rejected = files.find(file => !FEEDBACK_ALLOWED_EXTENSIONS.includes(feedbackFileExtension(file.name)));
    if (rejected) {
        return { ok: false, reason: 'type', name: rejected.name, total };
    }
    return { ok: true, total };
}

/**
 * A screenshot, smaller.
 *
 * A full-screen PNG is often one to two megabytes; the same picture as a JPEG
 * two thousand pixels wide is a couple of hundred kilobytes and just as
 * readable for "look what this dialog did". That matters twice over: the
 * upload is quicker on a bad connection, and the endpoint -- which gets 10 ms
 * of CPU per request on Cloudflare's free plan -- has far less to move.
 *
 * Returns the original file whenever shrinking it is not possible or not
 * worth it, so the caller never has to care whether it worked.
 */
export async function shrinkScreenshot(file, {
    maxBytes = FEEDBACK_SHRINK_ABOVE_BYTES,
    maxEdge = FEEDBACK_SHRINK_MAX_EDGE,
    quality = FEEDBACK_SHRINK_QUALITY,
    createBitmap = typeof createImageBitmap === 'function' ? createImageBitmap : null,
    CanvasCtor = typeof OffscreenCanvas === 'function' ? OffscreenCanvas : null,
    FileCtor = typeof File === 'function' ? File : null,
} = {}) {
    const type = String(file?.type || '');
    // GIF may be animated and re-encoding would freeze it; SVG has no pixels
    // to resample. Neither is what a screenshot arrives as.
    const shrinkable = type === 'image/png' || type === 'image/jpeg' || type === 'image/webp' || type === 'image/bmp';
    if (!shrinkable || !file || file.size <= maxBytes) return file;
    if (!createBitmap || !CanvasCtor || !FileCtor) return file;

    let bitmap = null;
    try {
        bitmap = await createBitmap(file);
        const scale = Math.min(1, maxEdge / Math.max(bitmap.width, bitmap.height));
        const width = Math.max(1, Math.round(bitmap.width * scale));
        const height = Math.max(1, Math.round(bitmap.height * scale));
        const canvas = new CanvasCtor(width, height);
        const context = canvas.getContext('2d');
        if (!context) return file;
        context.drawImage(bitmap, 0, 0, width, height);
        const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality });
        // A screenshot of flat UI can compress worse as JPEG than as PNG.
        // Keep whichever is actually smaller.
        if (!blob || blob.size >= file.size) return file;
        const name = `${String(file.name || 'screenshot').replace(/\.[A-Za-z0-9]{1,8}$/, '')}.jpg`;
        return new FileCtor([blob], name, { type: 'image/jpeg', lastModified: file.lastModified || Date.now() });
    } catch {
        // Any failure here is cosmetic: send the original.
        return file;
    } finally {
        bitmap?.close?.();
    }
}

/**
 * The handover from Full Desktop to the browser.
 *
 * The desktop edition transmits nothing: every external request the renderer
 * makes is cancelled on purpose (electron/navigation-policy.cjs). Rather than
 * cut a hole in that for one feature, Feedback there opens this URL in the
 * user's own browser, which has no such promise to keep. The desktop build's
 * version, commit and platform ride along in the query, because the report is
 * about THAT build, not about the web page now showing the form.
 */
export function buildFeedbackHandoffUrl(baseUrl, { version = '', commit = '', platform = '' } = {}) {
    const url = new URL(baseUrl);
    url.searchParams.set('feedback', '1');
    url.searchParams.set('from', 'desktop');
    if (version) url.searchParams.set('v', version);
    if (commit) url.searchParams.set('c', commit);
    if (platform) url.searchParams.set('p', platform);
    return url.toString();
}

/**
 * The other end of that handover, read from `location.search`.
 *
 * Everything here arrived in a URL, so it is treated as what it is: a
 * stranger's text. Each field is clipped to a short, harmless shape before it
 * can reach a report, and `reportedFrom` is the one sentence the issue shows.
 */
export function readFeedbackHandoff(search) {
    let params;
    try {
        params = new URLSearchParams(String(search || ''));
    } catch {
        return { requested: false, reportedFrom: '' };
    }
    if (!params.has('feedback')) return { requested: false, reportedFrom: '' };
    const clean = (key, max) => String(params.get(key) || '').replace(/[^A-Za-z0-9._ -]/g, '').slice(0, max);
    const desktop = params.get('from') === 'desktop';
    const version = clean('v', 20);
    const commit = clean('c', 12);
    const platform = clean('p', 20);
    if (!desktop) return { requested: true, reportedFrom: '' };
    const parts = [version && `Full Desktop ${version}`, platform, commit && `commit ${commit}`].filter(Boolean);
    return { requested: true, reportedFrom: parts.length ? parts.join(' · ') : 'Full Desktop' };
}

/**
 * The report, as the endpoint receives it: the metadata, and each attachment
 * already base64-encoded.
 */
export async function buildFeedbackReport(feedback, attachments = []) {
    const encoded = [];
    for (const entry of attachments) {
        const file = entry?.file ?? entry;
        if (!file) continue;
        const buffer = await file.arrayBuffer();
        encoded.push({
            name: file.name,
            type: file.type || 'application/octet-stream',
            size: buffer.byteLength,
            data: bytesToBase64(new Uint8Array(buffer)),
        });
    }
    return {
        // Bumped only if the endpoint has to tell old clients from new ones;
        // the worker rejects a version it does not know.
        schema: 1,
        category: feedback.category,
        summary: feedback.summary,
        details: feedback.details,
        expected: feedback.expected,
        contact: feedback.contact,
        app: {
            version: feedback.appVersion,
            commit: feedback.buildSha,
            buildDate: feedback.buildDate,
            url: feedback.pageUrl,
            userAgent: feedback.userAgent,
            language: feedback.language || '',
            // Set only when the form was opened from Full Desktop: the build
            // the report is about is not the one running this page.
            reportedFrom: feedback.reportedFrom || '',
            createdAt: feedback.createdAt,
        },
        attachments: encoded,
    };
}

/**
 * The report on the wire: one metadata line of JSON, then one line of base64
 * per attachment, in the order the metadata lists them.
 *
 * Why not one JSON document with the files inside it? Because the endpoint
 * runs on Cloudflare's free plan, which allows 10 ms of CPU per request, and
 * JSON.parse of a multi-megabyte document spends more than that on its own.
 * Line framing lets the worker parse only the small head and hand each
 * attachment to GitHub as an untouched substring. Base64 contains no newline,
 * so the framing is unambiguous.
 */
export function serializeFeedbackReport(report) {
    const head = {
        ...report,
        attachments: (report.attachments || []).map(({ name, type, size }) => ({ name, type, size })),
    };
    const lines = [JSON.stringify(head)];
    for (const attachment of report.attachments || []) {
        const data = String(attachment.data || '');
        if (/[\r\n]/.test(data)) throw new Error('Base64 attachment data must not contain newlines');
        lines.push(data);
    }
    return lines.join('\n');
}

/**
 * One POST. Resolves with what the endpoint filed, or throws a
 * FeedbackSendError the form can turn into a sentence.
 */
export async function sendFeedbackReport({
    endpoint,
    report,
    fetchImpl,
    timeoutMs = FEEDBACK_SEND_TIMEOUT_MS,
} = {}) {
    if (!endpoint) throw new FeedbackSendError('not-configured');
    const doFetch = fetchImpl || (typeof fetch === 'function' ? fetch : null);
    if (!doFetch) throw new FeedbackSendError('not-configured', { detail: 'No fetch implementation' });

    const controller = typeof AbortController === 'function' ? new AbortController() : null;
    const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
    let response;
    try {
        response = await doFetch(endpoint, {
            method: 'POST',
            // text/plain keeps this a "simple" CORS request, so it needs no
            // preflight and reaches the worker even from the desktop build,
            // whose origin is null.
            headers: { 'Content-Type': 'text/plain;charset=UTF-8' },
            body: serializeFeedbackReport(report),
            signal: controller?.signal,
            mode: 'cors',
            credentials: 'omit',
            cache: 'no-store',
        });
    } catch (error) {
        if (error?.name === 'AbortError') throw new FeedbackSendError('timeout');
        throw new FeedbackSendError('offline', { detail: error?.message || String(error) });
    } finally {
        if (timer) clearTimeout(timer);
    }

    const text = await response.text().catch(() => '');
    let payload = null;
    try {
        payload = text ? JSON.parse(text) : null;
    } catch {
        payload = null;
    }

    if (!response.ok) {
        const detail = payload?.error || text.slice(0, 300) || `HTTP ${response.status}`;
        // 4xx is something about this report the user can act on (too large, a
        // field missing, too many reports in an hour). 5xx is not.
        const kind = response.status >= 400 && response.status < 500 ? 'rejected' : 'server';
        throw new FeedbackSendError(kind, {
            detail,
            status: response.status,
            code: typeof payload?.code === 'string' ? payload.code : '',
        });
    }
    if (!payload?.ok) {
        throw new FeedbackSendError('server', {
            detail: payload?.error || 'Endpoint replied without ok:true',
            status: response.status,
        });
    }
    return {
        issueUrl: typeof payload.issueUrl === 'string' ? payload.issueUrl : '',
        issueNumber: Number.isFinite(payload.issueNumber) ? payload.issueNumber : 0,
        reference: typeof payload.reference === 'string' ? payload.reference : '',
    };
}
