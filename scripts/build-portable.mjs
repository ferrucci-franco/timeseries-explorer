import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';
import { build } from 'esbuild';
import AdmZip from 'adm-zip';
import pkg from '../package.json' with { type: 'json' };

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '..');
const outputRoot = path.join(projectRoot, 'portable-dist');
const downloadsRoot = path.join(projectRoot, 'public', 'downloads');

function getCommitShort() {
  try {
    return execSync('git rev-parse --short HEAD', { cwd: projectRoot, stdio: ['ignore', 'pipe', 'ignore'] })
      .toString()
      .trim();
  } catch {
    return 'unknown';
  }
}

async function removeIfExists(targetPath) {
  await fs.rm(targetPath, { recursive: true, force: true });
}

async function ensureDir(targetPath) {
  await fs.mkdir(targetPath, { recursive: true });
}

async function removeMatchingFiles(dirPath, matcher) {
  let entries = [];
  try {
    entries = await fs.readdir(dirPath, { withFileTypes: true });
  } catch {
    return;
  }

  await Promise.all(entries.map(async (entry) => {
    if (!entry.isFile()) return;
    if (!matcher(entry.name)) return;
    await fs.rm(path.join(dirPath, entry.name), { force: true });
  }));
}

async function copyFileInto(src, dest) {
  await ensureDir(path.dirname(dest));
  await fs.copyFile(src, dest);
}

async function copyDirInto(src, dest) {
  await ensureDir(path.dirname(dest));
  await fs.cp(src, dest, { recursive: true });
}

function portableDuckDbStubPlugin() {
  return {
    name: 'portable-duckdb-stub',
    setup(buildApi) {
      buildApi.onResolve({ filter: /src[\\/]data[\\/]duckdb-source\.js$/ }, () => ({
        path: 'duckdb-source-stub',
        namespace: 'portable-stubs',
      }));
      buildApi.onResolve({ filter: /\.\.[\\/]data[\\/]duckdb-source\.js$/ }, () => ({
        path: 'duckdb-source-stub',
        namespace: 'portable-stubs',
      }));
      buildApi.onLoad({ filter: /^duckdb-source-stub$/, namespace: 'portable-stubs' }, () => ({
        contents: `
          export default class DuckDbSource {
            constructor() {
              throw new Error('DuckDB is not available in the portable file:// build.');
            }
          }
        `,
        loader: 'js',
      }));
    },
  };
}

async function buildPortableBundle(packageDir) {
  await build({
    entryPoints: [path.join(projectRoot, 'app.js')],
    outfile: path.join(packageDir, 'app.bundle.js'),
    bundle: true,
    format: 'iife',
    platform: 'browser',
    target: ['es2019'],
    define: {
      'globalThis.__OMV_PORTABLE__': 'true',
    },
    plugins: [portableDuckDbStubPlugin()],
    sourcemap: false,
    minify: false,
  });
}

async function buildPortableHtml(packageDir) {
  const sourceHtml = await fs.readFile(path.join(projectRoot, 'index.html'), 'utf8');
  const portableHtml = sourceHtml.replace(
    '<script type="module" src="app.js"></script>',
    '<script src="app.bundle.js"></script>'
  );
  await fs.writeFile(path.join(packageDir, 'index.html'), portableHtml, 'utf8');
}

