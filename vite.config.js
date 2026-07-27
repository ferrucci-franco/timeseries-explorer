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

export default defineConfig({
  base: './',
  define: {
    __GIT_SHA__: JSON.stringify(resolveGitSha()),
    __BUILD_DATE__: JSON.stringify(new Date().toISOString()),
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
