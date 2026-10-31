import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';

export default defineConfig({
  root: resolve('src/frontend'),
  build: {
    outDir: resolve('dist/frontend'),
    emptyOutDir: true,
    sourcemap: false,
    minify: true,
  },
  plugins: [react(), {
    name: 'operator-page-navigation',
    configureServer(server) {
      server.middlewares.use((req, _res, next) => {
        const path = req.url?.split('?')[0];
        // /auth also matches auth.ts during Vite extension resolution. Navigation is HTML,
        // while explicit module requests such as /auth.ts must keep their original URL.
        if ((req.method === 'GET' || req.method === 'HEAD') && req.headers.accept?.includes('text/html')
          && path && ['/auth', '/auth/', '/import', '/import/', '/history', '/history/'].includes(path)) req.url = '/index.html';
        next();
      });
    },
  }],
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:3000',
        changeOrigin: true,
      },
      '/webhooks': {
        target: 'http://127.0.0.1:3000',
        changeOrigin: true,
      },
    },
  },
});
