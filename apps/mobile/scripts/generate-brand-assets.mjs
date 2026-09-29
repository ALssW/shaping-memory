/**
 * apps/mobile/scripts/generate-brand-assets.mjs
 *
 * 移动端品牌位图的唯一生成入口。几何关系抄自 apps/web/public/favicon.svg，
 * 参数化之后一次性栅格化出图标与开屏要用的 PNG —— 不再手工维护二十多个尺寸。
 *
 * 运行：node apps/mobile/scripts/generate-brand-assets.mjs
 *
 * 产出的源图（各密度副本由 `npx expo prebuild` 从它们自动切出来）：
 *   assets/icon.png            满幅深底 + 居中标记 → 传统启动图标
 *   assets/adaptive-icon.png   透明底 + 标记（收在安全区内）→ 自适应图标前景层
 *   assets/splash.png          深底玻璃板 + 标记 + accent 洇光 → 开屏标记
 *   assets/play-store-icon.png 512 见方，供应用商店列表用
 *   assets/icon.svg            同构图的矢量存档（将来调整比例时只需修改此文件）
 *
 * 【为什么不把洇光写成 SVG 渐变或 feGaussianBlur】
 *   两条路都试过：半透明径向渐变会在这么大面积上浮出同心环带，feGaussianBlur 更糟
 *   （色带 + 红边 + 硬方形边界），都是渲染器对 alpha 的插值实现不可靠。
 *   于是洇光改成在 sharp 里逐像素算出来 —— 衰减公式自己写，结果完全确定。
 */
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ASSETS = path.join(HERE, '..', 'assets');

/** 与 design-tokens 同源：--color-accent 与 --color-background */
const ACCENT = '#e8a33c';
const DEEP = '#1c1c1e';
/** 母版画布边长：下面所有比例都以它为准，换尺寸只改这一个数 */
const CANVAS = 1024;

/* -------------------------------------------------------------------------- */
/* 标记几何：favicon.svg 的画布是 64、实体方块是 22，这里全部改成「按格取倍数」   */
/* -------------------------------------------------------------------------- */

/** 圆角恒为边长的 1/3（与页头 .brand__dot 同一条比例语言） */
const RADIUS_RATIO = 1 / 3;
/** 叠影向右上偏移（favicon 里是 5/22 个格）：上一帧显影留下的位置 */
const GHOST_SHIFT = 0.227;
/** 光晕在实体外扩一圈（favicon 里是 4/22 个格） */
const HALO_PAD = 0.18;

/** 圆角方块片段：x/y 是左上角 */
const box = (x, y, side, fill) =>
  `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${side.toFixed(1)}" height="${side.toFixed(1)}" rx="${(
    side * RADIUS_RATIO
  ).toFixed(1)}" fill="${fill}"/>`;

/** 8 位 hex 的 alpha 通道：0x42≈26%、0x2e≈18%，与 favicon 的 fill-opacity 对齐 */
const accent = (hex) => `${ACCENT}${hex}`;

/**
 * 生成一张「品牌标记」的 SVG 源码。
 *
 * @param {number} size         画布边长（px）
 * @param {number} cell         实体方块边长（px），其余元素都由它按比例推出来
 * @param {number} [plateSide]  底板边长；0 表示不画底板（自适应图标的前景层不要底板）
 * @param {boolean} [backplate] 是否铺满幅背板（传统图标要，免得在启动器里是一块透明）
 */
function brandMarkSvg({ size, cell, plateSide = 0, backplate = false }) {
  const mid = size / 2;
  const shift = cell * GHOST_SHIFT;
  const glowSide = cell * (1 + HALO_PAD * 2);

  const defs = [];
  const layers = [];

  if (backplate) {
    // 满幅深底：中心略亮一档，做出一层玻璃的厚度，避免整块死黑
    defs.push(
      `<radialGradient id="backplate" cx="50%" cy="42%" r="72%">` +
        `<stop offset="0" stop-color="#2a2a2c"/><stop offset="1" stop-color="#161617"/></radialGradient>`,
    );
    layers.push(`<rect width="${size}" height="${size}" fill="url(#backplate)"/>`);
  }

  if (plateSide > 0) {
    // 底板：与 favicon 同一块深色玻璃，顶边略亮
    defs.push(
      `<linearGradient id="plate" x1="0" y1="0" x2="0" y2="1">` +
        `<stop offset="0" stop-color="#2a2a2c"/><stop offset="1" stop-color="${DEEP}"/></linearGradient>`,
    );
    layers.push(box(mid - plateSide / 2, mid - plateSide / 2, plateSide, 'url(#plate)'));
  }

  // 叠影 → 光晕 → 本体：顺序与 favicon.svg 完全一致，三层的叠色关系才不会变
  layers.push(box(mid - cell / 2 + shift, mid - cell / 2 - shift, cell, accent('42')));
  layers.push(box(mid - glowSide / 2, mid - glowSide / 2, glowSide, accent('2e')));
  layers.push(box(mid - cell / 2, mid - cell / 2, cell, ACCENT));

  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" width="${size}" height="${size}">` +
    (defs.length ? `<defs>${defs.join('')}</defs>` : '') +
    layers.join('') +
    `</svg>`
  );
}

