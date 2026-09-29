/**
 * apps/admin/src/lib/session.ts
 *
 * 后台登录态持久化。
 *
 * 【为什么后台要自己持久化】packages/sdk 刻意把 token 只放内存（刷新即丢），
 * 因为「要不要记住登录」属于各端的策略问题：前台匿名浏览不需要，后台则必须
 * 刷新后仍在。所以 localStorage 这一层由后台自己负责，sdk 只提供 setAuthToken。
 */
import { setAuthToken } from '@shaping-memory/sdk';

export interface Session {
  token: string;
  username: string;
  role: string;
}

const TOKEN_KEY = 'shaping-memory.admin.token';
const USER_KEY = 'shaping-memory.admin.user';

/** 读 localStorage 里的登录态（不做校验，token 是否过期由后端说了算） */
export function loadSession(): Session | null {
  const token = localStorage.getItem(TOKEN_KEY);
  const raw = localStorage.getItem(USER_KEY);
  if (!token || !raw) return null;
  try {
    const user = JSON.parse(raw) as { username?: string; role?: string };
    return { token, username: user.username ?? '', role: user.role ?? '' };
  } catch {
    // 存储内容被外部破坏时按未登录处理，避免整个后台白屏
    return null;
  }
}

export function saveSession(session: Session): void {
  localStorage.setItem(TOKEN_KEY, session.token);
  localStorage.setItem(USER_KEY, JSON.stringify({ username: session.username, role: session.role }));
}

export function clearSession(): void {
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(USER_KEY);
}

/**
 * 启动时恢复登录态：把 token 交回 sdk（否则刷新后所有管理类请求都缺 Authorization 头）。
 * 返回 null 表示未登录，调用方直接渲染登录页。
 */
export function restoreAuth(): Session | null {
  const session = loadSession();
  setAuthToken(session ? session.token : null);
  return session;
}
