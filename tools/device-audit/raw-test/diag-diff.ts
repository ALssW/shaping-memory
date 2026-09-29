/**
 * 写入差异定位工具：把差异字节归属到具体的 IFD 表结构位置。
 * 跨端一致性复验的配套工具（复验协议见《移动端多设备适配测试报告》§8.5.4，该报告已归档）。
 *
 * 两种模式：
 *   · 默认（给源文件）：对它打补丁（可用 `DIAG_PATCH` 环境变量覆盖 JSON），
 *     diff「原字节 vs Node 端写入产物」，产物落到本目录 `out/`；
 *   · `--diff a b`：直接 diff 两个已有文件 —— 用于比对**同一补丁下 Node 端产物
 *     与设备端（Hermes）产物**，看移动端写入到底多改了哪几处。
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';

import { walkTiffIfds } from '../../../packages/core/src/exif-container';
import { readLocalExifAny } from '../../../packages/core/src/exif-read';
import { writeLocalExif } from '../../../packages/core/src/exif-write';

/* 补丁可用环境变量 DIAG_PATCH 覆盖（JSON），便于复现设备端的实际改动 */
const patch: Record<string, string | null> = process.env.DIAG_PATCH
  ? JSON.parse(process.env.DIAG_PATCH)
  : { Copyright: 'SM-DNG-TEST' };

/** 把一段区间归属到「哪张表的结构区」——只认条目自身的 12 字节，不猜值数据区 */
function tableLabeller(bytes: Uint8Array) {
  const views = walkTiffIfds(bytes);
  return (start: number, end: number): { text: string; entryAt: number } => {
    const hits: string[] = [];
    let entryAt = -1;
    for (const view of views) {
      const body = { start: view.offset, end: view.offset + 2 + view.entries.length * 12 + 4 };
      if (start < body.end && body.start < end) {
        const index = view.entryOffsets.findIndex((at) => start < at + 12 && at < end);
        const entry = index >= 0 ? view.entries[index] : undefined;
        if (index >= 0 && entryAt < 0) entryAt = view.entryOffsets[index];
        hits.push(
          `${view.origin}@${view.offset}${
            entry ? ` tag 0x${entry.tag.toString(16)}(type=${entry.type},count=${entry.count}) 条目内` : ' 表头/next'
          }`,
        );
      }
    }
    return { text: hits.length ? hits.join(' | ') : '（不在任何 IFD 表结构内）', entryAt };
  };
}

function hex(bytes: Uint8Array, start: number, end: number): string {
  return Array.from(bytes.subarray(start, Math.min(end, bytes.length)))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join(' ');
}

function diffPair(before: Uint8Array, after: Uint8Array, heading: string): void {
  console.log(`\n${heading}`);
  const label = tableLabeller(before);
  const length = Math.min(before.length, after.length);
  let start = -1;
  let count = 0;
  for (let i = 0; i <= length; i += 1) {
    const differs = i < length && before[i] !== after[i];
    if (differs && start < 0) start = i;
    if (!differs && start >= 0) {
      count += 1;
      const { text, entryAt } = label(start, i);
      console.log(`\n  [差异 ${count}] 偏移 ${start}..${i}（${i - start} 字节）  归属: ${text}`);
      console.log(`    前: ${hex(before, start, i)}`);
      console.log(`    后: ${hex(after, start, i)}`);
      if (entryAt >= 0) {
        console.log(`    所在条目完整 12 字节 —— 前: ${hex(before, entryAt, entryAt + 12)}`);
        console.log(`    所在条目完整 12 字节 —— 后: ${hex(after, entryAt, entryAt + 12)}`);
      }
      start = -1;
    }
  }
  console.log(`\n  重叠区间内共 ${count} 处差异；前 ${before.length} 字节 / 后 ${after.length} 字节`);
}

function runSource(path: string): void {
  const before = new Uint8Array(readFileSync(path));
  const after = writeLocalExif(before, patch);
  diffPair(before, after, `=== ${path}（Node 端写入 ${JSON.stringify(patch)}）===`);

  console.log(`  回读 Copyright = ${readLocalExifAny(after).values.Copyright ?? '（空）'}`);
  const outPath = join(
    'tools',
    'device-audit',
    'raw-test',
    'out',
    `${basename(path).replace(/\.[^.]+$/, '')}-single${path.slice(path.lastIndexOf('.'))}`,
  );
  writeFileSync(outPath, after);
  console.log(`  已写出：${outPath}`);
}

const args = process.argv.slice(2);
if (args[0] === '--diff') {
  for (let at = 1; at + 1 < args.length; at += 2) {
    diffPair(
      new Uint8Array(readFileSync(args[at])),
      new Uint8Array(readFileSync(args[at + 1])),
      `=== ${args[at]}\n    → ${args[at + 1]} ===`,
    );
  }
} else {
  for (const path of args) runSource(path);
}
