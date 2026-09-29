/**
 * packages/core/src/geo.ts
 *
 * 地理坐标工具：GPS(WGS-84) ↔ 国内底图坐标（GCJ-02 / BD-09）的互转。
 *
 * 【为什么必须有这一层】EXIF 里存的 GPSLatitude / GPSLongitude 是 **WGS-84**
 * （全球卫星定位原始坐标）。而国内底图做了非线性偏移：
 *   - 高德 / 腾讯：GCJ-02（"火星坐标"）
 *   - 百度：BD-09（在 GCJ-02 上又叠加了一次自有偏移）
 * 如果拿地图上点到的坐标直接写进 EXIF，或把 EXIF 的坐标直接映射到高德底图上，
 * 都会偏出 300–600 米 —— 在街拍尺度上相当于「隔了一条街」。
 * 因此统一约定：**入 EXIF 一律 WGS-84，上底图一律按底图自身的坐标系转换**。
 *
 * 算法为公开的标准实现（GCJ-02 为「先算偏移量再叠加」，逆解用迭代逼近，
 * 迭代 10 次可达 1e-9 度精度，远优于 GPS 本身的米级误差）。
 * 纯函数、无依赖，前后端共用（后端做写回校验，前端做地图选点）。
 */

/** 一个经纬度点 */
export interface GeoPoint {
  /** 纬度，南纬为负 */
  lat: number;
  /** 经度，西经为负 */
  lon: number;
}

/** 坐标系标识 */
export type CoordSystem = 'wgs84' | 'gcj02' | 'bd09';

/** 克拉索夫斯基椭球长半轴（GCJ-02 算法固定常量） */
const A = 6378245.0;
/** 椭球偏心率平方 */
const EE = 0.00669342162296594323;
/** 百度坐标的极角偏移常量 */
const X_PI = (Math.PI * 3000.0) / 180.0;

/**
 * 是否在中国大陆范围外。
 * GCJ-02 的偏移只在大陆生效（境外 / 港澳台部分区域不偏移），
 * 范围外必须原样返回，否则会把东京的照片也推偏几百米。
 */
export function outOfChina(lat: number, lon: number): boolean {
  return lon < 72.004 || lon > 137.8347 || lat < 0.8293 || lat > 55.8271;
}

function transformLat(x: number, y: number): number {
  let ret =
    -100.0 + 2.0 * x + 3.0 * y + 0.2 * y * y + 0.1 * x * y + 0.2 * Math.sqrt(Math.abs(x));
  ret += ((20.0 * Math.sin(6.0 * x * Math.PI) + 20.0 * Math.sin(2.0 * x * Math.PI)) * 2.0) / 3.0;
  ret += ((20.0 * Math.sin(y * Math.PI) + 40.0 * Math.sin((y / 3.0) * Math.PI)) * 2.0) / 3.0;
  ret += ((160.0 * Math.sin((y / 12.0) * Math.PI) + 320 * Math.sin((y * Math.PI) / 30.0)) * 2.0) / 3.0;
  return ret;
}

function transformLon(x: number, y: number): number {
  let ret = 300.0 + x + 2.0 * y + 0.1 * x * x + 0.1 * x * y + 0.1 * Math.sqrt(Math.abs(x));
  ret += ((20.0 * Math.sin(6.0 * x * Math.PI) + 20.0 * Math.sin(2.0 * x * Math.PI)) * 2.0) / 3.0;
  ret += ((20.0 * Math.sin(x * Math.PI) + 40.0 * Math.sin((x / 3.0) * Math.PI)) * 2.0) / 3.0;
  ret += ((150.0 * Math.sin((x / 12.0) * Math.PI) + 300.0 * Math.sin((x / 30.0) * Math.PI)) * 2.0) / 3.0;
  return ret;
}

/** WGS-84 → GCJ-02（GPS 原始坐标 → 高德/腾讯底图坐标） */
export function wgs84ToGcj02(lat: number, lon: number): GeoPoint {
  if (outOfChina(lat, lon)) return { lat, lon };
  let dLat = transformLat(lon - 105.0, lat - 35.0);
  let dLon = transformLon(lon - 105.0, lat - 35.0);
  const radLat = (lat / 180.0) * Math.PI;
  let magic = Math.sin(radLat);
  magic = 1 - EE * magic * magic;
  const sqrtMagic = Math.sqrt(magic);
  dLat = (dLat * 180.0) / (((A * (1 - EE)) / (magic * sqrtMagic)) * Math.PI);
  dLon = (dLon * 180.0) / ((A / sqrtMagic) * Math.cos(radLat) * Math.PI);
  return { lat: lat + dLat, lon: lon + dLon };
}

/**
 * GCJ-02 → WGS-84（高德底图上点选的坐标 → 写进 EXIF 的 GPS）。
 * 正向公式没有解析逆，用不动点迭代逼近：每轮用正向公式算出偏差再回退，
 * 10 轮后残差 < 1e-9 度（约 0.1 毫米），远超 GPS 精度需求。
 */
