/**
 * packages/core/src/mock.ts
 *
 * 静态常量 + 纯函数（照片的**真实数据**已改由 @shaping-memory/sdk 从后端拉取，见 apps 里的 usePhotos）。
 * 这里不再有「样例照片数组」（PHOTOS 等 mock 数据已随真实后端接入移除），
 * 只剩跨端共用、不依赖网络的这部分：
 *   - CATEGORIES / ALBUM_DEFS / TOOL_LIST：分类、影集、工具清单的固定枚举
 *   - filterByCategory / albumCover：按分类筛、取影集封面
 *   - photoAspect / placeholderColors / formatDate：纯展示推导
 */
import type { Photo, PhotoCategory } from './types';

/** 分类筛选条（对应 categories 表） */
export const CATEGORIES: readonly string[] = ['全部', '风光', '街拍', '人像', '建筑', '微距', '纪实'];

/** 影集定义：一个影集 = 若干分类的归集，封面取其中最新一张 */
export const ALBUM_DEFS: ReadonlyArray<{ name: string; icon: string; cats: PhotoCategory[] }> = [
  { name: '山河 · 风光', icon: 'grid', cats: ['风光'] },
  { name: '街头 · 街拍', icon: 'camera', cats: ['街拍'] },
  { name: '人像 · 面孔', icon: 'heart', cats: ['人像'] },
  { name: '微距 · 微观', icon: 'album', cats: ['微距'] },
  { name: '建筑 · 几何', icon: 'aperture', cats: ['建筑'] },
  { name: '纪实 · 人间', icon: 'camera', cats: ['纪实'] },
];

/** 按分类筛选；'全部' 返回原数组（不复制，避免无谓的对象复制） */
export function filterByCategory(photos: readonly Photo[], cat: string): readonly Photo[] {
  return cat === '全部' ? photos : photos.filter((p) => p.cat === cat);
}

/**
 * 前台 EXIF 搜索条件。字段名与后端检索参数逐个对齐（sdk 的 PhotoQuery 亦然），
 * 因此同一份条件对象既能交给 /search/photos 在服务端筛，也能在本地筛。
 */
export interface SearchQuery {
  /** 关键词：标题 / 分类 / 相机 / 镜头模糊匹配 */
  q?: string;
  /** 拍摄日期下界（含），YYYY-MM-DD */
  from?: string;
  /** 拍摄日期上界（含），YYYY-MM-DD */
  to?: string;
  /** 相机型号精确匹配（取值来自字典） */
  cam?: string;
  /** 镜头型号精确匹配（取值来自字典） */
  lens?: string;
  /** 光圈匹配（如 "f/4"） */
  aperture?: string;
  /** 快门速度匹配（如 "1/200"） */
  speed?: string;
  /** 感光度精确匹配（数值；取值来自字典） */
  iso?: number;
  /** true 只看有定位、false 只看无定位 */
  hasGps?: boolean;
  /** 标签（AND：选中的标签必须全部命中）；空数组或缺省即不限 */
  tags?: string[];
}

/**
 * 按 EXIF 条件在本地过滤。
 * 【现在还用在哪】画廊的「相册内筛选」：册内照片走 albumApi.detail（不是检索入口），
 * 条件只能在前端套用。整份档案的检索已改由 /search/photos 在服务端完成，不再走这里。
 */
export function searchPhotos(photos: readonly Photo[], query: SearchQuery): readonly Photo[] {
  const q = query.q?.trim().toLowerCase();
  const aperture = query.aperture?.trim().toLowerCase();
  const speed = query.speed?.trim().toLowerCase();
  return photos.filter((p) => {
    if (q && !`${p.title} ${p.cat} ${p.cam} ${p.lens}`.toLowerCase().includes(q)) return false;
    if (query.from && p.date < query.from) return false;
    if (query.to && p.date > query.to) return false;
    if (query.cam && p.cam !== query.cam) return false;
    if (query.lens && p.lens !== query.lens) return false;
    if (aperture && !p.aperture.toLowerCase().includes(aperture)) return false;
    if (speed && !p.speed.toLowerCase().includes(speed)) return false;
    // 后端对感光度是精确匹配（Number(p.iso) 兼容 null 与字符串两种落地形态）
    if (query.iso !== undefined && Number(p.iso) !== query.iso) return false;
    if (query.hasGps !== undefined && query.hasGps !== Boolean(p.gps)) return false;
    // 标签 AND：每一枚选中的标签都要在这张照片的标签里（空数组即不限）
    if (query.tags && query.tags.length > 0) {
      const names = p.tags.map((t) => t.name);
      if (!query.tags.every((name) => names.includes(name))) return false;
    }
    return true;
  });
}

/** 在给定照片集里找某影集的最新一张作为封面 */
export function albumCover(photos: readonly Photo[], cats: readonly PhotoCategory[]): Photo | undefined {
  let cover: Photo | undefined;
  for (const p of photos) {
    if (!cats.includes(p.cat)) continue;
    if (!cover || p.date > cover.date) cover = p;
  }
  return cover;
}

/**
 * 稳定哈希：同一字符串永远得到同一结果。
 * 用于占位底色等「每次渲染都一致」的派生态。
 */
function stableHash(str: string, len: number): number {
  let h = 0;
  for (let i = 0; i < str.length; i += 1) h = (h * 31 + str.charCodeAt(i)) % 100003;
  return h % len;
}

/**
 * 照片纵横比 [宽, 高]，瀑布流占位与缩略图都据此布局，避免加载时重排。
 *
 * 【严格遵循原始比例】优先用 EXIF 写入的真实像素宽高，避免固定 3:4 / 4:3 占位
 * 与真实比例（如 3:2、16:9、9:16）不一致时，object-fit: cover 把画面裁掉一大半。
 * 像素宽高缺失（导入时未读到 EXIF）才回退到 size 口径的固定比例 —— 旧数据回退。
 */
export function photoAspect(photo: Photo): readonly [number, number] {
  const { width, height } = photo;
  if (width && height && width > 0 && height > 0) return [width, height];
  return photo.size === 'portrait' ? [3, 4] : [4, 3];
}

/**
 * 像素分辨率文案，如「4032 × 3024」；缺任一维度返回空串。
 * 悬浮蒙版与 EXIF 卡片共用一份，避免两处各写一遍格式化逻辑。
 */
export function resolutionOf(photo: Photo): string {
  const { width, height } = photo;
  if (!width || !height) return '';
  return `${width} × ${height}`;
}

/**
 * 占位底色：由 id 稳定派生一对 HSL 颜色。
 * 图片未加载时先用它作为底色，观感上更接近「尚未显影的底片」而非灰色色块。
 * 入参只取 id（相册卡片没有完整 Photo，但同样需要一块稳定底色）。
 */
export function placeholderColors(item: { id: string }): readonly [string, string] {
  const hue = (stableHash(item.id, 360) * 37) % 360;
  return [`hsl(${hue}, 22%, 22%)`, `hsl(${(hue + 40) % 360}, 26%, 15%)`];
}

/** YYYY-MM-DD → YYYY-MM-DD（原样返回，仅做边界保护） */
export function formatDate(date: string): string {
  return date.length === 10 ? date : date.slice(0, 10);
}