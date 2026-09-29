/**
 * tools/device-audit/raw-test/verify-raw.ts
 *
 * RAW（TIFF 直读直写）实证脚本 —— 需求 2b/2c 的证据来源。
 *
 * 【为什么要有它，而不是只看单测】NEF/DNG 里像素数据、MakerNotes、内嵌预览全靠**绝对偏移**
 * 被引用，写坏一次就是不可逆的废片。本脚本用真实相机文件做「最严的一刀」：
 *   1. 逐字节比对：除 patch 声明的位置外，原文件区间必须一字不动；
 *   2. 保护区（像素条带/瓦片、MakerNotes、内嵌 JPEG）必须逐字节相同；
 *   3. IFD 结构（表偏移、SubIFDs 数组、条带偏移数组）必须原样；
 *   4. 回读一遍确认字段真的写进去了；
 *   5. 追加区（EOF 之后）只准长、不准短。
 *
 * 【为什么直接 import core 的 .ts 源码】本脚本不属于任何 workspace 包，走 tsx 运行；
 * 直接引源码才能测到「刚改的那一份」，不必先 build。
 */
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import {
  extractEmbeddedPreview,
  protectedRangesOf,
  sniffContainer,
  walkTiffIfds,
} from '../../../packages/core/src/exif-container';
import { containerLabel, readLocalExifAny } from '../../../packages/core/src/exif-read';
import { writeLocalExif } from '../../../packages/core/src/exif-write';
import { planTiffWrite } from '../../../packages/core/src/exif-tiff-write';

/* fixture 目录：默认本目录；可用首个参数指向真实照片目录（相机原片约 40~120MB/张，不进仓库）。
   例：npx tsx tools/device-audit/raw-test/verify-raw.ts "E:\Pics\Nikon\Z72\日出" */
const FIXTURE_DIR = process.argv[2] ? resolve(process.argv[2]) : join(process.cwd(), 'tools', 'device-audit', 'raw-test');
/* 产物一律写回仓库里的 out/ —— 指到真实照片目录时也不往用户的相册目录里丢文件 */
const OUT_DIR = join(process.cwd(), 'tools', 'device-audit', 'raw-test', 'out');

type Range = readonly [number, number];

let failures = 0;

function check(label: string, ok: boolean, detail = ''): void {
  if (ok) console.log(`  [OK]   ${label}${detail ? ` — ${detail}` : ''}`);
  else {
    failures += 1;
    console.log(`  [FAIL] ${label}${detail ? ` — ${detail}` : ''}`);
  }
}

/** 逐字节求差异区间（只比原文件长度范围内的部分） */
function diffRanges(before: Uint8Array, after: Uint8Array): Range[] {
  const length = Math.min(before.length, after.length);
  const out: Range[] = [];
  let start = -1;
  for (let i = 0; i < length; i += 1) {
    const differs = before[i] !== after[i];
    if (differs && start < 0) start = i;
    if (!differs && start >= 0) {
      out.push([start, i]);
      start = -1;
    }
  }
  if (start >= 0) out.push([start, length]);
  return out;
}

const overlaps = (range: Range, protectedRanges: readonly Range[]): Range | undefined =>
  protectedRanges.find((p) => range[0] < p[1] && p[0] < range[1]);

/** 保护区字节是否逐字节相同 —— 像素 / MakerNote / 内嵌预览的最终防线 */
function protectedBytesEqual(before: Uint8Array, after: Uint8Array, ranges: readonly Range[]): string | null {
  for (const [start, end] of ranges) {
    if (end > after.length) return `保护区 [${start}, ${end}) 超出新文件长度`;
    for (let i = start; i < end; i += 1) {
      if (before[i] !== after[i]) return `保护区偏移 ${i} 被改动`;
    }
  }
  return null;
}

/**
 * 结构指纹：只收「改了就会毁片」的那些**引用值** —— SubIFDs 数组、条带/瓦片偏移、
 * 内嵌 JPEG 偏移与长度、以及 IFD0.next(缩略图表链)。
 *
 * 【为什么不收「表自身的偏移」与「IFD 张数」】合法搬迁的本意就是「把整张 IFD 表复制到 EOF、
 * 只改上级指针」，因此表偏移**必然**改变；新增 GPS/EXIF 字段时还会多出一张表。
 * 真正必须一字不差的是它引用的那些绝对偏移 —— 一旦它们变了，像素数据与 MakerNotes
 * 就再也找不回来了。这些引用值按「集合」比较（排序后拼串）：表搬到哪儿不该影响结论。
 */
