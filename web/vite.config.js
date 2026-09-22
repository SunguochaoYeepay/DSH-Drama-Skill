import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

/**
 * 看板前端构建配置。
 *
 * 生产：`npm run web:build` → web/dist，由 web/server.mjs 托管（同源，无需代理）。
 * 开发：`npm run web:dev` → vite 5173，把 /api 与 /media 反代到看板服务 8787，
 *       这样改前端不用重启后端。
 */
const API = process.env.AIH_API || 'http://127.0.0.1:8787';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
  server: {
    port: 5173,
    proxy: {
      '/api': API,
      '/media': API,
    },
  },
});
