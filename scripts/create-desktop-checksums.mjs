import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

const outputDir = path.resolve(process.env.OMV_DIST_OUTPUT?.trim() || 'desktop-dist');
const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
const productName = pkg.build?.productName || pkg.productName || pkg.name;
const platform = process.env.OMV_RELEASE_PLATFORM?.trim() || {
  win32: 'windows',
  darwin: 'macos',
  linux: 'linux',
}[process.platform] || 'windows';
const architecture = process.env.OMV_RELEASE_ARCH?.trim() || process.arch;
const expectedArtifacts = {
  windows: [
    `${productName}-${pkg.version}-portable-${architecture}.exe`,
    `${productName}-${pkg.version}-setup-${architecture}.exe`,
  ],
  macos: [
    `${productName}-${pkg.version}-mac-${architecture}.dmg`,
    `${productName}-${pkg.version}-mac-${architecture}.zip`,
  ],
  linux: [
    `${productName}-${pkg.version}-linux-amd64.deb`,
    `${productName}-${pkg.version}-linux-x86_64.AppImage`,
  ],
}[platform];

if (!expectedArtifacts) throw new Error(`Unsupported release platform: ${platform}`);

const expectedArtifactNames = expectedArtifacts.sort((a, b) => a.localeCompare(b));
const entries = await readdir(outputDir, { withFileTypes: true });
const artifacts = entries
  .filter(entry => entry.isFile() && expectedArtifactNames.includes(entry.name))
  .map(entry => entry.name)
  .sort((a, b) => a.localeCompare(b));

if (artifacts.length !== expectedArtifactNames.length) {
  throw new Error(
    `Expected release artifacts ${expectedArtifactNames.join(', ')} in ${outputDir}; found: ${artifacts.join(', ') || 'none'}`,
  );
}

async function sha256(filePath) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(filePath)) hash.update(chunk);
  return hash.digest('hex');
}

const lines = [];
for (const name of artifacts) {
  lines.push(`${await sha256(path.join(outputDir, name))}  ${name}`);
}

const checksumName = process.env.OMV_CHECKSUMS_FILE?.trim() || 'SHA256SUMS.txt';
const checksumPath = path.join(outputDir, checksumName);
await writeFile(checksumPath, `${lines.join('\n')}\n`, 'utf8');
console.log(`Wrote ${checksumPath}`);
for (const line of lines) console.log(line);
