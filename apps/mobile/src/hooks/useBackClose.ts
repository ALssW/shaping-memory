/**
 * apps/mobile/src/hooks/useBackClose.ts
 *
 * Android 物理返回键 = 关闭当前浮层。
 *
 * 【为什么需要它】浮层从 RN Modal 改成同层绝对定位后（Modal 会另起 window，
 * dimezis 模糊采样不到背后的页面，玻璃面失效），Modal 自带的 onRequestClose
 * 也随之消失。返回键不接管就会一路冒泡到系统，直接把 App 退到桌面。
 */
import { useEffect, useRef } from 'react';
import { BackHandler } from 'react-native';

export function useBackClose(onClose: () => void): void {
  /* 回调存 ref：订阅只建立一次，内容每次都取最新的那份，
     免得调用方传内联箭头函数时每次重渲染都摘挂一次监听 */
  const latest = useRef(onClose);
  latest.current = onClose;

  useEffect(() => {
    const subscription = BackHandler.addEventListener('hardwareBackPress', () => {
      latest.current();
      return true; // 消费掉：面板已收，不要再退 App
    });
    return () => subscription.remove();
  }, []);
}