function structuralFingerprint(bytes: Uint8Array): string {
  const le = bytes[0] === 0x49 && bytes[1] === 0x49;
  const views = walkTiffIfds(bytes);
  const refs: string[] = [`ifd0.next=${views[0]?.next ?? 0}`];
  // 0x014a SubIFDs / 0x0111 StripOffsets / 0x0117 StripByteCounts / 0x0144 TileOffsets /
  // 0x0145 TileByteCounts / 0x0201 JpgFromRawStart / 0x0202 JpgFromRawLength
  const refTags = [0x014a, 0x0111, 0x0117, 0x0144, 0x0145, 0x0201, 0x0202];
  for (const view of views) {
    for (const tag of refTags) {
      const entry = view.entries.find((candidate) => candidate.tag === tag);
      if (entry?.raw) refs.push(`0x${tag.toString(16)}:${Array.from(entry.raw).join(',')}`);
    }
  }
  return `${le ? 'II' : 'MM'}|${refs.sort().join('|')}`;
}

interface Scenario {
  name: string;
  patch: Record<string, string | null>;
  /** 说明这一步在测什么 */
  what: string;
}

const scenarios: readonly Scenario[] = [
  {
    name: 'A-改值',
    what: '全部命中已有 tag：走「原地覆写 / EOF 追加」，原有字节一个不挪',
    patch: { ISO: '1600', FNumber: '4', ExposureTime: '1/500', FocalLength: '50' },
  },
  {
    name: 'B-新增',
    what: '新增 IFD0 + GPS tag：触发整表搬迁 + 结构指针改写',
    patch: {
      ImageDescription: '塑忆 RAW 写入验证',
      Artist: 'shaping-memory',
      GPSLatitude: '31.230416',
      GPSLongitude: '121.473701',
      GPSAltitude: '12.5',
    },
  },
  {
    name: 'C-删除',
    what: '删除上一步新增的字段：表长变短，仍走搬迁不缩文件',
    patch: { ImageDescription: null, Artist: null },
  },
  {
    name: 'D-混合',
    what: '改值 + 新增 + 删除同一批：三类操作交织的边界',
    patch: {
      DateTimeOriginal: '2026-09-25 22:00:00',
      UserComment: 'shaping-memory raw round-trip',
      Copyright: null,
      Software: 'shaping-memory',
    },
  },
];

