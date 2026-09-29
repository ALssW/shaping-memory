/**
 * packages/image/src/index.ts
 *
 * 图像处理封装（Sharp）：
 *   1. 缩略图：原片 → 两档 JPEG（卡片档 / 详情档），供不同消费场景用（分级缩略图）
 *   2. 隐私模糊图：隐私照片在前台**唯一允许出口的字节**（见文件下半部分）
 *
 * 分级多档（preview/full）与 WebP 留待接入真实对象存储后再扩。
 */
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';

/** 缩略图长边像素（详情档）：覆盖查看器主图与缩略图条，兼顾清晰度与体积 */
export const THUMB_MAX = 1280;

/** 卡片档长边像素：覆盖瀑布流/列表卡片（含 2x retina），体积约为详情档的 1/4 */
export const CARD_MAX = 640;

/** 缩略图的落盘目录名（导出给导入管线建目录用，避免两处各写一遍字符串） */
export const THUMB_DIR_NAME = 'thumbs';

/** 生成缩略图并落盘，返回落盘路径。max 决定档位（默认详情档） */
export async function generateThumbnail(
  sourcePath: string,
  thumbPath: string,
  max: number = THUMB_MAX,
): Promise<string> {
  await sharp(sourcePath)
    .rotate() // 依据 EXIF Orientation 摆正
    .resize(max, max, { fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality: 82, mozjpeg: true })
    .toFile(thumbPath);
  return thumbPath;
}

/** 由原片路径推导缩略图路径（统一后缀 .jpg，与源格式解耦） */
export function thumbPathFor(sourcePath: string, storageDir: string): string {
  const base = path.basename(sourcePath, path.extname(sourcePath));
  return path.join(storageDir, THUMB_DIR_NAME, `${base}.jpg`);
}

/** 由详情档缩略图路径推导卡片档路径：`xxx.jpg` → `xxx-card.jpg`（约定，不另建 DB 字段） */
export function cardPathForThumb(thumbPath: string): string {
  return thumbPath.replace(/\.jpg$/i, '-card.jpg');
}

/* ==========================================================================
 * 隐私模糊图：隐私照片在前台唯一允许出口的字节
 * ========================================================================== */

/** 模糊图的落盘目录 */
export const BLUR_DIR_NAME = 'blur';

/**
 * 模糊强度的取值范围与默认值。
 *
 * 【强度调的是什么】隐私保证（降采样底线，见 BLUR_FLOOR_PX）是**算法常量、不可配置**；
 * 这个强度只调「观感」——展示尺寸下的高斯 σ、噪点 σ、JPEG 质量。
 * 换句话说：**每一档都是安全的**，管理员调整的是观感，而非安全性。
 *
 * 【为什么区间是 6~20】区间不承担安全职责（安全由 BLUR_FLOOR_PX 承担），
 * 只保证首尾两档在观感上有肉眼可辨的差别：下限 6 对应 σ10 的轻柔和，
 * 上限 20 对应 σ35 + 噪点 σ12 + 质量 46 的浓重。再往下调已经没有可感知的变化。
 */
export const BLUR_STRENGTH_MIN = 6;
export const BLUR_STRENGTH_MAX = 20;
export const DEFAULT_BLUR_STRENGTH = 12;

/**
 * 算法版本号：编进模糊图的缓存文件名。
 *
 * 【为什么必须有】模糊算法一旦升级，盘上旧的模糊图在语义上就是「用弱算法生成的」；
 * 而缓存文件名若只认强度，`existsSync` 会命中旧文件 —— 升级看起来「没生效」，
 * 而且是最危险的一类失效：界面显示已保护，实际发出的仍是旧算法的产物。
 * 把版本编进文件名，升级即换缓存键，旧文件自然被弃用（可另行清理）。
 */
export const BLUR_ALGO_VERSION = 2;

