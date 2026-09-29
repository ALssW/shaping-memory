/**
 * apps/mobile/src/components/GpsPicker.tsx
 *
 * 地图选点（需求 3a 的 GPS 部分）——与 Web 端 apps/web/src/components/GpsPicker.tsx 同一套逻辑，
 * 只是把 Leaflet 装进 `react-native-webview` 承载的内联页面里，避免引入需要 API Key 的原生地图 SDK。
 *
 * 【坐标口径】底图与 Web 端同样的高德瓦片（GCJ-02），而写进记录的恒为 WGS-84
 * —— 两者在深圳一带差 300–600 米，必须换算。换算只发生在**宿主与页面之间的边界**上，
 * 页面内部一律活在底图坐标系里，不必知道 WGS-84 的存在：
 *   - 注入（选点 / 已有定位 / 搜索命中）：WGS-84 → GCJ-02（fromWgs84）
 *   - 回传（点击底图、点搜索结果）：GCJ-02 → WGS-84（toWgs84）
 * 搜索命中由后端 /geo/places 给出 WGS-84（见 core/geocode.ts），因此注入前也要转一次，
 * 否则那枚箭头会落在真实地点旁边几百米处。
 * 界面仍把「底图坐标」与「写入记录的坐标」两行都列出来，方便人工核对。
 *
 * 【为什么只剩高德一条底图】OSM 瓦片在国内被 DNS 污染 / TCP 阻断（实测连接超时），
 * 留着它只会得到一片灰底，因此不再提供切换。
 *
 * 【离线可用性】只有瓦片与搜索需要联网（界面显式标注）；手动输入十进制度坐标完全不依赖网络，
 * 因此断网时这个面板依旧可用 —— 只是地图是灰的、搜索会失败。
 *
 * 【定位当前位置】走 expo-location（系统定位），与 Web 端的 navigator.geolocation 是同一件事：
 * 都是「把标记与视野移动到当前所在位置」的快捷方式，最终仍落到同一个 onPointChange，
 * 因此落点之后还能在图上继续微调。系统给的是 WGS-84，注入底图前同样要转成 GCJ-02。
 * 【与搜索的区别】搜索由 RN 侧发起（能直接用 core 的 searchPlaces 与已配置好的后端基址），
 * 定位也必须在 RN 侧 —— WebView 里拿不到系统定位权限。
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { WebView } from 'react-native-webview';
import type { WebViewMessageEvent } from 'react-native-webview';
import * as Location from 'expo-location';
import {
  distanceMeters,
  formatDistance,
  formatLatLon,
  fromWgs84,
  isValidLatLon,
  searchPlaces,
  toWgs84,
} from '@shaping-memory/core';
import type { GeoPoint } from '@shaping-memory/core';

import { colors, radius, size, space, text } from '../theme';

/** 没有定位时的默认视野：中国境内（上海），zoom 11 大致覆盖一个市区 */
const DEFAULT_CENTER: GeoPoint = { lat: 31.23, lon: 121.47 };

/**
 * 底图的坐标系 —— 换算的唯一依据，改底图时只改这一个常量。
 * 常量断言而非 `CoordSystem` 注解：让 `fromWgs84(point, BASEMAP_CRS)` 走字面量重载，
 * 同时这里就是「底图 = 高德 = GCJ-02」这条对应关系的落点。
 */
const BASEMAP_CRS = 'gcj02' as const;

/** 选点的字符串键：用来判断「这次变化是不是我自己刚刚发出去的」，避免回灌打断输入 */
function keyOf(point: GeoPoint | null): string {
  return point ? `${point.lat},${point.lon}` : '';
}

/** WGS-84 → 底图坐标：凡是「往页面里灌」的坐标都得先过这一道 */
function toBasemap(point: GeoPoint): GeoPoint {
  return fromWgs84(point, BASEMAP_CRS);
}

