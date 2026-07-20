import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

const outputDir = path.resolve(process.env.OMV_DIST_OUTPUT?.trim() || 'desktop-dist');
const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
const productName = pkg.build?.productName || pkg.productName || pkg.name;
const expectedExecutables = [
  `${productName}-${pkg.version}-portable-x64.exe`,
  `${productName}-${pkg.version}-setup-x64.exe`,
].sort((a, b) => a.localeCompare(b));
const entries = await readdir(outputDir, { withFileTypes: true });
const executables = entries
  .filter(entry => entry.isFile() && expectedExecutables.includes(entry.name))
  .map(entry => entry.name)
  .sort((a, b) => a.localeCompare(b));

if (executables.length !== expectedExecutables.length) {
  throw new Error(
    `Expected release executables ${expectedExecutables.join(', ')} in ${outputDir}; found: ${executables.join(', ') || 'none'}`,
  );
}

async function sha256(filePath) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(filePath)) hash.update(chunk);
  return hash.digest('hex');
}

const lines = [];
for (const name of executables) {
  lines.push(`${await sha256(path.join(outputDir, name))}  ${name}`);
}

const checksumPath = path.join(outputDir, 'SHA256SUMS.txt');
await writeFile(checksumPath, `${lines.join('\n')}\n`, 'utf8');
console.log(`Wrote ${checksumPath}`);
for (const line of lines) console.log(line);
