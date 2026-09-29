/**
 * packages/core/src/exif-tiff-write.ts
 *
 * TIFF / RAW（NEF / CR2 / ARW / DNG …）的**安全写入器** —— 本工具风险最高的一处代码。
 *
 * 【为什么不能照搬 JPEG 那套】JPEG 的 EXIF 住在独立 APP1 段里，整段替换不会碰到图像数据，
 * 所以 `exif-io.ts` 敢「重建 TIFF + 整段换掉」。RAW 完全不同：**整个文件就是 TIFF**，
 * IFD0 的 SubIFD 里存着指向像素数据的**绝对偏移**，MakerNotes 内部也满是绝对偏移。
 * 一旦插入或删除任何一个字节，其后所有偏移立即错位 —— 照片会立即损坏，且不可逆。
 *
 * 【因此只允许三类操作，其余一律拒绝】
 *   A. 原地改写：值长度 ≤ 4 字节时直接写进条目的 4 字节内联槽（同时同步 count 字段）；
 *   B. 追加到文件末尾：值变长时把新值追加到 EOF，只把条目里的 value-offset 原地改指过去；
 *   C. 整表搬迁：需要增删 tag（表长会变）时，把整张 IFD 复制到 EOF，原地只改**上级指针**
 *      （TIFF 头里的 IFD0 偏移，或 IFD0 里的 ExifIFD `0x8769` / GPSInfo `0x8825` 值槽）。
 *      **旧表字节一律不删** —— 即使仍有结构按旧偏移引用它，读到的仍是一份自洽的旧表，
 *      而不是被掏空的空表。这是「保留冗余字节、避免悬空指针」的取舍。
 *
 * A/B 的共同点是「原有字节一个不挪」；C 只挪「表」这种被指针引用的结构，且搬迁前先做
 * **指针反查**（含 MakerNote 内嵌 IFD）：发现任何第三方结构引用了要搬走的表就拒绝写。
 * MakerNote 结构无法解析时同样拒绝 —— 不冒险执行一次可能毁片的搬迁。
 *
 * 【写后审计是最后一道闸】apply 之后逐字节比对：改动只准落在 plan 声明的位置；
 * 再回读一次确认每个字段真的写进去了。任何一条不过即抛错丢弃结果 —— 宁可放弃写入，也不产出损坏文件。
 */
import {
  IFD_NAMES,
  TAG_EXIF_IFD_POINTER,
  TAG_GPS_IFD_POINTER,
  TAG_GPS_VERSION_ID,
  TAG_TABLE,
  TYPE_BYTE,
  TYPE_LONG,
  TYPE_SLONG,
  dataViewOf,
  encodeValue,
  ifdSize,
  parseIfd,
  parseTiff,
  readI32,
  readU16,
  readU32,
  unsupportedTagError,
  writeU16,
  writeU32,
} from './exif-io';
import type { EncodedValue, ParsedEntry, ParsedIfd, ParsedTiff, TagSpec, TiffIfd } from './exif-io';
import { sniffContainer, walkTiffIfds } from './exif-container';
import { readLocalExifAny } from './exif-read';
import { EXIF_FIELDS, GPS_TAGS } from './exif-fields';
import type { ExifFieldType } from './exif-fields';
import { exifRawToText, exifSameText } from './exif-values';
import { canonicalExposureText, exposureKindOfTag } from './exposure-presets';

/* ========================================================================== */
/* 1. 对外错误与计划结构                                                        */
/* ========================================================================== */

/** 拒绝写入：每一条都带中文可读原因，绝不静默降级成本地「看起来成功」 */
export class TiffWriteRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TiffWriteRefusedError';
  }
}

/** 原地改写一处（长度 ≤ 4 字节，因此不会改变文件长度） */
interface InPlaceWrite {
  offset: number;
  bytes: Uint8Array;
}

/** 一次整表搬迁：旧表字节不动，新表落在文件末尾 */
export interface TiffRelocation {
  ifd: TiffIfd;
  /** 旧表偏移（字节仍在原位，只是不再被指针引用） */
  from: number;
  /** 新表偏移（位于追加区） */
  to: number;
}

export interface TiffWritePlan {
  /** 允许变动的**原有**字节区间（审计白名单，已合并去重；追加区不在其内） */
  diffRanges: readonly (readonly [number, number])[];
  /** 会追加到文件末尾的字节；为空表示文件长度不变 */
  appended: Uint8Array;
  /** 原地改写清单 */
  writes: readonly InPlaceWrite[];
  /** 回读期望：tag → 期望读出的值（审计用的独立校验口径） */
  expected: Readonly<Record<string, string>>;
  /** 整表搬迁清单；为空表示本次只做了 A / B 两类操作 */
  relocations: readonly TiffRelocation[];
}

/** 某个 tag 在文件里的一处落点 */
interface Slot {
  entry: ParsedEntry;
  /** 条目 12 字节起点的绝对偏移（count 在 +4、value/offset 在 +8） */
  entryAt: number;
  /** 落在哪张主表（同名 tag 可能同时存在于 IFD0 与 ExifIFD） */
  ifd: TiffIfd;
}

