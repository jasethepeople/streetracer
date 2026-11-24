import { defineConfig } from 'vite';

export default defineConfig({
  base: process.env.VITE_BASE_PATH ?? '/',
  server: {
    proxy: {
      '/ws': {
        target: process.env.VITE_SERVER_PROXY ?? 'http://127.0.0.1:3001',
        changeOrigin: true,
        ws: true,
      },
    },
  },
});
