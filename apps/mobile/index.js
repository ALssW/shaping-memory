/**
 * apps/mobile/index.js
 *
 * Expo 入口：只做一件事 —— 把 App 注册为根组件。
 * 不用 expo/AppEntry，是因为它按「app 根目录下的 App」约定解析，
 * 在 monorepo 里显式注册更不容易出意外。
 */
import { registerRootComponent } from 'expo';

import { App } from './App';

registerRootComponent(App);