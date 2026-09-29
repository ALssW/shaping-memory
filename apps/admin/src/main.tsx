/**
 * apps/admin/src/main.tsx
 *
 * 入口：先加载 token 与主题基线，再挂载 React。
 * 顺序很重要 —— theme.css 已 @import tokens.css，两者必须早于 admin.css 生效，
 * 否则 admin.css 里的 var() 在首帧解析不到值，会出现一次「无样式闪烁」。
 */
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { bootstrapTheme, configureApiBase } from '@shaping-memory/sdk';
import dayjs from 'dayjs';
import 'dayjs/locale/zh-cn';

import '@shaping-memory/design-tokens/theme.css';
import 'leaflet/dist/leaflet.css';
import './styles/admin.css';

import { App } from './App';

// 构建期注入的 API 地址（VITE_API_BASE）：后台部署后经后台 API 域名调用，
// 未注入时保持 sdk 的本地开发默认值。
const apiBase = import.meta.env.VITE_API_BASE;
if (apiBase) configureApiBase(apiBase);

// DatePicker / 日期展示统一中文（AntD 的 locale 也依赖 dayjs 的 locale）
dayjs.locale('zh-cn');

const container = document.getElementById('root');
if (!container) throw new Error('未找到 #root，请检查 index.html');

/* 【为什么先 await 再 render】主题（颜色 / 字号倍率）决定首屏的样子。
   先渲染再套用会出现样式跳变；接口不可用也不会阻塞 ——
   bootstrapTheme 内部有 1.5s 超时与缓存回退，最差情况也能获取出厂配置。 */
void bootstrapTheme().then(() => {
  createRoot(container).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
});
