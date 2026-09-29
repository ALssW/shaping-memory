/**
 * apps/api/src/dictionary/dictionary.service.ts
 *
 * 通用字典服务：读公开（前后台搜索框要拉候选），写需 admin。
 *
 * 【字典不是照片字段的「真身」】它只提供**候选值**：改字典里的「NIKON Z 7_2」，
 * 不会去改任何照片的 EXIF（那是 EXIF 编辑的职责，见 PhotosService.updateExif）。
 * 因此这里没有任何跨表同步 —— 与分类改名必须同步 media.category 的场景正好相反。
 *
 * 【顺序由值本身决定】光圈 f/2 → f/32、快门 1/8000 → 30"、ISO 50 → 102400 都必须按数值排，
 * 机身/镜头按字序。每次增删改与整理之后统一重排一遍（reorder），
 * 因此后台不提供手工拖拽排序 —— 手工顺序会被下一次整理静默覆盖，因此不作支持。
 */
import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { and, asc, eq, or, sql } from 'drizzle-orm';
import { createHash } from 'node:crypto';
import { dictionary, exifMetadata, media } from '@shaping-memory/db';
import type { Db } from '@shaping-memory/db';
import {
  compareDictionaryValues,
  DICTIONARY_KIND_META,
  DICTIONARY_KINDS,
  DICTIONARY_PRESETS,
  dictionaryOrderOf,
} from '@shaping-memory/core';
import type { DictionaryKind } from '@shaping-memory/core';
import { DB } from '../infra.module';

/** 前端消费的字典条目 */
export interface ApiDictionaryEntry {
  id: string;
  kind: DictionaryKind;
  value: string;
  /** 展示文案；为空时前端回落到 value */
  label: string | null;
  sortOrder: number;
  /** 是否内置标准档位 */
  builtin: boolean;
  /** 数值口径（光圈 f 数 / 快门秒数 / ISO 数值）；文本类为 null，前端据此决定是否需要补零对齐 */
  order: number | null;
}

export interface CreateDictionaryDto {
  kind: string;
  value: string;
  label?: string | null;
  builtin?: boolean;
}

export interface UpdateDictionaryDto {
  value?: string;
  label?: string | null;
}

/** 一次「整理现有数据」的结果：按类型汇报新增与总数 */
export interface DictionarySyncReport {
  kind: DictionaryKind;
  label: string;
  /** 本次从照片数据里新整理进来多少条 */
  added: number;
  /** 整理后该类型的总条数 */
  total: number;
}

/** 字典 id：kind + value 的稳定哈希。同名同值 → 同 id，整理脚本反复执行天然幂等 */
export function dictionaryIdOf(kind: string, value: string): string {
  return 'dict_' + createHash('sha1').update(`${kind}\u0000${value}`).digest('hex').slice(0, 16);
}

/** 全部合法 kind（用于入参校验，避免异常数据混进字典） */
const VALID_KINDS = new Set<string>(DICTIONARY_KINDS.map((item) => item.kind));

