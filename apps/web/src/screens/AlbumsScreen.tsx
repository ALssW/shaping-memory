/**
 * apps/web/src/screens/AlbumsScreen.tsx
 *
 * 影集模块：相册与分组都由后端动态提供（GET /albums、GET /album-groups），这里只负责拉取与展示。
 *
 * 【布局】顶部一条分组导航（「全部」+ 各分组），下方按分组聚合出若干个区块，
 * 每个区块标题是分组名、内容是该组相册卡片。点导航上的某个分组即只保留那个区块。
 * 【分组顺序】完全按后端 sort_order 铺，前台不提供排序切换 —— 顺序由后台拖拽决定，
 * 保证「后台怎么排、前台就怎么显示」，读者看到的信息层级是稳定的。
 * 【点开某一册】把画廊切到该相册（filters.albumId），因此不额外造详情页 ——
 * 渲染复用画廊，查看器也复用同一套。
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { albumApi, albumGroupApi, shareAlbumUrl } from '@shaping-memory/sdk';
import type { Album, AlbumGroup } from '@shaping-memory/sdk';
import { placeholderColors } from '@shaping-memory/core';

import { ProgressiveImage } from '../components/ProgressiveImage';

interface AlbumsScreenProps {
  /** 点开某一册：带着 albumId 回到画廊，只展示该册照片 */
  onOpenAlbum: (albumId: string) => void;
}

/** 导航条上的「全部」伪分组：用固定 id 表示，与真实分组区分开 */
const ALL = 'all';

export function AlbumsScreen({ onOpenAlbum }: AlbumsScreenProps) {
  const [albums, setAlbums] = useState<readonly Album[]>([]);
  const [groups, setGroups] = useState<readonly AlbumGroup[]>([]);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  /** 当前选中的分组：ALL = 全部 */
  const [active, setActive] = useState<string>(ALL);
  // 刚复制了分享链接的相册 id：给一个短暂反馈，也用于 aria-live 播报
  const [copiedId, setCopiedId] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    // 相册与分组一起拉：缺了分组就没法把相册归位
    Promise.all([albumApi.list(), albumGroupApi.list()])
      .then(([albumList, groupList]) => {
        if (cancelled) return;
        setAlbums(albumList);
        setGroups(groupList);
        setLoading(false);
      })
      .catch(() => {
        if (cancelled) return;
        setAlbums([]);
        setGroups([]);
        setFailed(true);
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  /** 默认分组 id：历史数据里 groupId 为空的册都归到它名下，前台不会漏显示 */
  const defaultGroupId = useMemo(() => groups.find((group) => group.builtin)?.id ?? '', [groups]);

  /** 分组 → 该组相册；顺序即后端 sort_order，不做二次排序 */
  const sections = useMemo(
    () =>
      groups.map((group) => ({
        ...group,
        albums: albums.filter((album) => (album.groupId ?? defaultGroupId) === group.id),
      })),
    [groups, albums, defaultGroupId],
  );

  /** 实际渲染的区块：「全部」时略去空分组（避免整页都是空标题），选中某组时只看那一组 */
  const visible = useMemo(
    () => (active === ALL ? sections.filter((section) => section.albums.length > 0) : sections.filter((section) => section.id === active)),
    [sections, active],
  );

  /** 复制公开相册的分享链接；失败静默（剪贴板权限被拒时不给错误弹层） */
  const copyShare = useCallback((albumId: string) => {
    void navigator.clipboard.writeText(shareAlbumUrl(albumId)).then(() => {
      setCopiedId(albumId);
      window.setTimeout(() => setCopiedId(null), 1500);
    });
  }, []);

  return (
    <section className="module">
      <div className="shell">
        <h1 className="page-title">影集</h1>
        <p className="page-sub">按分组归集的影集，点开即进入该册的照片</p>
        <p className="sr-only" aria-live="polite">
          {copiedId ? '分享链接已复制' : ''}
        </p>

        {loading ? (
          <div className="empty-state">加载中…</div>
        ) : failed ? (
          <div className="empty-state">影集加载失败，请稍后重试</div>
        ) : albums.length === 0 ? (
          <div className="empty-state">暂无影集</div>
        ) : (
          <>
            {/* 分组导航：窄屏可横向滑动，不换行挤压标题 */}
            <nav className="album-nav" aria-label="相册分组">
              <button
                type="button"
                className="album-nav__chip"
                aria-pressed={active === ALL}
                onClick={() => setActive(ALL)}
              >
                全部
                <span className="album-nav__cnt">{albums.length}</span>
              </button>
              {sections.map((section) => (
                <button
                  key={section.id}
                  type="button"
                  className="album-nav__chip"
                  aria-pressed={active === section.id}
                  onClick={() => setActive(section.id)}
                >
                  {section.name}
                  <span className="album-nav__cnt">{section.albums.length}</span>
                </button>
              ))}
            </nav>

            {visible.length === 0 ? (
              <div className="empty-state">该分组下暂无影集</div>
            ) : (
              visible.map((section) => (
                <section key={section.id} className="album-group">
                  <h2 className="album-group__title">
                    {section.name}
                    <span className="album-group__cnt">{section.albums.length} 册</span>
                  </h2>
                  <div className="album-grid">
                    {section.albums.map((album) => (
                      <article key={album.id} className="album-card" draggable={false}>
                        <button
                          type="button"
                          className="album-card__open"
                          aria-label={`打开影集《${album.title}》，共 ${album.count} 张`}
                          onClick={() => onOpenAlbum(album.id)}
                        >
                          <div className="album-card__cover">
                            {album.coverUrl ? (
                              <ProgressiveImage
                                src={album.coverUrl}
                                alt={album.title}
                                aspect={[16, 10]}
                                colors={placeholderColors(album)}
                              >
                                <span className="album-card__shade" />
                              </ProgressiveImage>
                            ) : null}
                            <span className="badge album-card__cnt">{album.count} 张</span>
                          </div>
                          <div className="album-card__body">
                            <div className="album-card__name">{album.title}</div>
                            <div className="album-card__desc">{album.description ?? '—'}</div>
                          </div>
                        </button>
                        {album.isPublic ? (
                          <button
                            type="button"
                            className="album-card__share"
                            aria-label={`复制《${album.title}》的分享链接`}
                            onClick={() => copyShare(album.id)}
                          >
                            {copiedId === album.id ? '已复制' : '分享'}
                          </button>
                        ) : null}
                      </article>
                    ))}
                  </div>
                </section>
              ))
            )}
          </>
        )}
      </div>
    </section>
  );
}