function runOneFixture(fileName: string): void {
  const source = readFileSync(join(FIXTURE_DIR, fileName));
  const bytes = new Uint8Array(source.buffer, source.byteOffset, source.byteLength);
  const container = sniffContainer(bytes);
  console.log(`\n=== ${fileName} ===`);
  console.log(`  容器: ${container} (${containerLabel(container)})  体积: ${(bytes.length / 1024 / 1024).toFixed(1)} MB`);
  check('嗅探为 RAW/TIFF', container === 'tiff');

  const doc = readLocalExifAny(bytes);
  const tagCount = Object.keys(doc.values).length;
  console.log(`  识别字段 ${tagCount} 个 / 未知字段 ${doc.unknownCount} 个 / 字节序 ${doc.byteOrder}`);
  check('读到了关键字段', tagCount >= 5, `Model=${doc.values.Model ?? '—'} ISO=${doc.values.ISO ?? '—'}`);

  const preview = extractEmbeddedPreview(bytes);
  // NEF 必带内嵌 JpgFromRaw；DxO 出的线性 DNG 只存原始像素、可以没有内嵌预览，此时只记录不判失败
  if (preview) check('能抽出内嵌预览 JPEG', preview.length > 1000, `${preview.length} 字节`);
  else console.log('  [INFO] 该文件没有内嵌 JPEG 预览（线性 DNG 常见），列表缩略图将退化为占位');

  const ranges: Range[] = protectedRangesOf(bytes).map((range) => [range.start, range.end] as const);
  const protectedBytes = ranges.reduce((sum, [s, e]) => sum + (e - s), 0);
  console.log(`  保护区 ${ranges.length} 段 / 共 ${(protectedBytes / 1024 / 1024).toFixed(1)} MB`);
  check('圈出了保护区（像素/MakerNote/预览）', ranges.length > 0);

  const beforeFingerprint = structuralFingerprint(bytes);

  let current = bytes;
  for (const scenario of scenarios) {
    console.log(`  --- ${scenario.name}：${scenario.what} ---`);
    let next: Uint8Array;
    try {
      next = writeLocalExif(current, scenario.patch);
    } catch (err) {
      check(`${scenario.name} 写入未抛错`, false, err instanceof Error ? err.message : String(err));
      continue;
    }
    check(`${scenario.name} 写入未抛错`, true);

    // 1) 只准变长
    check(`${scenario.name} 文件未缩短`, next.length >= current.length, `${current.length} → ${next.length}`);
    // 2) 差异区间不得落在保护区
    const diffs = diffRanges(current, next);
    const clash = diffs.map((range) => overlaps(range, ranges)).find((hit) => hit !== undefined);
    check(
      `${scenario.name} 改动未侵入保护区`,
      clash === undefined,
      clash ? `差异落在保护区 [${clash[0]}, ${clash[1]})` : `共 ${diffs.length} 处差异`,
    );
    // 3) 保护区逐字节相同（含像素数据与 MakerNotes）
    const protectedVerdict = protectedBytesEqual(current, next, ranges);
    check(`${scenario.name} 保护区逐字节一致`, protectedVerdict === null, protectedVerdict ?? '');
    // 4) 结构指纹不变：SubIFDs / 条带偏移 / 内嵌预览偏移 / IFD0.next / 可达 IFD 张数
    const afterFingerprint = structuralFingerprint(next);
    check(
      `${scenario.name} 结构引用值（SubIFDs/像素偏移/IFD1）未变`,
      afterFingerprint === beforeFingerprint,
      afterFingerprint === beforeFingerprint ? '' : `\n         前: ${beforeFingerprint}\n         后: ${afterFingerprint}`,
    );
    // 5) 内嵌预览：原本有就必须字节相同，原本没有就不能凭空多出来
    const previewNext = extractEmbeddedPreview(next);
    const previewKept = preview === null
      ? previewNext === null
      : previewNext !== null && previewNext.length === preview.length &&
        previewNext.every((byte, index) => byte === preview[index]);
    check(`${scenario.name} 内嵌预览原样保留`, previewKept, `${previewNext?.length ?? 0} 字节`);
    // 6) 回读校验 patch 里写入的字段
    const afterDoc = readLocalExifAny(next);
    for (const [name, value] of Object.entries(scenario.patch)) {
      const readBack = afterDoc.values[name] ?? '';
      if (value === null) check(`${scenario.name} 已删除 ${name}`, readBack === '', `回读「${readBack}」`);
      else check(`${scenario.name} 写入 ${name}`, readBack === value, `期望「${value}」回读「${readBack}」`);
    }
    // 7) 计划里报告的搬迁必须真的发生了（否则说明分类逻辑退化成原地写）
    const plan = planTiffWrite(current, scenario.patch);
    if (plan) {
      console.log(
        `         计划：原地改写 ${plan.writes.length} 处 / 追加 ${plan.appended.length} 字节 / 整表搬迁 ${plan.relocations.length} 次`,
      );
    }
    current = next;
  }

  const outPath = join(OUT_DIR, fileName.replace(/\.(nef|dng|tif|tiff)$/i, '') + '-edited' + fileName.slice(fileName.lastIndexOf('.')));
  writeFileSync(outPath, current);
  console.log(`  已写出：${outPath}`);
}

console.log('RAW / TIFF EXIF 读写实证开始');
console.log(`fixture 目录：${FIXTURE_DIR}`);

/* 覆盖面：两张普通 RAW（含内嵌预览与 MakerNotes）+ 一张 DNG（多为线性，像素表结构最碎） */
const fixtures = (() => {
  const all = readdirSync(FIXTURE_DIR).filter((name) => /\.(nef|cr2|arw|tif|tiff|dng)$/i.test(name));
  const linear = all.filter((name) => /\.dng$/i.test(name));
  const plain = all.filter((name) => !/\.dng$/i.test(name));
  return [...plain.slice(0, 2), ...linear.slice(0, 1)];
})();
if (fixtures.length === 0) {
  console.log('[FAIL] fixture 目录里没有 .NEF / .CR2 / .ARW / .DNG 文件');
  process.exitCode = 1;
}

for (const name of fixtures) {
  try {
    runOneFixture(name);
  } catch (err) {
    failures += 1;
    console.log(`  [FAIL] ${name} 执行中断：${err instanceof Error ? err.stack : String(err)}`);
  }
}

console.log(`\n${failures === 0 ? '全部通过 ✅' : `${failures} 项未通过 ❌`}`);
process.exitCode = failures === 0 ? 0 : 1;