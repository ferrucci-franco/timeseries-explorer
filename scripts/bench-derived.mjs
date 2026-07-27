// Point 4 benchmark: derived-variable formulas, tree-walking evaluator vs
// compiled kernel.
//
//   node scripts/bench-derived.mjs
//   node scripts/bench-derived.mjs --tier medium --json bench/results/point4.json
//
// Compile time is charged to the first evaluation and reported separately, so
// the "one-off formula" case is visible next to the "reapplied on every live
// update" case — which is the one that actually repeats.
//
// Same child-process isolation as the other benchmarks: the interpreter
// allocates an array per AST node per evaluation, and leaving that in the heap
// distorts whatever is timed next.

import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { performance } from 'node:perf_hooks';

import { fmtMs, fmtSpeedup, markdownTable, speedup, TIERS } from '../bench/harness.mjs';

// A representative spread: the brief's own example, a pure elementwise chain, a
// neighbour op, and one mixing both.
const FORMULAS = [
    'sqrt(x^2 + y^2)',
    'x * gain + offset',
    '(x + y) * (x - y) / (abs(z) + 1)',
    'diff(x)',
    'diff(x) / diff(time)',
    'sqrt(square(x) + square(y) + square(z))',
];

const childArgIndex = process.argv.indexOf('--child');
if (childArgIndex >= 0) {
    const spec = JSON.parse(process.argv[childArgIndex + 1]);
    process.stdout.write(`__RESULT__${JSON.stringify(await runCase(spec))}\n`);
    process.exit(0);
}

async function runCase({ impl, formula, rows }) {
    const legacy = await import('../bench/legacy-derived.mjs');
    const data = legacy.makeDataset(rows, 20260726);

    let evaluate;
    let compileMs = 0;

    if (impl === 'interpreter') {
        evaluate = () => legacy.refEvaluateDerivedFormula(formula, data);
    } else {
        const { getCompiledFormula, clearFormulaCache } = await import('../src/expr/compile.js');
        const variables = data.variables;
        const classify = (name) => {
            const variable = variables[name];
            return (variable.kind === 'parameter' || variable.data.length === 1) ? 'scalar' : 'series';
        };
        const timeVar = Object.values(variables).find(v => v.kind === 'abscissa');

        // Compile cost, measured cold.
        clearFormulaCache();
        const t0 = performance.now();
        getCompiledFormula(formula, variables, classify);
        compileMs = performance.now() - t0;

        evaluate = () => {
            const compiled = getCompiledFormula(formula, variables, classify);
            const referenced = compiled.names.map(n => variables[n]).filter(v => v && v.kind !== 'parameter');
            const lengths = referenced.map(v => v.data?.length || 0).filter(Boolean);
            const n = lengths.length ? Math.min(timeVar.data.length, ...lengths) : timeVar.data.length;
            const columns = {};
            const scalars = {};
            for (const name of compiled.names) {
                const variable = variables[name];
                if (classify(name) === 'scalar') scalars[name] = Number(variable.data[0]);
                else columns[name] = variable.data;
            }
            return { values: compiled.run(columns, scalars, n) };
        };
    }

    evaluate();   // warm up
    let best = Infinity;
    for (let i = 0; i < 3; i++) {
        const t0 = performance.now();
        evaluate();
        const dt = performance.now() - t0;
        if (dt < best) best = dt;
    }

    const { heapUsed } = process.memoryUsage();
    return { impl, formula, rows, ms: best, compileMs, heapMb: heapUsed / (1024 * 1024) };
}

// ─── Parent ───────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const jsonAt = args.includes('--json') ? args[args.indexOf('--json') + 1] : null;
const tierArgs = args.includes('--tier')
    ? args.slice(args.indexOf('--tier') + 1).filter(a => !a.startsWith('--'))
    : null;
const tiers = (tierArgs?.length ? tierArgs : ['small', 'medium', 'large']).filter(name => name in TIERS);

function child(spec) {
    const stdout = execFileSync(
        process.execPath,
        [
            '--max-old-space-size=8192',
            new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'),
            '--child',
            JSON.stringify(spec),
        ],
        { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 },
    );
    const line = stdout.split('\n').find(l => l.startsWith('__RESULT__'));
    if (!line) throw new Error(`no result from child: ${stdout.slice(0, 400)}`);
    return JSON.parse(line.slice('__RESULT__'.length));
}

const rows = [];
const records = [];

for (const tier of tiers) {
    const n = TIERS[tier];
    console.log(`\n== tier ${tier}: ${n.toLocaleString('en-US')} samples ==`);
    for (const formula of FORMULAS) {
        const interpreter = child({ impl: 'interpreter', formula, rows: n });
        const compiled = child({ impl: 'compiled', formula, rows: n });
        const x = speedup(interpreter.ms, compiled.ms);

        console.log(
            `  ${formula.padEnd(38)} interp ${fmtMs(interpreter.ms).padStart(9)}`
            + `  ->  compiled ${fmtMs(compiled.ms).padStart(9)}   ${fmtSpeedup(x).padStart(6)}`
            + `   (compile ${fmtMs(compiled.compileMs)})`,
        );
        rows.push([
            `\`${formula}\``,
            `${tier} (${n.toLocaleString('en-US')})`,
            fmtMs(interpreter.ms),
            fmtMs(compiled.ms),
            fmtSpeedup(x),
            fmtMs(compiled.compileMs),
        ]);
        records.push({
            tier, rows: n, formula,
            interpreterMs: interpreter.ms,
            compiledMs: compiled.ms,
            compileMs: compiled.compileMs,
            speedup: x,
            interpreterHeapMb: interpreter.heapMb,
            compiledHeapMb: compiled.heapMb,
        });
    }
}

console.log('\n' + markdownTable(
    ['Formula', 'Tier (samples)', 'Interpreter', 'Compiled', 'Speedup', 'Compile'],
    rows,
));

if (jsonAt) {
    mkdirSync(dirname(jsonAt), { recursive: true });
    writeFileSync(jsonAt, JSON.stringify({
        point: 4,
        title: 'Derived variables: AST interpreter vs compiled kernel',
        node: process.version,
        generatedAt: new Date().toISOString(),
        records,
    }, null, 2));
    console.log(`\nwrote ${jsonAt}`);
}
