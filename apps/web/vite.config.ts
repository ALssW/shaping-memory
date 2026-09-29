import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const root = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(root, '../..');

export default defineConfig({
  plugins: [react()],
  // 生产环境挂在 https://<YOUR_DOMAIN>/shaping-memory/ 这个子路径下，
  // 打包时所有资源引用都会带上此前缀；本地 dev 默认也吃这一套，保持与线上一致。
  base: '/shaping-memory/',
  // EXIF 处理线程用 `new Worker(new URL(...), { type: 'module' })` 引入，构建时必须保留 ESM 形态
  // （默认的 iife 会让 `import '@shaping-memory/core'` 在 worker 里直接语法报错）
  worker: { format: 'es' },
  resolve: {
    // 显式别名指向源码，避免 Vite 把 workspace 包当第三方依赖预打包（TS 源码无法预打包）
    alias: [
      // 更具体的路径要排前面，否则会被下一条前缀匹配吃掉
      { find: '@shaping-memory/design-tokens/theme.css', replacement: path.join(repo, 'packages/design-tokens/web/theme.css') },
      { find: '@shaping-memory/design-tokens/tokens.css', replacement: path.join(repo, 'packages/design-tokens/web/tokens.css') },
      { find: '@shaping-memory/design-tokens', replacement: path.join(repo, 'packages/design-tokens/web/tokens.ts') },
      { find: '@shaping-memory/core', replacement: path.join(repo, 'packages/core/src/index.ts') },
      { find: '@shaping-memory/sdk', replacement: path.join(repo, 'packages/sdk/src/index.ts') },
    ],
  },
  server: {
    port: 5173,
    // 允许 dev server 读取 monorepo 内其他包的源码
    fs: { allow: [repo] },
  },
});