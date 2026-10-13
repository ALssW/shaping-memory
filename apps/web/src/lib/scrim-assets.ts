/**
 * apps/web/src/lib/scrim-assets.ts
 *
 * 查看器背板的素材生成：把当前照片压成一张长边 32px 的 PNG 位图，交给背板铺满视口。
 *
 * 【背板的主体是什么】铺满视口的不是「模糊过的照片」，而是一张 32px 的极图：
 * 浏览器把它放大到上千像素时，取样只落在少数几个像素之间，双线性插值本身就给出连续的色彩过渡 ——
 * 背板的柔和色场主要是「放大」出来的，而不是「算」出来的（参考 Afilmory 查看器的背板：
 * 那边是构建期编码好的 32px ThumbHash，这边等价地在客户端现压一张）。
 * 走这条路线的两个好处：
 *   1. 放大由合成器直接完成，翻页时 GPU 只换一张纹理，不必重算任何卷积；
 *   2. data URL 直接内联，翻页零额外请求 —— 素材随照片走，不吃网络。
 *
 * 【与背板上那档高斯模糊的分工】极图负责给出**这张照片自己的色彩分布**，
 * 背板再对它压一档 CSS 高斯模糊（见 app.css 的 .viewer__scrimblur）：前者提供色，
 * 后者抹平极图放大后在各采样块边界残留的转折线。两者缺一不可 ——
 * 只模糊一块纯色不会有任何色彩层次；只有极图则色块边界仍留有极淡的折线。
 * 模糊会让底图外缘向外淡出约两倍模糊半径，那圈衰减区由背板「撑大后裁回」吸收，
 * 因此**素材侧**不需要任何裁切或边缘遮罩（此前那两层处理正是因此被移除）。
 *
 * 【为什么在客户端现生成】服务端不为背板多存一份衍生品，也不必为「背板该长什么样」定协议；
 * 用一张浏览器已经缓存的缩略图（详情档）现压一张极图，是最短的一条路。
 * 结果按地址缓存，来回翻页不会重复计算。
 *
 * 【跨域取像素】canvas 只有在图片**同源**或**响应带 CORS 头**时才允许读像素，
 * 否则 drawImage 之后取不到内容、toDataURL 会抛 SecurityError。因此这里用一个独立的 Image 元素加载
 * （crossOrigin='anonymous'），而不是复用页面里正在显示的那张 <img>：
 * 万一拿不到像素，也只是退化成「没有背板素材」（回退中性底色），不会连背板图本身一起加载失败。
 */

/**
 * 极图长边（px）。
 * 【为什么是 32】背板只需要大面积的柔和色场，不需要细节：32px 铺满 1920px，一个像素摊到 60px，
 * 放大后只剩色块之间的平滑过渡。再小（如 16px）会让色块的分界过于明显，
 * 再大则开始露出可辨认的细节，偏离「纯色场」的定位。
 */
const RASTER_EDGE = 32;

/** 背板极图按图片地址缓存；Promise 一并缓存，同一张的并发请求因此只算一次 */
const cache = new Map<string, Promise<string | null>>();

/**
 * 取一张照片的背板极图。
 * @param url 图片地址（查看器传 photo.url，即详情档缩略图）
 * @returns 32px PNG 的 data URL；跨域被拒、解码失败或画布不可用时返回 null（调用方退回中性底色）
 */
export function scrimRaster(url: string): Promise<string | null> {
  const cached = cache.get(url);
  if (cached) return cached;
  const pending = rasterOf(url).catch(() => null);
  cache.set(url, pending);
  return pending;
}

/** 加载图片 → 压到极图尺寸 → 编码成 PNG data URL */
async function rasterOf(url: string): Promise<string | null> {
  const image = await loadImage(url);
  const canvas = document.createElement('canvas');
  /* 保持原始纵横比：背板是满屏的色场，若把宽高都固定成 32 会把画面拉歪 ——
     照片的细节虽已不可辨认，色块的**分布位置**却仍应与原图对应。 */
  canvas.width = RASTER_EDGE;
  canvas.height = Math.max(1, Math.round((image.naturalHeight / image.naturalWidth) * RASTER_EDGE));
  const context = canvas.getContext('2d');
  if (!context) return null;
  /* 交给 drawImage 做降采样：这一步本身就是一次盒式平均，省掉自己逐像素分组的循环 */
  context.drawImage(image, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL('image/png');
}

/** 以 CORS 方式加载图片：crossOrigin 必须在 src 之前设置，否则请求已经发出，读不到像素 */
function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.crossOrigin = 'anonymous';
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error(`scrim raster: unable to load ${url}`));
    image.src = url;
  });
}
