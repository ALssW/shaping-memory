#!/usr/bin/env node
/**
 * build-cursors.mjs —— AF 光标图标集构建 + 一致性守门
 *
 * 产出（packages/design-tokens/cursors/dist/）：
 *   svg/          母版 SVG 的副本（声明尺寸 256×256，带 viewBox，可无限缩放）
 *   png/          8 档 PNG（256 → 16），透明背景
 *   ico/          多尺寸 Windows ICO（内嵌 PNG，Vista+ 支持）
 *   cursors.css   由母版生成的 `:root` 光标变量块（CSS 的唯一事实源）
 *
 * 守门：把生成的声明逐条与 apps/web/src/styles/app.css 里已回填的值比对。
 *       改了 SVG 却忘了回填 app.css 时，本脚本会直接报错退出（退出码 1）——
 *       与 check-tokens.mjs 同一套「产物手写 + 机器守门」思路。
 *
 * 依赖：sharp。这里不重复声明 —— 复用 workspace 里 @shaping-memory/image 已装的同一份
 *       （npm workspaces 提升到根 node_modules，从本文件向上查找即可解析）。
 *
 * 用法（仓库根目录）：node packages/design-tokens/scripts/build-cursors.mjs
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PKG = path.resolve(HERE, '..'); // packages/design-tokens
const SRC_DIR = path.join(PKG, 'cursors', 'src');
const DIST_DIR = path.join(PKG, 'cursors', 'dist');
const APP_CSS = path.resolve(PKG, '..', '..', 'apps', 'web', 'src', 'styles', 'app.css');

/* --------------------------------------------------------------------------
 * 设计常量：与 SVG 母版里的坐标一一对应，改母版必须同步改这里
 * -------------------------------------------------------------------------- */
const GRID = 128; // 母版栅格边长
const HOTSPOT = 64; // 热点 = 几何中心
const CSS_SIZE = 32; // CSS 实际挂载尺寸（缩放比恰好 0.25 → 4 单位 = 1px）
// 【整体尺寸 = 原设计的 50%】可视包络 11..21px 共 10px，原为 6..26px 共 20px，恰好一半。
// 之所以能精确减半又保持零模糊：包络半宽 5px 是整数，且 5 = 面层半宽 4 + 底衬 1，
// 两个分量都落在整数像素上。面层方框本身是 8px（原 18px 的 44%）——
// 18 的一半是 9，奇数边长居中后边线必然压在半像素上，只能在 8px 与 10px 之间二选一。
const FRAME_OUTER = 48; // 面层方框外沿（48..80，边长 32 单位 = 8px）
const FRAME_THICK = 4; // 面层线宽（32px 下 = 1px，原 2px 的一半）
const HALO = 4; // 底衬向面层内外各露出的宽度（32px 下 = 1px）
const BASE_OUTER = FRAME_OUTER - HALO; // 底衬外沿 44（11px）
const BASE_THICK = FRAME_THICK + HALO * 2; // 底衬线宽 12（3px）

// 【拖拽态点阵】正方形 4 角 + 4 边中点，半边长 36 单位 = 9px。
// 点与主框同构：r=8 深色圆（4px 直径）垫底、r=4 绿圆（2px 直径）叠上，露出 1px 深色环。
// 注意：圆无法与像素网格对齐（任意半径的圆边都落在像素内部），点的边缘天生带抗锯齿。
// 这是圆形的物理属性，不是缺陷 —— 所以下面的像素对齐自检只跑 af-normal（矩形框），
// 不要把 af-drag 加进去，否则「整行不允许半透明像素」这条断言必然误报。

/** 4 的倍数坐标在这些尺寸下正好落在整数像素上，导出后边线零模糊 */
const PNG_SIZES = [256, 128, 96, 64, 48, 32, 24, 16];
const ICO_SIZES = [16, 24, 32, 48, 64, 128, 256];

const COLORS = { base: '#18181A', white: '#F5F5F7', green: '#30D158' };