/** 从 meta 里读出数值口径；没有或不是数字即视为「无解析结果」 */
function orderOf(meta: Record<string, unknown> | null): number | null {
  const value = meta?.order;
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

@Injectable()
export class DictionaryService {
  constructor(@Inject(DB) private readonly db: Db) {}

  /** 字典内容：可按 kind 过滤，缺省返回全部（供后台管理页一次拉全） */
  async list(kind?: string): Promise<ApiDictionaryEntry[]> {
    const rows = await this.db
      .select()
      .from(dictionary)
      .where(kind ? eq(dictionary.kind, kind) : undefined)
      .orderBy(asc(dictionary.kind), asc(dictionary.sortOrder), asc(dictionary.value));
    return rows.map((row) => this.toApi(row));
  }

  /**
   * 联想：按输入片段模糊匹配某一类型的候选值。
   * 【为什么在服务端做】前台的「输入即联想」如果只筛已经拉到本地的列表，
   * 字典一旦长大（镜头型号可以上千条）就得把整表搬到浏览器；这里按 kind + 片段查库，
   * 前端只拿回一屏候选。
   *
   * 【为什么要做「空格不敏感」这一路】真实器材名几乎都带空格（NIKON Z 8、Z 24-120mm），
   * 而人工输入往往省略它（Z8、24-120）。只做 %Z8% 的字面匹配会一无所获，
   * 用户会认为「字典中存在该值却检索不到」。因此再补一路「双方都去掉空格」的匹配。
   */
  async suggest(kind: string, q: string, limit = 20): Promise<ApiDictionaryEntry[]> {
    if (!VALID_KINDS.has(kind)) throw new BadRequestException('不支持的字典类型，请从页面上的候选项中选择');
    const keyword = q.trim();
    const pattern = `%${keyword}%`;
    // 去掉所有空白后的形态：'Z 8' → 'Z8'，两侧都能对上
    const compact = keyword.replace(/\s+/g, '');
    const rows = await this.db
      .select()
      .from(dictionary)
      .where(
        and(
          eq(dictionary.kind, kind),
          keyword
            ? or(
                sql`${dictionary.value} ILIKE ${pattern}`,
                sql`${dictionary.label} ILIKE ${pattern}`,
                compact
                  ? sql`replace(${dictionary.value}, ' ', '') ILIKE ${`%${compact}%`}`
                  : undefined,
              )
            : undefined,
        ),
      )
      .orderBy(
        // 完全相等的排最前：输入「1/200」时，候选里的 1/2000 会先命中模糊匹配，
        // 但它排在首位就意味着「输入 + 回车」选中的是 1/2000 —— 属于误选，而非联想本意。
        sql`case when ${dictionary.value} ILIKE ${keyword} then 0 else 1 end`,
        asc(dictionary.sortOrder),
        asc(dictionary.value),
      )
      .limit(Math.min(200, Math.max(1, limit)));
    return rows.map((row) => this.toApi(row));
  }

  /** 新建一条字典值：同类型下值唯一 */
  async create(dto: CreateDictionaryDto): Promise<ApiDictionaryEntry> {
    const kind = dto.kind?.trim();
    if (!VALID_KINDS.has(kind)) throw new BadRequestException('不支持的字典类型，请从页面上的候选项中选择');
    const value = dto.value?.trim();
    if (!value) throw new BadRequestException('请填写候选值的内容');

    const exists = await this.findByValue(kind, value);
    if (exists) throw new ConflictException(`「${value}」已存在于${DICTIONARY_KIND_META[kind as DictionaryKind].label}字典中`);

    const row = {
      id: dictionaryIdOf(kind, value),
      kind,
      value,
      label: dto.label?.trim() || null,
      meta: this.metaOf(kind as DictionaryKind, value),
      builtin: dto.builtin ?? false,
      sortOrder: 0,
    };
    await this.db.insert(dictionary).values(row);
    await this.reorder(kind as DictionaryKind);
    return this.requireEntry(kind, value);
  }

  /** 改字典值或展示文案（改值不会去改照片 EXIF，见文件头注释） */
  async update(id: string, dto: UpdateDictionaryDto): Promise<ApiDictionaryEntry> {
    const current = await this.requireRow(id);

    const sets: Partial<typeof dictionary.$inferInsert> = {};
    const nextValue = dto.value?.trim();
    if (nextValue && nextValue !== current.value) {
      const dup = await this.findByValue(current.kind, nextValue);
      if (dup) throw new ConflictException(`「${nextValue}」已存在于该类型字典中`);
      sets.value = nextValue;
      // 值变了，数值口径要跟着重算，否则排序会停在旧档位上
      sets.meta = this.metaOf(current.kind as DictionaryKind, nextValue);
    }
    if (dto.label !== undefined) sets.label = dto.label?.trim() || null;

    if (Object.keys(sets).length > 0) {
      await this.db.update(dictionary).set(sets).where(eq(dictionary.id, id));
      await this.reorder(current.kind as DictionaryKind);
    }
    return this.requireEntry(current.kind, sets.value ?? current.value);
  }

  async remove(id: string): Promise<void> {
    const current = await this.requireRow(id);
    await this.db.delete(dictionary).where(eq(dictionary.id, id));
    await this.reorder(current.kind as DictionaryKind);
  }

  /**
   * 整理现有数据：把照片 EXIF 里真实出现过的机身 / 镜头 / 光圈 / 快门 / ISO 去重后灌进字典。
   *
   * 【为什么按「一次查询 + 内存去重」而不是五个 distinct 查询】一次取回未删除照片的
   * 五个字段就够（百余行），五次往返反而更慢，且五个 SQL 几乎一模一样、改一处要改五处。
   * 【为什么排除软删除的照片】已删照片的值不必再占一个候选项。
   * 【幂等】同一值只会命中原行（kind+value 唯一索引 + 稳定 id），反复点「整理」不会堆重复。
   */
  async sync(): Promise<DictionarySyncReport[]> {
    await this.ensurePresets();

    const rows = await this.db
      .select({
        cam: exifMetadata.cam,
        lens: exifMetadata.lens,
        aperture: exifMetadata.aperture,
        speed: exifMetadata.speed,
        iso: exifMetadata.iso,
      })
      .from(exifMetadata)
      .innerJoin(media, eq(media.id, exifMetadata.mediaId))
      .where(eq(media.deleted, false));

    const found: Record<DictionaryKind, Set<string>> = {
      camera: new Set(),
      lens: new Set(),
      aperture: new Set(),
      shutter: new Set(),
      iso: new Set(),
    };
    for (const row of rows) {
      addValue(found.camera, row.cam);
      addValue(found.lens, row.lens);
      addValue(found.aperture, row.aperture);
      addValue(found.shutter, row.speed);
      addValue(found.iso, row.iso == null ? null : String(row.iso));
    }

    const report: DictionarySyncReport[] = [];
    for (const meta of DICTIONARY_KINDS) {
      const added = await this.insertMissing(meta.kind, found[meta.kind]);
      await this.reorder(meta.kind);
      report.push({
        kind: meta.kind,
        label: meta.label,
        added,
        total: await this.countOf(meta.kind),
      });
    }
    return report;
  }

  /**
   * 铺一遍内置标准档位（光圈 / 快门 / ISO 的常用值）。
   * 【为什么只在「该类型一条内置值都没有」时铺】否则管理员删掉一个不想要的档位，
   * 下次整理又会将其原样写回 —— 等同于删除功能失效。
   */
  private async ensurePresets(): Promise<void> {
    for (const meta of DICTIONARY_KINDS) {
      const presets = DICTIONARY_PRESETS[meta.kind];
      if (presets.length === 0) continue;
      const existing = await this.db
        .select({ n: sql<number>`count(*)::int` })
        .from(dictionary)
        .where(and(eq(dictionary.kind, meta.kind), eq(dictionary.builtin, true)));
      if (Number(existing[0]?.n ?? 0) > 0) continue;

      await this.db
        .insert(dictionary)
        .values(
          presets.map((preset) => ({
            id: dictionaryIdOf(meta.kind, preset.value),
            kind: meta.kind,
            value: preset.value,
            label: preset.label ?? null,
            meta: { order: preset.order },
            builtin: true,
            sortOrder: 0,
          })),
        )
        .onConflictDoNothing();
    }
  }

  /** 把数据里出现过、但字典里还没有的值插进去，返回新增条数 */
  private async insertMissing(kind: DictionaryKind, values: Set<string>): Promise<number> {
    if (values.size === 0) return 0;
    const rows = await this.db.select({ value: dictionary.value }).from(dictionary).where(eq(dictionary.kind, kind));
    const known = new Set(rows.map((row) => row.value));

    const fresh = [...values].filter((value) => !known.has(value));
    if (fresh.length === 0) return 0;

    await this.db
      .insert(dictionary)
      .values(
        fresh.map((value) => ({
          id: dictionaryIdOf(kind, value),
          kind,
          value,
          label: null,
          meta: this.metaOf(kind, value),
          builtin: false,
          sortOrder: 0,
        })),
      )
      .onConflictDoNothing();
    return fresh.length;
  }

  /**
   * 给某一类型重排 sortOrder。
   * 排序口径统一走 core 的 compareDictionaryValues：有数值口径的按数值排、纯文本按字序排，
   * 且解析不出数值的异常值一律排在末尾 —— 不会插到 f/4 与 f/8 中间去。
   */
  private async reorder(kind: DictionaryKind): Promise<void> {
    const rows = await this.db.select().from(dictionary).where(eq(dictionary.kind, kind));
    const sorted = rows
      .map((row) => ({ id: row.id, value: row.value, order: orderOf(row.meta), current: row.sortOrder }))
      .sort((a, b) => compareDictionaryValues(a, b));

    // 只更新真正变了序的行，避免每次整理都写一遍全表
    const changed = sorted.filter((item, index) => item.current !== index);
    if (changed.length === 0) return;
    await this.db.transaction(async (tx) => {
      for (const [index, item] of sorted.entries()) {
        if (item.current === index) continue;
        await tx.update(dictionary).set({ sortOrder: index }).where(eq(dictionary.id, item.id));
      }
    });
  }

  private metaOf(kind: DictionaryKind, value: string): Record<string, unknown> | null {
    const order = dictionaryOrderOf(kind, value);
    return order == null ? null : { order };
  }

  private async requireRow(id: string) {
    const row = await this.db.query.dictionary.findFirst({ where: eq(dictionary.id, id) });
    if (!row) throw new NotFoundException('这条候选值不存在，可能已被删除');
    return row;
  }

  /** 按 kind + value 精确取回一条（新建 / 改名后返回用） */
  private async requireEntry(kind: string, value: string): Promise<ApiDictionaryEntry> {
    const found = await this.findByValue(kind, value);
    if (!found) throw new NotFoundException('这条候选值不存在，可能已被删除');
    return found;
  }

  private async findByValue(kind: string, value: string): Promise<ApiDictionaryEntry | undefined> {
    const row = await this.db.query.dictionary.findFirst({
      where: and(eq(dictionary.kind, kind), eq(dictionary.value, value)),
    });
    return row ? this.toApi(row) : undefined;
  }

  private async countOf(kind: DictionaryKind): Promise<number> {
    const rows = await this.db
      .select({ n: sql<number>`count(*)::int` })
      .from(dictionary)
      .where(eq(dictionary.kind, kind));
    return Number(rows[0]?.n ?? 0);
  }

  private toApi(row: typeof dictionary.$inferSelect): ApiDictionaryEntry {
    return {
      id: row.id,
      kind: row.kind as DictionaryKind,
      value: row.value,
      label: row.label,
      sortOrder: row.sortOrder,
      builtin: row.builtin,
      order: orderOf(row.meta),
    };
  }
}

/** 去空去重地把一个 EXIF 值收进集合（空串、null、纯空白一律丢弃） */
function addValue(bucket: Set<string>, value: string | null): void {
  const text = value?.trim();
  if (text) bucket.add(text);
}

/** 供其它模块（如 /search 的联想）复用的 kind 白名单校验 */
export function isDictionaryKind(kind: string): kind is DictionaryKind {
  return VALID_KINDS.has(kind);
}