/** tag 编号 → 规范（新增时要知道它该住哪张表、落盘什么类型） */
const SPEC_BY_ID = new Map<number, TagSpec>(Array.from(TAG_TABLE.values()).map((spec) => [spec.id, spec]));

/** 追加区分配器：值与新表都排在原文件之后，偏移仍是「从文件头算起」的绝对偏移 */
interface Appender {
  chunks: Uint8Array[];
  cursor: number;
}

function appenderFrom(length: number): Appender {
  // 对齐由 allocate / alignAppender 负责（每处落位前都补一次），这里只管从原长度起步
  return { chunks: [], cursor: length };
}

/**
 * 补到 2 字节对齐。
 * 【为什么每处落位前都要补】部分老解析器要求字对齐；不补的话，一个奇数长度的值会让
 * **其后所有值**落到奇数偏移上，exiftool 会对每条逐次告警 `[minor] Odd offset for …`
 * —— 不致命，但一份「通篇可疑」的 RAW 会使人不敢使用。
 */
function alignAppender(app: Appender): void {
  if (app.cursor % 2 === 0) return;
  app.chunks.push(new Uint8Array(1));
  app.cursor += 1;
}

function allocate(app: Appender, data: Uint8Array): number {
  alignAppender(app);
  const at = app.cursor;
  app.chunks.push(data);
  app.cursor += data.length;
  return at;
}

/** 4 字节小工具：count 字段、value-offset 字段、结构指针都用它 */
function u32Bytes(value: number, le: boolean): Uint8Array {
  const out = new Uint8Array(4);
  writeU32(dataViewOf(out), 0, value, le);
  return out;
}

const reasonOf = (err: unknown): string => (err instanceof Error ? err.message : '未知错误');

const parsedIfdOf = (parsed: ParsedTiff, ifd: TiffIfd): ParsedIfd | undefined =>
  ifd === 'ifd0' ? parsed.ifd0 : ifd === 'exif' ? parsed.exif : parsed.gps;

/* ========================================================================== */
/* 2. 规划入口：先分类，再决定走「原地值写入」还是「整表搬迁」                     */
/* ========================================================================== */

/** 一次 patch 的三种意图（按 tag 编号归口，避免同名 tag 在多表里重复计算） */
interface PatchIntent {
  /** tag 编号 → 新值文本：文件里已有该 tag，只改值 */
  updates: ReadonlyMap<number, string>;
  /** tag 编号 → 新值文本：文件里没有该 tag，需要新增 */
  adds: ReadonlyMap<number, string>;
  /** tag 编号 → 字段名：需要整条摘掉 */
  deletes: ReadonlyMap<number, string>;
  /** tag 编号 → 字段名（三者并集，写「期望值」与报错文案时用） */
  names: ReadonlyMap<number, string>;
}

/** 某张表要怎么改：fresh = 要写新值的条目，remove = 要摘掉的条目 */
interface TableEdit {
  fresh: Set<number>;
  remove: Set<number>;
}

/**
 * 规划一次 RAW 写入。返回 null 表示「这次 patch 不需要改动任何字节」（例如 patch 为空）。
 * 任何越界、类型不符、结构无法安全搬迁的情形都抛 TiffWriteRefusedError。
 */
export function planTiffWrite(bytes: Uint8Array, patch: Record<string, string | null>): TiffWritePlan | null {
  if (sniffContainer(bytes) !== 'tiff') {
    throw new TiffWriteRefusedError('这不是 TIFF/RAW 文件，不能按 RAW 的规则写入');
  }
  let parsed: ParsedTiff;
  try {
    parsed = parseTiff(bytes);
  } catch (err) {
    throw new TiffWriteRefusedError(`这张照片的拍摄信息结构异常（${reasonOf(err)}），为保护原图已放弃保存`);
  }
  if (Object.keys(patch).length === 0) return null;

  const le = parsed.byteOrder === 'II';
  const slots = indexSlots(parsed);
  // GPS 方向伴随字段必须一起写：本体是无符号的，漏写方向会把照片定位到镜像的另一个半球
  const intent = classifyPatch(withGpsCompanions(patch), slots);
  const rebuild = rebuiltTablesOf(intent, parsed, slots);

  return rebuild.size === 0
    ? planValueWrite(bytes, intent, slots, le)
    : planRelocationWrite(bytes, parsed, intent, rebuild, slots, le);
}

/** 建索引：tag 编号 → 它在三张主表里的全部落点 */
function indexSlots(parsed: ParsedTiff): Map<number, Slot[]> {
  const map = new Map<number, Slot[]>();
  for (const ifd of IFD_NAMES) {
    const parsedIfd = parsedIfdOf(parsed, ifd);
    if (!parsedIfd) continue;
    parsedIfd.entries.forEach((entry, index) => {
      const slot: Slot = { entry, entryAt: parsedIfd.offset + 2 + index * 12, ifd };
      const list = map.get(entry.tag);
      if (list) list.push(slot);
      else map.set(entry.tag, [slot]);
    });
  }
  return map;
}

