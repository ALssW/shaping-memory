/**
 * apps/web/src/screens/MapScreen.tsx
 *
 * 地图画廊（导航胶囊第三项 #map）：把带 GPS 的照片按**当前缩放级别**聚成簇，钉在 Leaflet 底图上。
 *
 * 【坐标系铁律】照片的 `photo.gps` 恒为 WGS-84，而高德底图是 GCJ-02（上海一带偏 300–600 米）。
 * 因此：内部一切坐标口径都是 WGS-84，只在**画到地图上**那一刻做 fromWgs84，
 * 从地图读回来（视图中心）时做 toWgs84。切底图因此只是「换个坐标系重新落点」，
 * 真实地点不动 —— 这也是切底图时分组不重排的前提（聚类在 WGS-84 空间做，见 core/map-cluster）。
 *
 * 【为什么直挂 Leaflet 原生 API】与 GpsPicker 同一决定：项目已装 leaflet@1.9.4，
 * 再引 react-leaflet 会带一套自己的 React 版本要求与生命周期，得不偿失。
 *
 * 【浮层卡片为什么用 L.popup】它自带「锚点跟随」——拖动、缩放地图时卡片自动跟着标记走。
 * 自绘浮层要自己订阅 move / zoom 重算屏幕坐标，等于把 Leaflet 已经做对的事再做一遍。
 *
 * 【点针脚怎么进放大器】针脚 → 浮层卡片 → 点卡片里的缩略图才进放大器（三步）。
 * 不做「点针脚直接进」：地图上针脚很密，一次点击要同时承担「看看这儿是哪张」与「进大图」
 * 两种意图，直接进大图会使用户失去先大致浏览的机会。卡片承担这段停顿，缩略图则是这段停顿的出口。
 *
 * 【放大器的列表为什么只有这个点位的照片】进放大器时把 list 钉成 `cluster.photos`
 * ——「从地图进来的放大器」问的是「这个机位拍了些什么」，不是「整份档案的第几张」。
 * 网格那一路传的是整个视图的有序数组，两者语义不同，因此各自传各自的 list。
 * 代价：地图这路上没有网格里的 `[data-photo]` 格子可量，退场落点只能回落到
 * 打开时那个缩略图按钮的矩形（Viewer 的 originRef 回退）。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { clusterPhotosByZoom, filterByCategory, formatLatLon, fromWgs84, hasGps, searchPhotos, toWgs84 } from '@shaping-memory/core';
import type { Photo, PhotoCluster, SearchQuery } from '@shaping-memory/core';
import { albumApi, categoryApi } from '@shaping-memory/sdk';

import { BASEMAPS } from '../components/GpsPicker';
import type { BasemapKey } from '../components/GpsPicker';
import { Chip, PillBar } from '../components/controls';
import type { PillOption } from '../components/controls';
import { Viewer } from '../components/Viewer';
import { usePrivacyTick } from '../lib/privacy';
import type { GalleryFilters, MapViewState } from '../types';

/** 聚类格边长（屏幕像素）：「多近算相邻」的唯一参数，说明见 core/map-cluster */
const CELL_PX = 64;
/** 单次渲染的标记上限：超出由 core 自动把格边长翻倍，保护 Leaflet 的节点数 */
const MAX_MARKERS = 240;
/** 缩略图针脚直径（与 CSS 的 .map-pin 同值） */
const PIN_SIZE = 44;
/** 底图与聚类都缺失时的回退视野：中国腹地，zoom 4 大致装下全国 */
const DEFAULT_VIEW: MapViewState = { basemap: 'amap', lat: 34.5, lon: 108.9, zoom: 4 };
/** 包围盒跨度（度）小于它即认为「同一机位」——放大也分不开，直接展开簇内容 */
const SAME_SPOT_SPAN = 1e-4;
/** 点簇放大时允许的最近档：再近瓦片就糊了 */
const FOCUS_MAX_ZOOM = 17;

const BASEMAP_OPTIONS: readonly PillOption<BasemapKey>[] = [
  { value: 'amap', label: '高德' },
  { value: 'osm', label: 'OSM' },
];

/* -------------------------------------------------------------------------- */
/* 标记与卡片的 DOM 构造                                                        */
/* 用 createElement 而不是拼 HTML 字符串：图片地址不需要转义，且 img 的 draggable 能直接关掉 */
/* -------------------------------------------------------------------------- */

