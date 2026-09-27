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

import {
    checkDecodedAudioLimit,
    checkFullLoadLimit,
    eagerOnlyFormatFor,
    EAGER_ONLY_FORMATS,
} from '../src/app/file-size-limits.js';

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

check('audio is deliberately NOT one of them', () => {
    // Audio has no lazy path either, but its file size says almost nothing
    // about its memory cost — 5 MB of MP3 is roughly twenty times the samples
    // of 5 MB of WAV. Checking it here, before the file is read, would wave the
    // expensive case through and stop the cheap one.
    for (const extension of ['.wav', '.mp3', '.m4a', '.flac', '.ogg', '.3gp', '.webm']) {
        assert.equal(eagerOnlyFormatFor(extension), null, `${extension} is measured after decoding, not before`);
    }
});

check('the decoded-audio check warns on memory, not on file size', () => {
    const limit = 400 * MB;
    assert.equal(checkDecodedAudioLimit('memo.m4a', limit, limit), null, 'exactly at the limit loads silently');
    const verdict = checkDecodedAudioLimit('memo.m4a', limit + 1, limit);
    assert.equal(verdict.format, 'audio');
    assert.equal(verdict.sizeBytes, limit + 1);
    assert.equal(verdict.limitBytes, limit);
    // Its own wording: "memo.m4a is 420 MB" would be nonsense printed over a
    // 4 MB file, which is the whole reason this format is measured differently.
    assert.equal(verdict.bodyKey, 'fileOverLimitAudioBody');
    assert.equal(verdict.titleKey, 'fileOverLimitAudioTitle');
    assert.equal(verdict.formatLabelKey, 'fileFormatAudio');
    assert.equal(verdict.settingLabelKey, 'audioFullLoadLimit');
});

