/**
 * apps/web/src/main.tsx
 *
 * 入口：先加载 token 与主题基线，再挂载 React。
 * 顺序很重要 —— theme.css 已 @import tokens.css，两者必须早于 app.css 生效，
 * 否则 app.css 里的 var() 在首帧解析不到值，会出现一次「无样式闪烁」。
 */
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { bootstrapTheme, configureApiBase } from '@shaping-memory/sdk';

import '@shaping-memory/design-tokens/theme.css';
import './styles/app.css';

import { App } from './App';

// 构建期注入的 API 地址（VITE_API_BASE）：部署到域名后必须指向后台 API 域名，
// 否则页面会去请求浏览器本机。未注入时保持 sdk 的本地开发默认值。
const apiBase = import.meta.env.VITE_API_BASE;
if (apiBase) configureApiBase(apiBase);

const container = document.getElementById('root');
if (!container) throw new Error('#root 未找到，检查 index.html');

/* 【为什么先 await 再 render】主题（颜色 / 字号倍率）决定首屏的样子。
   先渲染再套用会让用户看到样式「跳一下」；接口挂了也不会卡住 ——
   bootstrapTheme 内部有 1.5s 超时与缓存保底，最差也能拿到出厂配置。 */
void bootstrapTheme().then(() => {
  createRoot(container).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
});