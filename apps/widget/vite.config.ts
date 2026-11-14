import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

/** 위젯 로더 — 한 파일(loader.js, IIFE)로 빌드해 /widget/v1/ 에서 서빙한다 */
export default defineConfig({
  root: import.meta.dirname,
  plugins: [react(), tailwindcss()],
  resolve: { alias: { '@': `${import.meta.dirname}/src` } },
  publicDir: 'demo',
  define: { 'process.env.NODE_ENV': JSON.stringify('production') },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    target: 'es2020',
    sourcemap: true,
    lib: {
      entry: 'src/loader.tsx',
      name: 'TheOneWidgetLoader',
      formats: ['iife'],
      fileName: () => 'loader.js',
    },
  },
});