/**
 * 用户 patch + GPS 方向伴随字段。
 * 【为什么要在这里做】方向字段可能原文件中原本不存在（新增），也可能只是改值，
 * 统一并入 patch 后，后面的「原地/搬迁」分类就不必为它写特例。
 */
function withGpsCompanions(patch: Record<string, string | null>): Record<string, string | null> {
  const out: Record<string, string | null> = { ...patch };
  const companions: ReadonlyArray<readonly [string, string, string, string]> = [
    ['GPSLatitude', 'GPSLatitudeRef', 'N', 'S'],
    ['GPSLongitude', 'GPSLongitudeRef', 'E', 'W'],
  ];
  for (const [valueTag, refTag, positive, negative] of companions) {
    const value = patch[valueTag];
    if (value === undefined || value === null) continue;
    out[refTag] = Number(value) < 0 ? negative : positive;
  }
  const altitude = patch.GPSAltitude;
  // 海拔方向是 0/1 的枚举（0 = 海平面以上）
  if (altitude !== undefined && altitude !== null) out.GPSAltitudeRef = Number(altitude) < 0 ? '1' : '0';
  return out;
}

function classifyPatch(patch: Record<string, string | null>, slots: Map<number, Slot[]>): PatchIntent {
  const updates = new Map<number, string>();
  const adds = new Map<number, string>();
  const deletes = new Map<number, string>();
  const names = new Map<number, string>();
  for (const [name, value] of Object.entries(patch)) {
    const spec = TAG_TABLE.get(name);
    if (!spec) throw new TiffWriteRefusedError(unsupportedTagError(name).message);
    names.set(spec.id, name);
    const found = slots.get(spec.id) ?? [];
    if (value === null) {
      // 原文件本来就没有这个 tag，清除是个空操作
      if (found.length > 0) deletes.set(spec.id, name);
      continue;
    }
    if (found.length > 0) updates.set(spec.id, value);
    else adds.set(spec.id, value);
  }
  return { updates, adds, deletes, names };
}

/** 哪些主表需要重整（表长会变）：新增 → 字段的归属表；删除 → 该 tag 全部落点所在的表 */
function rebuiltTablesOf(intent: PatchIntent, parsed: ParsedTiff, slots: Map<number, Slot[]>): Set<TiffIfd> {
  const rebuild = new Set<TiffIfd>();
  for (const id of intent.adds.keys()) {
    const spec = SPEC_BY_ID.get(id);
    if (!spec) continue;
    rebuild.add(spec.ifd);
    // 全新的一张子表：还得在 IFD0 里补一条结构指针 → IFD0 的表长同样会变
    if (spec.ifd !== 'ifd0' && !parsedIfdOf(parsed, spec.ifd)) rebuild.add('ifd0');
  }
  for (const id of intent.deletes.keys()) for (const slot of slots.get(id) ?? []) rebuild.add(slot.ifd);
  return rebuild;
}

/* ========================================================================== */
/* 3. A / B：原地覆写 + EOF 追加（原有字节一个不挪）                             */
/* ========================================================================== */

/** 把一份编码结果写到某个落点：≤4 字节走内联槽，否则追加到 EOF 并改指过去 */
function writeValueAt(
  app: Appender,
  writes: InPlaceWrite[],
  slot: Slot,
  encoded: EncodedValue,
  tagName: string,
  le: boolean,
): void {
  if (slot.entry.type !== encoded.type) {
    throw new TiffWriteRefusedError(
      `字段「${tagName}」在原文件里的数据类型与可写入类型不一致，已拒绝写入以免损坏文件`,
    );
  }
  // count 跟随值长度：ASCII 变长/变短时不更新此处，解析器会读出多余的残留字节
  const countBytes = u32Bytes(encoded.count, le);
  if (encoded.data.length <= 4) {
    const inline = new Uint8Array(4);
    inline.set(encoded.data, 0);
    writes.push({ offset: slot.entryAt + 4, bytes: countBytes }, { offset: slot.entryAt + 8, bytes: inline });
    return;
  }
  const at = allocate(app, encoded.data);
  writes.push({ offset: slot.entryAt + 4, bytes: countBytes }, { offset: slot.entryAt + 8, bytes: u32Bytes(at, le) });
}

/** 编码一个字段的值，失败时换成可读的中文拒绝原因 */
function encodeField(spec: TagSpec, tagName: string, text: string, le: boolean): EncodedValue {
  try {
    return encodeValue(spec, text, le);
  } catch (err) {
    throw new TiffWriteRefusedError(`字段「${tagName}」的值无法编码：${reasonOf(err)}`);
  }
}

/** 只做 A / B：patch 全部命中已有 tag 的改值场景 */
function planValueWrite(
  bytes: Uint8Array,
  intent: PatchIntent,
  slots: Map<number, Slot[]>,
  le: boolean,
): TiffWritePlan | null {
  const app = appenderFrom(bytes.length);
  const writes: InPlaceWrite[] = [];
  const expected: Record<string, string> = {};

  for (const [id, text] of intent.updates) {
    const tagName = intent.names.get(id) ?? `${id}`;
    const spec = SPEC_BY_ID.get(id);
    if (!spec) continue;
    const encoded = encodeField(spec, tagName, text, le);
    // 同名 tag 在多张表里都出现时一并更新：只改一处会留下不一致的副本
    for (const slot of slots.get(id) ?? []) writeValueAt(app, writes, slot, encoded, tagName, le);
    expected[tagName] = text;
  }

  if (writes.length === 0) return null;
  return {
    writes,
    appended: concatChunks(app.chunks),
    diffRanges: whitelistOf(writes, bytes.length),
    expected,
    relocations: [],
  };
}