/** 缩略图针脚：圆形头像式。圆形是「地图标记」的语汇，与图墙去圆角是两件事 */
function buildPin(photo: Photo): HTMLElement {
  const wrap = document.createElement('span');
  wrap.className = 'map-pin';
  const img = document.createElement('img');
  img.src = photo.cardUrl ?? photo.url;
  img.alt = '';
  img.draggable = false;
  wrap.appendChild(img);
  return wrap;
}

/** 簇标记的直径：张数越多圈越大，便于看出哪一片拍摄最密 */
function clusterBadgeSize(count: number): number {
  return count >= 100 ? 46 : count >= 10 ? 40 : 34;
}

/** 簇标记：圆点 + 张数 */
function buildClusterBadge(count: number, size: number): HTMLElement {
  const badge = document.createElement('span');
  badge.className = 'map-cluster';
  badge.style.width = `${size}px`;
  badge.style.height = `${size}px`;
  const num = document.createElement('b');
  num.textContent = String(count);
  badge.appendChild(num);
  return badge;
}

/**
 * 一个簇的图标。**必须显式给 iconSize** —— Leaflet 的锚点是从 iconSize 取中点的，
 * iconSize 为空时锚点退化成左上角，标记会整体偏出去半个身位。
 */
function iconForCluster(cluster: PhotoCluster): L.DivIcon {
  if (cluster.photos.length === 1) {
    return L.divIcon({ className: 'map-marker', html: buildPin(cluster.photos[0]), iconSize: [PIN_SIZE, PIN_SIZE] });
  }
  const size = clusterBadgeSize(cluster.photos.length);
  return L.divIcon({ className: 'map-marker', html: buildClusterBadge(cluster.photos.length, size), iconSize: [size, size] });
}

/** 图标签名 = 「长什么样」的全部输入。签名不变就不必 setIcon，图片因此不会被重新请求 */
function signatureOf(cluster: PhotoCluster): string {
  if (cluster.photos.length === 1) {
    const photo = cluster.photos[0];
    return `p:${photo.id}:${photo.cardUrl ?? photo.url}`;
  }
  return `c:${cluster.photos.length}`;
}

/** 一行「标签 + 值」 */
function buildRow(label: string, value: string): HTMLElement {
  const row = document.createElement('div');
  row.className = 'map-card__row';
  const key = document.createElement('span');
  key.className = 'map-card__label';
  key.textContent = label;
  const val = document.createElement('span');
  val.className = 'map-card__value';
  val.textContent = value;
  row.append(key, val);
  return row;
}

/** 单张照片的浮层卡片：缩略图 + 基本拍摄信息（需求 4）。
 *  缩略图是整张卡片的主入口 —— 点它进本端的放大器（需求 2），
 *  因此它包在按钮里：键盘可达、焦点可见，且不必给 img 挂点击。
 *  `onOpen` 收的是**点击那一刻量出的矩形**：放大器要从这里飞出去。 */
function buildPhotoCard(photo: Photo, onOpen: (photo: Photo, origin: DOMRect) => void): HTMLElement {
  const card = document.createElement('div');
  card.className = 'map-card';

  const thumbBtn = document.createElement('button');
  thumbBtn.type = 'button';
  thumbBtn.className = 'map-card__thumbbtn';
  thumbBtn.title = '查看大图';
  const img = document.createElement('img');
  img.className = 'map-card__thumb';
  img.src = photo.cardUrl ?? photo.url;
  img.alt = photo.title;
  img.draggable = false;
  thumbBtn.appendChild(img);
  thumbBtn.addEventListener('click', () => onOpen(photo, thumbBtn.getBoundingClientRect()));
  card.appendChild(thumbBtn);

  const head = document.createElement('div');
  head.className = 'map-card__head';
  const title = document.createElement('b');
  title.className = 'map-card__title';
  title.textContent = photo.title;
  const cat = document.createElement('span');
  cat.className = 'map-card__cat';
  cat.textContent = photo.cat;
  head.append(title, cat);
  card.appendChild(head);

  // 有值才出行：空字段全部跳过，免得卡片被一串「—」撑大
  const gear = [photo.cam, photo.lens].filter(Boolean).join(' · ');
  if (gear) card.appendChild(buildRow('器材', gear));
  const isoText = photo.iso ? `ISO ${photo.iso}` : '';
  const exposure = [photo.focal, photo.aperture, photo.speed, isoText].filter(Boolean).join(' · ');
  if (exposure) card.appendChild(buildRow('曝光', exposure));
  if (photo.date) card.appendChild(buildRow('拍摄', photo.date));
  if (photo.place) card.appendChild(buildRow('地点', photo.place));
  if (photo.gps) card.appendChild(buildRow('坐标', formatLatLon(photo.gps.lat, photo.gps.lon, 5)));

  // 触屏没有 hover，靠这一行明确说明「图可点击」
  const hint = document.createElement('span');
  hint.className = 'map-card__hint';
  hint.textContent = '点击图片查看大图';
  card.appendChild(hint);
  return card;
}

