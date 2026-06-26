export function duckDbAppendGrowthLimitError(meta, limits = {}) {
    const maxRows = Number(limits.maxRows);
    const maxBytes = Number(limits.maxBytes);
    const appendRows = Number(meta?.appendRows) || 0;
    const appendBytes = Number(meta?.appendBytes) || 0;
    let message = '';
    let limitKind = '';
    if (Number.isFinite(maxRows) && maxRows > 0 && appendRows > maxRows) {
        message = `Live Update paused: appended DuckDB rows (${appendRows.toLocaleString()}) exceeded the session limit (${maxRows.toLocaleString()}). Reload the file to create a fresh snapshot before continuing.`;
        limitKind = 'rows';
    } else if (Number.isFinite(maxBytes) && maxBytes > 0 && appendBytes > maxBytes) {
        const mb = value => (value / (1024 * 1024)).toFixed(value >= 100 * 1024 * 1024 ? 0 : 1);
        message = `Live Update paused: appended DuckDB data (${mb(appendBytes)} MB) exceeded the session limit (${mb(maxBytes)} MB). Reload the file to create a fresh snapshot before continuing.`;
        limitKind = 'bytes';
    }
    if (!message) return null;
    const err = new Error(message);
    err.code = 'LIVE_UPDATE_APPEND_LIMIT';
    err.limitKind = limitKind;
    err.appendRows = appendRows;
    err.maxRows = maxRows;
    err.appendBytes = appendBytes;
    err.maxBytes = maxBytes;
    return err;
}