/* ========================================================================== */
/* 4. C：整表搬迁                                                              */
/* ========================================================================== */

/** 按「哪张表要动哪些条目」分组；新增按字段归属表落位，改值/删除按原落点逐表落位 */
function editsByTable(intent: PatchIntent, slots: Map<number, Slot[]>): Map<TiffIfd, TableEdit> {
  const edits = new Map<TiffIfd, TableEdit>();
  const editOf = (ifd: TiffIfd): TableEdit => {
    const found = edits.get(ifd);
    if (found) return found;
    const created: TableEdit = { fresh: new Set(), remove: new Set() };
    edits.set(ifd, created);
    return created;
  };
  for (const id of intent.updates.keys()) for (const slot of slots.get(id) ?? []) editOf(slot.ifd).fresh.add(id);
  for (const id of intent.adds.keys()) {
    const spec = SPEC_BY_ID.get(id);
    if (spec) editOf(spec.ifd).fresh.add(id);
  }
  for (const id of intent.deletes.keys()) for (const slot of slots.get(id) ?? []) editOf(slot.ifd).remove.add(id);
  return edits;
}

/** 每张待重整表的条目 tag 编号（升序）：保留原有条目 − 被重写的 + 新增的 + IFD0 结构指针 */
function tableLayouts(
  parsed: ParsedTiff,
  rebuild: ReadonlySet<TiffIfd>,
  edits: Map<TiffIfd, TableEdit>,
): Map<TiffIfd, number[]> {
  const layouts = new Map<TiffIfd, number[]>();
  for (const ifd of IFD_NAMES) {
    if (!rebuild.has(ifd)) continue;
    const edit = edits.get(ifd);
    const dropped = new Set<number>([...(edit?.remove ?? []), ...(edit?.fresh ?? [])]);
    const kept = (parsedIfdOf(parsed, ifd)?.entries ?? [])
      .map((entry) => entry.tag)
      .filter((tag) => !dropped.has(tag));
    // 新建的 GPS 表必须带 GPSVersionID，否则部分解析器不认整张表
    const seeded = ifd === 'gps' && !parsed.gps ? [TAG_GPS_VERSION_ID] : [];
    layouts.set(ifd, [...new Set([...kept, ...(edit?.fresh ?? []), ...seeded])].sort((a, b) => a - b));
  }
  return layouts;
}

/** IFD0 要保留 / 补齐的结构指针（目标表不存在就不写，避免留下指向 0 的野指针） */
function pointerTagsOf(parsed: ParsedTiff, rebuild: ReadonlySet<TiffIfd>): number[] {
  const tags: number[] = [];
  if (parsed.exif || rebuild.has('exif')) tags.push(TAG_EXIF_IFD_POINTER);
  if (parsed.gps || rebuild.has('gps')) tags.push(TAG_GPS_IFD_POINTER);
  return tags;
}

/** 新表里的一条条目：值域 4 字节已定（内联值或 value-offset） */
interface BuiltEntry {
  tag: number;
  type: number;
  count: number;
  slot: Uint8Array;
}

/** 序列化一张 IFD：count + 条目（升序）+ next */
function serializeTable(entries: readonly BuiltEntry[], next: number, le: boolean): Uint8Array {
  const out = new Uint8Array(ifdSize(entries.length));
  const view = dataViewOf(out);
  writeU16(view, 0, entries.length, le);
  entries.forEach((entry, index) => {
    const at = 2 + index * 12;
    writeU16(view, at, entry.tag, le);
    writeU16(view, at + 2, entry.type, le);
    writeU32(view, at + 4, entry.count, le);
    out.set(entry.slot, at + 8);
  });
  writeU32(view, 2 + entries.length * 12, next, le);
  return out;
}

/** 搬迁时的上下文：新表偏移、重写过的值槽、原表条目查找 */
interface RelocationContext {
  parsed: ParsedTiff;
  layouts: Map<TiffIfd, number[]>;
  edits: Map<TiffIfd, TableEdit>;
  tableAt: Map<TiffIfd, number>;
  freshEntries: Map<number, BuiltEntry>;
  pointerTags: readonly number[];
  le: boolean;
}

