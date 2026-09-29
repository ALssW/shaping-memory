/**
 * apps/web/src/lib/session.ts
 *
 * 前台登录态（内存 + localStorage 持久化）。与后台共用 sdk 的 setAuthToken，
 * 差异只在「前台编辑能力只看 admin」：admin 登录前台才出现编辑入口。
 *
 * 【为什么持久化到 localStorage】刷新页面频繁，管理员不希望每次都重登；
 * 移动端没有 localStorage，故移动端用内存态（见 apps/mobile/src/front/session.ts）。
 */
import { setAuthToken } from '@shaping-memory/sdk';

export interface FrontSession {
  token: string;
  username: string;
  role: string;
}

const STORAGE_KEY = 'shaping-memory.front-session';

let memory: FrontSession | null = null;

function load(): FrontSession | null {
  if (memory) return memory;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as FrontSession;
    if (parsed?.token) setAuthToken(parsed.token);
    return parsed;
  } catch {
    return null;
  }
}

/** 当前登录态（无则 null）；首次调用时从 localStorage 恢复并回写 sdk token */
export function currentSession(): FrontSession | null {
  if (!memory) memory = load();
  return memory;
}

/** 登录成功：落内存 + 落 localStorage + 把 token 交回 sdk */
export function saveSession(next: FrontSession): void {
  memory = next;
  setAuthToken(next.token);
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    /* 隐私模式 / 配额不足时写不进 localStorage：仍保留内存态，本次会话内可用 */
  }
}

/** 退出：清三处（内存 / localStorage / sdk token） */
export function clearSession(): void {
  memory = null;
  setAuthToken(null);
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    /* 忽略：写不进去自然也没有残留 */
  }
}

/** 是否具备前台编辑能力：只认 admin（editor/viewer 不开放前台编辑） */
export function isFrontAdmin(session: FrontSession | null): boolean {
  return session != null && session.role === 'admin';
}