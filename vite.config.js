import { defineConfig } from 'vite';
import { execSync } from 'node:child_process';

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

export default defineConfig({
  base: './',
  define: {
    __GIT_SHA__: JSON.stringify(resolveGitSha()),
    __BUILD_DATE__: JSON.stringify(resolveCommitDate()),
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