/**
 * 内联 Leaflet 页面。通过 `postMessage` 上报选点与搜索请求、由宿主 `injectJavaScript` 回灌
 * 标记与搜索结果，与 Web 端 GpsPicker 的「点击 → 上抛 toWgs84 后的坐标」同一套交互。
 * 【为什么内联而不是加载 remote URL】内联 HTML 不依赖本项目的静态资源托管，
 * 换域名 / 离线打包都不会失效；页面里真正联网的只有瓦片。
 * 【为什么搜索要绕回 RN】内联页面的 URL 是 about:blank，拿相对基址（生产是
 * `/shaping-memory/api`）解析不出真实地址；而且 RN 侧已经有一份能用的 searchPlaces，
 * 在页面里再写一遍等于两处维护同一段逻辑。因此页面只发 `{type:'search', q}`，
 * 由宿主请求后端后用 `window.__setHits` / `window.__setSearchError` 把结果画回来。
 */
function buildMapHtml(initial: GeoPoint | null): string {
  const lat = initial?.lat ?? DEFAULT_CENTER.lat;
  const lon = initial?.lon ?? DEFAULT_CENTER.lon;
  return `<!DOCTYPE html>
<html><head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no"/>
<link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css"/>
<style>
  html,body,#map{height:100%;margin:0;background:#1c1c1e}
  .search{position:absolute;z-index:1000;left:8px;right:8px;top:8px;display:flex;gap:6px}
  .search input{flex:1;height:36px;border-radius:8px;border:0;padding:0 10px;font-size:14px}
  .search button{height:36px;padding:0 12px;border:0;border-radius:8px;background:#e0a44a;color:#1c1c1e;font-weight:600}
  .search button:disabled{opacity:.6}
  /* 命中一屏最多占半张地图，多了自己滚，免得把底图整块盖住 */
  .results{position:absolute;z-index:1000;left:8px;right:8px;top:52px;max-height:45%;overflow-y:auto;background:#2c2c2e;border-radius:8px;display:none}
  .results div{padding:8px 10px;color:#fff;font-size:13px;border-bottom:1px solid #3a3a3c}
  .results div:last-child{border-bottom:0}
</style>
</head><body>
<div class="search"><input id="q" placeholder="搜索地点，如「外滩」"/><button id="go">搜索</button></div>
<div class="results" id="results"></div>
<div id="map"></div>
<script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"></script>
<script>
  var post = function (msg) { if (window.ReactNativeWebView) window.ReactNativeWebView.postMessage(JSON.stringify(msg)); };
  var map = L.map('map', { zoomControl: true, attributionControl: false }).setView([${lat}, ${lon}], 11);
  /* 高德瓦片（GCJ-02）：与 Web 端「高德」底图同一套地址。
     subdomains 必须给，否则单域名并发受限、拖动时瓦片会成片留白。
     页面里落的一切坐标都是底图坐标 —— 换算由宿主在边界处完成（见文件头）。 */
  L.tileLayer('https://webrd0{s}.is.autonavi.com/appmaptile?lang=zh_cn&size=1&scale=1&style=8&x={x}&y={y}&z={z}', { subdomains: '1234', minZoom: 3, maxZoom: 18 }).addTo(map);
  var picked = null, saved = null;
  function drawPicked(lat, lon) {
    if (!picked) { picked = L.circleMarker([lat, lon], { radius: 7, color: '#fff', weight: 2, fillColor: '#e0a44a', fillOpacity: 1 }).addTo(map); }
    else { picked.setLatLng([lat, lon]); }
  }
  function removePicked() { if (picked) { map.removeLayer(picked); picked = null; } }
  function resultsBox() { return document.getElementById('results'); }
  function hideResults() { var box = resultsBox(); box.style.display = 'none'; box.innerHTML = ''; }
  /* 外部同步：落点并把视野聚焦过去 */
  window.__setPoint = function (lat, lon) {
    if (lat == null || lon == null) { removePicked(); return; }
    drawPicked(lat, lon);
    map.setView([lat, lon], Math.max(map.getZoom(), 14));
  };
  /* 手动输入时只挪标记，不抢视野（否则每敲一个字符地图都跳一下） */
  window.__markPoint = function (lat, lon) {
    if (lat == null || lon == null) { removePicked(); return; }
    drawPicked(lat, lon);
  };
  window.__setSaved = function (lat, lon) {
    if (lat == null || lon == null) { if (saved) { map.removeLayer(saved); saved = null; } return; }
    if (!saved) { saved = L.circleMarker([lat, lon], { radius: 10, color: '#fff', weight: 1.5, dashArray: '3 3', fillOpacity: 0 }).addTo(map); }
    else { saved.setLatLng([lat, lon]); }
  };
  /* 搜索忙碌态：请求由宿主发出，结果回灌前一直锁住按钮，避免连点发出多个请求 */
  var busy = false;
  function setBusy(next) {
    busy = next;
    var button = document.getElementById('go');
    button.disabled = next;
    button.textContent = next ? '搜索中…' : '搜索';
  }
  /* 宿主回灌命中列表：点一条即「把标记与视野挪过去」，与 Web 端 flyTo 同一语义 */
  window.__setHits = function (hits) {
    setBusy(false);
    var box = resultsBox();
    box.innerHTML = '';
    if (!hits || !hits.length) { box.style.display = 'none'; return; }
    hits.forEach(function (hit) {
      var row = document.createElement('div');
      row.textContent = hit.label;
      row.onclick = function () {
        hideResults();
        drawPicked(hit.lat, hit.lon);
        map.setView([hit.lat, hit.lon], 15);
        post({ type: 'pick', lat: hit.lat, lon: hit.lon });
      };
      box.appendChild(row);
    });
    box.style.display = 'block';
  };
  /* 宿主回灌失败文案（网络不通 / 上游不可用 / 未搜到），直接铺在输入框下方 */
  window.__setSearchError = function (message) {
    setBusy(false);
    var box = resultsBox();
    box.innerHTML = '';
    var row = document.createElement('div');
    row.textContent = message;
    box.appendChild(row);
    box.style.display = 'block';
  };
  map.on('click', function (event) {
    hideResults();
    drawPicked(event.latlng.lat, event.latlng.lng);
    post({ type: 'pick', lat: event.latlng.lat, lon: event.latlng.lng });
  });
  function search() {
    if (busy) return;
    var q = document.getElementById('q').value.trim();
    if (!q) return;
    hideResults();
    setBusy(true);
    post({ type: 'search', q: q });
  }
  document.getElementById('go').onclick = search;
  document.getElementById('q').addEventListener('keydown', function (event) { if (event.key === 'Enter') search(); });
  post({ type: 'ready' });
</script>
</body></html>`;
}

