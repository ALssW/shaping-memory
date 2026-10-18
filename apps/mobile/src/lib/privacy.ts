/**
 * apps/mobile/src/lib/privacy.ts
 *
 * 隐私解锁的「广播」通道（移动端版；与 Web 的 apps/web/src/lib/privacy.ts 同义）。
 *
 * 【为什么用订阅表而不是 window 事件】RN 没有浏览器那个全局 window / EventTarget，
 * 但这件事本身只需要「一次通知、多方收到」，一张订阅表就能表达，不必为此引入事件库。
 *
 * 【为什么通知之后各自重取就够】票据由 SDK 保存（见 packages/sdk 的 setPrivacyToken），
 * 重取时请求会自动带上它；后端据此把「已解锁」的原片地址与元数据发下来 ——
 * 前端不需要自己改任何地址，也就没有改错的可能。
 */
import { useEffect, useState } from 'react';

/** 订阅者集合：解锁成功时逐个回调；用 Set 保证重复注册不会收到两次 */
const listeners = new Set<() => void>();

/** 解锁成功后广播一次；监听者据此重新拉取数据 */
export function notifyPrivacyUnlocked(): void {
  // 复制一份再遍历：回调里若又发生订阅 / 退订，也不会打乱本次遍历
  for (const listener of [...listeners]) listener();
}

/** 订阅解锁事件，返回取消订阅的函数（可直接作为 useEffect 的清理函数） */
export function onPrivacyUnlocked(handler: () => void): () => void {
  listeners.add(handler);
  return () => {
    listeners.delete(handler);
  };
}

/**
 * 解锁计数：把它放进数据请求的依赖里，解锁一次就自动重取一次。
 * 用「递增的计数」而不是布尔量，是为了让多次解锁都能各自触发一轮重取。
 */
export function usePrivacyTick(): number {
  const [tick, setTick] = useState(0);
  useEffect(() => onPrivacyUnlocked(() => setTick((n) => n + 1)), []);
  return tick;
}