check('an unknown decoded size is not evidence of a problem', () => {
    for (const size of [0, -1, NaN, undefined]) {
        assert.equal(checkDecodedAudioLimit('memo.m4a', size, 400 * MB), null, `size ${size}`);
    }
    assert.equal(checkDecodedAudioLimit('memo.m4a', 900 * MB, 0), null, 'no limit configured');
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

// ─── Zero means "never ask", all the way down ────────────────────────────
{
    // Three layers each used to turn a zero back into the default limit: the
    // Settings normalizer clamped it up to a floor, _advancedSettingMb read it
    // as "unset", and the pickle/netCDF readers take `maxFileBytes || DEFAULT`.
    // Any one of them alone reintroduced the warning — or worse, a refusal from
    // inside the reader about a limit the app never mentioned.
    const { installFileMethods, readerFileCeiling } = await import('../src/app/methods/file-methods.js');
    class Harness {
        constructor(settings, desktop = false) {
            this.capabilities = { isDesktop: desktop };
            this.advancedSettings = settings;
        }
    }
    installFileMethods(Harness);

    const hugeSize = 64 * 1024 * MB;
    assert.ok(new Harness({})._checkFullLoadLimit({ name: 'huge.mat', size: hugeSize }, '.mat'),
        'with nothing configured the runtime default still asks');
    assert.ok(new Harness({ matlabFullLoadMb: 1 })._checkFullLoadLimit({ name: 'huge.mat', size: hugeSize }, '.mat'),
        'a positive limit still asks — zero is the only "off"');

    const off = new Harness({
        matlabFullLoadMb: 0, excelFullLoadMb: 0, pickleFullLoadMb: 0, pypsaNetcdfFullLoadMb: 0, audioFullLoadMb: 0,
    });
    for (const format of EAGER_ONLY_FORMATS) {
        const extension = format.extensions[0];
        assert.equal(off._checkFullLoadLimit({ name: `huge${extension}`, size: hugeSize }, extension), null,
            `${format.id} set to 0 never asks`);
    }
    assert.equal(off._audioDecodedLimitBytes(), 0, 'audio set to 0 resolves to no limit');
    assert.equal(checkDecodedAudioLimit('memo.m4a', hugeSize, off._audioDecodedLimitBytes()), null,
        'and no decoded size trips it');

    assert.equal(readerFileCeiling(0, {}), Infinity, 'no limit reaches the reader as no ceiling, never as zero');
    assert.equal(readerFileCeiling(80 * MB, {}), 80 * MB, 'a configured limit reaches the reader as is');
    assert.equal(readerFileCeiling(80 * MB, { allowOversized: true }), Infinity, 'an approved file has no reader ceiling');

    // The Settings ranges let zero through for every size limit: the formats
    // that warn and the two that switch modes. Only the conversion suggestion
    // keeps its floor, because zero means nothing there.
    const viewerApp = readFileSync(new URL('../src/app/viewer-app.js', import.meta.url), 'utf8');
    for (const key of [...EAGER_ONLY_FORMATS.map(format => format.limitKey), 'audioFullLoadMb', 'csvFullLoadMb', 'parquetFullLoadMb']) {
        assert.match(viewerApp, new RegExp(`${key}: \\[0, Infinity\\]`), `${key} may be 0 and has no ceiling`);
    }
    assert.doesNotMatch(viewerApp, /csvCompactHintMb: \[0,/, 'the conversion suggestion keeps its floor');
    // And the dialog takes its bounds from that same table, not from a second copy.
    const uiMethods = readFileSync(new URL('../src/app/methods/ui-methods.js', import.meta.url), 'utf8');
    assert.match(uiMethods, /this\._advancedSettingRanges\(\)/, 'the Settings fields read the shared ranges');
    assert.doesNotMatch(uiMethods, /makeNumberField\('[A-Za-z]+',\s*'[A-Za-z]+',\s*'[A-Za-z]+',\s*\d/, 'no field carries its own min/max');
    console.log('file size limits: zero means never ask');
}

// ─── CSV and Parquet: whole below the limit, and whole while it fits at 0 ─
{
    const { installFileMethods } = await import('../src/app/methods/file-methods.js');
    class Harness {
        constructor(settings) {
            this.capabilities = { isDesktop: false };
            this.advancedSettings = settings;
        }
    }
    installFileMethods(Harness);

    // The default moved from 150 to 300 MB, in both runtimes.
    const unset = new Harness({});
    assert.equal(unset._csvFullLoadLimitBytes(), 300 * MB, 'CSV defaults to 300 MB');
    assert.equal(new Harness({ csvFullLoadMb: 0 })._csvFullLoadLimitBytes(), 0, 'CSV 0 reaches the loader as no limit');
    assert.equal(new Harness({ parquetFullLoadMb: 0 })._parquetFullLoadLimitBytes(), 0, 'Parquet 0 reaches the loader as no limit');
    assert.equal(new Harness({ csvFullLoadMb: 450 })._csvFullLoadLimitBytes(), 450 * MB, 'a configured value is used as is');

    const memoryErrors = [
        new Error('Out of Memory Error: could not allocate block of size 256.0 KiB (95.1 MiB/95.3 MiB used)'),
        new RangeError('Array buffer allocation failed'),
    ];
    const run = async (limitBytes, size, attempt) => {
        const calls = [];
        const data = await unset._loadWholeOrLazy(async lazy => {
            calls.push(lazy);
            return attempt(lazy);
        }, { size, limitBytes });
        return { calls, data };
    };
    const ok = lazy => ({ metadata: {}, lazy });

    let r = await run(300 * MB, 300 * MB, ok);
    assert.deepEqual(r.calls, [true], 'at the limit: memory-saving mode, one attempt');
    r = await run(300 * MB, 300 * MB - 1, ok);
    assert.deepEqual(r.calls, [false], 'one byte under: whole');
    r = await run(0, 50 * 1024 * MB, ok);
    assert.deepEqual(r.calls, [false], 'limit 0: whole, whatever the size');
    assert.equal(r.data.metadata.lazyReason, undefined, 'and nothing to explain');

    for (const error of memoryErrors) {
        for (const limit of [0, 300 * MB]) {
            r = await run(limit, 10 * MB, lazy => { if (!lazy) throw error; return ok(lazy); });
            assert.deepEqual(r.calls, [false, true], `"${error.message.slice(0, 30)}" at limit ${limit}: retried in memory-saving mode`);
            assert.equal(r.data.lazy, true);
            assert.equal(r.data.metadata.lazyReason, 'memory', 'marked, so the notice can say why');
        }
    }

    // Anything that is not about size goes up as it came: the legacy reader
    // and the Parquet-reader message both depend on seeing it.
    for (const error of [
        new Error('Invalid Input Error: CSV Error on Line: 12'),
        Object.assign(new Error('The Parquet reader could not be loaded'), { code: 'PARQUET_EXTENSION_UNAVAILABLE' }),
    ]) {
        const calls = [];
        await assert.rejects(unset._loadWholeOrLazy(async lazy => { calls.push(lazy); throw error; }, { size: 1, limitBytes: 0 }),
            err => err === error, `${error.message.slice(0, 30)} is not retried`);
        assert.deepEqual(calls, [false]);
    }

    // A memory-saving attempt that fails too is not retried again.
    const lazyFailure = new Error('Out of Memory Error: even the overview');
    await assert.rejects(unset._loadWholeOrLazy(async () => { throw lazyFailure; }, { size: 10, limitBytes: 1 }),
        err => err === lazyFailure, 'already in memory-saving mode: the failure stands');

    // Both loaders go through it.
    const fileMethods = readFileSync(new URL('../src/app/methods/file-methods.js', import.meta.url), 'utf8');
    const csvPath = fileMethods.slice(fileMethods.indexOf('proto._parseCsvResultBuffer ='), fileMethods.indexOf('proto._largeCsvDuckDbError'));
    const parquetPath = fileMethods.slice(fileMethods.indexOf('proto._parseParquetResult ='), fileMethods.indexOf('proto._parseCsvResultBuffer ='));
    assert.match(csvPath, /_loadWholeOrLazy\([\s\S]*parseCsvFile[\s\S]*_csvFullLoadLimitBytes\(\)/, 'CSV loads through it');
    assert.match(parquetPath, /_loadWholeOrLazy\([\s\S]*parseParquetFile[\s\S]*_parquetFullLoadLimitBytes\(\)/, 'Parquet loads through it');
    assert.doesNotMatch(fileMethods, /size \?\? 0\) >= this\._(csv|parquet)FullLoadLimitBytes\(\)/, 'no loader compares against the limit by itself');
    console.log('file size limits: CSV and Parquet load whole while they fit');
}

// ─── Stored settings from before the new CSV default ─────────────────────
{
    const { ADVANCED_SETTINGS_VERSION, migrateAdvancedSettings } = await import('../src/app/advanced-settings-migration.js');
    assert.equal(ADVANCED_SETTINGS_VERSION, 2);
    assert.deepEqual(migrateAdvancedSettings({ csvFullLoadMb: 150, excelFullLoadMb: 50 }), { excelFullLoadMb: 50 },
        'an unversioned 150 is the old default: dropped, so 300 applies');
    assert.deepEqual(migrateAdvancedSettings({ csvFullLoadMb: 150, settingsVersion: 1 }), {}, 'version 1 too');
    assert.deepEqual(migrateAdvancedSettings({ csvFullLoadMb: 150, settingsVersion: 2 }), { csvFullLoadMb: 150 },
        'a 150 saved under version 2 is a choice');
    assert.deepEqual(migrateAdvancedSettings({ csvFullLoadMb: 400 }), { csvFullLoadMb: 400 }, 'any other value is a choice');
    assert.deepEqual(migrateAdvancedSettings({ csvFullLoadMb: 0 }), { csvFullLoadMb: 0 }, 'and so is 0');
    for (const nothing of [null, undefined, 'x', 42, []]) {
        assert.deepEqual(migrateAdvancedSettings(nothing), {}, `${JSON.stringify(nothing)} is nothing stored`);
    }
    assert.ok(!('settingsVersion' in migrateAdvancedSettings({ settingsVersion: 2 })), 'the version never reaches the settings');

    const viewerApp = readFileSync(new URL('../src/app/viewer-app.js', import.meta.url), 'utf8');
    assert.match(viewerApp, /migrateAdvancedSettings\(saved\)/, 'loading goes through the migration');
    assert.match(viewerApp, /settingsVersion: ADVANCED_SETTINGS_VERSION/, 'saving records the version');
    console.log('file size limits: an old stored default gives way to the new one');
}