/* -------------------------------------------------------------------------- */

interface GpsPickerProps {
  /** 当前选点（WGS-84）；null = 没有选点 */
  point: GeoPoint | null;
  /** 文件里已有的定位（WGS-84）；批量编辑传 null */
  savedGps: GeoPoint | null;
  /** 是否已标记「本次清除定位」 */
  cleared: boolean;
  disabled?: boolean;
  /** 选点变化（来自地图或手动输入）；父级会据此解除「已清除」 */
  onPointChange: (point: GeoPoint) => void;
  onClear: () => void;
  onCancelClear: () => void;
}

export function GpsPicker({
  point,
  savedGps,
  cleared,
  disabled = false,
  onPointChange,
  onClear,
  onCancelClear,
}: GpsPickerProps) {
  const viewRef = useRef<WebView>(null);
  const [latText, setLatText] = useState(point ? String(point.lat) : '');
  const [lonText, setLonText] = useState(point ? String(point.lon) : '');
  /** 正在定位（按钮的忙碌态） */
  const [locating, setLocating] = useState(false);
  /** 定位失败 / 无权限的提示；与「选点结果」无关，成功即清空 */
  const [error, setError] = useState<string | null>(null);
  /** 最近一次「本地产生」的选点键（地图回传或手动输入），用于区分外部改动 */
  const local = useRef(keyOf(point));

  /* HTML 只用初始坐标建一次：之后所有变化都走 injectJavaScript，重建 WebView 会丢地图状态 */
  const initial = useRef(point);
  /* 初始视野也落在底图坐标系里 —— 与后面所有注入走同一个换算口径 */
  const html = useMemo(() => buildMapHtml(initial.current ? toBasemap(initial.current) : null), []);

  /* 外部改动（重新载入 / 清除）时同步输入框与地图标记；本地产生的不回灌，避免打断输入 */
  useEffect(() => {
    const key = keyOf(point);
    if (key === local.current) return;
    local.current = key;
    setLatText(point ? String(point.lat) : '');
    setLonText(point ? String(point.lon) : '');
  }, [point]);

  /** 每次选点变化都把标记钉到地图上（含手动输入）；只挪标记、不抢视野 */
  useEffect(() => {
    if (!point) {
      viewRef.current?.injectJavaScript('window.__markPoint(null, null); true;');
      return;
    }
    const base = toBasemap(point);
    viewRef.current?.injectJavaScript(`window.__markPoint(${base.lat}, ${base.lon}); true;`);
  }, [point]);

  /** 文件里已有定位的虚线标记：与当前选点区分开，便于核对是否偏移 */
  useEffect(() => {
    if (!savedGps) {
      viewRef.current?.injectJavaScript('window.__setSaved(null, null); true;');
      return;
    }
    const base = toBasemap(savedGps);
    viewRef.current?.injectJavaScript(`window.__setSaved(${base.lat}, ${base.lon}); true;`);
  }, [savedGps]);

  /**
   * 搜索地点：请求在 RN 侧发出（core 的 searchPlaces），WebView 只负责画结果。
   * 【为什么不把后端基址写入内联 HTML】基址可能是相对路径（生产是 `/shaping-memory/api`），
 * 而内联页面的 URL 是 about:blank，相对地址解析不出真实主机；绕回 RN 就没有这层不确定性，
 * 同时也复用了 Web 端那一条已经验证过的请求链路。
   */
  const runSearch = async (keyword: string): Promise<void> => {
    const query = keyword.trim();
    if (query === '') return;
    const inject = (script: string): void => {
      viewRef.current?.injectJavaScript(`${script} true;`);
    };
    try {
      const hits = await searchPlaces(query);
      // 命中为零与失败是两件事，提示也分开写：前者提示用户改用更具体的写法，后者提示用户重试（与 Web 端一致）
      if (hits.length === 0) {
        inject(`window.__setSearchError(${JSON.stringify(`未找到「${query}」，请改用更具体的写法`)});`);
        return;
      }
      /* 命中坐标是 WGS-84（后端转过），页面要按底图坐标系画 —— 注入前换一次，
         否则那枚标记会落在真实地点旁边几百米处。label 原样带上，只换 lat/lon。 */
      const forMap = hits.map((hit) => ({ ...hit, ...toBasemap({ lat: hit.lat, lon: hit.lon }) }));
      inject(`window.__setHits(${JSON.stringify(forMap)});`);
    } catch (caught) {
      inject(`window.__setSearchError(${JSON.stringify(caught instanceof Error ? caught.message : '地点搜索失败')});`);
    }
  };

  const handleMessage = (event: WebViewMessageEvent): void => {
    try {
      const message = JSON.parse(event.nativeEvent.data) as { type?: string; lat?: number; lon?: number; q?: string };
      /* 搜索请求由页面发起、宿主执行：结果通过 injectJavaScript 回灌 */
      if (message.type === 'search') {
        void runSearch(typeof message.q === 'string' ? message.q : '');
        return;
      }
      if (message.type !== 'pick') return;
      if (typeof message.lat !== 'number' || typeof message.lon !== 'number') return;
      if (!isValidLatLon(message.lat, message.lon)) return;
      /* 页面回传的是底图坐标（GCJ-02），上抛前换回 WGS-84 —— 上游与写进记录的都是它 */
      const next = toWgs84({ lat: message.lat, lon: message.lon }, BASEMAP_CRS);
      local.current = keyOf(next);
      setLatText(String(next.lat));
      setLonText(String(next.lon));
      onPointChange(next);
    } catch {
      // 页面里的其它 postMessage 与本组件无关，忽略即可
    }
  };

  const updateManual = (which: 'lat' | 'lon', value: string): void => {
    if (which === 'lat') setLatText(value);
    else setLonText(value);
    const latText2 = which === 'lat' ? value : latText;
    const lonText2 = which === 'lon' ? value : lonText;
    const lat = latText2.trim() === '' ? null : Number(latText2);
    const lon = lonText2.trim() === '' ? null : Number(lonText2);
    /* 只填一半不参与提交（也不清掉已有定位），与 Web 端「两半都合法才算选点」一致 */
    if (lat == null || lon == null || !isValidLatLon(lat, lon)) return;
    const next = { lat, lon };
    local.current = keyOf(next);
    /* 输入框里填的、以及留给上层的都是 WGS-84；只有图纸上那个标记要按底图坐标落 */
    const base = toBasemap(next);
    viewRef.current?.injectJavaScript(`window.__markPoint(${base.lat}, ${base.lon}); true;`);
    onPointChange(next);
  };

  /**
   * 定位当前位置：拿系统定位，成功就把标记与视野一起挪过去。
   * 每一条失败路径都给出可操作的中文提示，而不是静默无反馈 ——
   * 定位失败的原因（未授权 / 定位未开启）用户可自行修复，前提是了解失败原因。
   */
  const locate = async (): Promise<void> => {
    if (locating || disabled) return;
    setLocating(true);
    setError(null);
    try {
      const permission = await Location.requestForegroundPermissionsAsync();
      if (!permission.granted) {
        setError('缺少定位权限：请在系统设置中允许「塑忆」使用位置信息');
        return;
      }
      const position = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced });
      const next = { lat: position.coords.latitude, lon: position.coords.longitude };
      if (!isValidLatLon(next.lat, next.lon)) {
        setError('定位结果超出有效范围，请稍后重试');
        return;
      }
      local.current = keyOf(next);
      setLatText(String(next.lat));
      setLonText(String(next.lon));
      /* __setPoint 而不是 __markPoint：定位的语义就是「把视野挪到我现在的位置」 */
      const base = toBasemap(next);
      viewRef.current?.injectJavaScript(`window.__setPoint(${base.lat}, ${base.lon}); true;`);
      onPointChange(next);
    } catch {
      setError('定位失败：请检查系统定位开关是否已打开');
    } finally {
      setLocating(false);
    }
  };

  const offset = point && savedGps ? distanceMeters(point, savedGps) : null;
  const offsetText = offset != null ? formatDistance(offset) : savedGps ? '当前无选点' : '文件里原本没有定位';
  /* 底图坐标（GCJ-02）：只用于下面那行读数，与写入记录的 WGS-84 并排显示以便核对 */
  const baseCoords = point ? toBasemap(point) : null;

  return (
    <View style={styles.wrap}>
      <View style={styles.toolbar}>
        <View style={styles.badge}>
          <Text style={styles.badgeText}>高德底图 · 需联网</Text>
        </View>
        {/* 定位当前位置：与 Web 端 GpsPicker 的同一枚按钮（那里走 navigator.geolocation） */}
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="定位当前位置"
          accessibilityState={{ disabled: disabled || locating }}
          disabled={disabled || locating}
          onPress={locate}
          style={({ pressed }) => [
            styles.locate,
            (disabled || locating) && styles.locateOff,
            pressed && styles.pressed,
          ]}
        >
          <Text style={styles.locateText}>{locating ? '定位中…' : '定位当前位置'}</Text>
        </Pressable>
      </View>
      {/* 出错时占掉提示位：错的正是「为什么刚才那一下没反应」，与提示同一处讲最省眼神 */}
      <Text style={[styles.toolbarTip, error ? styles.locateError : null]} numberOfLines={2}>
        {error ?? '在图上单击选点，或直接输入坐标'}
      </Text>

      <WebView
        ref={viewRef}
        source={{ html }}
        originWhitelist={['*']}
        javaScriptEnabled
        domStorageEnabled
        setSupportMultipleWindows={false}
        onMessage={handleMessage}
        style={styles.map}
      />

      <View style={styles.manualRow}>
        <ManualInput
          label="纬度"
          value={latText}
          disabled={disabled}
          onChange={(value) => updateManual('lat', value)}
        />
        <ManualInput
          label="经度"
          value={lonText}
          disabled={disabled}
          onChange={(value) => updateManual('lon', value)}
        />
      </View>

      <View style={styles.statusRow}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={cleared ? '取消清除定位' : '清除定位'}
          accessibilityState={{ selected: cleared }}
          disabled={disabled || (!cleared && !point && !savedGps)}
          onPress={cleared ? onCancelClear : onClear}
          style={({ pressed }) => [
            styles.clear,
            cleared && styles.clearOn,
            (disabled || (!cleared && !point && !savedGps)) && styles.clearDisabled,
            pressed && styles.pressed,
          ]}
        >
          <Text style={[styles.clearText, cleared && styles.clearTextOn]}>
            {cleared ? '已标记清除，点此取消' : '清除定位'}
          </Text>
        </Pressable>
        <Text style={styles.statusText}>这张照片{savedGps ? '已有定位' : '暂无定位'}</Text>
      </View>

      <View style={styles.readout}>
        <Text style={styles.readoutRow}>
          ① 地图上的位置（高德地图）：{baseCoords ? formatLatLon(baseCoords.lat, baseCoords.lon) : '未选点'}
        </Text>
        <Text style={[styles.readoutRow, styles.readoutWgs]}>
          ② 保存到照片的坐标（国际标准）：{point ? formatLatLon(point.lat, point.lon) : '未选点'}
        </Text>
        <Text style={styles.readoutRow}>③ 与照片原定位的距离：{offsetText}</Text>
        {cleared ? <Text style={styles.clearNote}>保存后将移除这张照片的定位。</Text> : null}
      </View>
    </View>
  );
}

