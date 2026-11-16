import { defineConfig } from 'vite';

const apiProxy = { '/api': 'http://127.0.0.1:3001' };

export default defineConfig({
  envPrefix: ['VITE_', 'BCH_'],
  server: { proxy: apiProxy },
  preview: { proxy: apiProxy },
});
