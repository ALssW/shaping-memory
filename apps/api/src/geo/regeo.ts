/**
 * apps/api/src/geo/regeo.ts
 *
 * 逆地理编码（坐标 → 可读地名）：把照片里的 WGS-84 定位换成「省市区」这样的可读表述。
 *
 * 【为什么与地名搜索分开放】两者都问高德，但回答的是相反的问题：
 *   place/text   = 名字 → 坐标（用户在地图上搜地点）
 *   geocode/regeo = 坐标 → 名字（照片有定位，要显示「在哪儿拍的」）
 * 逆解是**按坐标缓存**的：同一机位的几十张照片共用一次请求，缓存必须与搜索路径分开，
 * 否则搜过的关键词会被当成坐标命中。
 *
 * 【坐标系铁律】EXIF 存 WGS-84，高德底图吃 GCJ-02，因此先 fromWgs84 转过去再发请求 ——
 * 与写入链路（toWgs84）方向相反、口径相同（见 core 的 geo.ts）。
 *
 * 【为什么失败一律返回 null 而不抛错】地点只是展示增强：反解不到就整项不显示，
 * 绝不能因为它让「保存拍摄参数」这类主流程失败。
 */
import { fromWgs84 } from '@shaping-memory/core';

/** 上游超时：反解是旁路增强，宁可放弃也不应阻塞请求 */
const TIMEOUT_MS = 8000;
/** 缓存上限：键是坐标桶，本档案远小于它；超了整体清空，避免长期运行后无界增长 */
const CACHE_MAX = 500;
/** 坐标分桶精度：4 位小数约 11 米 —— 省市区在这个尺度上必然一致，配额则显著节省 */
const BUCKET_DIGITS = 4;

/** 坐标桶 → 已解出的地名；只增不减，超过 CACHE_MAX 时整体清空 */
const placeCache = new Map<string, string>();

/** 高德 regeo 的地址组成（只声明用得到的字段） */
interface AmapRegeoComponent {
  province?: string | string[];
  city?: string | string[];
  district?: string | string[];
}

/** 高德 geocode/regeo 的响应外壳 */
interface AmapRegeoResponse {
  /** "1" 成功，"0" 失败 */
  status?: string;
  info?: string;
  regeocode?: {
    formatted_address?: string | string[];
    addressComponent?: AmapRegeoComponent;
  };
}

/** 取一个字符串字段：高德对空字段返回 `[]` 而不是 `""`，直接当字符串用会得到异常值 */
function text(value: string | string[] | undefined): string {
  if (Array.isArray(value)) return value.length > 0 ? String(value[0] ?? '') : '';
  return typeof value === 'string' ? value : '';
}

/**
 * 拼「省 市 区」（无分隔符，符合中文地名的书写习惯）。
 * 直辖市会返回 province=北京市、city=北京市，不去重就会拼成「北京市北京市朝阳区」。
 * 三者都为空时回落到 formatted_address（境外坐标常见这种形态）。
 */
function buildLabel(component: AmapRegeoComponent, fallback: string): string | null {
  const parts: string[] = [];
  for (const name of [text(component.province), text(component.city), text(component.district)]) {
    if (name !== '' && !parts.includes(name)) parts.push(name);
  }
  const label = parts.join('');
  if (label !== '') return label;
  return fallback === '' ? null : fallback;
}

/**
 * 把 WGS-84 坐标反解成可读地名；未配置 key、上游异常、查不到地址一律返回 null。
 * @param key 高德「Web 服务」key（由调用方从配置注入，本模块不读环境变量）
 */
export async function reverseGeocode(key: string, lat: number, lon: number): Promise<string | null> {
  const trimmedKey = key.trim();
  if (trimmedKey === '') {
    console.warn('[geo] 未配置 AMAP_KEY，拍摄地点反解不可用');
    return null;
  }

  // 命中缓存即返回：同一机位的成组照片因此只花一次配额
  const cacheKey = `${lat.toFixed(BUCKET_DIGITS)},${lon.toFixed(BUCKET_DIGITS)}`;
  const cached = placeCache.get(cacheKey);
  if (cached !== undefined) return cached;

  const gcj = fromWgs84({ lat, lon }, 'gcj02');
  const url =
    'https://restapi.amap.com/v3/geocode/regeo' +
    `?key=${encodeURIComponent(trimmedKey)}` +
    // location 固定为 "经度,纬度"，顺序与 lat/lon 相反，避免看反
    `&location=${gcj.lon.toFixed(6)},${gcj.lat.toFixed(6)}&extensions=base`;

  /* AbortSignal.timeout 在 Node 18+ 可用；缺失时退化为不设超时，
     比整条反解直接报错更可取 */
  const signal = typeof AbortSignal.timeout === 'function' ? AbortSignal.timeout(TIMEOUT_MS) : undefined;
  let body: AmapRegeoResponse;
  try {
    const response = await fetch(url, { signal, headers: { Accept: 'application/json' } });
    if (!response.ok) {
      console.warn(`[geo] 逆地理编码响应异常 ${response.status}`);
      return null;
    }
    body = (await response.json()) as AmapRegeoResponse;
  } catch (err) {
    console.warn('[geo] 逆地理编码请求失败：', (err as Error).message);
    return null;
  }

  if (body.status !== '1') {
    // info 常见为 INVALID_USER_KEY / DAILY_QUERY_OVER_LIMIT —— 属实现细节，只入控制台
    console.warn(`[geo] 逆地理编码返回失败：${body.info ?? 'unknown'}`);
    return null;
  }

  const regeocode = body.regeocode;
  const label = buildLabel(regeocode?.addressComponent ?? {}, text(regeocode?.formatted_address));
  if (label === null) return null;

  if (placeCache.size >= CACHE_MAX) placeCache.clear();
  placeCache.set(cacheKey, label);
  return label;
}