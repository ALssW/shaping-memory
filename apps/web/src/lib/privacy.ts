/**
 * apps/web/src/lib/privacy.ts
 *
 * 隐私解锁的「广播」通道。
 *
 * 【为什么用自定义事件】发起解锁的只有查看器里的那一个输入框，但解锁成功后
 * 需要重取数据的地方有好几处（整份档案、相册详情……），它们分布在不同组件里。
 * 若用 props 把 setState 一路传下去，这些组件就要被迫串成一条链；
 * 换成事件后，「通知」与「重取」互不认识，各自只做自己那件事。
 *
 * 【为什么可以重取就够】票据由 SDK 保存，重取时请求自动带上它；
 * 后端据此把「已解锁」的地址与元数据发下来 —— 前端不需要自己改任何地址。
 */
import { useEffect, useState } from 'react';

export const PRIVACY_UNLOCKED_EVENT = 'privacy:unlocked';

/** 解锁成功后广播一次；监听者据此重新拉取数据 */
export function notifyPrivacyUnlocked(): void {
  window.dispatchEvent(new Event(PRIVACY_UNLOCKED_EVENT));
}

/** 订阅解锁事件，返回取消订阅的函数（可直接作为 useEffect 的清理函数） */
export function onPrivacyUnlocked(handler: () => void): () => void {
  window.addEventListener(PRIVACY_UNLOCKED_EVENT, handler);
  return () => window.removeEventListener(PRIVACY_UNLOCKED_EVENT, handler);
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