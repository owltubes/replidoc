import { defineConfig } from 'vite';

export default defineConfig({
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://localhost:3001',
      '/projects': 'http://localhost:3001',
    },
  },
  optimizeDeps: {
    include: ['pdfjs-dist'],
  },
});