/* -------------------------------------------------------------------------- */
/* 洇光：逐像素算一张中心向外平滑衰减的 accent 光斑                              */
/* -------------------------------------------------------------------------- */

/**
 * 衰减曲线取 (1 - d²)³（d 为归一化半径）：中心满值、到 radius 处归零，
 * 且一阶导在边界也归零 —— 所以看不出「一圈边」，是真正的洇开。
 *
 * @param {number} size    画布边长
 * @param {number} radius  衰减到 0 的半径
 * @param {number} peak    中心处的最大不透明度
 */
async function haloPng(size, radius, peak) {
  const rgb = [0xe8, 0xa3, 0x3c];
  const mid = (size - 1) / 2;
  const data = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const d = Math.hypot(x - mid, y - mid) / radius;
      const falloff = d >= 1 ? 0 : (1 - d * d) ** 3;
      const at = (y * size + x) * 4;
      data[at] = rgb[0];
      data[at + 1] = rgb[1];
      data[at + 2] = rgb[2];
      data[at + 3] = Math.round(falloff * peak * 255);
    }
  }
  return sharp(data, { raw: { width: size, height: size, channels: 4 } }).png().toBuffer();
}

/* -------------------------------------------------------------------------- */
/* 具体比例                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * 自适应图标的安全区是画布中央 66/108 ≈ 61%，标记最外沿（叠影右上角）落在
 * 实体边长的一半 + 偏移 = 0.727×cell 处，因此 cell 必须 ≤ 0.419×边长。
 * 取 0.41 留一点余量，保证任何形状的启动器遮罩都啃不到标记。
 */
const ADAPTIVE_CELL_RATIO = 0.41;

/**
 * 开屏整张素材会被 Expo 缩到 200dp 见方（imageWidth 的默认值），
 * 所以这里的比例直接决定真机观感：底板 ≈ 104dp、实体 ≈ 36dp、洇光散到 90dp 直径外。
 * JS 侧的首帧遮罩用同一张图、同样按 200dp 渲染，两边才对得上。
 */
const SPLASH_IMAGE_DP = 200;
const SPLASH_PLATE_RATIO = 0.52;

const OUTPUTS = [
  { file: 'icon.png', svg: brandMarkSvg({ size: CANVAS, cell: CANVAS * 0.44, backplate: true }) },
  {
    file: 'adaptive-icon.png',
    svg: brandMarkSvg({ size: CANVAS, cell: CANVAS * ADAPTIVE_CELL_RATIO }),
  },
  {
    file: 'splash.png',
    svg: brandMarkSvg({
      size: CANVAS,
      cell: CANVAS * 0.179,
      plateSide: CANVAS * SPLASH_PLATE_RATIO,
    }),
    halo: { radius: CANVAS * 0.55, peak: 0.4 },
  },
  {
    file: 'play-store-icon.png',
    svg: brandMarkSvg({ size: CANVAS, cell: CANVAS * 0.44, backplate: true }),
    width: 512,
  },
];

await mkdir(ASSETS, { recursive: true });

for (const { file, svg, width, halo } of OUTPUTS) {
  const raster = sharp(Buffer.from(svg));
  if (width) raster.resize(width, width);
  const mark = await raster.png().toBuffer();

  // 洇光垫底、标记压在上面：composite 的后者叠在前者之上，顺序不能反
  const composed = halo
    ? await sharp(await haloPng(CANVAS, halo.radius, halo.peak))
        .composite([{ input: mark, blend: 'over' }])
        .png()
        .toBuffer()
    : mark;

  await writeFile(path.join(ASSETS, file), composed);
  console.log(`[brand] ${file}${width ? ` (${width}px)` : ''}`);
}

/** 一并生成一份矢量存档：将来调整比例时，修改 SVG 比修改二进制图片容易得多 */
await writeFile(
  path.join(ASSETS, 'icon.svg'),
  brandMarkSvg({ size: 512, cell: 512 * 0.44, backplate: true }),
  'utf8',
);
console.log('[brand] icon.svg (矢量存档)');
console.log(`[brand] 开屏素材在真机上按 ${SPLASH_IMAGE_DP}dp 见方渲染`);