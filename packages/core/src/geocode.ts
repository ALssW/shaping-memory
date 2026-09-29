/**
 * packages/core/src/geocode.ts
 *
 * 地名搜索（正向地理编码）：把「外滩 上海」这样的关键词换成一对 WGS-84 坐标。
 *
 * 【为什么放在 core】地图选点在 Web 前台（编辑框 / 工具模块）与后台（抽屉）各有一份
 * GpsPicker，两处要的是同一个接口、同一套返回结构。放这里定义一次，
 * 两端都只需调用该接口、把结果铺成下拉列表 —— 与档位表（exposure-presets）出于同一条理由。
 *
 * 【为什么改走后端代理，而不是直连 Nominatim】Nominatim 免 key、直接返回 WGS-84，
 * 本来是首选；但它在国内不可达（DNS 污染 + TCP 阻断，本机与生产服务器实测均超时），
 * 线上等于完全不可用。换成高德后 key 必须留在服务端（配额凭证，进前端等于公开），
 * 因此这里只请求自家的 `GET /geo/places`，由后端完成「调高德 + GCJ-02→WGS-84」。
 * 换源的收益是中文 POI 覆盖大幅提升，代价是多一跳内网请求。
 *
 * 【坐标系铁律】返回的 lat/lon 恒为 WGS-84（见 packages/core/src/geo.ts 的说明）。
 */
import type { GeoPoint } from './geo';

/** 一条搜索命中：可读的地点全名 + WGS-84 坐标 */
export interface PlaceHit extends GeoPoint {
  /** 展示名（形如「外滩 · 中山东一路 · 上海市 黄浦区」） */
  label: string;
}

/** 一次搜索最多等这么久：上游偶发慢响应时，避免调用方长时间处于等待状态 */
const TIMEOUT_MS = 8000;

/**
 * 后端基址：默认直连本地开发端口。
 * 部署或真机联调时由 packages/sdk 的 configureApiBase 顺带调过来，
 * 各端入口因此不必为地点搜索多写一行配置。
 */
let apiBase = 'http://127.0.0.1:3000';

/** 运行时可改写后端基址（与 sdk 的 configureApiBase 同口径：去掉尾部斜杠） */
export function configurePlacesApi(base: string): void {
  apiBase = base.replace(/\/+$/, '');
}

/**
 * 从错误响应体里取后端返回的面向用户的文案。
 * 【为什么不在这里拼状态码】状态码属实现细节，界面上只呈现可读文案，
 * 技术信息写控制台即可 —— 与 sdk 的 request() 同一条口径。
 */
async function errorTextOf(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as { message?: string | string[] } | null;
    const message = body?.message;
    if (Array.isArray(message)) return message.join('；');
    if (typeof message === 'string' && message !== '') return message;
  } catch {
    // 非 JSON 响应（网关 502 / 连接被中断等）没有可读文案，下面回落
  }
  return '地点搜索失败，请稍后重试';
}

/**
 * 按关键词搜地名。
 * 失败一律抛 Error（带一句能直接显示给用户的中文），由调用方决定怎么呈现
 * —— core 里不碰 UI，也就无法决定「用 toast 还是行内提示」。
 */
export async function searchPlaces(keyword: string): Promise<PlaceHit[]> {
  const q = keyword.trim();
  if (!q) return [];

  const url = `${apiBase}/geo/places?q=${encodeURIComponent(q)}`;

  /* AbortSignal.timeout 在旧 Safari（<16.4）上没有 —— 那里退化成不设超时，
     比整个搜索功能报错要好 */
  const signal = typeof AbortSignal.timeout === 'function' ? AbortSignal.timeout(TIMEOUT_MS) : undefined;
  let response: Response;
  try {
    response = await fetch(url, { signal, headers: { Accept: 'application/json' } });
  } catch {
    throw new Error('地点搜索失败，请检查网络后重试');
  }
  if (!response.ok) {
    console.warn(`[geo] ${response.status} /geo/places`);
    throw new Error(await errorTextOf(response));
  }

  const rows = (await response.json()) as PlaceHit[];
  const hits: PlaceHit[] = [];
  for (const row of rows) {
    const lat = Number(row.lat);
    const lon = Number(row.lon);
    // 坐标换算不出来就整条丢掉：一条无法使用的命中比没有命中更糟
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    hits.push({ label: row.label || q, lat, lon });
  }
  return hits;
}

/**
 * 浏览器定位接口的最小形状。
 * 【为什么不直接用 DOM 的 Geolocation 类型】core 会连同 api（tsconfig 里只有
 * `lib: ["ES2022"]`，没有 DOM）一起编译，该侧没有 `navigator.geolocation` 的声明。
 * 只声明用得到的三个成员，比给整个仓库开 DOM lib 划算。
 */
interface GeolocationLike {
  getCurrentPosition(
    success: (position: { coords: { latitude: number; longitude: number } }) => void,
    failure: (error: { code: number }) => void,
    options?: { enableHighAccuracy?: boolean; timeout?: number; maximumAge?: number },
  ): void;
}

/** GeolocationPositionError.PERMISSION_DENIED */
const PERMISSION_DENIED = 1;

/**
 * 定位当前位置。
 * 走运行时的原生定位（浏览器 / RN 的 `navigator.geolocation`），返回的本来就是 WGS-84。
 * 拒绝授权、超时、无定位能力一律抛 Error；移动端不走这里（它有 expo-location）。
 */
export function locateCurrent(): Promise<GeoPoint> {
  const geo = (globalThis as { navigator?: { geolocation?: GeolocationLike } }).navigator?.geolocation;
  if (!geo) return Promise.reject(new Error('当前环境不支持定位'));

  return new Promise<GeoPoint>((resolve, reject) => {
    geo.getCurrentPosition(
      (position) => resolve({ lat: position.coords.latitude, lon: position.coords.longitude }),
      (error) => {
        // 1 = 用户拒绝，2 = 无法获取（无信号 / 定位关闭），3 = 超时
        reject(
          new Error(
            error.code === PERMISSION_DENIED
              ? '定位权限被拒绝，请在浏览器地址栏里允许定位'
              : '定位失败，请稍后重试或手动在图上选点',
          ),
        );
      },
      // 地图选点只要到「哪条街」这一级，因此不必等高精度（启用它会明显更慢、更耗电）
      { enableHighAccuracy: false, timeout: 10000, maximumAge: 60000 },
    );
  });
}
