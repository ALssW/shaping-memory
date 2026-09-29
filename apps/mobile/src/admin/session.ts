/**
 * apps/mobile/src/admin/session.ts
 *
 * 移动端后台登录态（内存态）。
 *
 * 【为什么是内存态】Web 后台用 localStorage 持久化（刷新后仍需登录），
 * 但 RN 没有 localStorage，等价物是 AsyncStorage（尚未引入）。移动端「审核」场景
 * 里 app 重启后重新登录是可接受的代价，因此这里只用内存 + sdk 的 setAuthToken，
 * 不为持久化单独引入一个存量依赖；将来要「记住登录」再补 AsyncStorage。
 */
import { setAuthToken } from '@shaping-memory/sdk';

export interface AdminSession {
  token: string;
  username: string;
  role: string;
}

let session: AdminSession | null = null;

/** 登录成功：把 token 交回 sdk（后续管理类请求自动带 Authorization 头） */
export function saveSession(next: AdminSession): void {
  session = next;
  setAuthToken(next.token);
}

/** 能否进入后台：只有 admin / editor 有管理权，其余角色一律视为未登录 */
export function isEditor(next: AdminSession | null): boolean {
  return next != null && (next.role === 'admin' || next.role === 'editor');
}

/** 退出：清内存态 + 清 sdk token，回到登录页 */
export function clearSession(): void {
  session = null;
  setAuthToken(null);
}

export function currentSession(): AdminSession | null {
  return session;
}