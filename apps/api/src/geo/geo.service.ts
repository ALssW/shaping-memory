/**
 * apps/api/src/geo/geo.service.ts
 *
 * 地点搜索服务（正向地理编码）：把「外滩 上海」这样的关键词换成若干 WGS-84 坐标。
 *
 * 【为什么必须由后端代理，而不是前端直连】两个硬性原因：
 *  1. 高德「Web 服务」的 key 是**配额凭证**，放进前端产物等于公开，会被他人滥用耗尽；
 *  2. 浏览器直连 restapi.amap.com 会遇到跨域限制，且返回的 GCJ-02 还得在前端做一次换算，
 *     换算逻辑一旦分散就会有人遗漏转换 —— 上游统一转好，下游只管收 WGS-84。
 *
 * 【为什么不用 Nominatim（OpenStreetMap）】它免 key，但国内不可达
 * （DNS 被污染 + TCP 阻断，本机与生产服务器实测均超时），线上实际不可用。
 *
 * 【坐标系铁律】高德返回 GCJ-02，这里转成 WGS-84 后再出网（见 core 的 toWgs84）。
 * 全链路只有这一处做换算，前端 GpsPicker 拿到的坐标可以直接写进 EXIF。
 */
import { Inject, Injectable, ServiceUnavailableException } from '@nestjs/common';
import { toWgs84 } from '@shaping-memory/core';
import type { AppConfig } from '@shaping-memory/config';
import { APP_CONFIG } from '../infra.module';

/** 单次返回的命中数：与前端下拉的一屏匹配，更多条目也没有查看价值 */
const LIMIT = 6;
/** 上游超时：高德偶发慢响应时不应让用户长时间等待加载 */
const TIMEOUT_MS = 8000;

/** 上游不可用时面向用户的统一说法（按项目文案规范：不拼状态码等技术细节） */
const UNAVAILABLE_TEXT = '地点搜索暂时不可用，请稍后重试或直接在地图上选点';

/** 高德 place/text 返回的单条 POI（只声明用得到的字段） */
interface AmapPoi {
  name?: string | string[];
  /** 格式固定为 "经度,纬度" */
  location?: string | string[];
  address?: string | string[];
  /** 省 / 直辖市 */
  pname?: string | string[];
  /** 市（直辖市与 pname 相同） */
  cityname?: string | string[];
  /** 区 / 县 */
  adname?: string | string[];
}

/** 高德 place/text 的响应外壳 */
interface AmapPlaceResponse {
  /** "1" 成功，"0" 失败 */
  status?: string;
  /** 失败原因，如 INVALID_USER_KEY */
  info?: string;
  pois?: AmapPoi[];
}

/** 一条命中：可读的地点全名 + WGS-84 坐标 */
export interface GeoPlaceHit {
  label: string;
  lat: number;
  lon: number;
}

/**
 * 取一个字符串字段。
 * 【为什么需要】高德对空字段返回的是 `[]`（空数组）而不是 `""`，
 * 直接当字符串用会得到 "[object Object]" 之类的异常值。
 */
function text(value: string | string[] | undefined): string {
  if (Array.isArray(value)) return value.length > 0 ? String(value[0] ?? '') : '';
  return typeof value === 'string' ? value : '';
}

/**
 * 拼「省 市 区」。
 * 直辖市会返回 pname=上海市 cityname=上海市，不去重就会拼成「上海市 上海市 黄浦区」。
 */
function regionOf(poi: AmapPoi): string {
  const unique: string[] = [];
  for (const name of [text(poi.pname), text(poi.cityname), text(poi.adname)]) {
    if (name !== '' && !unique.includes(name)) unique.push(name);
  }
  return unique.join(' ');
}

/**
 * 拼下拉里显示的那一行：`名称 · 地址 · 省市区`。
 * address 有时已自带省市区（"上海市黄浦区中山东一路"），此时再拼一遍就是叠字，
 * 因此用「区名是否已出现在 address 里」来判断要不要追加。
 */
function buildLabel(poi: AmapPoi, fallback: string): string {
  const address = text(poi.address);
  const region = regionOf(poi);
  const needRegion = region !== '' && !address.includes(text(poi.adname) || region);
  const parts = [text(poi.name), address, needRegion ? region : ''].filter((part) => part !== '');
  return parts.length > 0 ? parts.join(' · ') : fallback;
}

@Injectable()
export class GeoService {
  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {}

  /**
   * 按关键词搜地点，返回 WGS-84 坐标。
   * 上游异常一律抛 ServiceUnavailableException（带一句能直接显示给用户的中文），
   * 技术细节只写控制台 —— 与审计服务的日志口径一致。
   */
  async searchPlaces(keyword: string): Promise<GeoPlaceHit[]> {
    const q = keyword.trim();
    if (q === '') return [];

    const key = this.config.AMAP_KEY.trim();
    if (key === '') {
      console.warn('[geo] 未配置 AMAP_KEY，地点搜索不可用');
      throw new ServiceUnavailableException(UNAVAILABLE_TEXT);
    }

    const url =
      'https://restapi.amap.com/v3/place/text' +
      `?key=${encodeURIComponent(key)}&keywords=${encodeURIComponent(q)}` +
      `&offset=${LIMIT}&page=1&extensions=base`;

    /* AbortSignal.timeout 在 Node 18+ 可用；缺失时退化为不设超时，
       比整个搜索功能报错要好 */
    const signal = typeof AbortSignal.timeout === 'function' ? AbortSignal.timeout(TIMEOUT_MS) : undefined;
    let body: AmapPlaceResponse;
    try {
      const response = await fetch(url, { signal, headers: { Accept: 'application/json' } });
      if (!response.ok) {
        console.warn(`[geo] 高德响应异常 ${response.status}`);
        throw new ServiceUnavailableException(UNAVAILABLE_TEXT);
      }
      body = (await response.json()) as AmapPlaceResponse;
    } catch (err) {
      if (err instanceof ServiceUnavailableException) throw err;
      console.warn('[geo] 高德请求失败：', (err as Error).message);
      throw new ServiceUnavailableException(UNAVAILABLE_TEXT);
    }

    if (body.status !== '1') {
      // info 常见为 INVALID_USER_KEY / DAILY_QUERY_OVER_LIMIT —— 属实现细节，只入控制台
      console.warn(`[geo] 高德返回失败：${body.info ?? 'unknown'}`);
      throw new ServiceUnavailableException(UNAVAILABLE_TEXT);
    }

    const hits: GeoPlaceHit[] = [];
    for (const poi of body.pois ?? []) {
      // location 是 "经度,纬度"，顺序与 lat/lon 相反，避免看反
      const [lonRaw, latRaw] = text(poi.location).split(',');
      const lon = Number(lonRaw);
      const lat = Number(latRaw);
      // 坐标算不出来就整条丢弃：一个无法定位的命中比没有命中更糟
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
      // GCJ-02 → WGS-84：全链路唯一的换算点
      const wgs = toWgs84({ lat, lon }, 'gcj02');
      hits.push({ label: buildLabel(poi, q), lat: wgs.lat, lon: wgs.lon });
    }
    return hits;
  }
}