const ICONS = [
  { file: 'af-normal', token: '--cursor-default', fallback: 'default', label: '正常 · 单点 AF' },
  { file: 'af-hover', token: '--cursor-pointer', fallback: 'pointer', label: '悬停可点 · 单点 AF' },
  { file: 'af-press', token: '--cursor-active', fallback: 'pointer', label: '按下 · 微点 AF' },
  { file: 'af-drag', token: '--cursor-drag', fallback: 'grab', label: '拖拽 · 动态区域 AF' },
];

const readSvg = (name) => fs.readFileSync(path.join(SRC_DIR, `${name}.svg`), 'utf8');

/**
 * 把母版声明的 256 改写成目标尺寸再交给 librsvg 原生栅格化。
 * 比「先渲 256 再缩到 16」锐得多：小尺寸的边缘由几何抗锯齿算出，
 * 而不是重采样出来的灰边。
 */
const renderAt = (svg, size) =>
  sharp(Buffer.from(svg.replace(/width="256"\s+height="256"/, `width="${size}" height="${size}"`)))
    .png({ compressionLevel: 9 })
    .toBuffer();

/* --------------------------------------------------------------------------
 * ICO 打包：ICO 允许直接内嵌 PNG（Vista 起支持），因此零依赖即可写出多尺寸图标
 * -------------------------------------------------------------------------- */
function packIco(entries) {
  const sorted = [...entries].sort((a, b) => a.size - b.size);
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // 保留位
  header.writeUInt16LE(1, 2); // 类型：1 = 图标
  header.writeUInt16LE(sorted.length, 4);

  let offset = 6 + sorted.length * 16;
  const dir = sorted.map(({ size, data }) => {
    const e = Buffer.alloc(16);
    // 尺寸字段是单字节，256 用 0 表示
    e.writeUInt8(size >= 256 ? 0 : size, 0);
    e.writeUInt8(size >= 256 ? 0 : size, 1);
    e.writeUInt8(0, 2); // 调色板数量（真彩为 0）
    e.writeUInt8(0, 3); // 保留位
    e.writeUInt16LE(1, 4); // 色彩平面
    e.writeUInt16LE(32, 6); // 位深
    e.writeUInt32LE(data.length, 8);
    e.writeUInt32LE(offset, 12);
    offset += data.length;
    return e;
  });

  return Buffer.concat([header, ...dir, ...sorted.map((e) => e.data)]);
}

/* --------------------------------------------------------------------------
 * data URI：注释与 title 不进产物（光标没有可访问性语义），换行压平，# 转义
 * -------------------------------------------------------------------------- */