export function gcj02ToWgs84(lat: number, lon: number): GeoPoint {
  if (outOfChina(lat, lon)) return { lat, lon };
  let wgsLat = lat;
  let wgsLon = lon;
  for (let i = 0; i < 10; i += 1) {
    const forward = wgs84ToGcj02(wgsLat, wgsLon);
    const dLat = forward.lat - lat;
    const dLon = forward.lon - lon;
    if (Math.abs(dLat) < 1e-9 && Math.abs(dLon) < 1e-9) break;
    wgsLat -= dLat;
    wgsLon -= dLon;
  }
  return { lat: wgsLat, lon: wgsLon };
}

/** GCJ-02 → BD-09（高德坐标 → 百度底图坐标） */
export function gcj02ToBd09(lat: number, lon: number): GeoPoint {
  const z = Math.sqrt(lon * lon + lat * lat) + 0.00002 * Math.sin(lat * X_PI);
  const theta = Math.atan2(lat, lon) + 0.000003 * Math.cos(lon * X_PI);
  return { lat: z * Math.sin(theta) + 0.006, lon: z * Math.cos(theta) + 0.006 };
}

/** BD-09 → GCJ-02 */
export function bd09ToGcj02(lat: number, lon: number): GeoPoint {
  const x = lon - 0.0065;
  const y = lat - 0.006;
  const z = Math.sqrt(x * x + y * y) - 0.00002 * Math.sin(y * X_PI);
  const theta = Math.atan2(y, x) - 0.000003 * Math.cos(x * X_PI);
  return { lat: z * Math.sin(theta), lon: z * Math.cos(theta) };
}

/**
 * 任意坐标系 → WGS-84（写进 EXIF 前的最后一步）。
 * 后端写回前会再过一遍它，避免前端漏转。
 */
export function toWgs84(point: GeoPoint, from: CoordSystem): GeoPoint {
  if (from === 'wgs84') return point;
  // 百度坐标先退回 GCJ-02，再统一走 GCJ-02 → WGS-84
  const gcj = from === 'gcj02' ? point : bd09ToGcj02(point.lat, point.lon);
  return gcj02ToWgs84(gcj.lat, gcj.lon);
}

/** WGS-84 → 目标坐标系（把 EXIF 坐标映射到底图上时用） */
export function fromWgs84(point: GeoPoint, to: CoordSystem): GeoPoint {
  if (to === 'wgs84') return point;
  const gcj = wgs84ToGcj02(point.lat, point.lon);
  return to === 'gcj02' ? gcj : gcj02ToBd09(gcj.lat, gcj.lon);
}

/** 经纬度是否是一对有效值（0,0 视为「未设置」—— 大西洋上的空点没有意义） */
export function isValidLatLon(lat: number | null | undefined, lon: number | null | undefined): boolean {
  if (typeof lat !== 'number' || typeof lon !== 'number') return false;
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return false;
  if (lat === 0 && lon === 0) return false;
  return lat >= -90 && lat <= 90 && lon >= -180 && lon <= 180;
}

/** 展示用：31.230400° N, 121.473700° E */
export function formatLatLon(lat: number, lon: number, digits = 6): string {
  const ns = lat >= 0 ? 'N' : 'S';
  const ew = lon >= 0 ? 'E' : 'W';
  return `${Math.abs(lat).toFixed(digits)}° ${ns}, ${Math.abs(lon).toFixed(digits)}° ${ew}`;
}

/* -------------------------------------------------------------------------- */
/* 两点距离（只用于地图选点面板的「与已有定位偏差多少米」读数）                     */
/* -------------------------------------------------------------------------- */

/** 地球平均半径（米） */
const EARTH_RADIUS = 6371008.8;

const toRad = (deg: number): number => (deg * Math.PI) / 180;

/**
 * 两个 WGS-84 点之间的球面距离（米），Haversine 公式。
 * 纯展示用，不参与任何写入逻辑 —— 写入时的坐标系归一由后端 toWgs84 权威完成。
 */
export function distanceMeters(a: GeoPoint, b: GeoPoint): number {
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** 偏差的可读文案：米级 / 公里级 */
export function formatDistance(meters: number): string {
  if (meters < 1000) return `${meters.toFixed(1)} 米`;
  return `${(meters / 1000).toFixed(2)} 公里`;
}

/**
 * 容错解析 EXIF 的 GPS 值。
 * 常规路径下 exiftool 带 -n 输出纯十进制（"31.2304"），但若读到未归一的历史数据，
 * 可能是度分秒文本（"31 deg 13' 49.44\""），这里一并处理，避免出现 NaN 坐标。
 */
export function parseGpsValue(raw: string | number | null | undefined): number | null {
  if (raw == null || raw === '') return null;
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : null;
  const direct = Number(raw);
  if (Number.isFinite(direct)) return direct;
  const parts = raw.match(/-?\d+(\.\d+)?/g);
  if (!parts || parts.length === 0) return null;
  const [deg = '0', min = '0', sec = '0'] = parts;
  const sign = raw.trim().startsWith('-') ? -1 : 1;
  return sign * (Math.abs(Number(deg)) + Number(min) / 60 + Number(sec) / 3600);
}
