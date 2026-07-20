import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const builder = require.resolve('electron-builder/cli.js');
// Release publishing is handled explicitly by the GitHub Actions workflow.
// Prevent electron-builder from inferring an implicit publish when the build
// happens on a Git tag.
const args = [...process.argv.slice(2), '--publish', 'never'];
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