function planRelocationWrite(
  bytes: Uint8Array,
  parsed: ParsedTiff,
  intent: PatchIntent,
  rebuild: ReadonlySet<TiffIfd>,
  slots: Map<number, Slot[]>,
  le: boolean,
): TiffWritePlan {
  assertRelocationSafe(bytes, parsed, rebuild, le);

  const app = appenderFrom(bytes.length);
  const writes: InPlaceWrite[] = [];
  const edits = editsByTable(intent, slots);
  const layouts = tableLayouts(parsed, rebuild, edits);
  const freshEntries = new Map<number, BuiltEntry>();

  // 第一遍：被重整的表要写的新值字节先落位 —— 新表的 value-offset 必须指向它们
  for (const ifd of IFD_NAMES) {
    for (const id of edits.get(ifd)?.fresh ?? []) {
      const spec = SPEC_BY_ID.get(id);
      if (!spec) continue;
      const tagName = intent.names.get(id) ?? `${id}`;
      const encoded = encodeField(spec, tagName, textOf(intent, id), le);
      freshEntries.set(id, { tag: id, type: encoded.type, count: encoded.count, slot: slotOf(app, encoded, le) });
    }
  }

  // 第二遍：**没被重整**的表里的改值走原地覆写（新增/删除必然触发重整，故这里只可能是改值）。
  // 【为什么必须排在表落位之前】它可能往追加区塞长值，塞晚了就会插到新表字节中间去
  for (const ifd of IFD_NAMES) {
    if (rebuild.has(ifd)) continue;
    for (const id of edits.get(ifd)?.fresh ?? []) {
      const spec = SPEC_BY_ID.get(id);
      if (!spec) continue;
      const tagName = intent.names.get(id) ?? `${id}`;
      const encoded = encodeField(spec, tagName, textOf(intent, id), le);
      for (const slot of slots.get(id) ?? []) writeValueAt(app, writes, slot, encoded, tagName, le);
    }
  }

  // 第三遍：值都排完了，新表按 IFD_NAMES 顺序紧跟着落位
  // 【为什么要先补一次对齐】表长恒为偶数，只要这段起点是偶数，后面所有表就都落在偶数偏移；
  // 只需补这一处，不能逐表补（挨个补会把垫字节全挤到所有表之前，顺序就错位了）
  alignAppender(app);
  const tableAt = new Map<TiffIfd, number>();
  for (const ifd of IFD_NAMES) {
    const layout = layouts.get(ifd);
    if (!layout) continue;
    tableAt.set(ifd, app.cursor);
    app.cursor += ifdSize(layout.length);
  }

  const ctx: RelocationContext = { parsed, layouts, edits, tableAt, freshEntries, pointerTags: pointerTagsOf(parsed, rebuild), le };
  const tables: Uint8Array[] = [];
  const relocations: TiffRelocation[] = [];
  for (const ifd of IFD_NAMES) {
    const layout = layouts.get(ifd);
    if (!layout) continue;
    const oldAt = parsedIfdOf(parsed, ifd)?.offset ?? 0;
    const newAt = tableAt.get(ifd)!;
    if (oldAt > 0) relocations.push({ ifd, from: oldAt, to: newAt });
    tables.push(serializeTable(buildTableEntries(ifd, ctx), parsedIfdOf(parsed, ifd)?.next ?? 0, le));
    // 表本体落在追加区里；只有「上级表没被重整」时才需要原地改指针
    if (ifd === 'ifd0') writes.push({ offset: 4, bytes: u32Bytes(newAt, le) });
    else if (!rebuild.has('ifd0')) writes.push(inPlacePointer(parsed, newAt, ifd, le));
  }

  const expected: Record<string, string> = {};
  for (const [id, text] of intent.updates) expected[intent.names.get(id) ?? `${id}`] = text;
  for (const [id, text] of intent.adds) expected[intent.names.get(id) ?? `${id}`] = text;
  // 删除：回读期望是「读不出来」
  for (const name of intent.deletes.values()) expected[name] = '';

  return {
    writes,
    // 顺序即偏移顺序：值区（含对齐垫字节）在前，新表依次在后
    appended: concatChunks([...app.chunks, ...tables]),
    diffRanges: whitelistOf(writes, bytes.length),
    expected,
    relocations,
  };
}

/** 按 layout 逐条生成新表条目：结构指针 → 新值 → 原有条目原样复用 */
function buildTableEntries(ifd: TiffIfd, ctx: RelocationContext): BuiltEntry[] {
  const original = parsedIfdOf(ctx.parsed, ifd)?.entries ?? [];
  return (ctx.layouts.get(ifd) ?? []).flatMap((tag) => {
    if (ifd === 'ifd0' && ctx.pointerTags.includes(tag)) {
      const target = tag === TAG_EXIF_IFD_POINTER ? 'exif' : 'gps';
      const at = ctx.tableAt.get(target) ?? parsedIfdOf(ctx.parsed, target)?.offset ?? 0;
      if (at === 0) return [];
      return [{ tag, type: TYPE_LONG, count: 1, slot: u32Bytes(at, ctx.le) }];
    }
    // 新建 GPS 表时的版本号：4 个 BYTE 的固定值，写不出别的
    if (tag === TAG_GPS_VERSION_ID && !ctx.parsed.gps) {
      return [{ tag, type: TYPE_BYTE, count: 4, slot: Uint8Array.from([2, 3, 0, 0]) }];
    }
    const fresh = ctx.freshEntries.get(tag);
    if (fresh && ctx.edits.get(ifd)?.fresh.has(tag)) return [fresh];
    const kept = original.find((entry) => entry.tag === tag);
    if (!kept) return [];
    // 未改动条目：值域 4 字节原样复用（内联值或旧的 value-offset 都继续成立）
    return [{ tag, type: kept.type, count: kept.count, slot: kept.entryBytes.slice(8, 12) }];
  });
}

