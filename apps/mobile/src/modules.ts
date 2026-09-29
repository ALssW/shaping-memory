/**
 * apps/mobile/src/modules.ts
 *
 * 五个平级模块。没有嵌套层级、没有路径参数，因此不引入路由库：
 * 一个 state 就是最短的路由实现。将来要做深链接（如推送直达某张照片）
 * 再换成原生导航，届时这里的常量正好是它的 screen 名清单。
 */
export const MODULES = ['gallery', 'albums', 'map', 'tools', 'admin'] as const;

export type Module = (typeof MODULES)[number];