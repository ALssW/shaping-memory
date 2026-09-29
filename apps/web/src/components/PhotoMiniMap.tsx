/**
 * apps/web/src/components/PhotoMiniMap.tsx
 *
 * EXIF 卡片里的「拍摄位置」：一枚嵌在卡片中的小地图，只画这一张照片的坐标。
 *
 * 【为什么是 Leaflet 而不是一张静态瓦片图】需求要的是「与地图画廊同样的点位查看」——
 * 能拖、能缩、能看清周边在哪儿。静态图做不到这些，还得另搭一套拼图逻辑
 * （按 zoom 算瓦片行列再贴成一整张），等于把 Leaflet 已经做对的事重做一遍。
 *
 * 【为什么关掉滚轮缩放】这张地图住在一个**可滚动的卡片**里，且查看器还给整个
 * 查看器挂了滚轮锁（见 Viewer 的「打开期间锁住页面滚动」）。开着滚轮缩放，
 * 指针划过地图时卡片就滚不动了。拖拽 / 双击 / 触摸捏合三样都在，缩放依旧可达。
 *
 * 【坐标系铁律】传进来的 gps 恒为 WGS-84，落点前按底图坐标系 fromWgs84 ——
 * 与 GpsPicker、地图画廊同一处口径。
 */
import { useEffect, useRef } from 'react';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { fromWgs84 } from '@shaping-memory/core';
import type { GeoPoint } from '@shaping-memory/core';

import { BASEMAPS } from './GpsPicker';
import type { BasemapKey } from './GpsPicker';

/** 小地图的固定视野：比选点面板的聚焦档略近，卡片这么小、再远就看不清周边了 */
const MINI_ZOOM = 15;
/** 底图取与地图画廊的默认档同一张（中文标注），免得两处看到的底图不一样 */
const MINI_BASEMAP: BasemapKey = 'amap';

/** 一枚玻璃圆点。外观全在 CSS（app.css 的 .photo-map__dot），这里只负责挂类名 */
function buildDot(): HTMLElement {
  const dot = document.createElement('span');
  dot.className = 'photo-map__dot';
  return dot;
}

interface PhotoMiniMapProps {
  /** 拍摄坐标（WGS-84） */
  gps: GeoPoint;
  /** 照片标题：只用于无障碍标签 */
  title: string;
}

export function PhotoMiniMap({ gps, title }: PhotoMiniMapProps) {
  const holderRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<L.Map | null>(null);
  const markerRef = useRef<L.Marker | null>(null);
  const config = BASEMAPS[MINI_BASEMAP];

  /* 建图只做一次；换页时坐标由下面那个 effect 挪 */
  useEffect(() => {
    const holder = holderRef.current;
    if (!holder || mapRef.current) return;
    const start = fromWgs84(gps, config.crs);
    const map = L.map(holder, {
      center: [start.lat, start.lon],
      zoom: MINI_ZOOM,
      zoomControl: true,
      attributionControl: false,
      scrollWheelZoom: false,
      worldCopyJump: true,
    });
    mapRef.current = map;
    L.tileLayer(config.url, { subdomains: config.subdomains ?? 'abc', minZoom: 3, maxZoom: 19 }).addTo(map);
    markerRef.current = L.marker([start.lat, start.lon], {
      icon: L.divIcon({ className: 'map-marker', html: buildDot(), iconSize: [16, 16] }),
      // 点位不参与交互：它是「说明」，不是「入口」（要进地图画廊请走导航胶囊）
      interactive: false,
      keyboard: false,
    }).addTo(map);

    /* 卡片是「从照片背后滑出来」的：挂载那一刻它还贴在画框里，甚至宽高为 0，
       Leaflet 按那个时候的尺寸算出来的瓦片是错位的。尺寸一变就重算一次。 */
    const observer = new ResizeObserver(() => map.invalidateSize());
    observer.observe(holder);

    return () => {
      observer.disconnect();
      map.remove();
      mapRef.current = null;
      markerRef.current = null;
    };
    // gps 只用作初值：后续变化由下面那个 effect 负责，重建地图会丢瓦片与缩放状态
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [config]);

  /* 换页（照片变了）→ 点位与视野一起挪到新坐标。animate:false —— 这是「换了一张照片」，
     不是「地图被平移了」，缓动会让两件事读起来像同一件。 */
  useEffect(() => {
    const map = mapRef.current;
    const marker = markerRef.current;
    if (!map || !marker) return;
    const moved = fromWgs84(gps, config.crs);
    marker.setLatLng([moved.lat, moved.lon]);
    map.setView([moved.lat, moved.lon], MINI_ZOOM, { animate: false });
  }, [gps, config]);

  return (
    <div className="photo-map-block">
      <p className="photo-map__label">拍摄位置</p>
      <div className="photo-map" ref={holderRef} role="img" aria-label={`${title} 的拍摄位置`} />
      <p className="photo-map__credit">© OpenStreetMap · © 高德</p>
    </div>
  );
}