/** 值 ≤4 字节走内联，否则追加到 EOF —— 新表里的条目一律用这条路 */
function slotOf(app: Appender, encoded: EncodedValue, le: boolean): Uint8Array {
  if (encoded.data.length <= 4) {
    const inline = new Uint8Array(4);
    inline.set(encoded.data, 0);
    return inline;
  }
  return u32Bytes(allocate(app, encoded.data), le);
}

/** 上级表没被重整时，原地把结构指针改指新表 */
function inPlacePointer(parsed: ParsedTiff, newAt: number, ifd: TiffIfd, le: boolean): InPlaceWrite {
  const pointerTag = ifd === 'exif' ? TAG_EXIF_IFD_POINTER : TAG_GPS_IFD_POINTER;
  const ifd0 = parsed.ifd0;
  const index = ifd0?.entries.findIndex((entry) => entry.tag === pointerTag) ?? -1;
  if (!ifd0 || index < 0) {
    throw new TiffWriteRefusedError(`原文件里找不到指向 ${ifd} 表的结构指针，已拒绝写入以免损坏文件`);
  }
  return { offset: ifd0.offset + 2 + index * 12 + 8, bytes: u32Bytes(newAt, le) };
}

/** 取某 tag 这次要写入的文本（改值优先，其次新增） */
function textOf(intent: PatchIntent, id: number): string {
  return intent.updates.get(id) ?? intent.adds.get(id) ?? '';
}

/* ========================================================================== */
/* 5. 搬迁前的指针反查（拒绝网）                                                 */
/* ========================================================================== */

/**
 * 确认没有任何第三方结构用绝对偏移引用计划搬走的表。
 * 合法引用只有两处，且本模块本来就会改写它们：TIFF 头的 IFD0 偏移、IFD0 里的 ExifIFD/GPS 指针。
 * 【为什么连 MakerNote 也要翻】厂商私有结构里全是相对自身基址的偏移，理论上不会指向主表，
 * 但「理论上」不足以支撑一次不可逆的写入 —— 无法穷尽检查就直接拒绝。
 */
function assertRelocationSafe(bytes: Uint8Array, parsed: ParsedTiff, rebuild: ReadonlySet<TiffIfd>, le: boolean): void {
  const targets = new Map<number, TiffIfd>();
  const allowed = new Set<string>();
  // ExifIFD / GPS 偏移是「几千~几十万」这种量级，几乎不可能与普通数据值撞车，值得反查。
  if (rebuild.has('exif') && parsed.exif) {
    targets.set(parsed.exif.offset, 'exif');
    allowed.add(`ifd0:${TAG_EXIF_IFD_POINTER}`);
  }
  if (rebuild.has('gps') && parsed.gps) {
    targets.set(parsed.gps.offset, 'gps');
    allowed.add(`ifd0:${TAG_GPS_IFD_POINTER}`);
  }
  targets.delete(0);
  if (targets.size === 0) return;

  /* 【为什么反查唯独跳过 IFD0】IFD0 的偏移按规范恒等于 8，与「值就是 8」的普通数据
     （NEF 里 BitsPerSample 就是 [8,8,8]）在字节上完全无法区分，反查必然误报。
     这也不构成风险：旧表字节**从不删除**，万一仍有结构按旧偏移引用 IFD0，读到的仍是一份
     自洽的旧表，而不是悬空指针。 */
  for (const view of walkTiffIfds(bytes)) {
    for (const entry of view.entries) {
      const hit = offsetValuesOf(entry, le).find((value) => targets.has(value));
      if (hit === undefined) continue;
      // 指针 tag 指向其应指表的旧偏移 —— 这正是需要改写的那条，放行
      if (allowed.has(`${view.origin}:${entry.tag}`)) continue;
      throw new TiffWriteRefusedError(
        '这张 RAW 内部存在相互引用的信息，直接修改可能损坏原图，因此已放弃保存（可改用 exiftool 手工处理）',
      );
    }
    assertMakerNoteSafe(bytes, view.entries, targets, le);
  }
}

/** MakerNote：解得动就一起反查，解不动直接拒绝搬迁 */
function assertMakerNoteSafe(
  bytes: Uint8Array,
  entries: readonly ParsedEntry[],
  targets: Map<number, TiffIfd>,
  le: boolean,
): void {
  const maker = entries.find((entry) => entry.tag === TAG_MAKER_NOTE && entry.raw && entry.raw.length > 4);
  // 短于 4 字节的 MakerNote 是内联槽里的残留字节，没有内嵌结构可遍历
  if (!maker?.raw) return;
  const values = makerNoteNumericValues(bytes, maker.raw, longValueOfEntry(maker, le));
  if (values === null) {
    throw new TiffWriteRefusedError(
      '这张 RAW 的厂商信息结构无法识别，无法保证安全保存，因此已放弃（可改用 exiftool 手工处理）',
    );
  }
  if (values.some((value) => targets.has(value))) {
    throw new TiffWriteRefusedError('这张 RAW 的厂商信息与拍摄信息相互引用，无法保证安全保存，因此已放弃');
  }
}

