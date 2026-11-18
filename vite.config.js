import { defineConfig, loadEnv } from 'vite';

const apiProxy = { '/api': 'http://127.0.0.1:3001' };

export default defineConfig(({ mode }) => {
  const { BCH_NETWORK = '' } = loadEnv(mode, process.cwd(), '');
  return {
    define: { 'import.meta.env.BCH_NETWORK': JSON.stringify(BCH_NETWORK) },
    server: { proxy: apiProxy },
    preview: { proxy: apiProxy },
  };
});