const toCursorValue = (svg) => {
  const compact = svg
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<title>[\s\S]*?<\/title>/g, '')
    .replace(/\s*\n\s*/g, ' ')
    .replace(/>\s+</g, '><')
    // 先改声明尺寸（此刻属性还是双引号），再统一换成单引号
    .replace(/width="256"\s+height="256"/, `width="${CSS_SIZE}" height="${CSS_SIZE}"`)
    // 属性引号必须换成单引号：外层是 url("...")，内层再用双引号会把 CSS 字符串提前闭合
    .replace(/"/g, "'")
    // role / aria-label 对光标毫无意义，且中文属于非 ASCII —— data URI 里不编码就是隐患，一并剥掉
    .replace(/\s+role='img'/g, '')
    .replace(/\s+aria-label='[^']*'/g, '')
    .replace(/#/g, '%23')
    .trim();
  const hot = Math.round((HOTSPOT * CSS_SIZE) / GRID);
  const value = `url("data:image/svg+xml,${compact}") ${hot} ${hot}`;
  // 守门一：url(" 与 ") 之间不允许再出现双引号，否则 CSS 声明会被截断
  if (!/^url\("data:image\/svg\+xml,[^"]*"\) \d+ \d+$/.test(value)) {
    throw new Error('data URI 生成异常：url("…") 内混入了未转义的双引号');
  }
  // 守门二：载荷必须是纯 ASCII。中文等非 ASCII 未做百分号编码时，浏览器可能整条丢弃
  if (!/^[\x20-\x7E]*$/.test(compact)) {
    throw new Error('data URI 生成异常：载荷含非 ASCII 字符，需先做百分号编码');
  }
  return value;
};

/* --------------------------------------------------------------------------
 * 像素对齐自检：把关键几何换算成 32px 下的像素序号，逐点核对颜色。
 * 半像素错位（例如某处坐标不是 4 的倍数）会立刻在这里暴露。
 * -------------------------------------------------------------------------- */
async function assertPixelAligned(svg) {
  const scale = CSS_SIZE / GRID;
  const row = Math.round(HOTSPOT * scale); // 纵向中心行
  const { data, info } = await sharp(await renderAt(svg, CSS_SIZE))
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const at = (x) => {
    const i = (row * info.width + x) * 4;
    const [r, g, b, a] = [data[i], data[i + 1], data[i + 2], data[i + 3]];
    if (a === 0) return 'empty';
    if (a !== 255) return 'blur';
    return '#' + [r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('').toUpperCase();
  };

  // 32px 下（scale 0.25）：底衬占 11..14、面层占 12..13，图形关于 64 对称
  const P = (u) => Math.round(u * scale);
  const mirror = (x) => 2 * P(GRID / 2) - 1 - x; // 像素序号关于中心轴的镜像
  const b0 = P(BASE_OUTER); // 11 底衬外沿
  const f0 = P(FRAME_OUTER); // 12 面层外沿
  const f1 = P(FRAME_OUTER + FRAME_THICK); // 13 面层内沿
  const b1 = P(BASE_OUTER + BASE_THICK); // 14 底衬内沿

  const expected = [
    [b0 - 1, 'empty'], // 底衬之外
    [b0, COLORS.base], // 底衬向外露出的一圈
    // 面层线宽占 f0 .. f1-1 这些列（线宽 1px 时 f1-1 就等于 f0，重复核一遍也无妨）
    [f0, COLORS.white],
    [f1 - 1, COLORS.white],
    [f1, COLORS.base], // 底衬向内露出的一圈
    [b1, 'empty'], // 方框内部
    [P(GRID / 2), 'empty'], // 正中心（单点 AF 的框是空的）
    [mirror(f0), COLORS.white], // 镜像侧逐点核对
    [mirror(f1), COLORS.base],
    [mirror(b0), COLORS.base],
    [mirror(b0) + 1, 'empty'],
  ];

  for (const [x, want] of expected) {
    const got = at(x);
    if (got !== want) {
      throw new Error(
        `像素对齐自检失败：x=${x} 期望 ${want}、实际 ${got}（母版坐标可能不是 4 的倍数）`,
      );
    }
  }

  // 最强断言：整行不允许出现半透明像素。有，就说明某条边落在了半像素上。
  for (let x = 0; x < info.width; x++) {
    if (at(x) === 'blur') {
      throw new Error(`锐度自检失败：x=${x} 是半透明像素，边线落在了半像素上`);
    }
  }
}

/* --------------------------------------------------------------------------
 * 预览图：四态 × 背景 的对比 + 尺寸阶梯，拼成一张联系表。
 * 先出 SVG（矢量、可放大看细节），再栅格化成 2× PNG（直接贴文档/沟通用）。
 * 图形一律从母版内联进来，因此预览图与图标永远是同一份几何，不会各画各的。
 * -------------------------------------------------------------------------- */
const SHEET_W = 1200;
const SHEET_MARGIN = 40;
const SHEET_LABEL_W = 200;
const SHEET_CELL_H = 150;
const SHEET_ICON = 96;
const SHEET_ROWS_Y = 150;
const FONT = 'Microsoft YaHei, PingFang SC, Segoe UI, sans-serif';

/** 背景对照：覆盖「近黑界面 / 纯白照片 / 中灰 / 主色」四种极端 */
const SHEET_BACKGROUNDS = [
  ['站点底色', '#1C1C1E'],
  ['纯白照片', '#FFFFFF'],
  ['中灰', '#808080'],
  ['主色', '#E8A33C'],
];
const LADDER_SIZES = [128, 64, 32, 16];

function buildPreviewSheet() {
  const cellW = (SHEET_W - SHEET_MARGIN * 2 - SHEET_LABEL_W) / SHEET_BACKGROUNDS.length;
  const ladderY = SHEET_ROWS_Y + ICONS.length * SHEET_CELL_H + 56;
  const baseline = ladderY + 48 + 128; // 阶梯底部对齐线
  const height = baseline + 48;

  /** 剥掉母版的外壳，只留图形本体，用于嵌成嵌套 <svg> */
  const inner = (svg) =>
    svg
      .replace(/^[\s\S]*?<svg[^>]*>/, '')
      .replace(/<\/svg>\s*$/, '')
      .replace(/<!--[\s\S]*?-->/g, '')
      .replace(/<title>[\s\S]*?<\/title>/g, '')
      .trim();
  const iconAt = (svg, x, y, size) =>
    `<svg x="${x}" y="${y}" width="${size}" height="${size}" viewBox="0 0 ${GRID} ${GRID}">${inner(svg)}</svg>`;
  const label = (x, y, text, size, fill) =>
    `<text x="${x}" y="${y}" font-family="${FONT}" font-size="${size}" fill="${fill}">${text}</text>`;

  const parts = [
    `<rect width="${SHEET_W}" height="${height}" fill="#0E0E10"/>`,
    label(SHEET_MARGIN, 56, 'AF 光标图标集 · 四态预览', 30, '#F5F5F7'),
    label(
      SHEET_MARGIN,
      84,
      `母版 ${GRID}×${GRID} · CSS 挂载 ${CSS_SIZE}×${CSS_SIZE} · 热点居中 · 不用 stroke，靠深色实心底衬保住轮廓`,
      17,
      '#8E8E93',
    ),
  ];

  // 列头：背景色名
  SHEET_BACKGROUNDS.forEach(([name, fill], c) => {
    const x = SHEET_MARGIN + SHEET_LABEL_W + c * cellW;
    parts.push(label(x + 12, 122, `${name} ${fill}`, 16, '#8E8E93'));
  });

  // 四态 × 四背景
  ICONS.forEach((icon, r) => {
    const y = SHEET_ROWS_Y + r * SHEET_CELL_H;
    parts.push(label(SHEET_MARGIN, y + SHEET_CELL_H / 2 + 2, icon.label, 19, '#F5F5F7'));
    parts.push(label(SHEET_MARGIN, y + SHEET_CELL_H / 2 + 26, icon.token, 15, '#8E8E93'));
    SHEET_BACKGROUNDS.forEach(([, fill], c) => {
      const x = SHEET_MARGIN + SHEET_LABEL_W + c * cellW;
      parts.push(
        `<rect x="${x + 10}" y="${y + 10}" width="${cellW - 20}" height="${SHEET_CELL_H - 20}" rx="14" fill="${fill}"/>`,
        iconAt(svgs.get(icon.file), x + (cellW - SHEET_ICON) / 2, y + (SHEET_CELL_H - SHEET_ICON) / 2, SHEET_ICON),
      );
    });
  });

  // 尺寸阶梯：拖拽态按真实像素尺寸排开，检验小尺寸下图形是否还立得住
  parts.push(label(SHEET_MARGIN, ladderY, '尺寸阶梯（拖拽态，按真实像素尺寸显示）', 17, '#8E8E93'));
  let lx = SHEET_MARGIN;
  for (const size of LADDER_SIZES) {
    const top = baseline - size;
    parts.push(
      `<rect x="${lx}" y="${top}" width="${size}" height="${size}" rx="6" fill="#1C1C1E"/>`,
      iconAt(svgs.get('af-drag'), lx, top, size),
      label(lx, baseline + 24, `${size}px`, 15, '#8E8E93'),
    );
    lx += Math.max(size, 60) + 36;
  }

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${SHEET_W}" height="${height}" viewBox="0 0 ${SHEET_W} ${height}">${parts.join('')}</svg>`;
}

/* --------------------------------------------------------------------------
 * 主流程
 * -------------------------------------------------------------------------- */
const problems = [];
const svgs = new Map(ICONS.map((i) => [i.file, readSvg(i.file)]));

fs.rmSync(DIST_DIR, { recursive: true, force: true });
for (const d of ['svg', 'png', 'ico']) fs.mkdirSync(path.join(DIST_DIR, d), { recursive: true });

const cssLines = [];
for (const icon of ICONS) {
  const svg = svgs.get(icon.file);
  fs.writeFileSync(path.join(DIST_DIR, 'svg', `${icon.file}.svg`), svg);

  const pngs = [];
  for (const size of PNG_SIZES) {
    const data = await renderAt(svg, size);
    pngs.push({ size, data });
    fs.writeFileSync(path.join(DIST_DIR, 'png', `${icon.file}-${size}.png`), data);
  }

  const icoEntries = await Promise.all(
    ICO_SIZES.map(async (size) => ({ size, data: await renderAt(svg, size) })),
  );
  fs.writeFileSync(path.join(DIST_DIR, 'ico', `${icon.file}.ico`), packIco(icoEntries));

  cssLines.push(`  ${icon.token}: ${toCursorValue(svg)}, ${icon.fallback};`);
}

await assertPixelAligned(svgs.get('af-normal'));

/* 预览图：矢量 SVG + 2× 栅格 PNG（density 144 = 72×2，文字与图形都不糊） */
const sheet = buildPreviewSheet();
fs.writeFileSync(path.join(DIST_DIR, 'preview.svg'), sheet);
fs.writeFileSync(
  path.join(DIST_DIR, 'preview.png'),
  await sharp(Buffer.from(sheet), { density: 144 }).png({ compressionLevel: 9 }).toBuffer(),
);

/* 生成 cursors.css（唯一事实源） */
const cssArtifact = [
  '/* 由 packages/design-tokens/scripts/build-cursors.mjs 生成，请勿手改。',
  ' * 改图标请改 cursors/src/*.svg，然后重新构建并回填 apps/web/src/styles/app.css。 */',
  ':root {',
  ...cssLines,
  '}',
  '',
].join('\n');
fs.writeFileSync(path.join(DIST_DIR, 'cursors.css'), cssArtifact);

/* 与 app.css 已回填的值逐条比对 */
const appCss = fs.readFileSync(APP_CSS, 'utf8');
for (const icon of ICONS) {
  const want = toCursorValue(svgs.get(icon.file)) + `, ${icon.fallback}`;
  const m = appCss.match(new RegExp(`(?:^|\\s)${icon.token}\\s*:\\s*([^;]+);`, 'm'));
  if (!m) problems.push(`app.css 缺少 ${icon.token}`);
  else if (m[1].trim() !== want) problems.push(`${icon.token} 与母版不一致 —— 重新构建后回填 app.css`);
}

console.log('AF 光标图标集构建');
console.log(`  母版栅格      : ${GRID}×${GRID}（热点 ${HOTSPOT},${HOTSPOT}）`);
console.log(`  CSS 挂载尺寸  : ${CSS_SIZE}×${CSS_SIZE}（缩放 ${CSS_SIZE / GRID}）`);
console.log(`  面层线宽      : ${FRAME_THICK} 单位 = ${(FRAME_THICK * CSS_SIZE) / GRID}px`);
console.log(`  图标          : ${ICONS.length} 枚`);
console.log(`  PNG           : ${ICONS.length * PNG_SIZES.length} 个（${PNG_SIZES.join('/')}）`);
console.log(`  ICO           : ${ICONS.length} 个（${ICO_SIZES.join('/')} 多尺寸）`);
console.log(`  预览图        : preview.svg + preview.png（2×）`);
console.log(`  CSS 产物      : cursors.css（app.css 的唯一事实源）`);
console.log(`  产物目录      : ${path.relative(process.cwd(), DIST_DIR)}`);
console.log('');

if (problems.length) {
  console.error(`校验失败，共 ${problems.length} 处问题：`);
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}
console.log('校验通过：app.css 里的光标变量与母版完全一致。');