const TAG_MAKER_NOTE = 0x927c;
/** Nikon MakerNote v2 的前 6 字节；后面 2 字节是版本号，再后面才是内嵌 TIFF 头 */
const NIKON_HEADER: readonly number[] = [0x4e, 0x69, 0x6b, 0x6f, 0x6e, 0x00];

/**
 * 抽 Nikon MakerNote 里所有条目内的数值（偏移语义的那些），用于反查。
 * 结构不认识就返回 null —— 调用方据此拒绝搬迁，不做任何猜测。
 */
function makerNoteNumericValues(bytes: Uint8Array, maker: Uint8Array, makerAt: number): number[] | null {
  if (maker.length < 14) return null;
  if (!NIKON_HEADER.every((byte, index) => maker[index] === byte)) return null;
  const version = ((maker[6] ?? 0) << 8) | (maker[7] ?? 0);
  // v1（0x0100）结构与 v2 完全不同，不猜
  if (version < 0x0200) return null;

  // 内嵌 TIFF 头从 MakerNote 第 10 字节开始，**字节序由其自身声明**，与外层无关
  const base = makerAt + 10;
  const innerLe = bytes[base] === 0x49 && bytes[base + 1] === 0x49;
  const innerBe = bytes[base] === 0x4d && bytes[base + 1] === 0x4d;
  if (!innerLe && !innerBe) return null;
  const view = dataViewOf(bytes);
  if (readU16(view, base + 2, innerLe) !== 42) return null;

  const values: number[] = [];
  let offset = readU32(view, base + 4, innerLe);
  for (let depth = 0; depth < 8 && offset > 0; depth += 1) {
    let ifd: ParsedIfd | undefined;
    try {
      // 内嵌表的偏移是相对 base 的
      ifd = parseIfd(bytes, base + offset, innerLe);
    } catch {
      return null;
    }
    if (!ifd) break;
    for (const entry of ifd.entries) values.push(...offsetValuesOf(entry, innerLe));
    offset = ifd.next;
  }
  return values;
}

/**
 * 条目里可能承载「绝对偏移」的值。
 * 【为什么只认 LONG / SLONG 且 count === 1】偏移几乎总是单个 4 字节整数；
 * 放进 SHORT 与数组会把 BitsPerSample 的 `[8,8,8]`、条带偏移数组这类普通数据也算进来，
 * 反查立刻被误报淹没 —— 判据要的是「能指向表的那一种写法」，不是「凡是整数都算」。
 */
function offsetValuesOf(entry: ParsedEntry, le: boolean): number[] {
  if (!entry.raw || entry.count !== 1) return [];
  const view = dataViewOf(entry.raw);
  if (entry.type === TYPE_LONG) return [readU32(view, 0, le)];
  if (entry.type === TYPE_SLONG) return [readI32(view, 0, le)];
  return [];
}

/** 条目值域里的「偏移」（长度 > 4 时值域就是数据位置，字节序沿用外层 TIFF 的） */
function longValueOfEntry(entry: ParsedEntry, le: boolean): number {
  return readU32(dataViewOf(entry.entryBytes), 8, le);
}

/* ========================================================================== */
/* 6. 应用与审计                                                                */
/* ========================================================================== */

/**
 * 落地：原文件逐字节复制 + 应用原地改写 + 追加尾部数据。
 * 除 plan 里声明的字节外，**不做任何其他改动**（这是「绝对偏移不失效」的保证）。
 */
export function applyTiffWrite(bytes: Uint8Array, plan: TiffWritePlan): Uint8Array {
  const out = new Uint8Array(bytes.length + plan.appended.length);
  out.set(bytes, 0);
  for (const write of plan.writes) out.set(write.bytes, write.offset);
  out.set(plan.appended, bytes.length);
  return out;
}

/** tag → 字段类型（回读比对要按类型归一：'8.0' 与 '8' 是同一个值） */
const FIELD_TYPE_BY_TAG = new Map<string, ExifFieldType>(EXIF_FIELDS.map((field) => [field.tag, field.type]));

/** 以有理数编码、且读侧会把小数位四舍五入到 6 位的坐标类字段 */
const AUDIT_NUMERIC_TAGS: ReadonlySet<string> = new Set([GPS_TAGS.lat, GPS_TAGS.lon, GPS_TAGS.alt]);

/** 坐标类字段的回读容差：读侧只保留 6 位小数，必然与输入的完整小数尾部存在舍入差 */
const AUDIT_NUMERIC_TOLERANCE = 1e-5;

