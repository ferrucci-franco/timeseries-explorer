import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
const testScripts = Object.keys(pkg.scripts)
  .filter(name => name.startsWith('test:') && name !== 'test:release')
  .sort((a, b) => a.localeCompare(b));

const npmCli = process.env.npm_execpath;
if (!npmCli) throw new Error('npm_execpath is unavailable; run this suite through npm run test:release');

for (const script of testScripts) {
  console.log(`\n===== ${script} =====`);
  const result = spawnSync(process.execPath, [npmCli, 'run', script], {
    cwd: fileURLToPath(new URL('..', import.meta.url)),
    env: process.env,
    stdio: 'inherit',
    shell: false,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

console.log(`\nAll ${testScripts.length} release tests passed.`);
