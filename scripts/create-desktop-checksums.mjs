import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

const outputDir = path.resolve(process.env.OMV_DIST_OUTPUT?.trim() || 'desktop-dist');
const entries = await readdir(outputDir, { withFileTypes: true });
const executables = entries
  .filter(entry => entry.isFile() && entry.name.toLowerCase().endsWith('.exe'))
  .map(entry => entry.name)
  .sort((a, b) => a.localeCompare(b));

const setup = executables.filter(name => /-setup-x64\.exe$/i.test(name));
const portable = executables.filter(name => /-portable-x64\.exe$/i.test(name));

if (setup.length !== 1 || portable.length !== 1 || executables.length !== 2) {
  throw new Error(
    `Expected exactly one x64 setup and one x64 portable executable in ${outputDir}; found: ${executables.join(', ') || 'none'}`,
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
