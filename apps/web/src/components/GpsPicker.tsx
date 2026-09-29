/**
 * apps/web/src/components/GpsPicker.tsx
 *
 * 地图选点（leaflet 原生 API 挂载，不用 react-leaflet 以免版本冲突）。
 * 与后台 apps/admin/src/components/GpsPicker.tsx 是同一套实现 —— 只把 antd 控件换成前台基元。
 *
 * 【坐标系铁律】EXIF 里的 GPS 恒为 WGS-84，而国内底图有自己的偏移
 * （高德 GCJ-02，与 WGS-84 在上海一带差 300–600 米）。因此：
 *   - 组件内部状态（props 里的 point / savedGps）**统一是 WGS-84**
 *   - 渲染到底图前用 fromWgs84(point, 底图坐标系) 换算
 *   - 用户点击底图时用 toWgs84(点击坐标, 底图坐标系) 换回 WGS-84 再上抛
 * 这样切换底图时标记停在同一个真实地点；写进 EXIF 的永远是 WGS-84。
 *
 * 【搜索与定位是「把视野挪过去」的快捷方式，不是另一套选点通道】两条路最终都落到
 * 同一个 onPointChange：搜索命中一条地点、或定位拿到当前位置，都只是替用户省下
 * 「先把地图拖到那一带再点一下」的动作。落点之后仍可在地图上微调，
 * 因此这两件事都不需要额外的坐标换算 —— searchPlaces 已由后端把高德的 GCJ-02
 * 转成 WGS-84（见 core/geocode.ts），浏览器定位给的本来就是 WGS-84。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import {
  distanceMeters,
  formatDistance,
  fromWgs84,
  formatLatLon,
  locateCurrent,
  searchPlaces,
  toWgs84,
} from '@shaping-memory/core';
import type { CoordSystem, GeoPoint, PlaceHit } from '@shaping-memory/core';
import { tokens } from '@shaping-memory/design-tokens';

import { PillBar } from './controls';

/** 底图标识 */
export type BasemapKey = 'amap' | 'osm';

interface BasemapConfig {
  label: string;
  /** 瓦片地址模板 */
  url: string;
  /** 子域轮询（高德必需，否则单域名并发受限） */
  subdomains?: string;
  /** 该底图使用的坐标系 —— 换算的唯一依据 */
  crs: CoordSystem;
}

export const BASEMAPS: Record<BasemapKey, BasemapConfig> = {
  amap: {
    label: '高德',
    url: 'https://webrd0{s}.is.autonavi.com/appmaptile?lang=zh_cn&size=1&scale=1&style=8&x={x}&y={y}&z={z}',
    subdomains: '1234',
    crs: 'gcj02',
  },
  osm: {
    label: 'OSM',
    url: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
    crs: 'wgs84',
  },
};

const CRS_LABEL: Record<CoordSystem, string> = {
  wgs84: '国际标准',
  gcj02: '高德地图',
  bd09: '百度地图',
};

/** 没有定位时的默认视野：中国境内（上海），zoom 11 大致覆盖一个市区 */
const DEFAULT_CENTER: GeoPoint = { lat: 31.23, lon: 121.47 };
const DEFAULT_ZOOM = 11;
/** 已有定位时的聚焦 zoom */
const FOCUS_ZOOM = 16;

const BASEMAP_OPTIONS = [
  { value: 'amap' as const, label: '高德' },
  { value: 'osm' as const, label: 'OSM' },
];

interface GpsPickerProps {
  /** 当前选点（WGS-84）；null = 没有选点 */
  point: GeoPoint | null;
  /** 文件里实际存在的定位（WGS-84）；null = 文件里没有 GPS */
  savedGps: GeoPoint | null;
  /** 当前底图 */
  basemap: BasemapKey;
  onPointChange: (point: GeoPoint) => void;
  onBasemapChange: (key: BasemapKey) => void;
}

