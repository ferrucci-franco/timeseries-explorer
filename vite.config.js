import { defineConfig } from 'vite';

export default defineConfig({
  base: './',
  server: {
    host: '127.0.0.1',
    port: 8000
  },
  preview: {
    host: '127.0.0.1',
    port: 4173
  }
});
