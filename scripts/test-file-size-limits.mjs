// The full-load size check: which formats it covers, where the boundary is,
// and what it refuses to guess about.
//
//   node scripts/test-file-size-limits.mjs
//
// This is the logic behind the warning that replaced the old hard refusal, so
// the boundary condition matters: a file exactly at the limit must load
// silently, and one byte over must ask.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { checkFullLoadLimit, eagerOnlyFormatFor, EAGER_ONLY_FORMATS } from '../src/app/file-size-limits.js';

const MB = 1024 * 1024;
const LIMITS = {
    matlabFullLoadMb: 250 * MB,
    excelFullLoadMb: 50 * MB,
    pickleFullLoadMb: 80 * MB,
    pypsaNetcdfFullLoadMb: 250 * MB,
};
const limitFor = key => LIMITS[key] ?? 0;

let checks = 0;
const check = (label, fn) => { fn(); checks++; };

// ─── Coverage ─────────────────────────────────────────────────────────────

check('eager-only formats are the four without a lazy path', () => {
    assert.deepEqual(
        EAGER_ONLY_FORMATS.map(f => f.id).sort(),
        ['excel', 'mat', 'netcdf', 'pickle'],
    );
});

check('formats with a memory-saving path are not covered here', () => {
    // CSV and Parquet switch to the lazy path instead of warning, so a size
    // check on them would produce a dialog for a file that opens fine.
    for (const extension of ['.csv', '.parquet', '.txt', '.tsv', '']) {
        assert.equal(eagerOnlyFormatFor(extension), null, `${extension || '(none)'} must not be treated as eager-only`);
        assert.equal(
            checkFullLoadLimit({ name: `huge${extension}`, size: 4096 * MB }, extension, limitFor),
            null,
            `${extension || '(none)'} never warns about size`,
        );
    }
});

check('every eager-only extension resolves to its format', () => {
    const cases = {
        '.mat': 'mat',
        '.xlsx': 'excel', '.xlsm': 'excel', '.xls': 'excel', '.ods': 'excel',
        '.pkl': 'pickle', '.pickle': 'pickle',
        '.nc': 'netcdf', '.netcdf': 'netcdf',
    };
    for (const [extension, id] of Object.entries(cases)) {
        assert.equal(eagerOnlyFormatFor(extension)?.id, id, extension);
    }
});

check('extension matching is case-insensitive', () => {
    assert.equal(eagerOnlyFormatFor('.MAT')?.id, 'mat');
    assert.equal(eagerOnlyFormatFor('.XLSX')?.id, 'excel');
});

// ─── Boundary ─────────────────────────────────────────────────────────────

check('exactly at the limit loads without asking', () => {
    for (const format of EAGER_ONLY_FORMATS) {
        const extension = format.extensions[0];
        const limit = LIMITS[format.limitKey];
        assert.equal(
            checkFullLoadLimit({ name: `at-limit${extension}`, size: limit }, extension, limitFor),
            null,
            `${format.id} at exactly ${limit} bytes`,
        );
    }
});

check('one byte over the limit asks', () => {
    for (const format of EAGER_ONLY_FORMATS) {
        const extension = format.extensions[0];
        const limit = LIMITS[format.limitKey];
        const verdict = checkFullLoadLimit({ name: `over${extension}`, size: limit + 1 }, extension, limitFor);
        assert.ok(verdict, `${format.id} at ${limit + 1} bytes`);
        assert.equal(verdict.format, format.id);
        assert.equal(verdict.limitBytes, limit);
        assert.equal(verdict.sizeBytes, limit + 1);
        assert.equal(verdict.settingLabelKey, format.settingLabelKey);
        assert.equal(verdict.formatLabelKey, format.formatLabelKey);
    }
});

// ─── What it declines to guess ────────────────────────────────────────────

check('an unknown size is not treated as a problem', () => {
    // Some sources report no size. Warning on that would train people to
    // dismiss the dialog, which is the one outcome that makes it useless.
    for (const size of [undefined, null, 0, NaN, -1, 'lots']) {
        assert.equal(
            checkFullLoadLimit({ name: 'mystery.mat', size }, '.mat', limitFor),
            null,
            `size ${String(size)}`,
        );
    }
});

check('a missing or nonsensical limit disables the check', () => {
    for (const limit of [0, -1, NaN, undefined]) {
        assert.equal(
            checkFullLoadLimit({ name: 'big.mat', size: 4096 * MB }, '.mat', () => limit),
            null,
            `limit ${String(limit)}`,
        );
    }
});

check('the reported name falls back to a per-format sample', () => {
    const verdict = checkFullLoadLimit({ size: 999 * MB }, '.pkl', limitFor);
    assert.equal(verdict.name, 'data.pkl');
});

// ─── The setting keys must be real ────────────────────────────────────────

check('every limit key is a real advanced setting', async () => {
    // A typo here would silently resolve to 0 and disable the warning, which
    // is exactly the failure this whole module exists to prevent.
    const source = await import('node:fs').then(fs =>
        fs.readFileSync(new URL('../src/app/viewer-app.js', import.meta.url), 'utf8'));
    for (const format of EAGER_ONLY_FORMATS) {
        assert.match(source, new RegExp(`\\b${format.limitKey}\\s*:`), `${format.limitKey} exists in _defaultAdvancedSettings`);
    }
});

console.log(`file size limits: ${checks} checks passed`);

// ─── A decision lasts one load, not the session ───────────────────────────
{
    // Both memos exist so one file is not asked about twice inside a single
    // load: the over-limit question is put from two places, and the conversion
    // offer would otherwise come back mid-batch. Neither is a preference.
    // Kept for the session they became one — open a file whole, change your
    // mind, and the app would not ask again, so there was no way back to
    // memory-saving mode short of reloading the page.
    const fileMethods = readFileSync(new URL('../src/app/methods/file-methods.js', import.meta.url), 'utf8');
    const load = fileMethods.slice(fileMethods.indexOf('proto.loadFiles ='), fileMethods.indexOf('proto._expandExcelEntries'));
    assert.match(load, /_oversizedApproved\?\.clear\(\)/, 'the over-limit answer is forgotten when the load ends');
    assert.match(load, /_largeCsvRawApproved\?\.clear\(\)/, 'and so is declining the conversion');
    const finallyBlock = load.slice(load.lastIndexOf('} finally {'));
    assert.match(finallyBlock, /clear\(\)/, 'cleared however the load ends, including a failure');
    console.log('file size limits: decisions do not outlive their load');
}
