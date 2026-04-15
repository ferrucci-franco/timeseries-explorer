const fs = require('fs');
const vm = require('vm');
const assert = require('assert');

function loadClass(file, className) {
    const sandbox = { console, performance };
    const code = fs.readFileSync(file, 'utf8') + `\nthis.${className} = ${className};`;
    vm.runInNewContext(code, sandbox, { filename: file });
    return sandbox[className];
}

const MatParser = loadClass('mat-parser.js', 'MatParser');
const PlotManager = loadClass('plot-manager.js', 'PlotManager');

async function parseFile(path) {
    const buf = fs.readFileSync(path);
    const parser = new MatParser();
    const t0 = performance.now();
    const data = await parser.parse(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
    const ms = performance.now() - t0;

    assert(data.metadata.numVariables > 0, `${path}: expected variables`);
    assert(data.metadata.numTimesteps > 0, `${path}: expected timesteps`);
    assert(data.variables[data.metadata.timeName], `${path}: expected time variable`);

    return {
        file: path,
        sizeMB: +(buf.length / 1024 / 1024).toFixed(2),
        ms: +ms.toFixed(2),
        variables: data.metadata.numVariables,
        timesteps: data.metadata.numTimesteps,
    };
}

(async () => {
    const results = [];
    for (const file of [
        'ExampleSimplePendulum.mat',
        'python/ControlledDCMotor_res.mat',
        'python/ElasticCollisionV3_res.mat',
        'python/Rectifier_res.mat',
        'python/SimplePendulum_res.mat',
    ]) {
        results.push(await parseFile(file));
    }

    const pm = new PlotManager(null);
    const times = [0, 0.1, 0.2, 0.35, 1.0];
    assert.strictEqual(pm._findTimeIdx(times, -1), 0);
    assert.strictEqual(pm._findTimeIdx(times, 0.19), 2);
    assert.strictEqual(pm._findTimeIdx(times, 0.7), 4);
    assert.strictEqual(pm._findTimeIdx(times, 2), 4);

    console.table(results);
    console.log('Parser and time-index checks passed.');
})().catch(err => {
    console.error(err);
    process.exit(1);
});
