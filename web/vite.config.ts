import { defineConfig } from 'vite';

// base: './' 让产物用相对路径引用资源，
// 因此同一份 dist 可部署到 GitHub Pages 的任意子路径（/repo/ 或 /）
export default defineConfig({
  base: './',
  build: {
    outDir: 'dist',
    target: 'es2020',
    assetsInlineLimit: 8192,
  },
});