/**
 * 模糊管线的完整规格：一次模糊实际用到的全部参数。
 * 后台的「完整规格参数」面板直接展示它 —— 管理员看到的是真正生效的值，
 * 而不是另写一套文案，避免「界面上写的」与「算法真正用的」不一致。
 */
export interface BlurSpec {
  /** 总开关：管理员在后台设置的整数（6~20） */
  strength: number;
  /** 降采样底线（长边像素）：隐私保证，算法常量，不随强度变化 */
  floorPx: number;
  /** 展示尺寸下的高斯模糊 sigma（像素） */
  sigma: number;
  /** 噪点抖动 sigma（0~255 标度） */
  noiseSigma: number;
  /** JPEG 编码质量 */
  quality: number;
  /** 输出长边像素 */
  outputPx: number;
}

/**
 * 降采样底线（长边像素）—— **隐私保证，不可配置**。
 *
 * 【这个 8 是怎么定出来的】实测定标（满幅人像 × 逐档底线 × 最强/最弱掩护）：
 *   · floor 32px → 眉毛、双眼、鼻、嘴全部清晰可辨
 *   · floor 24px → 五官清晰可辨
 *   · floor 16px → 明显可辨
 *   · floor 12px → 已能看出两个眼窝
 *   · floor 10px → 隐约有结构，处在临界
 *   · floor  8px → 只剩色块，读不出任何五官  ← 取此值
 *
 * 【为什么杠杆是底线而不是高斯 σ】把 32px 的画面放大 20 倍后，眼睛会变成
 * 70px 的大色斑 —— 高斯削的是高频，而五官在这个尺度上已经是**低频结构**，
 * 加大 σ 无法压制：实测 σ35 的强模糊叠加在 floor 10px 上，结构依然可辨。
 * 唯一可靠的杠杆是底线本身，所以它必须是常量。
 *
 * 【为什么不做成可配置项】这是安全边界，不是偏好。做成设置项就意味着
 * 有人能把它调回 32px，而界面依然显示「已保护」—— 那是最危险的失败模式：
 * 看似已关闭，实际仍敞开。安全边界只应存在于代码里，并接受代码评审。
 */
export const BLUR_FLOOR_PX = 8;

/* 观感参数的取值区间：t=0（强度最低）→ t=1（强度最高）之间线性插值。
 * 方向刻意相反 —— 强度越高，高斯越大、噪点越重、编码质量越低。 */
const SIGMA_RATIO_WEAK = 0.016; // 高斯 sigma 占输出长边的比例：1.6% → 5.5%
const SIGMA_RATIO_STRONG = 0.055;
const NOISE_WEAK = 4; // 噪点 sigma（0~255 标度）
const NOISE_STRONG = 12;
const QUALITY_WEAK = 62; // JPEG 质量：62 → 46
const QUALITY_STRONG = 46;

/**
 * 由「模糊强度」推导出全部规格参数。
 *
 * 【隐私与观感是两条正交的轴】
 *   · 隐私（floorPx）—— 常量 8px，**不随强度变化**，见 BLUR_FLOOR_PX 的定标依据；
 *   · 观感（sigma / noiseSigma / quality）—— 由强度线性插值。
 * 之所以不让强度去动 floorPx：实测证明 floorPx 一旦超过 10px，五官就会透出来，
 * 而 σ 再大也无法压制 —— 也就是说 floorPx 完全不存在「可以商量」的区间。
 * 与其给一个只能落在 8px 附近的无效旋钮，不如把它固定，让强度只作用于它真正能影响的部分。
 */