function ManualInput({
  label,
  value,
  disabled,
  onChange,
}: {
  label: string;
  value: string;
  disabled: boolean;
  onChange: (value: string) => void;
}) {
  return (
    <View style={styles.manualField}>
      <Text style={styles.manualLabel}>{label}</Text>
      <TextInput
        style={styles.input}
        value={value}
        editable={!disabled}
        keyboardType="numbers-and-punctuation"
        placeholder="十进制"
        placeholderTextColor={colors.text.quaternary}
        underlineColorAndroid="transparent"
        onChangeText={onChange}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { gap: space.s8 },
  toolbar: { flexDirection: 'row', alignItems: 'center', gap: space.s8 },
  badge: {
    paddingHorizontal: space.s8,
    paddingVertical: space.s2,
    borderRadius: radius.full,
    backgroundColor: colors.material.thick,
  },
  badgeText: { ...text.caption, color: colors.accent },
  toolbarTip: { ...text.meta, color: colors.text.quaternary, flexShrink: 1 },

  /* 定位按钮：与「清除定位」同一档胶囊，主色文字表明它是「去找一个位置」的动作 */
  locate: {
    paddingHorizontal: space.s12,
    paddingVertical: space.s4,
    borderRadius: radius.full,
    backgroundColor: colors.material.thin,
  },
  locateOff: { opacity: 0.4 },
  locateText: { ...text.caption, color: colors.accent },
  locateError: { color: colors.danger },

  map: { height: 240, borderRadius: radius.lg, overflow: 'hidden', backgroundColor: colors.material.thin },

  manualRow: { flexDirection: 'row', gap: space.s8 },
  manualField: { flex: 1, gap: space.s4 },
  manualLabel: { ...text.caption, color: colors.text.tertiary },
  input: {
    ...text.body,
    height: size.button.md,
    paddingHorizontal: space.s12,
    borderRadius: radius.lg,
    backgroundColor: colors.material.thin,
  },

  statusRow: { flexDirection: 'row', alignItems: 'center', gap: space.s8 },
  statusText: { ...text.meta, color: colors.text.quaternary },
  clear: {
    paddingHorizontal: space.s12,
    paddingVertical: space.s4,
    borderRadius: radius.full,
    backgroundColor: colors.material.thin,
  },
  clearOn: { backgroundColor: colors.material.thick },
  clearDisabled: { opacity: 0.4 },
  clearText: { ...text.caption, color: colors.text.secondary },
  clearTextOn: { color: colors.danger },
  pressed: { opacity: 0.7 },

  readout: { gap: space.s2 },
  readoutRow: { ...text.meta, color: colors.text.tertiary },
  readoutWgs: { color: colors.text.secondary },
  clearNote: { ...text.meta, color: colors.danger },
});
