/**
 * apps/admin/src/App.tsx
 *
 * 后台外壳：登录门禁 + 页头 + 左侧导航 + 工作区。
 *
 * 【门禁策略】未登录时只渲染登录页 —— 后台没有「公开页面」，
 * 因此不需要路由，用登录态直接决定渲染哪一棵树，天然满足「未登录访问任何页面都跳登录」。
 * 【为什么不上路由库】后台页面之间没有可分享的深链需求，导航状态就是「当前选中哪个菜单」，
 * 用一个 useState 表达最清楚；引入 react-router 只会多一层 URL ↔ 状态的同步。
 * 【按角色裁剪菜单】账号管理 / 系统设置 / 操作日志需要 admin 权限，非 admin 直接不显示入口
 * （后端同样会拒绝，这里只是不给用户徒劳点击的机会）。
 */
import { useCallback, useState } from 'react';
import { App as AntApp, Button, ConfigProvider, Layout, Menu, Space, Tag } from 'antd';
import zhCN from 'antd/locale/zh_CN';
import { authApi } from '@shaping-memory/sdk';

import { buildAdminTheme } from './theme';
import { clearSession, restoreAuth, saveSession } from './lib/session';
import type { Session } from './lib/session';
import { ThemeStoreProvider, useThemeStore } from './lib/theme-store';
import { LoginPage } from './pages/LoginPage';
import { OverviewPage } from './pages/OverviewPage';
import { PhotoManager } from './pages/PhotoManager';
import { AlbumManager } from './pages/AlbumManager';
import { AlbumGroupManager } from './pages/AlbumGroupManager';
import { CategoryManager } from './pages/CategoryManager';
import { DictionaryManager } from './pages/DictionaryManager';
import { UserManager } from './pages/UserManager';
import { PrivacyManager } from './pages/PrivacyManager';
import { SettingsPage } from './pages/SettingsPage';
import { ThemePage } from './pages/ThemePage';
import { AuditPage } from './pages/AuditPage';

/** 页面标识：与菜单 key 一一对应 */
type PageKey =
  | 'overview'
  | 'photos'
  | 'albums'
  | 'album-groups'
  | 'categories'
  | 'dictionary'
  | 'users'
  | 'privacy'
  | 'settings'
  | 'theme'
  | 'audit';

/** 菜单项；adminOnly 的项只对 admin 显示 */
const NAV_ITEMS: { key: PageKey; label: string; adminOnly?: boolean }[] = [
  { key: 'overview', label: '数据概览' },
  { key: 'photos', label: '照片管理' },
  { key: 'albums', label: '相册管理' },
  // 分组管理紧跟相册管理：分组是相册的一级归集，两者相邻更顺。
  // 仅 admin 可见 —— 分组写接口也只对 admin 开放（需求：只有管理员可进行分组管理）
  { key: 'album-groups', label: '分组管理', adminOnly: true },
  { key: 'categories', label: '分类管理' },
  // 字典管理紧跟分类之后：它属于「内容维护」，与分类管理相邻更顺；可见性由下面的 adminOnly 过滤决定
  { key: 'dictionary', label: '字典管理', adminOnly: true },
  { key: 'users', label: '账号管理', adminOnly: true },
  { key: 'privacy', label: '隐私与分享' },
  // 主题配置与系统设置相邻：都属于「站点外观 / 行为」的全局设置
  { key: 'settings', label: '系统设置', adminOnly: true },
  { key: 'theme', label: '主题配置', adminOnly: true },
  { key: 'audit', label: '操作日志', adminOnly: true },
];

interface PageContentProps {
  page: PageKey;
  session: Session;
}

/** 按菜单 key 渲染对应页面（这里就是「路由表」，只是没有 URL） */
function PageContent({ page, session }: PageContentProps) {
  switch (page) {
    case 'photos':
      return <PhotoManager />;
    case 'albums':
      return <AlbumManager />;
    case 'album-groups':
      return <AlbumGroupManager />;
    case 'categories':
      return <CategoryManager />;
    case 'dictionary':
      return <DictionaryManager />;
    case 'users':
      return <UserManager session={session} />;
    case 'privacy':
      return <PrivacyManager />;
    case 'settings':
      return <SettingsPage />;
    case 'theme':
      return <ThemePage />;
    case 'audit':
      return <AuditPage />;
    default:
      return <OverviewPage />;
  }
}

export function App() {
  /* 主题 store 必须在最外层：ConfigProvider 的 AntD token 要跟着草稿实时变，
     而草稿又被「主题配置」页改 —— 两侧共用同一份状态才不会出现半预览。 */
  return (
    <ThemeStoreProvider>
      <AdminShell />
    </ThemeStoreProvider>
  );
}

/** 后台外壳：消费主题 store，把草稿算成 AntD 主题 */
function AdminShell() {
  const { draft, scaleOn } = useThemeStore();
  // 启动时把 localStorage 里的 token 交回 sdk，刷新后管理类请求仍带凭证
  const [session, setSession] = useState<Session | null>(() => restoreAuth());
  const [page, setPage] = useState<PageKey>('overview');

  const handleLoggedIn = useCallback((next: Session) => {
    saveSession(next);
    setSession(next);
  }, []);

  const handleLogout = useCallback(() => {
    authApi.logout();
    clearSession();
    setSession(null);
    setPage('overview');
  }, []);

  const isAdmin = session?.role === 'admin';
  const menuItems = NAV_ITEMS.filter((item) => !item.adminOnly || isAdmin).map((item) => ({
    key: item.key,
    label: item.label,
  }));

  // 窄屏不放大：AntD 的 token 是 JS 算的，用不了媒体查询，这里按断点把倍率归 1
  const theme = buildAdminTheme(draft, scaleOn ? draft.fontScale : 1);

  return (
    <ConfigProvider theme={theme} locale={zhCN}>
      <AntApp>
        {session ? (
          <Layout className="admin-shell">
            <Layout.Header className="admin-header">
              <div className="admin-brand">
                <span className="admin-brand__name">塑忆 · 后台</span>
                <span className="admin-brand__slogan">shape of my memory</span>
              </div>
              <Space size={12}>
                <span className="t-sec">{session.username}</span>
                <Tag color="gold">{session.role}</Tag>
                <Button size="small" onClick={handleLogout}>
                  退出登录
                </Button>
              </Space>
            </Layout.Header>
            <Layout className="admin-body">
              <Layout.Sider width={176} theme="dark" className="admin-sider">
                <Menu
                  className="admin-menu"
                  mode="inline"
                  theme="dark"
                  selectedKeys={[page]}
                  items={menuItems}
                  onClick={({ key }) => setPage(key as PageKey)}
                />
              </Layout.Sider>
              <Layout.Content className="admin-main">
                <PageContent page={page} session={session} />
              </Layout.Content>
            </Layout>
          </Layout>
        ) : (
          <LoginPage onLoggedIn={handleLoggedIn} />
        )}
      </AntApp>
    </ConfigProvider>
  );
}