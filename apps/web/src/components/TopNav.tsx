/**
 * apps/web/src/components/TopNav.tsx
 *
 * 顶部悬浮导航（§8.1）：品牌标识 + 胶囊导航项组。
 * 外壳 fixed 且不拦事件，只有胶囊本身可点，避免遮住下方的照片点击区。
 * 品牌名与标语来自站点设置（后台可改），读不到时回落到这里的缺省文案。
 */
import { useEffect, useState } from 'react';
import { settingsApi } from '@shaping-memory/sdk';
import type { SearchQuery } from '@shaping-memory/core';
import type { PillOption } from './controls';
import { IconButton, PillBar } from './controls';
import { SearchPanel } from './SearchPanel';
import { AccountPanel } from './AccountPanel';
import type { FrontSession } from '../lib/session';
import { isFrontAdmin } from '../lib/session';
import type { Route } from '../hooks/useHashRoute';

const NAV_OPTIONS: readonly PillOption<Route>[] = [
  { value: 'gallery', label: '画廊', icon: 'grid' },
  { value: 'albums', label: '影集', icon: 'album' },
  { value: 'map', label: '地图画廊', icon: 'map' },
  { value: 'tools', label: '工具', icon: 'wrench' },
];

/** 缺省品牌文案：与站点设置的出厂值一致，接口不可用时页面不至于空着 */
const BRAND_FALLBACK = { name: 'Shaping Memory', slogan: 'shape of my memory, snapshot of my mind' };

interface TopNavProps {
  route: Route;
  onNavigate: (next: Route) => void;
  /** 搜索条件变化（搜索面板「应用」后回调） */
  onSearch: (query: SearchQuery) => void;
  /** 前台登录态：admin 登录后图标变成账号态（绿框），并可退出 */
  session: FrontSession | null;
  onLogin: (session: FrontSession) => void;
  onLogout: () => void;
}

export function TopNav({ route, onNavigate, onSearch, session, onLogin, onLogout }: TopNavProps) {
  const [brand, setBrand] = useState(BRAND_FALLBACK);
  const [searchOpen, setSearchOpen] = useState(false);
  const [accountOpen, setAccountOpen] = useState(false);
  const admin = isFrontAdmin(session);

  useEffect(() => {
    // 用 canceled 标记丢弃「组件已卸载后才到」的响应，避免无谓的 setState
    let canceled = false;
    void settingsApi
      .all()
      .then((value) => {
        if (canceled) return;
        setBrand({ name: value['site.title'], slogan: value['site.slogan'] });
      })
      .catch(() => {
        // 读不到设置就沿用缺省品牌文案：页头不值得为一次失败请求报错
      });
    return () => {
      canceled = true;
    };
  }, []);

  return (
    <header className="topnav">
      <div className="brand">
        <span className="brand__dot" />
        <b className="brand__name">{brand.name}</b>
        {/* 英文标语：紧跟在品牌名之后，与中文 slogan「塑记忆之形，撷心影之瞬」同义 */}
        <span className="brand__sub">{brand.slogan}</span>
      </div>
      <div className="topnav__actions">
        <PillBar
          options={NAV_OPTIONS}
          value={route}
          onChange={onNavigate}
          ariaLabel="主导航"
          neutral
          iconOnly
        />
        {/* 搜索图标：点击唤出搜索面板，再点一次收起（面板自己也提供唯一的关闭按钮） */}
        <IconButton
          name="search"
          label="搜索"
          active={searchOpen}
          onClick={() => {
            setSearchOpen((prev) => !prev);
            setAccountOpen(false);
          }}
        />
        {/* 账号图标：未登录弹出登录表单，admin 登录后 active（绿框）提示已具备编辑能力 */}
        <IconButton
          name="user"
          label={session ? '账号' : '登录'}
          active={admin || accountOpen}
          onClick={() => {
            setAccountOpen((prev) => !prev);
            setSearchOpen(false);
          }}
        />
      </div>
      {searchOpen ? (
        <SearchPanel
          /* 应用条件后**不**收起面板：搜索是反复调整的过程，看完结果常常还要回来改一个条件再搜 */
          onApply={onSearch}
          onClose={() => setSearchOpen(false)}
        />
      ) : null}
      {accountOpen ? (
        <AccountPanel
          session={session}
          onLogin={onLogin}
          onLogout={onLogout}
          onClose={() => setAccountOpen(false)}
        />
      ) : null}
    </header>
  );
}