export function blurSpec(strength: number = DEFAULT_BLUR_STRENGTH): BlurSpec {
  // 越界值夹紧而不是报错：这里可能被非法设置值调用，夹紧保证行为可预期
  const s = Math.min(BLUR_STRENGTH_MAX, Math.max(BLUR_STRENGTH_MIN, Math.round(strength)));
  const t = (s - BLUR_STRENGTH_MIN) / (BLUR_STRENGTH_MAX - BLUR_STRENGTH_MIN);
  const lerp = (weak: number, strong: number): number => weak + t * (strong - weak);

  return {
    strength: s,
    floorPx: BLUR_FLOOR_PX,
    sigma: Math.round(CARD_MAX * lerp(SIGMA_RATIO_WEAK, SIGMA_RATIO_STRONG)),
    noiseSigma: Math.round(lerp(NOISE_WEAK, NOISE_STRONG)),
    quality: Math.round(lerp(QUALITY_WEAK, QUALITY_STRONG)),
    outputPx: CARD_MAX,
  };
}

/**
 * 全部可选强度的规格表。
 * 【为什么整表下发】后台滑杆拖动时，规格面板要实时显示「拖到这一档会是什么参数」。
 * 让前端自行按公式推导就等于把算法复制两份，一旦公式变更必然产生不一致；
 * 而每拖一档调用一次接口又过于频繁。整表一次下发，前端查表即可 —— 公式只有一份。
 */
export function blurSpecTable(): BlurSpec[] {
  const rows: BlurSpec[] = [];
  for (let s = BLUR_STRENGTH_MIN; s <= BLUR_STRENGTH_MAX; s++) rows.push(blurSpec(s));
  return rows;
}

/**
 * 隐私照片模糊图的目标路径：以 media.id 命名，与缩略图同属生成物。
 *
 * 文件名同时编入**算法版本**与**强度**：两者任一变化都必须换缓存键，
 * 否则「升级算法」或「改强度」都会被 existsSync 命中旧文件而静默失效。
 * 旧文件留在盘上无害（回滚参数时还能直接复用），需要清理时按前缀删即可。
 */
export function blurPathFor(
  storageDir: string,
  mediaId: string,
  strength: number = DEFAULT_BLUR_STRENGTH,
): string {
  return path.join(storageDir, BLUR_DIR_NAME, `${mediaId}-v${BLUR_ALGO_VERSION}s${strength}.jpg`);
}

/** 按长宽比把「长边像素」摊成实际宽高，避免占位盒比例失真 */
function fitAspect(longEdge: number, aspect: number): { w: number; h: number } {
  const w = aspect >= 1 ? longEdge : Math.max(4, Math.round(longEdge * aspect));
  const h = aspect >= 1 ? Math.max(4, Math.round(longEdge / aspect)) : longEdge;
  return { w, h };
}

/**
 * 噪点抖动：逐像素叠加独立高斯噪声，抬高画面的噪声底。
 *
 * 【为什么需要】降采样已经销毁了细节，理论上不可逆；叠一层噪声是**纵深防御** ——
 * 它使「反卷积 + 超分」这一还原路径的解空间进一步发散：即便攻击者推测出高斯核，
 * 被噪声污染的输入也无法稳定地反推出唯一解。
 *
 * 用 Box-Muller 把两个均匀分布换成一个标准正态（sharp 没有直接的加噪 API，
 * 而 composite 叠加噪声层的混合公式难以精确控制幅度，这里直接改像素更可控）。
 */
function addGrain(rgb: Buffer, sigma: number): void {
  for (let i = 0; i < rgb.length; i++) {
    const u1 = Math.random() || 1e-9; // 避免 log(0) = -Infinity
    const u2 = Math.random();
    const normal = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
    const value = rgb[i] + normal * sigma;
    rgb[i] = value <= 0 ? 0 : value >= 255 ? 255 : Math.round(value);
  }
}

