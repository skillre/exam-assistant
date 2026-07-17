import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// 开发期：前端 5173，API 反代到本机 3000（生产由 Nginx 反代，见 Phase 9）。
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: process.env.API_TARGET ?? 'http://localhost:3000',
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: 'dist',
  },
});
