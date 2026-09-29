/**
 * apps/mobile/src/components/TopNav.tsx
 *
 * 顶部悬浮页头：品牌标识 + 胶囊导航项组。
 * 与 Web 端一致：品牌字用 meta 档宽字距，点由 accent 现算光晕；
 * 标语在窄屏让位给导航胶囊（与 Web 的 .brand__sub 媒体查询同一档断点）。
 */
import { useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { BRAND_SLOGAN_MIN_WIDTH } from '@shaping-memory/core';
import type { PhotoQuery } from '@shaping-memory/sdk';

import { IconButton, PillBar } from './primitives';
import type { PillOption } from './primitives';
import { SearchPanel } from './SearchPanel';
import { AccountPanel } from './AccountPanel';
import type { FrontSession } from '../front/session';
import { isFrontAdmin } from '../front/session';
import { useBreakpoint } from '../layout/useBreakpoint';
import { accentRgba, colors, space, text, metaTracking } from '../theme';
import type { Module } from '../modules';

const NAV_OPTIONS: readonly PillOption<Module>[] = [
  { value: 'gallery', label: '画廊', icon: 'grid' },
  { value: 'albums', label: '影集', icon: 'album' },
  { value: 'map', label: '地图画廊', icon: 'map' },
  { value: 'tools', label: '工具', icon: 'wrench' },
  { value: 'admin', label: '后台', icon: 'info' },
];

/** 品牌名与标语：与 Web 的 BRAND_FALLBACK 同一份文案（移动端暂未接站点设置） */
const BRAND_NAME = 'Shaping Memory';
const BRAND_SLOGAN = 'shape of my memory, snapshot of my mind';

interface TopNavProps {
  module: Module;
  onNavigate: (next: Module) => void;
  /** 搜索条件变化（搜索面板「应用」后回调） */
  onSearch: (query: PhotoQuery) => void;
  /** 前台登录态：admin 登录后账号图标 active（绿框） */
  session: FrontSession | null;
  onLogin: (session: FrontSession) => void;
  onLogout: () => void;
}

export function TopNav({ module, onNavigate, onSearch, session, onLogin, onLogout }: TopNavProps) {
  const [searchOpen, setSearchOpen] = useState(false);
  const [accountOpen, setAccountOpen] = useState(false);
  const admin = isFrontAdmin(session);
  /* 标语是否出场只看视口宽度：与 Web 的媒体查询同一档 */
  const showSlogan = useBreakpoint().width >= BRAND_SLOGAN_MIN_WIDTH;

  return (
    <View style={styles.bar}>
      <View style={styles.brand}>
        <View style={styles.dot} />
        <Text style={styles.name} numberOfLines={1}>
          {BRAND_NAME}
        </Text>
        {/* 窄屏不渲染：导航项是操作入口，标语是气质，先牺牲后者（与 Web 同一取舍） */}
        {showSlogan ? (
          <Text style={styles.slogan} numberOfLines={1}>
            {BRAND_SLOGAN}
          </Text>
        ) : null}
      </View>
      <View style={styles.actions}>
        <PillBar options={NAV_OPTIONS} value={module} onChange={onNavigate} label="主导航" iconOnly />
        {/* 搜索图标：点击唤出搜索面板，再点一次收起 */}
        <IconButton
          name="search"
          label="搜索"
          active={searchOpen}
          onPress={() => {
            setSearchOpen((prev) => !prev);
            setAccountOpen(false);
          }}
        />
        {/* 账号图标：未登录弹出登录表单，admin 登录后 active（绿框） */}
        <IconButton
          name="user"
          label={session ? '账号' : '登录'}
          active={admin || accountOpen}
          onPress={() => {
            setAccountOpen((prev) => !prev);
            setSearchOpen(false);
          }}
        />
      </View>

      {searchOpen ? (
        <SearchPanel
          onApply={(query) => {
            onSearch(query);
            setSearchOpen(false);
          }}
          onClose={() => setSearchOpen(false)}
        />
      ) : null}

      {accountOpen ? (
        <AccountPanel session={session} onLogin={onLogin} onLogout={onLogout} onClose={() => setAccountOpen(false)} />
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  bar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: space.s12,
    paddingVertical: space.s8,
    gap: space.s8,
    /* 搜索 / 账号面板是页头的绝对定位子节点（理由见 SearchPanel 顶部注释）。
       页头排在页面内容之前，不给 zIndex 就会被后画的页面盖住；
       overflow:'visible' 是这个做法的前提：卡片要能画到页头下方去。 */
    zIndex: 20,
    overflow: 'visible',
  },
  /* flexShrink：窄屏时品牌区先收，不许把右侧的导航胶囊与图标挤出可视区 */
  brand: { flexDirection: 'row', alignItems: 'center', gap: space.s8, flexShrink: 1, minWidth: 0 },
  /** 右侧：胶囊导航 + 搜索图标，各自横向排开 */
  actions: { flexDirection: 'row', alignItems: 'center', gap: space.s8, flexShrink: 0 },
  /** 品牌点：accent 实心 + 18% 光晕，和 Web 的 box-shadow 表达同一件事 */
  dot: {
    width: 9,
    height: 9,
    borderRadius: 3,
    backgroundColor: colors.accent,
    shadowColor: accentRgba(1),
    shadowOpacity: 0.18,
    shadowRadius: 4,
    shadowOffset: { width: 0, height: 0 },
  },
  name: {
    ...text.label,
    ...metaTracking,
    fontWeight: '600',
    flexShrink: 1,
  },
  /** 标语：与 Web 的 .brand__sub 同款（caption 档 + meta 字距 + 三级文字色）。
      字距取 meta 而不是 brand —— 0.14em 只适合全大写短语，
      落在小写句子上会把词与词拉散，读不成一串。 */
  slogan: {
    ...text.caption,
    ...metaTracking,
    color: colors.text.tertiary,
    flexShrink: 1,
  },
});