/** 同一机位多张：横向缩略图条，点某张切到那一张的卡片（再由卡片进放大器） */
function buildSpotCard(
  cluster: PhotoCluster,
  onPick: (photo: Photo) => void,
): HTMLElement {
  const card = document.createElement('div');
  card.className = 'map-card';

  const title = document.createElement('b');
  title.className = 'map-card__title';
  title.textContent = `该点 ${cluster.photos.length} 张`;
  card.appendChild(title);

  // 最多铺 12 张，再多只报数：横向条过长会把卡片顶出屏幕
  const strip = document.createElement('div');
  strip.className = 'map-card__strip';
  const shown = cluster.photos.slice(0, 12);
  shown.forEach((photo, index) => {
    const img = document.createElement('img');
    img.className = 'map-card__mini';
    img.src = photo.cardUrl ?? photo.url;
    img.alt = photo.title;
    img.title = photo.title;
    img.draggable = false;
    img.addEventListener('click', () => onPick(shown[index]));
    strip.appendChild(img);
  });
  card.appendChild(strip);

  if (cluster.photos.length > shown.length) {
    const more = document.createElement('span');
    more.className = 'map-card__more';
    more.textContent = `还有 ${cluster.photos.length - shown.length} 张`;
    card.appendChild(more);
  }
  return card;
}

/* -------------------------------------------------------------------------- */

/** 放大器状态：列表 + 当前下标 + 打开时被点缩略图的矩形（退场飞回这里） */
interface ViewerState {
  list: readonly Photo[];
  index: number;
  origin: DOMRect;
}

interface MapScreenProps {
  /** 整份档案（非相册模式下的数据源；Web 端已被 /search/photos 在服务端筛过） */
  photos: readonly Photo[];
  loading: boolean;
  filters: GalleryFilters;
  onFiltersChange: (patch: Partial<GalleryFilters>) => void;
  search: SearchQuery;
  /** 上次的视野；null = 还没定过，由本组件按照片分布自己定 */
  view: MapViewState | null;
  onViewChange: (view: MapViewState) => void;
  /** 是否具备前台编辑能力（admin 登录为 true）：放大器里显示编辑入口 */
  admin: boolean;
  /** 编辑保存成功后的回调：触发顶层重拉照片列表 */
  onPhotosChanged: () => void;
  liked: ReadonlySet<string>;
  onToggleLike: (id: string) => void;
}

