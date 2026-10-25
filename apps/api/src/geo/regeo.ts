/**
 * apps/api/src/geo/regeo.ts
 *
 * 逆地理编码（坐标 → 可读地名）：把照片里的 WGS-84 定位换成「广东 · 深圳」这样的可读表述，
 * 并结构化给出省 / 市两个行政区字段供搜索面板筛选。省、市名一律去行政层级后缀
 * （「广东省 · 深圳市」→「广东 · 深圳」，见 trimAdminSuffix）。
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

/** 逆解结果：结构化的省 / 市（供筛选）+ 展示标签（「省 · 市」分隔、专名去后缀） */
export interface PlaceInfo {
  /** 展示用地名，格式统一「广东 · 深圳」；两者皆无时回落到高德的 formatted_address（境外坐标常见） */
  label: string;
  /** 省级专名（已去行政层级后缀，如「广东」）；无省级时为 null */
  province: string | null;
  /** 市级专名（已去行政层级后缀，如「深圳」）；无市级时为 null */
  city: string | null;
}

/** 坐标桶 → 已解出的地名；只增不减，超过 CACHE_MAX 时整体清空 */
const placeCache = new Map<string, PlaceInfo>();

/** 高德 regeo 的地址组成（只声明用得到的字段） */
interface AmapRegeoComponent {
  province?: string | string[];
  city?: string | string[];
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
 * 省级 + 地级的行政层级后缀全集（最长优先匹配，不可遗漏）：
 *   省级：省 / 自治区 / 特别行政区（直辖市名以「市」结尾，由地级后缀覆盖）
 *   地级：市 / 地区 / 自治州 / 盟
 * 【为什么只去后缀、不碰专名】「广西壮族自治区」里的「壮族」是专名的一部分而非行政层级字符，
 * 只有结尾的「自治区」表达行政层级 —— 去后缀即止，其余字符一字不动。
 * 【为什么必须最长优先】「特别行政区」「自治区」「自治州」都以单字「区 / 州」的形态收尾，
 * 若先匹配短后缀就会把「香港特别行政」这种残缺名留下来。
 */
const ADMIN_SUFFIXES = ['特别行政区', '自治区', '自治州', '地区', '省', '市', '盟'] as const;

/**
 * 去掉行政区名称结尾的行政层级后缀：「广东省」→「广东」、「延边朝鲜族自治州」→「延边朝鲜族」。
 * 只按结尾最长匹配去除一次；不含后缀（或削完会成空串）的名称原样返回。
 */
export function trimAdminSuffix(name: string): string {
  for (const suffix of ADMIN_SUFFIXES) {
    // 名称不能被削成空串：异常短名兜底保留，绝不产出空内容
    if (name.length > suffix.length && name.endsWith(suffix)) {
      return name.slice(0, -suffix.length);
    }
  }
  return name;
}

/**
 * 「省 · 市」口径的展示地名逐段去后缀：「广东省 · 深圳市」→「广东 · 深圳」。
 * 分隔符与空段原样保留 —— 历史数据与 buildPlace 的拼出口径共用这一个修剪函数。
 */
export function trimPlaceLabel(label: string): string {
  return label
    .split(' · ')
    .map((part) => trimAdminSuffix(part))
    .join(' · ');
}

/**
 * 构造「省 · 市」口径的逆解结果。
 * 直辖市会返回 province=北京市、city=北京市，不去重会拼成「北京 · 北京」——
 * 同名时只留一份。市级缺失（省直辖县级行政区等）时只展示省级。
 * 省、市都为空时回落到 formatted_address（境外坐标常见这种形态），此时无结构化省/市。
 */
function buildPlace(component: AmapRegeoComponent, fallback: string): PlaceInfo | null {
  /* 省、市入列前先去行政层级后缀（见 trimAdminSuffix）：
     展示与搜索筛选下拉因此都是「广东 / 深圳」口径，不再带「省 / 市」尾巴。 */
  const province = trimAdminSuffix(text(component.province)) || null;
  const city = trimAdminSuffix(text(component.city)) || null;
  if (province != null || city != null) {
    const label = province != null && city != null && province !== city ? `${province} · ${city}` : (province ?? city ?? '');
    return { label, province, city };
  }
  return fallback === '' ? null : { label: fallback, province: null, city: null };
}

/**
 * 把 WGS-84 坐标反解成「省 · 市」地名；未配置 key、上游异常、查不到地址一律返回 null。
 * @param key 高德「Web 服务」key（由调用方从配置注入，本模块不读环境变量）
 */
export async function reverseGeocode(key: string, lat: number, lon: number): Promise<PlaceInfo | null> {
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
  const place = buildPlace(regeocode?.addressComponent ?? {}, text(regeocode?.formatted_address));
  if (place === null) return null;

  if (placeCache.size >= CACHE_MAX) placeCache.clear();
  placeCache.set(cacheKey, place);
  return place;
}