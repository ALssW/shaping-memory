/**
 * apps/web/src/screens/GalleryScreen.tsx
 *
 * 画廊模块：置顶工具栏（分类 chip + 墙面/列表切换 + 倒序/正序）+ 两个视图 + 全屏查看器。
 *
 * 【工具栏为什么取代了原来的画廊头部】此前分类 chip 被包在 .chiprow 里、视图切换又单独
 * 占一格，多了一层「容器」却没有带来任何信息。现在两者与排序一起平铺在同一条 sticky 行上：
 * 控件各自独立（chip 直接贴着页面底色，不再嵌在容器里），切换排列方式的那一组紧跟在分类后面。
 *
 * 【为什么这一块还多带一个 module--gallery】工具栏与左轨都要「钉死不动」：
 * sticky 只有在静态位置＝吸附点时才真的零位移，因此本模块的顶部留白必须收窄到
 * size-header（与吸附点同值）。其余模块仍是 space-64 —— 那是呼吸，不是定位。
 *
 * 【时间线去哪了】「时间线式」这个视图已取消 —— 时间信息改由左侧进度轨承担：
 * 轨上按年月打点画出整份档案的时间分布，两个视图共用同一条轨（见 ProgressRail）。
 *
 * 【为什么查看器状态放在这一层】它需要「当前列表 + 下标」，而列表由视图产生；
 * 把这份状态交给 App 会让 App 多背一个与本模块强耦合的结构。放在这里，
 * 切换视图时查看器自然归位，切模块时整块卸载。
 *
 * 【查看器的两个下标操作都保留 origin】origin 只在放大时用得上，但结构里必须一直带着它，
 * 否则翻页时构造新状态会把起点矩形丢掉，关闭时就没法飞回原位。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { filterByCategory, searchPhotos, sortByDate } from '@shaping-memory/core';
import type { GalleryView, Photo, SearchQuery, SortOrder } from '@shaping-memory/core';
import { albumApi, categoryApi } from '@shaping-memory/sdk';

import { Chip, IconButton, PillBar } from '../components/controls';
import type { PillOption } from '../components/controls';
import { BatchEditDialog } from '../components/BatchEditDialog';
import { ListView } from '../components/ListView';
import { Viewer } from '../components/Viewer';
import { WallView } from '../components/WallView';
import { usePrivacyTick } from '../lib/privacy';
import type { RailScale } from '../hooks/useProgressRail';
import type { GalleryFilters } from '../types';

const VIEW_OPTIONS: readonly PillOption<GalleryView>[] = [
  { value: 'wall', label: '墙面', icon: 'grid' },
  { value: 'list', label: '列表', icon: 'list' },
];

const SORT_OPTIONS: readonly PillOption<SortOrder>[] = [
  { value: 'desc', label: '倒序（最新在前）', icon: 'arrowDown' },
  { value: 'asc', label: '正序（最旧在前）', icon: 'arrowUp' },
];

/** 刻度粒度：月看整份档案的分布，日做逐日精读 —— 只换刻度密度，不换数据 */
const SCALE_OPTIONS: readonly PillOption<RailScale>[] = [
  { value: 'month', label: '月' },
  { value: 'day', label: '日' },
];

interface GalleryScreenProps {
  photos: readonly Photo[];
  loading: boolean;
  /** 服务端还有下一页（懒加载分页）；相册模式恒为 false —— 册内是一次取回的 */
  hasMore: boolean;
  /** 正在追加下一页 */
  loadingMore: boolean;
  /** 取数错误：首屏失败时整块呈现，翻页失败时由底部状态条呈现并给重试入口 */
  error: string | null;
  /** 触发下一页：底部哨兵进入视口时自动调用，失败后也由「重试」按钮调用 */
  onLoadMore: () => void;
  filters: GalleryFilters;
  onFiltersChange: (patch: Partial<GalleryFilters>) => void;
  /** EXIF 搜索条件：在分类过滤之后、排序之前应用 */
  search: SearchQuery;
  /** 是否具备前台编辑能力（admin 登录为 true）：显示编辑入口 */
  admin: boolean;
  /** 编辑保存成功后的回调：触发顶层重拉照片列表（首屏失败时也复用它来重试） */
  onPhotosChanged: () => void;
  liked: ReadonlySet<string>;
  onToggleLike: (id: string) => void;
}

