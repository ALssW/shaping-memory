/**
 * apps/mobile/metro.config.js
 *
 * monorepo 配置（对齐 Expo 官方的 workspace 指南）：
 *   1) watchFolders 指向仓库根，Metro 才能读到 packages/ 下的 TS 源码；
 *   2) nodeModulesPaths 同时列出 app 与根的 node_modules；
 *   3) extraNodeModules 把两个工作区包直接指到源码入口 ——
 *      绕开 package.json 的 exports 字段，Metro 与 tsc 看到的是同一份文件；
 *   4) disableHierarchicalLookup 关掉向上逐级查找，避免解析到不该用的副本。
 *
 * 原生依赖（expo-blur / expo-image / safe-area-context）留在 app 自己的
 * dependencies 里，不要提到根 —— 原生模块必须能被 app 的构建找得到。
 */
const { getDefaultConfig } = require('expo/metro-config');
const path = require('node:path');

const projectRoot = __dirname;
const workspaceRoot = path.resolve(projectRoot, '../..');

const config = getDefaultConfig(projectRoot);

config.watchFolders = [workspaceRoot];
config.resolver.nodeModulesPaths = [
  path.resolve(projectRoot, 'node_modules'),
  path.resolve(workspaceRoot, 'node_modules'),
];
config.resolver.extraNodeModules = {
  '@shaping-memory/core': path.resolve(workspaceRoot, 'packages/core/src/index.ts'),
  '@shaping-memory/design-tokens': path.resolve(workspaceRoot, 'packages/design-tokens/web/tokens.ts'),
  '@shaping-memory/sdk': path.resolve(workspaceRoot, 'packages/sdk/src/index.ts'),
};
config.resolver.disableHierarchicalLookup = true;

module.exports = config;