/**
 * 审计用的「值真的写进去了吗」比对。
 * 【为什么不能直接用 exifSameText】读侧对两类值做了「摄影化 / 展示化」呈现，直接比会误判成没写成功：
 *   - 曝光时间回读是摄影写法（`1/320`），而 exif-values 的 number 归一认不出分数 → 恒判不等；
 *   - GPS 坐标回读被四舍五入到 6 位小数，与输入的完整小数尾部必然不同。
 * 因此这里按「同一物理量是否相等」判：曝光三要素走 canonical 归一，坐标类走数值容差，
 * 其余字段照旧走 exifSameText（'8.0' 与 '8'、日期的分隔符差异都算同值）。
 */
function auditValueMatches(tagName: string, readBack: string, expected: string): boolean {
  // 删除的期望本身就是「读不出来」，先短路，免得下面按数值比时把空串当成 0
  if (expected === '') return readBack === '';
  const kind = exposureKindOfTag(tagName);
  if (kind !== null) {
    const actual = canonicalExposureText(kind, readBack);
    return actual !== '' && actual === canonicalExposureText(kind, expected);
  }
  if (AUDIT_NUMERIC_TAGS.has(tagName)) {
    const actual = Number(readBack);
    const wanted = Number(expected);
    return Number.isFinite(actual) && Number.isFinite(wanted) && Math.abs(actual - wanted) <= AUDIT_NUMERIC_TOLERANCE;
  }
  const type = FIELD_TYPE_BY_TAG.get(tagName) ?? 'text';
  return exifSameText(type, exifRawToText(type, readBack), exifRawToText(type, expected));
}

/**
 * 写后审计，三关都过才放行：
 *   1. 长度只允许多出 plan.appended（绝不缩短）；
 *   2. 原有区间里凡是变动的字节，必须落在 plan.diffRanges 内 —— 一条就够抓住「偏移算错」这类致命 bug；
 *   3. 用读侧再解析一遍，逐个字段确认真的写进去了。
 */
export function auditTiffWrite(before: Uint8Array, after: Uint8Array, plan: TiffWritePlan): void {
  if (after.length !== before.length + plan.appended.length) {
    throw new TiffWriteRefusedError('写后审计未通过：文件长度与预期不符，已丢弃结果');
  }

  let cursor = 0;
  for (const [start, end] of plan.diffRanges) {
    assertUnchanged(before, after, cursor, start);
    cursor = Math.max(cursor, end);
  }
  assertUnchanged(before, after, cursor, before.length);

  let document;
  try {
    document = readLocalExifAny(after);
  } catch (err) {
    throw new TiffWriteRefusedError(`写后审计未通过：新文件已无法解析（${reasonOf(err)}），已丢弃结果`);
  }
  for (const [tagName, text] of Object.entries(plan.expected)) {
    const readBack = document.values[tagName] ?? '';
    if (!auditValueMatches(tagName, readBack, text)) {
      throw new TiffWriteRefusedError(
        `写后审计未通过：字段「${tagName}」回读为「${readBack}」，与期望值「${text}」不一致，已丢弃结果`,
      );
    }
  }
}

/** 断言 [start, end) 区间逐字节相同 */
function assertUnchanged(before: Uint8Array, after: Uint8Array, start: number, end: number): void {
  for (let i = start; i < end; i += 1) {
    if (before[i] !== after[i]) {
      throw new TiffWriteRefusedError(
        `写后审计未通过：偏移 ${i} 的字节被意外改动（超出允许范围），已丢弃结果以免损坏 RAW`,
      );
    }
  }
}

/**
 * 一步到位：规划 → 应用 → 审计。返回值一定是「通过了三关审计」的字节。
 * 【为什么强制走审计】RAW 损坏不可逆，调用方不该有「先拿结果、有空再校验」的选项。
 */
export function applyTiffExifPatch(bytes: Uint8Array, patch: Record<string, string | null>): Uint8Array {
  const plan = planTiffWrite(bytes, patch);
  if (plan === null) return bytes.slice();
  const next = applyTiffWrite(bytes, plan);
  auditTiffWrite(bytes, next, plan);
  return next;
}

/* ========================================================================== */
/* 7. 小工具                                                                    */
/* ========================================================================== */

function concatChunks(chunks: readonly Uint8Array[]): Uint8Array {
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.length;
  }
  return out;
}

/** 合并相邻/重叠区间，审计时按段比对即可，不必逐字节标记 */
function mergeRanges(ranges: readonly (readonly [number, number])[]): Array<readonly [number, number]> {
  const sorted = [...ranges].sort((a, b) => a[0] - b[0]);
  const merged: Array<readonly [number, number]> = [];
  for (const range of sorted) {
    const last = merged[merged.length - 1];
    if (last && range[0] <= last[1]) merged[merged.length - 1] = [last[0], Math.max(last[1], range[1])];
    else merged.push([range[0], range[1]]);
  }
  return merged;
}

/**
 * 审计白名单 = 落在**原文件范围内**的原地改写。
 * 追加区（偏移 ≥ 原文件长度）不属于「原有字节」，审计用长度检查覆盖它。
 */
function whitelistOf(writes: readonly InPlaceWrite[], length: number): Array<readonly [number, number]> {
  return mergeRanges(
    writes
      .filter((write) => write.offset + write.bytes.length <= length)
      .map((write) => [write.offset, write.offset + write.bytes.length] as const),
  );
}