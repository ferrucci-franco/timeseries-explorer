// Every data tool, and every detrend method, works on a file in memory-saving
// (lazy) mode — and that is checked here rather than handled in the panel.
//
// The panel used to carry four ways of saying "not on a lazy file": an option
// reading "Not available yet for lazy files", a greyed-out entry in the tool
// picker, a greyed-out detrend method with a fall back to "linear", and a
// refusal thrown when the draft was read. None of them could fire any more —
// `LAZY_DATA_TOOLS` holds all eleven tools of the picker and
// `LAZY_DETREND_METHODS` all five methods — so what the user saw was a promise
// the code could not keep, in five languages.
//
// They were removed, and this test is what keeps them unnecessary: add a tool
// or a detrend method without making it work on a lazy file and this fails,
// which is where the decision belongs (CLAUDE.md: "lo nuevo nace funcionando
// en lazy"), rather than in a message nobody ever sees.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (relative) => readFileSync(new URL(`../${relative}`, import.meta.url), 'utf8');

const html = read('index.html');
const dataTools = read('src/app/methods/data-tools-methods.js');
const lazyDataTools = read('src/app/methods/lazy-data-tools-methods.js');
const translations = read('src/i18n/translations.js');

// ── The options a <select> of index.html offers, in order ───────────────────
function selectValues(id) {
    const block = new RegExp(`<select id="${id}"[\\s\\S]*?</select>`).exec(html);
    assert.ok(block, `index.html has a <select id="${id}">`);
    const values = [...block[0].matchAll(/<option value="([^"]*)"/g)].map(match => match[1]).filter(Boolean);
    assert.ok(values.length >= 2, `#${id} offers more than one option (${values.length})`);
    return values;
}

// ── A `new Set([...])` written with string literals, read from the source ───
function setLiterals(source, name) {
    const pattern = new RegExp(`${name} = new Set\\(\\[([\\s\\S]*?)\\]\\)`);
    const block = pattern.exec(source);
    assert.ok(block, `${name} is a Set literal`);
    return new Set([...block[1].matchAll(/'([^']+)'/g)].map(match => match[1]));
}

// ── The eleven data tools ───────────────────────────────────────────────────
{
    const offered = selectValues('data-tool-select');
    const lazy = setLiterals(dataTools, 'const LAZY_DATA_TOOLS');
    for (const tool of offered) {
        assert.ok(lazy.has(tool),
            `the Data Tools picker offers "${tool}", so LAZY_DATA_TOOLS must hold it: a tool that cannot run on a lazy file needs a decision, not a greyed-out option`);
    }
    for (const tool of lazy) {
        assert.ok(offered.includes(tool),
            `LAZY_DATA_TOOLS names "${tool}", which the picker no longer offers: the set is stale`);
    }
    assert.equal(lazy.size, offered.length, 'the set and the picker name the same tools');
    console.log(`lazy tool coverage: the ${offered.length} data tools of the picker all run on a lazy file`);
}

// ── The five detrend methods ────────────────────────────────────────────────
{
    const offered = selectValues('detrend-method');
    const sql = setLiterals(lazyDataTools, 'const LAZY_SQL_DETREND_METHODS');
    const extra = setLiterals(lazyDataTools, 'export const LAZY_DETREND_METHODS');
    const lazy = new Set([...sql, ...extra]);
    for (const method of offered) {
        assert.ok(lazy.has(method),
            `the Detrend panel offers "${method}", so LAZY_DETREND_METHODS must hold it (as SQL, or through the chunked executor)`);
    }
    for (const method of lazy) {
        assert.ok(offered.includes(method),
            `LAZY_DETREND_METHODS names "${method}", which the panel no longer offers: the set is stale`);
    }
    // The moving-average baseline is the one that is not SQL: it runs in the
    // chunked executor. If that ever changes, the comment above the set does.
    assert.ok(!sql.has('movingAverage') && lazy.has('movingAverage'),
        'the moving-average baseline is the method the chunked executor covers');
    console.log(`lazy tool coverage: the ${offered.length} detrend methods of the panel all run on a lazy file`);
}

// ── What was said and is no longer true is not said anywhere ────────────────
{
    const sources = [dataTools, lazyDataTools, translations, html];
    for (const key of ['dataToolLazyUnavailable', 'dataToolLazyToolUnavailable', 'dataToolLazyDetrendMethod', 'correlationLazyPending']) {
        for (const source of sources) {
            assert.ok(!source.includes(key),
                `"${key}" said a lazy file could not do something it does: it was removed, in every language, and nothing may bring it back`);
        }
    }
    // The one that stays: a tool whose source variable exists only over the
    // overview of a lazy file is genuinely refused, and says so.
    assert.ok(translations.includes('dataToolLazyDisabled'),
        'dataToolLazyDisabled is still needed: a variable with no column in the file cannot feed a tool');
    assert.ok(lazyDataTools.includes("i18n.t('dataToolLazyDisabled')"),
        'and it is still what the lazy path throws for such a variable');
    console.log('lazy tool coverage: the four stale refusals are gone; the one that still applies stayed');
}
