/**
 * apps/mobile/src/components/PhotoMiniMap.tsx
 *
 * EXIF 卡片里的「拍摄位置」：一枚嵌在卡片中的小地图，只画这一张照片的坐标。
 * 与 Web 端 apps/web/src/components/PhotoMiniMap.tsx 同一套语义 ——
 * 可拖、可缩、能看清周边在哪儿，因此不是一张静态瓦片图（静态图还需自行按 zoom
 * 计算瓦片行列再拼成一整张，等于重复实现 Leaflet 已妥善处理的部分）。
 *
 * 【为什么又是内联 Leaflet + WebView】与 MapScreen / GpsPicker 同一个决定：
 * 项目里没有原生地图 SDK（那要 API Key），WebView 承载 Leaflet 是唯一零密钥的路径，
 * 底图配置与坐标换算也与那两处共用同一份口径（高德 / GCJ-02）。
 *
 * 【坐标系铁律】传进来的 gps 恒为 WGS-84，落点前按底图坐标系 fromWgs84。
 * 页面里不存第二份换算代码 —— 换底图只需改这里的 BASEMAP 常量。
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { WebView } from 'react-native-webview';
import type { WebViewMessageEvent } from 'react-native-webview';
import { fromWgs84 } from '@shaping-memory/core';
import type { GeoPoint } from '@shaping-memory/core';

import { accentOpacity, accentRgba, colors, elevationCssShadow, radius, space, text, textRgba } from '../theme';

/** 小地图的固定视野：比选点面板的聚焦档略近，卡片这么小、再远就看不清周边了 */
const MINI_ZOOM = 15;
/** 小地图高度（与 Web 的 .photo-map 同值） */
const MINI_HEIGHT = 132;
/** 底图取与地图画廊的默认档同一张（中文标注），免得两处看到的底图不一样 */
const BASEMAP = {
  url: 'https://webrd0{s}.is.autonavi.com/appmaptile?lang=zh_cn&size=1&scale=1&style=8&x={x}&y={y}&z={z}',
  subdomains: '1234',
  crs: 'gcj02',
} as const;

/**
 * 内联 Leaflet 页面：只有一枚点位，没有其它交互负担。
 * 视觉与地图画廊的针脚同一套玻璃语汇 —— 主色芯 + 玻璃环 + 中性阴影。
 */
function buildMiniHtml(initial: GeoPoint): string {
  const start = fromWgs84(initial, BASEMAP.crs);
  const accent = JSON.stringify(colors.accent);
  const background = JSON.stringify(colors.background);
  const textColor = JSON.stringify(colors.text.base);
  /** 玻璃描边：与 Web 的 color-mix(text-base 34%) 同一口径（RN 侧算好 rgba 后写入） */
  const hairline = JSON.stringify(textRgba(0.34));
  const pad = JSON.stringify(colors.material.medium);
  /** 点位四周那圈淡淡的 accent 光晕：与 Web 的 accent-wash 同一档 */
  const wash = JSON.stringify(accentRgba(accentOpacity.wash));
  const ring = JSON.stringify(textRgba(0.65));
  return `<!DOCTYPE html>
<html><head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no"/>
<link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css"/>
<style>
  html,body,#map{height:100%;margin:0;background:${background}}
  .leaflet-container{background:${background};font-family:inherit}
  /* 点位：主色芯 + 玻璃环。box-sizing 必须显式给 —— Leaflet 按 iconSize 取锚点中点，
     边框算在盒外会让圆点比锚点偏出 3px */
  .dot{box-sizing:border-box;display:block;width:16px;height:16px;border-radius:50%;
    background:${accent};border:3px solid ${hairline};
    box-shadow:0 0 0 1px ${ring}, 0 0 0 6px ${wash}, ${elevationCssShadow}}
  .mk{background:none;border:0}
  /* 缩放控件默认白底黑边，与暗色卡片冲突：换成材质色 + 文字色图标 */
  .leaflet-control-zoom a{background:${pad};color:${textColor};border-color:${hairline}}
</style>
</head><body>
<div id="map"></div>
<script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"></script>
<script>
(function(){
  var post = function (m) { if (window.ReactNativeWebView) window.ReactNativeWebView.postMessage(JSON.stringify(m)); };
  var map = L.map('map', { zoomControl: true, attributionControl: false, worldCopyJump: true })
    .setView([${start.lat}, ${start.lon}], ${MINI_ZOOM});
  L.tileLayer(${JSON.stringify(BASEMAP.url)}, { subdomains: ${JSON.stringify(BASEMAP.subdomains)}, minZoom: 3, maxZoom: 19 }).addTo(map);
  var dot = L.marker([${start.lat}, ${start.lon}], {
    icon: L.divIcon({ className: 'mk', html: '<span class="dot"></span>', iconSize: [16, 16] }),
    /* 点位不参与交互：它是「说明」，不是「入口」（要进地图画廊请走导航胶囊） */
    interactive: false,
    keyboard: false
  }).addTo(map);
  /* 换页（照片变了）→ 点位与视野一起挪到新坐标。animate:false —— 这是「换了一张照片」，
     不是「地图被平移了」，缓动会让两件事读起来像同一件 */
  window.__setSpot = function (lat, lon) { dot.setLatLng([lat, lon]); map.setView([lat, lon], ${MINI_ZOOM}, { animate: false }); };
  post({ type: 'ready' });
})();
</script>
</body></html>`;
}