/**
 * 生成「不可还原」的隐私模糊图 —— 隐私照片在前台唯一允许出口的字节。
 *
 * 五段式管线，每一段解决一个具体问题：
 *
 *   ① 降采样到隐私底线（BLUR_FLOOR_PX = 8px）
 *      **这才是不可逆的保证，也是整个算法唯一的安全边界**。把画面压到 8px 长边，
 *      信息量降到原始的 0.001% 量级，面部特征在这一步就物理消失了 ——
 *      之后无论怎么处理都变不回来。只做高斯模糊是不够的：模糊在数学上可逆，
 *      而且五官在放大后的尺度上是低频结构，高斯无法消除（见 BLUR_FLOOR_PX 的定标依据）。
 *
 *   ② 放大回展示尺寸（outputPx）
 *      让模糊图在前台有合适的显示尺寸，不至于被拉伸成马赛克块。
 *
 *   ③ 展示尺寸下的真高斯模糊（sigma）
 *      **在放大之后**做，而不是在底线尺寸上做。两个原因：
 *      · 视觉上：底线尺寸上的模糊经过放大后被双线性插值主导，出来是「柔和的色块」
 *        而不是「模糊」；在展示尺寸上做才是真正的失焦观感。
 *      · 参数上：sigma 若作用在 28px 的小图上，6 和 20 的差别几乎被放大过程抹平，
 *        滑杆调节时「几乎看不出变化」；作用在展示尺寸上，滑杆的每一档都肉眼可辨。
 *      实现用 sharp 的 .blur()（libvips gaussblur，三次盒式滤波逼近高斯核，
 *      σ 误差 <1%）。不用 .convolve() 显式卷积是因为 σ=35 需要 211×211 的核，
 *      每像素 4 万次乘加，代价无法接受 —— 盒式逼近是图像工业的标准做法。
 *
 *   ④ 噪点抖动（noiseSigma）
 *      纵深防御，见 addGrain。
 *
 *   ⑤ 低质量 JPEG 编码（quality）
 *      压缩本身再抹掉一层高频残留，且让文件体积保持很小。
 *
 * strength 由调用方按当前隐私设置传入（默认 12）。
 *
 * 【为什么内核收 Buffer 而不收路径】云模式下照片的正本在对象存储里、本机没有文件，
 * 只能把字节取回内存再算。收 Buffer 让同一段算法既能服务本机（薄壳读文件）也能服务云端。
 */
export async function blurPlaceholderOf(
  input: Buffer,
  aspect: number = 1,
  strength: number = DEFAULT_BLUR_STRENGTH,
): Promise<Buffer> {
  const spec = blurSpec(strength);
  const floor = fitAspect(spec.floorPx, aspect);
  const output = fitAspect(spec.outputPx, aspect);

  // ① 降采样到隐私底线。显式去掉 alpha、统一到 sRGB，
  //    保证后面的 raw 缓冲恒为 3 通道（PNG 带透明通道 / CMYK 源都不会打乱步长）
  const destroyed = await sharp(input)
    .rotate()
    .resize(floor.w, floor.h, { fit: 'fill' })
    .removeAlpha()
    .toColorspace('srgb')
    .raw()
    .toBuffer();

  // ② 放大回展示尺寸 → ③ 真高斯模糊 → 取回像素
  const blurred = await sharp(destroyed, { raw: { width: floor.w, height: floor.h, channels: 3 } })
    .resize(output.w, output.h, { fit: 'fill' })
    .blur(spec.sigma)
    .raw()
    .toBuffer();

  // ④ 噪点抖动
  addGrain(blurred, spec.noiseSigma);

  // ⑤ 低质量编码（本机薄壳会把它写盘，云模式直接发出去）
  return sharp(blurred, { raw: { width: output.w, height: output.h, channels: 3 } })
    .jpeg({ quality: spec.quality, mozjpeg: true })
    .toBuffer();
}

/**
 * 生成「不可还原」的隐私模糊图并落盘，返回落盘路径（本机模式用）。
 * 算法本体在 blurPlaceholderOf，这里只是「读文件 → 算 → 写文件」的薄壳。
 */
export async function generateBlurPlaceholder(
  sourcePath: string,
  destPath: string,
  aspect: number = 1,
  strength: number = DEFAULT_BLUR_STRENGTH,
): Promise<string> {
  await writeFile(destPath, await blurPlaceholderOf(await readFile(sourcePath), aspect, strength));
  return destPath;
}