/** 查看器状态：列表 + 当前下标 + 打开时被点照片的网格矩形 */
interface ViewerState {
  list: readonly Photo[];
  index: number;
  origin: DOMRect;
}

export function GalleryScreen({
  photos,
  loading,
  hasMore,
  loadingMore,
  error,
  onLoadMore,
  filters,
  onFiltersChange,
  search,
  admin,
  onPhotosChanged,
  liked,
  onToggleLike,
}: GalleryScreenProps) {
  const albumId = filters.albumId;

  /* 分类 chip 来自后端（GET /categories）。拉取中或失败时只保留「全部」，
     保证筛选条永远可用、不会白屏。 */
  const [categories, setCategories] = useState<readonly string[]>(['全部']);
  useEffect(() => {
    let cancelled = false;
    categoryApi
      .list()
      .then((list) => {
        if (!cancelled) setCategories(['全部', ...list.map((item) => item.name)]);
      })
      .catch(() => {
        /* 静默降级：保留「全部」，不打断浏览 */
      });
    return () => {
      cancelled = true;
    };
  }, []);

  /* 相册模式：数据源换成 albumApi.detail(id).photos（顺序由后台的 sortOrder 决定），
     其余筛选（分类 / 排序 / 视图）行为保持不变。
     解锁后要重取：相册详情的照片同样由后端按票据决定「给原图还是给模糊图」。 */
  const privacyTick = usePrivacyTick();
  const [album, setAlbum] = useState<{ title: string; photos: readonly Photo[] } | null>(null);
  const [albumLoading, setAlbumLoading] = useState(false);
  useEffect(() => {
    if (!albumId) {
      setAlbum(null);
      return;
    }
    let cancelled = false;
    setAlbumLoading(true);
    albumApi
      .detail(albumId)
      .then((detail) => {
        if (!cancelled) {
          setAlbum({ title: detail.album.title, photos: detail.photos });
          setAlbumLoading(false);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setAlbum({ title: '相册', photos: [] });
          setAlbumLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [albumId, privacyTick]);

  // 数据源：进了相册就用册内照片，否则用整份档案
  const source = albumId ? album?.photos : photos;
  /* 检索条件的落点：
     - 整份档案（非相册）：source 已经由 /search/photos 按同一组条件在服务端筛过，这里不再二次过滤；
     - 相册内：册内照片来自 albumApi.detail（不是检索入口），条件只能在这一层套用。 */
  const searched = useMemo(
    () => (albumId ? searchPhotos(source ?? [], search) : (source ?? [])),
    [albumId, source, search],
  );
  /* 排序提前到这一层：两个视图与查看器共用同一份「有序」数组，
     查看器翻页的顺序因此与眼睛在网格里看到的顺序必然一致（见 core 的 sortByDate）。 */
  const ordered = useMemo(
    () => sortByDate(filterByCategory(searched, filters.category), filters.sort),
    [searched, filters.category, filters.sort],
  );
  const busy = albumId ? albumLoading || !album : loading;
  const [viewer, setViewer] = useState<ViewerState | null>(null);

  /* ---------------------- 无感分页（底部哨兵） ---------------------- */

  /* 相册模式的数据是一次取回的，没有下一页；出错时也**不**自动续取 ——
     否则「请求失败 → 哨兵仍在视口 → 再失败」会转成死循环把流量打光，
     改为停止观察、由用户点「重试」。 */
  const canLoadMore = !albumId && hasMore && !loadingMore && !error;
  const sentinelRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const node = sentinelRef.current;
    if (!node || !canLoadMore) return;
    /* 用 IntersectionObserver 而不是 scroll 事件：不占用滚动回调（列表越长开销越明显），
       也不必知道页面的滚动容器是哪一个。rootMargin 向下多留一屏做预取 ——
       等哨兵真正进入视口才请求就已经晚了，用户会先看到一段空白。 */
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) onLoadMore();
      },
      { rootMargin: '800px 0px' },
    );
    observer.observe(node);
    return () => observer.disconnect();
    // canLoadMore 里含 loadingMore：每页取完会重新观察一次，
    // 于是「新一页太短、哨兵仍停在视口内」也能继续往下取，不会卡住。
  }, [canLoadMore, onLoadMore]);

  /* 前台编辑（仅 admin）：编辑模式下点照片切换选中，浮动条提供批量编辑入口 */
  const [editing, setEditing] = useState(false);
  const [selected, setSelected] = useState<ReadonlySet<string>>(() => new Set());
  const [batchOpen, setBatchOpen] = useState(false);

  const toggleSelect = useCallback((id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (!next.delete(id)) next.add(id);
      return next;
    });
  }, []);

  const exitEditing = useCallback(() => {
    setEditing(false);
    setSelected(new Set());
  }, []);

  const beginEditing = useCallback(() => {
    setEditing(true);
    setSelected(new Set());
  }, []);

  const openViewer = useCallback(
    (index: number, list: readonly Photo[], origin: DOMRect) => setViewer({ list, index, origin }),
    [],
  );
  const closeViewer = useCallback(() => setViewer(null), []);
  /** 循环翻页：只接方向，下标在函数式更新里算，回调引用因此恒稳，键盘监听器只挂一次 */
  const stepViewer = useCallback((delta: number) => {
    setViewer((prev) => {
      if (!prev || prev.list.length === 0) return prev;
      const count = prev.list.length;
      return { ...prev, index: (prev.index + delta + count) % count };
    });
  }, []);
  /** 底部缩略图条直接定位：下标已是绝对值，只需夹在合法区间内 */
  const seekViewer = useCallback((index: number) => {
    setViewer((prev) => {
      if (!prev || prev.list.length === 0) return prev;
      return { ...prev, index: Math.min(prev.list.length - 1, Math.max(0, index)) };
    });
  }, []);

  /* 数据换了（隐私解锁后重拉、切分类、切排序）要同步给查看器 —— 否则查看器里永远是
     打开那一刻的那份数据：解锁了密码、背后网格已经变清晰，查看器却还停在模糊图上。
     同步时按**当前这张的 id** 找回它的新下标，人因此不会被换到另一张照片上去；
     若它在新列表里没了（被设为隐藏、或被筛掉），就退回原下标并夹进合法区间。 */
  useEffect(() => {
    setViewer((prev) => {
      if (!prev) return prev;
      const current = prev.list[prev.index];
      const at = current ? ordered.findIndex((photo) => photo.id === current.id) : -1;
      if (at >= 0) return { ...prev, list: ordered, index: at };
      if (ordered.length === 0) return null;
      return { ...prev, list: ordered, index: Math.min(prev.index, ordered.length - 1) };
    });
  }, [ordered]);

  return (
    <section className="module module--gallery">
      {/* 分类 chip 不带包裹容器：直接平铺，与两个切换组同处一行。
          处于相册模式时最前面多一枚「退出相册」，点它回到全部照片。 */}
      <div className="gallery-toolbar">
        {albumId ? (
          <Chip
            label={`退出相册 · ${album?.title ?? ''}`}
            active
            onClick={() => onFiltersChange({ albumId: undefined })}
          />
        ) : null}
        {categories.map((category) => (
          <Chip
            key={category}
            label={category}
            active={category === filters.category}
            onClick={() => onFiltersChange({ category })}
          />
        ))}
        <PillBar
          className="gallery-toolbar__view"
          options={VIEW_OPTIONS}
          value={filters.view}
          onChange={(view) => onFiltersChange({ view })}
          ariaLabel="排列方式"
          iconOnly
        />
        <PillBar
          options={SORT_OPTIONS}
          value={filters.sort}
          onChange={(sort) => onFiltersChange({ sort })}
          neutral
          ariaLabel="时间排序"
          iconOnly
        />
        {/* 刻度粒度紧跟在排序之后：同属「怎么看时间」，放在一起读起来才成组 */}
        <PillBar
          className="gallery-toolbar__scale"
          options={SCALE_OPTIONS}
          value={filters.scale}
          onChange={(scale) => onFiltersChange({ scale })}
          neutral
          ariaLabel="时间刻度单位"
        />
        {/* 前台编辑入口（仅 admin）：进入/退出「选择模式」，批量编辑因此而来 */}
        {admin ? (
          <IconButton
            className="gallery-toolbar__edit"
            name="edit"
            label={editing ? '退出选择' : '批量编辑'}
            active={editing}
            onClick={editing ? exitEditing : beginEditing}
          />
        ) : null}
      </div>

      {/* 选择模式下浮动的批量操作条：显示已选数量 + 批量编辑 + 退出 */}
      {editing ? (
        <div className="edit-bar mat-thick glass-neutral">
          <span className="edit-bar__count">已选 {selected.size} 张</span>
          <button
            type="button"
            className="search-action is-primary"
            disabled={selected.size === 0}
            onClick={() => setBatchOpen(true)}
          >
            批量编辑
          </button>
          <button type="button" className="search-action" onClick={exitEditing}>
            退出选择
          </button>
        </div>
      ) : null}

      {busy ? (
        <div className="empty-state">加载中…</div>
      ) : ordered.length === 0 ? (
        /* 首屏就失败：整块呈现错误 + 重试（重试即顶层的 refresh，与编辑保存后重拉是同一件事） */
        error ? (
          <div className="empty-state">
            <p className="load-more__text--error">{error}</p>
            <button type="button" className="search-action" onClick={onPhotosChanged}>
              重试
            </button>
          </div>
        ) : (
          <div className="empty-state">{albumId ? '本相册暂无照片' : '暂无照片'}</div>
        )
      ) : filters.view === 'wall' ? (
        <WallView
          photos={ordered}
          sort={filters.sort}
          scale={filters.scale}
          onOpen={openViewer}
          selecting={editing}
          selected={selected}
          onToggleSelect={toggleSelect}
        />
      ) : (
        <ListView
          photos={ordered}
          sort={filters.sort}
          scale={filters.scale}
          onOpen={openViewer}
          selecting={editing}
          selected={selected}
          onToggleSelect={toggleSelect}
        />
      )}

      {/* 分页哨兵 + 底部状态条：相册模式不分页，整块不渲染。
          哨兵自己无内容，仅作为「看到这里就该取下一页」的标记，高度交给 CSS 给一点余量。 */}
      {!albumId && !busy && ordered.length > 0 ? (
        <div className="load-more" ref={sentinelRef}>
          {loadingMore ? (
            <span className="load-more__text">正在加载更多…</span>
          ) : error ? (
            <>
              <span className="load-more__text load-more__text--error">{error}</span>
              <button type="button" className="search-action" onClick={onLoadMore}>
                重试
              </button>
            </>
          ) : null}
        </div>
      ) : null}

      {/* 不用 AnimatePresence：查看器自己管两段式关闭（先播退场动画，播完才调 onClose），
          父级只负责在收到 onClose 时卸载 —— 退出动画因此不会被打断 */}
      {viewer ? (
        <Viewer
          list={viewer.list}
          index={viewer.index}
          origin={viewer.origin}
          onStep={stepViewer}
          onSeek={seekViewer}
          onClose={closeViewer}
          admin={admin}
          categories={categories}
          onPhotosChanged={onPhotosChanged}
          liked={liked}
          onToggleLike={onToggleLike}
        />
      ) : null}

      {/* 批量编辑对话框（仅 admin、选择模式内可触发） */}
      {batchOpen ? (
        <BatchEditDialog
          ids={[...selected]}
          categories={categories}
          onClose={() => setBatchOpen(false)}
          onDone={() => {
            setBatchOpen(false);
            exitEditing();
            onPhotosChanged();
          }}
        />
      ) : null}
    </section>
  );
}