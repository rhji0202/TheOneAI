import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

/** 콘솔 SPA — /console/ 에서 서빙 (API 서버가 dist 를 제공, 클라이언트 라우팅은 index.html 로) */
export default defineConfig({
  root: import.meta.dirname,
  base: '/console/',
  plugins: [react(), tailwindcss()],
  resolve: { alias: { '@': `${import.meta.dirname}/src` } },
  build: { outDir: 'dist', emptyOutDir: true, target: 'es2022', sourcemap: true },
  server: {
    port: 5174,
    proxy: { '/v1': process.env.CONSOLE_API ?? 'http://localhost:3000' },
  },
});
