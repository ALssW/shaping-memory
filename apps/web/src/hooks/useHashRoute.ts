/**
 * apps/web/src/hooks/useHashRoute.ts
 *
 * 极简 hash 路由：#gallery / #albums / #map / #tools / #privacy-share。
 * 刻意不引入路由库 —— 都是平级模块，没有嵌套，参数只有零星几个，
 * 一个 hashchange 监听就够，省掉一整套客户端路由运行时。
 */
import { useCallback, useEffect, useState } from 'react';

export const ROUTES = ['gallery', 'albums', 'map', 'tools', 'privacy-share'] as const;

export type Route = (typeof ROUTES)[number];

/** hash 里支持的 query 参数（相册 id 供分享链接直达某册；token 是隐私分享链接的凭证） */
export interface RouteParams {
  album?: string;
  token?: string;
}

/** 只认白名单内的 hash；query 与 hash 用 ? 分隔，参数用 URLSearchParams 解析 */
function parseHash(hash: string): { route: Route; params: RouteParams } {
  const raw = hash.replace(/^#/, '');
  const [keyPart, queryPart] = raw.split('?');
  const route = (ROUTES as readonly string[]).includes(keyPart ?? '') ? (keyPart as Route) : 'gallery';
  const params: RouteParams = {};
  if (queryPart) {
    const search = new URLSearchParams(queryPart);
    const album = search.get('album');
    const token = search.get('token');
    if (album) params.album = album;
    if (token) params.token = token;
  }
  return { route, params };
}

export function useHashRoute(): readonly [Route, RouteParams, (next: Route) => void] {
  const [state, setState] = useState(() => parseHash(window.location.hash));

  useEffect(() => {
    const onHashChange = () => setState(parseHash(window.location.hash));
    window.addEventListener('hashchange', onHashChange);
    return () => window.removeEventListener('hashchange', onHashChange);
  }, []);

  const navigate = useCallback((next: Route) => {
    // 写 hash 会触发上面的 hashchange；若与当前相同则不会触发，此时状态本就一致
    window.location.hash = next;
  }, []);

  return [state.route, state.params, navigate] as const;
}