import { defineConfig } from 'vite';
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { renderManualPages } from './scripts/manual/render-manual.mjs';

function resolveGitSha() {
  // Prefer the CI-provided commit; fall back to a local git call, then to a
  // placeholder when neither is available (e.g. building from a source tarball).
  const ciSha = process.env.GITHUB_SHA;
  if (ciSha) return ciSha.slice(0, 7);
  try {
    return execSync('git rev-parse --short HEAD').toString().trim();
  } catch {
    return 'unknown';
  }
}

// The date the code was written, not the date it happened to be compiled.
// Those two are shown side by side as one fact -- "#18e881e · 2026-07-28" --
// and taking the date from the wall clock made it a different fact from the
// commit beside it: build a week-old commit today and the line described a
// version that never existed. Falls back the same way the sha does.
function resolveCommitDate() {
  try {
    return execSync('git show -s --format=%cI HEAD').toString().trim();
  } catch {
    return new Date().toISOString();
  }
}

const GIT_SHA = resolveGitSha();
const BUILD_DATE = resolveCommitDate();

// The build publishes its own commit as `version.json`, beside index.html. A
// page that the browser or the CDN kept from an older deploy reads it on start
// and switches to the newer build (src/app/version-check.js, #374). The dev
// server answers with the same file, so a dev page finds itself current. The
// values are the ones `define` bakes into the bundle below, read once, so the
// two can never disagree.
function versionJsonPlugin() {
  const source = () => `${JSON.stringify({ sha: GIT_SHA, date: BUILD_DATE })}\n`;
  return {
    name: 'omv-version-json',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        if (!/\/version\.json(\?|$)/.test(req.url || '')) return next();
        res.setHeader('Content-Type', 'application/json');
        res.setHeader('Cache-Control', 'no-store');
        res.end(source());
      });
    },
    generateBundle() {
      this.emitFile({ type: 'asset', fileName: 'version.json', source: source() });
    },
  };
}

// The user manual: the texts of the in-app Help as static pages, one per
// language, under manual/ (scripts/manual/render-manual.mjs). Written by the
// build and answered by the dev server from the same function, so the manual
// is never a second copy of the Help. Its figures are public/manual/img.
function manualPagesPlugin() {
  const version = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')).version;
  return {
    name: 'omv-manual-pages',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const path = (req.url || '').split('?')[0].replace(/^\//, '').replace(/\/$/, '/index.html');
        if (!path.startsWith('manual/')) return next();
        const page = renderManualPages({ version }).find(candidate => candidate.path === path);
        if (!page) return next();
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.end(page.html);
      });
    },
    generateBundle() {
      for (const page of renderManualPages({ version })) {
        this.emitFile({ type: 'asset', fileName: page.path, source: page.html });
      }
    },
  };
}

export default defineConfig({
  base: './',
  plugins: [versionJsonPlugin(), manualPagesPlugin()],
  define: {
    __GIT_SHA__: JSON.stringify(GIT_SHA),
    __BUILD_DATE__: JSON.stringify(BUILD_DATE),
    // The endpoint the Feedback form sends reports to (server/feedback-worker).
    // A build without it still shows the form; the send then fails with a
    // message saying so, rather than silently going nowhere.
    __FEEDBACK_ENDPOINT__: JSON.stringify(process.env.OMV_FEEDBACK_ENDPOINT || ''),
  },
  // The parse worker loads each format's parser with a dynamic import(), so it
  // is a code-splitting build. Vite's default worker format (iife) cannot do
  // that. ES modules are what the workers are already created with
  // (`new Worker(url, { type: 'module' })`), so this only makes the bundle
  // match the runtime.
  worker: {
    format: 'es'
  },
  server: {
    host: '127.0.0.1',
    port: 8000
  },
  preview: {
    host: '127.0.0.1',
    port: 4173
  }
});
