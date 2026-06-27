import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const builder = require.resolve('electron-builder/cli.js');
const args = [...process.argv.slice(2)];
const output = process.env.OMV_DIST_OUTPUT?.trim();

if (output) {
  args.push(`--config.directories.output=${output}`);
}

const child = spawn(process.execPath, [builder, ...args], {
  stdio: 'inherit',
  shell: false,
});

child.on('exit', (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 0);
});
