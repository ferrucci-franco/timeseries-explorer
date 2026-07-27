// Which formats must be loaded whole, and what the size limit for each means.
//
// The app has two kinds of "full load limit" that look identical in Settings —
// same number field, same "MB" unit — but mean opposite things:
//
//   * CSV / Parquet: crossing the limit switches the file to the memory-saving
//     (lazy) path. The file still opens. Handled elsewhere, not here.
//   * MAT / Excel / pickle / netCDF: there is no lazy path. Crossing the limit
//     used to REFUSE the file outright. It now produces a warning the user can
//     override, which is what this module describes.
//
// Kept free of DOM and i18n so it can be unit-tested directly: it returns a
// verdict plus the keys the UI needs, never a rendered message.

export const EAGER_ONLY_FORMATS = [
    {
        id: 'mat',
        extensions: ['.mat'],
        limitKey: 'matlabFullLoadMb',
        settingLabelKey: 'matlabFullLoadLimit',
        formatLabelKey: 'fileFormatMatlab',
        sampleName: 'data.mat',
    },
    {
        id: 'excel',
        extensions: ['.xlsx', '.xlsm', '.xls', '.ods'],
        limitKey: 'excelFullLoadMb',
        settingLabelKey: 'excelFullLoadLimit',
        formatLabelKey: 'fileFormatSpreadsheet',
        sampleName: 'data.xlsx',
    },
    {
        id: 'pickle',
        extensions: ['.pkl', '.pickle'],
        limitKey: 'pickleFullLoadMb',
        settingLabelKey: 'pickleFullLoadLimit',
        formatLabelKey: 'fileFormatPickle',
        sampleName: 'data.pkl',
    },
    {
        id: 'netcdf',
        extensions: ['.nc', '.netcdf'],
        limitKey: 'pypsaNetcdfFullLoadMb',
        settingLabelKey: 'pypsaNetcdfFullLoadLimit',
        formatLabelKey: 'fileFormatNetcdf',
        sampleName: 'network.nc',
    },
];

const BY_EXTENSION = new Map();
for (const format of EAGER_ONLY_FORMATS) {
    for (const extension of format.extensions) BY_EXTENSION.set(extension, format);
}

/** The eager-only format an extension belongs to, or null for everything else. */
export function eagerOnlyFormatFor(extension) {
    return BY_EXTENSION.get(String(extension || '').toLowerCase()) || null;
}

/**
 * Does this file exceed the configured full-load limit for its format?
 *
 * @param {{ name?: string, size?: number }} file
 * @param {string} extension
 * @param {(limitKey: string) => number} limitBytesFor resolves the current
 *   limit, so the caller keeps ownership of Settings and desktop/web defaults.
 * @returns {null | { format, sizeBytes, limitBytes, settingLabelKey, formatLabelKey, name }}
 *   null when the file is within the limit, when the format has a lazy path, or
 *   when the size is unknown — an unknown size is not evidence of a problem, and
 *   warning about it would train the user to dismiss the dialog.
 */
export function checkFullLoadLimit(file, extension, limitBytesFor) {
    const format = eagerOnlyFormatFor(extension);
    if (!format) return null;

    const sizeBytes = Number(file?.size);
    if (!Number.isFinite(sizeBytes) || sizeBytes <= 0) return null;

    const limitBytes = Number(limitBytesFor(format.limitKey));
    if (!Number.isFinite(limitBytes) || limitBytes <= 0) return null;
    if (sizeBytes <= limitBytes) return null;

    return {
        format: format.id,
        name: file?.name || format.sampleName,
        sizeBytes,
        limitBytes,
        settingLabelKey: format.settingLabelKey,
        formatLabelKey: format.formatLabelKey,
    };
}