async function copyPortableLauncher(packageDir) {
  const serverDir = path.join(packageDir, 'server');
  const runtimeDir = path.join(packageDir, 'runtime');
  await ensureDir(serverDir);
  await ensureDir(runtimeDir);
  await copyFileInto(path.join(projectRoot, 'scripts', 'portable-server.mjs'), path.join(serverDir, 'portable-server.mjs'));

  const runtimeName = process.platform === 'win32' ? 'node.exe' : 'node';
  await copyFileInto(process.execPath, path.join(runtimeDir, runtimeName));

  const windowsStart = [
    '@echo off',
    'setlocal',
    'cd /d "%~dp0"',
    'runtime\\node.exe server\\portable-server.mjs',
    'pause',
    '',
  ].join('\r\n');
  const unixStart = [
    '#!/bin/sh',
    'DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"',
    'cd "$DIR" || exit 1',
    'chmod +x ./runtime/node 2>/dev/null || true',
    './runtime/node ./server/portable-server.mjs',
    '',
  ].join('\n');

  await fs.writeFile(path.join(packageDir, 'start-windows.bat'), windowsStart, 'utf8');
  await fs.writeFile(path.join(packageDir, 'start-linux.sh'), unixStart, 'utf8');
  await fs.writeFile(path.join(packageDir, 'start-macos.command'), unixStart, 'utf8');
  if (process.platform !== 'win32') {
    await fs.chmod(path.join(packageDir, 'start-linux.sh'), 0o755);
    await fs.chmod(path.join(packageDir, 'start-macos.command'), 0o755);
  }
}

async function writeOfflineReadme(packageDir, folderName) {
  const text = [
    `OpenModelica Viewer portable package`,
    ``,
    `Folder: ${folderName}`,
    `Version: ${pkg.version}`,
    `Commit: ${getCommitShort()}`,
    ``,
    `Use:`,
    `1. Extract the zip.`,
    `2. Basic offline mode: open index.html with a double click.`,
    `3. Live offline mode: run the start script for your platform to open http://localhost in your browser:`,
    `   - Windows: start-windows.bat`,
    `   - Linux: start-linux.sh`,
    `   - macOS: start-macos.command`,
    `4. No internet connection is required after extraction.`,
    ``,
    `Notes:`,
    `- This package is intended for direct file:// opening.`,
    `- The localhost launcher uses the bundled Node runtime from the platform that built this zip; publish one zip per OS for best results.`,
    `- The local server binds to 127.0.0.1 and exposes only this app plus a file-read endpoint used for live update paths selected by the user.`,
    `- Example data is included under public/examples/.`,
  ].join('\n');
  await fs.writeFile(path.join(packageDir, 'README-offline.txt'), text, 'utf8');
}

async function createZip(packageDir, zipPath, folderName) {
  const zip = new AdmZip();
  zip.addLocalFolder(packageDir, folderName);
  zip.writeZip(zipPath);
}

async function publishDownloadArtifacts(zipPath, zipFileName, version, commit) {
  await ensureDir(downloadsRoot);
  await removeMatchingFiles(downloadsRoot, (name) => name.startsWith('openmodelica-viewer-v') && name.endsWith('.zip'));
  await fs.copyFile(zipPath, path.join(downloadsRoot, zipFileName));
  const manifest = {
    version,
    commit,
    fileName: zipFileName,
    zipUrl: `./downloads/${zipFileName}`
  };
  await fs.writeFile(path.join(downloadsRoot, 'standalone.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
}

async function main() {
  const commit = getCommitShort();
  const folderName = `openmodelica-viewer-v${pkg.version}-${commit}`;
  const packageDir = path.join(outputRoot, folderName);
  const zipFileName = `${folderName}.zip`;
  const zipPath = path.join(outputRoot, zipFileName);

  await removeIfExists(packageDir);
  await removeIfExists(zipPath);
  await ensureDir(outputRoot);

  await buildPortableBundle(packageDir);
  await buildPortableHtml(packageDir);
  await copyFileInto(path.join(projectRoot, 'styles.css'), path.join(packageDir, 'styles.css'));
  await copyDirInto(path.join(projectRoot, 'src', 'styles'), path.join(packageDir, 'src', 'styles'));
  await copyDirInto(path.join(projectRoot, 'public', 'examples'), path.join(packageDir, 'public', 'examples'));
  await copyPortableLauncher(packageDir);
  await writeOfflineReadme(packageDir, folderName);
  await createZip(packageDir, zipPath, folderName);
  await publishDownloadArtifacts(zipPath, zipFileName, pkg.version, commit);

  console.log(`Portable folder: ${packageDir}`);
  console.log(`Portable zip: ${zipPath}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