interface PhotoMiniMapProps {
  /** 拍摄坐标（WGS-84） */
  gps: GeoPoint;
  /** 照片标题：只用于无障碍标签 */
  title: string;
}

export function PhotoMiniMap({ gps, title }: PhotoMiniMapProps) {
  const viewRef = useRef<WebView>(null);
  /** 页面就绪前的 injectJavaScript 会丢，所有下发都以它为闸门 */
  const [ready, setReady] = useState(false);
  /* HTML 只用首帧坐标建一次：之后换页都走 injectJavaScript，重建 WebView 会丢瓦片与缩放状态 */
  const initial = useRef(gps);
  const html = useMemo(() => buildMiniHtml(initial.current), []);

  useEffect(() => {
    if (!ready) return;
    const moved = fromWgs84(gps, BASEMAP.crs);
    viewRef.current?.injectJavaScript(`window.__setSpot(${moved.lat}, ${moved.lon}); true;`);
  }, [gps, ready]);

  /* 页面里的 ready 之外的消息与本文无关，忽略即可 */
  const handleMessage = (event: WebViewMessageEvent): void => {
    try {
      if ((JSON.parse(event.nativeEvent.data) as { type?: string }).type === 'ready') setReady(true);
    } catch {
      // 非 JSON 的同源消息，忽略
    }
  };

  return (
    <View style={styles.block}>
      <Text style={styles.label}>拍摄位置</Text>
      <WebView
        ref={viewRef}
        source={{ html }}
        originWhitelist={['*']}
        javaScriptEnabled
        domStorageEnabled
        setSupportMultipleWindows={false}
        onMessage={handleMessage}
        style={styles.map}
        accessibilityLabel={`${title} 的拍摄位置`}
      />
      {/* 底图只有高德一张，因此署名也只挂高德 —— 留着 OSM 的字样等于给没用到的一方挂名 */}
      <Text style={styles.credit}>© 高德</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  /* 左右内缩交给宿主容器（EXIF 正文自己有一档 padding），这里只管与下方元数据行的间距 */
  block: { marginBottom: space.s8 },
  label: { ...text.meta, color: colors.text.tertiary, marginBottom: space.s4 },
  /* 瓦片没到之前先铺材质色，免得在暗色卡片里闪一块白 */
  map: {
    height: MINI_HEIGHT,
    borderRadius: radius.md,
    overflow: 'hidden',
    backgroundColor: colors.material.thin,
  },
  /* 署名：与地图画廊右下的 credit 是同一句话，两处都省不掉 */
  credit: { ...text.caption, color: colors.text.quaternary, textAlign: 'right', marginTop: space.s4 },
});
