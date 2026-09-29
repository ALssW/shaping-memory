/**
 * apps/mobile/src/front/session.ts
 *
 * 前台登录态（内存态）。与后台 admin/session 分离：前台编辑只看 admin。
 *
 * 【为什么是内存态】RN 没有 localStorage，等价物是 AsyncStorage（尚未引入）。
 * 前台「编辑」场景里 app 重启后重新登录是可接受的代价，因此只做内存 + sdk 的 setAuthToken。
 */
import { setAuthToken } from '@shaping-memory/sdk';

export interface FrontSession {
  token: string;
  username: string;
  role: string;
}

let session: FrontSession | null = null;

/** 登录成功：把 token 交回 sdk（后续管理类请求自动带 Authorization 头） */
export function saveSession(next: FrontSession): void {
  session = next;
  setAuthToken(next.token);
}

/** 是否具备前台编辑能力：只认 admin */
export function isFrontAdmin(next: FrontSession | null): boolean {
  return next != null && next.role === 'admin';
}

/** 退出：清内存态 + 清 sdk token */
export function clearSession(): void {
  session = null;
  setAuthToken(null);
}

export function currentSession(): FrontSession | null {
  return session;
}