import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const root = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(root, '../..');

export default defineConfig({
  plugins: [react()],
  // 后台挂在前台子路径的下一层：https://<YOUR_DOMAIN>/shaping-memory/admin/
  base: '/shaping-memory/admin/',
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
    // 后台与前台同机并行开发：前台占 5173，后台用 5174
    port: 5174,
    // 允许 dev server 读取 monorepo 内其他包的源码
    fs: { allow: [repo] },
  },
});
