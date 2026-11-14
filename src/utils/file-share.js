// An exported file goes to the device's share sheet (the Web Share API: a chat,
// mail, Drive…) or is downloaded, as every export was before.
//
// Sharing is offered only where the browser says it can share that kind of
// file (navigator.canShare with a file of the type): Chrome on Android, Safari
// on iOS and macOS, Chrome and Edge on Windows. Elsewhere nothing changes.
//
// The browser opens the share sheet only close to a tap ("transient user
// activation"). Building a large PNG or CSV can take longer than that window,
// above all in Safari, so a share that comes too late is not an error: the
// caller is told to ask for one more tap (see _saveExportBlob in
// export-methods.js), never left with nothing.
//
// No DOM beyond an anchor for the download, and the navigator is passed in, so
// the logic runs in Node in the tests.

const MIME_BY_EXTENSION = {
    csv: 'text/csv',
    png: 'image/png',
    svg: 'image/svg+xml',
};

const extensionOf = (fileName) => String(fileName || '').split('.').pop().toLowerCase();

/** The MIME type a file of this name is shared as ('' when not one of ours). */
export function exportMimeType(fileName) {
    return MIME_BY_EXTENSION[extensionOf(fileName)] || '';
}

/**
 * The blob as a named File, with a plain MIME type: a share target reads the
 * type, and "text/csv;charset=utf-8;" is not one every target recognises.
 */
export function exportFile(blob, fileName) {
    const type = exportMimeType(fileName) || blob?.type || 'application/octet-stream';
    return new File([blob], fileName, { type, lastModified: Date.now() });
}

/** Whether a file with this extension ('csv', 'png', 'svg') can be shared here. */
export function canShareFiles(extension, nav = globalThis.navigator) {
    if (typeof nav?.share !== 'function' || typeof nav?.canShare !== 'function') return false;
    const type = MIME_BY_EXTENSION[extension];
    if (!type || typeof File !== 'function') return false;
    try {
        return !!nav.canShare({ files: [new File([''], `export.${extension}`, { type })] });
    } catch (_) {
        return false;
    }
}

/**
 * Open the share sheet with the file. Resolves to
 *   'shared'        the sheet took it;
 *   'cancelled'     the user closed the sheet: nothing to say;
 *   'needs-gesture' too long after the tap: ask for another tap;
 *   { error }       anything else.
 */
export async function shareFile(file, nav = globalThis.navigator) {
    // Where the browser says the tap has expired, asking would only be refused.
    if (nav?.userActivation && nav.userActivation.isActive === false) return 'needs-gesture';
    try {
        await nav.share({ files: [file], title: file.name });
        return 'shared';
    } catch (error) {
        if (error?.name === 'AbortError') return 'cancelled';
        if (error?.name === 'NotAllowedError') return 'needs-gesture';
        return { error };
    }
}

/** Save the blob through a download, as exports always have. */
export function downloadFile(blob, fileName) {
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = fileName;
    link.rel = 'noopener';
    document.body.appendChild(link);
    link.click();
    link.remove();
    // Revoking straight away can cut a large download short in some browsers.
    setTimeout(() => URL.revokeObjectURL(url), 10000);
}
