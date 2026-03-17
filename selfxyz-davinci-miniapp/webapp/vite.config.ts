import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  base: '/',
  plugins: [react()],
  server: {
    proxy: {
      '/pinata-upload': {
        target: 'https://uploads.pinata.cloud',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/pinata-upload/, '/v3'),
      },
    },
  },
});