export function MapScreen({
  photos,
  loading,
  filters,
  onFiltersChange,
  search,
  view,
  onViewChange,
  admin,
  onPhotosChanged,
  liked,
  onToggleLike,
}: MapScreenProps) {
  const albumId = filters.albumId;
  const holderRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<L.Map | null>(null);
  const tileRef = useRef<L.TileLayer | null>(null);
  /** 已落地的标记，按簇键复用：平移、切分类时同键的标记不必重建（图片因此不闪） */
  const markersRef = useRef<Map<string, { marker: L.Marker; sig: string }>>(new Map());
  /** 簇的最新数据：点击回调里读它，避免闭包持有过期的簇 */
  const clustersRef = useRef<Map<string, PhotoCluster>>(new Map());
  /** 视野是否已经定过（首次按包围盒自动定位只做一次） */
  const fittedRef = useRef(false);

  const basemap = view?.basemap ?? DEFAULT_VIEW.basemap;
  const [showAll, setShowAll] = useState(false);
  /* 地图当前缩放级：聚类随它重算。初值与地图创建时一致，避免首帧先按别的 zoom 画一遍 */
  const [zoom, setZoom] = useState(view?.zoom ?? DEFAULT_VIEW.zoom);
  /* 放大器：与画廊那一路各持一份（列表语义不同，见文件头） */
  const [viewer, setViewer] = useState<ViewerState | null>(null);

  // 地图与点击回调只建一次，而它们要读到最新的 basemap / 回调 —— 用 ref 保存最新值
  const basemapRef = useRef(basemap);
  const onViewChangeRef = useRef(onViewChange);
  const crsRef = useRef(BASEMAPS[basemap].crs);
  useEffect(() => {
    basemapRef.current = basemap;
    onViewChangeRef.current = onViewChange;
  }, [basemap, onViewChange]);

  /* ---------------------------------------------------------------- 数据 */

  const privacyTick = usePrivacyTick();
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

  /* 相册模式：数据源换成册内照片（顺序由后台 sortOrder 决定）。解锁后要重取 —— 相册详情同样
     由后端按票据决定「给原图还是给模糊图」，否则地图上会一直钉着解锁前的模糊缩略图。 */
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
        if (cancelled) return;
        setAlbum({ title: detail.album.title, photos: detail.photos });
        setAlbumLoading(false);
      })
      .catch(() => {
        if (cancelled) return;
        setAlbum({ title: '相册', photos: [] });
        setAlbumLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [albumId, privacyTick]);

  /**
   * 实际参与筛选的照片。检索条件的落点与画廊一致：
   * 整份档案已由 /search/photos 在服务端筛过，只有「册内照片」需要在这一层再套一次。
   * 「看全部」直接短路 —— 它的语义就是「无视分类 / 相册 / 搜索条件」。
   */
  const filtered = useMemo(() => {
    if (showAll) return photos;
    const base = albumId ? album?.photos ?? [] : photos;
    return filterByCategory(albumId ? searchPhotos(base, search) : base, filters.category);
  }, [showAll, albumId, album, photos, search, filters.category]);

  /** 可上图的部分（没有定位的照片在地图上无处安放，直接剔除并另行计数） */
  const mapped = useMemo(() => filtered.filter(hasGps), [filtered]);
  const missingCount = filtered.length - mapped.length;

  const clusters = useMemo(
    () => clusterPhotosByZoom(mapped, { zoom, cellPx: CELL_PX, maxMarkers: MAX_MARKERS }),
    [mapped, zoom],
  );

  const busy = albumId ? albumLoading || !album : loading;

  /* ---------------------------------------------------------------- 地图 */

  /** 循环翻页与直接定位：与画廊那一路同形，只是列表恒为「这个点位的照片」 */
  const stepViewer = useCallback((delta: number) => {
    setViewer((prev) => {
      if (!prev || prev.list.length === 0) return prev;
      const count = prev.list.length;
      return { ...prev, index: (prev.index + delta + count) % count };
    });
  }, []);
  const seekViewer = useCallback((index: number) => {
    setViewer((prev) => {
      if (!prev || prev.list.length === 0) return prev;
      return { ...prev, index: Math.min(prev.list.length - 1, Math.max(0, index)) };
    });
  }, []);
  const closeViewer = useCallback(() => setViewer(null), []);

  /**
   * 卡片里的缩略图被点 → 进放大器。列表恒为**这个点位的全部照片**：
   * 单张针脚的簇长度就是 1，多张的簇进来就能左右翻遍该机位的每一张。
   * `origin` 是点击那一刻量出的按钮矩形 —— 放大器从这里飞出去，退场再飞回来。
   */
  const openFromCard = useCallback((cluster: PhotoCluster, photo: Photo, origin: DOMRect) => {
    const at = cluster.photos.findIndex((item) => item.id === photo.id);
    setViewer({ list: cluster.photos, index: at < 0 ? 0 : at, origin });
  }, []);

  /* 打开卡片：size 是锚点标记的直径，卡片因此浮在标记正上方而不是压住它 */
  const openCard = useCallback((latlng: L.LatLng, content: HTMLElement, size: number) => {
    const map = mapRef.current;
    if (!map) return;
    L.popup({
      className: 'map-card-popup',
      maxWidth: 280,
      minWidth: 232,
      offset: [0, -(size / 2 + 10)],
      closeButton: true,
      autoPan: true,
    })
      .setLatLng(latlng)
      .setContent(content)
      .openOn(map);
  }, []);

  /** 点簇 / 点针脚：单张开卡片，多张先放大，实在分不开（同一机位）就直接展开簇内容 */
  const handleMarkerClick = useCallback(
    (key: string) => {
      const map = mapRef.current;
      const cluster = clustersRef.current.get(key);
      if (!map || !cluster) return;
      const base = fromWgs84({ lat: cluster.lat, lon: cluster.lon }, BASEMAPS[basemapRef.current].crs);
      const latlng = L.latLng(base.lat, base.lon);

      if (cluster.photos.length === 1) {
        openCard(
          latlng,
          buildPhotoCard(cluster.photos[0], (photo, origin) => openFromCard(cluster, photo, origin)),
          PIN_SIZE,
        );
        return;
      }

      // 包围盒跨度：小于阈值的簇放大后仍会并在一起，直接展开内容才是有效反馈
      let span = 0;
      for (const photo of cluster.photos) {
        span = Math.max(span, Math.abs((photo.gps?.lat ?? 0) - cluster.lat), Math.abs((photo.gps?.lon ?? 0) - cluster.lon));
      }
      if (span <= SAME_SPOT_SPAN || map.getZoom() >= FOCUS_MAX_ZOOM) {
        const badgeSize = clusterBadgeSize(cluster.photos.length);
        openCard(
          latlng,
          buildSpotCard(cluster, (photo) =>
            openCard(latlng, buildPhotoCard(photo, (picked, origin) => openFromCard(cluster, picked, origin)), badgeSize),
          ),
          badgeSize,
        );
        return;
      }
      const bounds = L.latLngBounds(
        cluster.photos.map((photo) => {
          const g = fromWgs84({ lat: photo.gps?.lat ?? 0, lon: photo.gps?.lon ?? 0 }, BASEMAPS[basemapRef.current].crs);
          return [g.lat, g.lon] as [number, number];
        }),
      );
      map.fitBounds(bounds, { padding: [64, 64], maxZoom: FOCUS_MAX_ZOOM });
    },
    [openCard, openFromCard],
  );

  /* 创建地图：只做一次。底图图层、标记、视野同步各自交给下面的 effect */
  useEffect(() => {
    const holder = holderRef.current;
    if (!holder || mapRef.current) return;

    const start = view ?? DEFAULT_VIEW;
    const startCenter = fromWgs84({ lat: start.lat, lon: start.lon }, BASEMAPS[start.basemap].crs);
    const map = L.map(holder, {
      center: [startCenter.lat, startCenter.lon],
      zoom: start.zoom,
      zoomControl: true,
      attributionControl: false,
      worldCopyJump: true,
    });
    mapRef.current = map;

    map.on('zoomend', () => setZoom(map.getZoom()));
    // moveend 在缩放结束后也会触发，因此视野上报只挂这一个事件就够
    map.on('moveend', () => {
      const center = map.getCenter();
      const wgs = toWgs84({ lat: center.lat, lon: center.lng }, BASEMAPS[basemapRef.current].crs);
      onViewChangeRef.current({ basemap: basemapRef.current, lat: wgs.lat, lon: wgs.lon, zoom: map.getZoom() });
    });

    // 容器尺寸变化后必须 invalidateSize，否则瓦片错位（编辑面板滚动、窗口缩放都会触发）
    const observer = new ResizeObserver(() => map.invalidateSize());
    observer.observe(holder);

    const markers = markersRef.current;
    return () => {
      observer.disconnect();
      map.remove();
      mapRef.current = null;
      tileRef.current = null;
      markers.clear();
      clustersRef.current.clear();
    };
    // 只在挂载时建图：view 的后续变化由外部 onViewChange 回写，重建地图会丢瓦片与平移动画
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /* 底图切换：换瓦片源 + 把中心与所有标记按新坐标系重新落点，真实地点因此不动 */
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const config = BASEMAPS[basemap];
    const nextCrs = config.crs;

    if (crsRef.current !== nextCrs) {
      const center = map.getCenter();
      const wgs = toWgs84({ lat: center.lat, lon: center.lng }, crsRef.current);
      const moved = fromWgs84(wgs, nextCrs);
      crsRef.current = nextCrs;
      // animate:false —— 换底图是「换个坐标系看同一个地方」，不该看到一段位移
      map.setView([moved.lat, moved.lon], map.getZoom(), { animate: false });
    }

    tileRef.current?.remove();
    tileRef.current = L.tileLayer(config.url, {
      subdomains: config.subdomains ?? 'abc',
      minZoom: 3,
      maxZoom: 19,
    }).addTo(map);
    return () => {
      tileRef.current?.remove();
      tileRef.current = null;
    };
  }, [basemap]);

  /* 标记落地：按簇键复用，签名相同就不碰 DOM */
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const crs = BASEMAPS[basemap].crs;
    const live = markersRef.current;
    const next = new Set(clusters.map((cluster) => cluster.key));

    for (const [key, entry] of live) {
      if (!next.has(key)) {
        entry.marker.remove();
        live.delete(key);
      }
    }

    clustersRef.current = new Map(clusters.map((cluster) => [cluster.key, cluster]));

    for (const cluster of clusters) {
      const { lat, lon } = fromWgs84({ lat: cluster.lat, lon: cluster.lon }, crs);
      const sig = signatureOf(cluster);
      // 大簇盖在小针脚之上，密集区不会把计数点埋掉
      const lift = cluster.photos.length * 100;
      const existing = live.get(cluster.key);
      if (existing) {
        existing.marker.setLatLng([lat, lon]);
        existing.marker.setZIndexOffset(lift);
        if (existing.sig !== sig) {
          existing.marker.setIcon(iconForCluster(cluster));
          existing.sig = sig;
        }
        continue;
      }
      const marker = L.marker([lat, lon], { icon: iconForCluster(cluster), zIndexOffset: lift, keyboard: false });
      marker.on('click', () => handleMarkerClick(cluster.key));
      marker.addTo(map);
      live.set(cluster.key, { marker, sig });
    }
  }, [clusters, basemap, handleMarkerClick]);

  /* 首次进入：没定过视野就按包围盒自动定位，让用户一进来就看见自己的照片都在哪 */
  useEffect(() => {
    const map = mapRef.current;
    if (!map || fittedRef.current) return;
    if (view) {
      fittedRef.current = true;
      return;
    }
    if (mapped.length === 0) return;
    fittedRef.current = true;
    const crs = BASEMAPS[basemap].crs;
    const bounds = L.latLngBounds(
      mapped.map((photo) => {
        const g = fromWgs84({ lat: photo.gps?.lat ?? 0, lon: photo.gps?.lon ?? 0 }, crs);
        return [g.lat, g.lon] as [number, number];
      }),
    );
    map.fitBounds(bounds, { padding: [56, 56], maxZoom: 14 });
  }, [mapped, view, basemap]);

  const empty = !busy && mapped.length === 0;

  return (
    <section className="module module--map">
      <div className="map-toolbar">
        {albumId && !showAll ? (
          <Chip
            label={`退出相册 · ${album?.title ?? ''}`}
            active
            onClick={() => onFiltersChange({ albumId: undefined })}
          />
        ) : null}
        {/* 看全部打开时分类 chip 收起：此时它们已经不生效，留着只会误导 */}
        {showAll
          ? null
          : categories.map((category) => (
              <Chip
                key={category}
                label={category}
                active={category === filters.category}
                onClick={() => onFiltersChange({ category })}
              />
            ))}
        <Chip label="看全部" active={showAll} onClick={() => setShowAll((prev) => !prev)} />
        <PillBar
          className="map-toolbar__basemap"
          options={BASEMAP_OPTIONS}
          value={basemap}
          onChange={(key) => onViewChange({ ...(view ?? DEFAULT_VIEW), basemap: key })}
          ariaLabel="底图选择"
        />
        <span className="map-toolbar__hint">
          {busy ? '正在读取照片…' : `${mapped.length} 张已上图 · ${missingCount} 张无定位`}
        </span>
      </div>

      <div className="map-stage">
        <div className="map-canvas" ref={holderRef} />
        {empty ? (
          <div className="map-empty">
            <p className="map-empty__title">当前范围没有带定位的照片</p>
            <p className="map-empty__tip">
              {showAll ? '相册中暂无带定位的照片，可在「工具」模块补充拍摄地点' : '可打开「看全部」，或切换其他分类'}
            </p>
          </div>
        ) : null}
        <span className="map-credit">© OpenStreetMap · © 高德</span>
      </div>

      {/* 放大器：与画廊那一路共用同一个组件，差别只在 list —— 这里恒为「这个点位的照片」。
          不用 AnimatePresence：查看器自己管两段式关闭（先播退场动画，播完才调 onClose）。 */}
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
    </section>
  );
}