export function GpsPicker({ point, savedGps, basemap, onPointChange, onBasemapChange }: GpsPickerProps) {
  const holderRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<L.Map | null>(null);
  const tileRef = useRef<L.TileLayer | null>(null);
  /** 当前选点标记（实心 accent 圆） */
  const pickedRef = useRef<L.CircleMarker | null>(null);
  /** 文件里已有定位的标记（虚线空心圆），与选点区分开 */
  const savedRef = useRef<L.CircleMarker | null>(null);

  // 地图只创建一次，而点击回调 / 底图切换需要读到最新值 —— 用 ref 保存最新值，避免重建地图
  const basemapRef = useRef(basemap);
  const onPointChangeRef = useRef(onPointChange);
  useEffect(() => {
    basemapRef.current = basemap;
  }, [basemap]);
  useEffect(() => {
    onPointChangeRef.current = onPointChange;
  }, [onPointChange]);

  // 创建地图：只做一次，底图图层交给下面那个 effect
  useEffect(() => {
    const holder = holderRef.current;
    if (!holder || mapRef.current) return;

    const map = L.map(holder, {
      center: [DEFAULT_CENTER.lat, DEFAULT_CENTER.lon],
      zoom: DEFAULT_ZOOM,
      zoomControl: true,
      attributionControl: false,
    });
    map.on('click', (event: L.LeafletMouseEvent) => {
      // 底图坐标 → WGS-84 再上抛，保证内部状态与底图无关
      const raw: GeoPoint = { lat: event.latlng.lat, lon: event.latlng.lng };
      onPointChangeRef.current(toWgs84(raw, BASEMAPS[basemapRef.current].crs));
    });
    mapRef.current = map;

    // 容器尺寸变化后（编辑框滚动、窗口缩放）必须 invalidateSize，否则瓦片错位
    const observer = new ResizeObserver(() => map.invalidateSize());
    observer.observe(holder);

    return () => {
      observer.disconnect();
      map.remove();
      mapRef.current = null;
      tileRef.current = null;
      pickedRef.current = null;
      savedRef.current = null;
    };
  }, []);

  // 底图图层：切换时只换瓦片源（标记位置由下面两个 effect 按新坐标系重算），不重建地图
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const config = BASEMAPS[basemap];
    tileRef.current?.remove();
    tileRef.current = L.tileLayer(config.url, {
      subdomains: config.subdomains ?? 'abc',
      minZoom: 3,
      maxZoom: 18,
    }).addTo(map);
    return () => {
      tileRef.current?.remove();
      tileRef.current = null;
    };
  }, [basemap]);

  // 已有定位标记：WGS-84 → 底图坐标系后落点
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    if (!savedGps) {
      savedRef.current?.remove();
      savedRef.current = null;
      return;
    }
    const base = fromWgs84(savedGps, BASEMAPS[basemap].crs);
    const latlng = L.latLng(base.lat, base.lon);
    if (savedRef.current) {
      savedRef.current.setLatLng(latlng);
    } else {
      savedRef.current = L.circleMarker(latlng, {
        radius: 10,
        color: tokens.color.text.base,
        weight: 1.5,
        dashArray: '3 3',
        fillOpacity: 0,
      }).addTo(map);
    }
  }, [savedGps, basemap]);

  // 当前选点标记
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    if (!point) {
      pickedRef.current?.remove();
      pickedRef.current = null;
      return;
    }
    const base = fromWgs84(point, BASEMAPS[basemap].crs);
    const latlng = L.latLng(base.lat, base.lon);
    if (pickedRef.current) {
      pickedRef.current.setLatLng(latlng);
    } else {
      pickedRef.current = L.circleMarker(latlng, {
        radius: 7,
        color: tokens.color.background,
        weight: 2,
        fillColor: tokens.color.accent,
        fillOpacity: 1,
      }).addTo(map);
    }
  }, [point, basemap]);

  // 首次拿到已有定位时把视野聚焦过去（没有定位就用默认中心点）
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !savedGps) return;
    const base = fromWgs84(savedGps, BASEMAPS[basemapRef.current].crs);
    map.setView([base.lat, base.lon], FOCUS_ZOOM);
  }, [savedGps]);

  /* ------------------------------------------------------- 搜索地点 / 定位当前位置 */

  const [query, setQuery] = useState('');
  /** 搜索结果；空数组 = 搜过但没命中（与「还没搜过」由 error 文案区分开） */
  const [hits, setHits] = useState<readonly PlaceHit[]>([]);
  /** 正在进行的动作：搜索与定位共用一个锁，避免两个请求的结果互相覆盖 */
  const [busy, setBusy] = useState<'search' | 'locate' | null>(null);
  const [error, setError] = useState<string | null>(null);

  /** 把标记与视野一起挪到某个 WGS-84 点：搜索命中和定位当前位置的唯一出口 */
  const flyTo = useCallback(
    (target: GeoPoint) => {
      const map = mapRef.current;
      const base = fromWgs84(target, BASEMAPS[basemapRef.current].crs);
      map?.setView([base.lat, base.lon], FOCUS_ZOOM);
      setHits([]);
      setError(null);
      onPointChangeRef.current(target);
    },
    [],
  );

  const runSearch = useCallback(
    async (event: FormEvent) => {
      event.preventDefault();
      const keyword = query.trim();
      if (!keyword || busy) return;
      setBusy('search');
      setError(null);
      try {
        const found = await searchPlaces(keyword);
        setHits(found);
        // 命中为零与失败是两件事，提示也分开写：前者提示更换关键词，后者提示重试
        if (found.length === 0) setError(`未找到「${keyword}」，请使用更具体的写法`);
      } catch (caught) {
        setHits([]);
        setError(caught instanceof Error ? caught.message : '地点搜索失败');
      } finally {
        setBusy(null);
      }
    },
    [query, busy],
  );

  const runLocate = useCallback(async () => {
    if (busy) return;
    setBusy('locate');
    setError(null);
    try {
      flyTo(await locateCurrent());
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : '定位失败');
    } finally {
      setBusy(null);
    }
  }, [busy, flyTo]);

  const baseConfig = BASEMAPS[basemap];
  // ① 底图原始坐标（就是提交给后端的那一对数 + crs）
  const baseCoords = point ? fromWgs84(point, baseConfig.crs) : null;
  // ③ 与文件里已有定位的偏差（都在 WGS-84 下比，才有意义）
  const offset = point && savedGps ? distanceMeters(point, savedGps) : null;

  return (
    <div className="gps">
      <div className="gps__toolbar">
        <span className="gps__toolbar-label">底图</span>
        <PillBar
          neutral
          options={BASEMAP_OPTIONS}
          value={basemap}
          onChange={onBasemapChange}
          ariaLabel="底图选择"
        />
        <span
          className="gps__toolbar-tip"
          title="选点固定按国际标准坐标记录；切换底图时会自动换算，因此标记始终停在同一真实地点"
        >
          在图上单击选点
        </span>
      </div>

      {/* 搜索地点 / 定位当前位置：两条都比「拖地图再点」快一步。
          用 form 而非独立的 input + onClick —— 回车提交是搜索框的基本预期。 */}
      <form className="gps__search" onSubmit={runSearch}>
        <input
          className="gps__search-input"
          type="search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="搜索地点，如「外滩」「Tokyo Tower」"
          aria-label="搜索地点"
        />
        <button type="submit" className="gps__btn" disabled={busy !== null || query.trim() === ''}>
          {busy === 'search' ? '搜索中…' : '搜索'}
        </button>
        <button type="button" className="gps__btn" onClick={runLocate} disabled={busy !== null}>
          {busy === 'locate' ? '定位中…' : '定位当前位置'}
        </button>
      </form>

      {/* 命中列表：坐标一并列出，便于确认是否是目标地点 */}
      {hits.length > 0 ? (
        <ul className="gps__hits">
          {hits.map((hit) => (
            <li key={`${hit.lat},${hit.lon},${hit.label}`}>
              <button type="button" className="gps__hit" onClick={() => flyTo(hit)}>
                <span className="gps__hit-label">{hit.label}</span>
                <span className="gps__hit-coord">{formatLatLon(hit.lat, hit.lon, 5)}</span>
              </button>
            </li>
          ))}
        </ul>
      ) : null}

      {error ? <p className="gps__error">{error}</p> : null}

      {/* leaflet 容器必须有明确高度（见 app.css 的 .gps-map） */}
      <div className="gps-map" ref={holderRef} />

      <div className="gps-readout">
        <div className="gps-readout__row">
          ① 地图上的位置（{CRS_LABEL[baseConfig.crs]}）：
          {baseCoords ? formatLatLon(baseCoords.lat, baseCoords.lon) : '未选点'}
        </div>
        <div className="gps-readout__row is-wgs">
          ② 保存到照片的坐标（国际标准）：
          {point ? formatLatLon(point.lat, point.lon) : '未选点'}
        </div>
        <div className="gps-readout__row">
          ③ 与照片原定位的距离：
          {offset != null ? formatDistance(offset) : savedGps ? '当前无选点' : '照片原本没有定位'}
        </div>
      </div>
    </div>
  );
}