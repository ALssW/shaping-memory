/**
 * packages/sdk/src/tag-catalog.ts
 *
 * 标签候选目录的客户端缓存（Web 前台 / 移动端 / 后台共用一份）。
 *
 * 【为什么要缓存】筛选器每次打开面板都要候选列表，而标签集合变化很慢（只随照片编辑变）；
 * 每次都发请求既慢又浪费。这里按 TTL 缓存，并在**写标签的接口返回后主动作废**
 * （见 index.ts 的 photoApi.update / updateBatch）—— 因此改了标签立刻就能看到新候选，
 * 无需等待 TTL 到期。
 *
 * 【为什么要合并在途请求】面板里可能有多个组件、或用户连点两次导致并发加载；
 * 把「正在飞的那一次」记下来共享，后来的调用者直接等同一个 Promise，
 * 不会打出一串重复请求。
 */

/** 候选标签：count = 该标签下的照片数（筛选器按热度铺开，并显示在标签右侧） */
export interface TagOption {
  id: string;
  name: string;
  count: number;
}

/** 缓存寿命：标签集合变动很慢，5 分钟足够新鲜，又能省掉面板反复开合的开销 */
const TAG_CATALOG_TTL_MS = 5 * 60 * 1000;

/** 后端基址：由 index.ts 的 configureApiBase 注入（本文件不关心各端的配置来源） */
let base = 'http://127.0.0.1:3000';

let cache: { at: number; data: TagOption[] } | null = null;
let inflight: Promise<TagOption[]> | null = null;

/** 同步后端基址；换环境时丢掉旧缓存，避免跨环境拿到上一份数据 */
export function configureTagCatalogBase(next: string): void {
  if (next === base) return;
  base = next;
  cache = null;
  inflight = null;
}

/** 发一次请求拿候选标签 */
async function fetchTags(): Promise<TagOption[]> {
  const res = await fetch(`${base}/tags`);
  if (!res.ok) throw new Error(`加载标签失败（HTTP ${res.status}）`);
  return (await res.json()) as TagOption[];
}

/**
 * 取候选标签：命中缓存直接返回，否则发一次请求（并发的调用共享同一次）。
 * 【失败不缓存】失败时只清掉 inflight，让下一次调用重试；
 * 若把空数组写进缓存，筛选器会在 TTL 内一直空着。
 */
export async function loadTagCatalog(): Promise<TagOption[]> {
  const fresh = cache && Date.now() - cache.at < TAG_CATALOG_TTL_MS;
  if (fresh) return cache!.data;
  if (inflight) return inflight;

  // 先同步挂上 inflight 再等结果：同一轮事件循环里进来的第二次调用才能共享到它
  inflight = fetchTags()
    .then((data) => {
      cache = { at: Date.now(), data };
      return data;
    })
    .finally(() => {
      inflight = null;
    });
  return inflight;
}

/** 作废缓存（写标签后调用）：下一次 loadTagCatalog 会重新拉取 */
export function invalidateTagCatalog(): void {
  cache = null;
}