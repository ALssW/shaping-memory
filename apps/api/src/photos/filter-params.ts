/**
 * apps/api/src/photos/filter-params.ts
 *
 * 「HTTP query 参数 → ListFilter」的共用解析。
 *
 * 【为什么要单独成文件】照片列表有两个入口：/photos（整份档案读取）与
 * /search/photos（专用检索）。两者的**参数口径必须一致** —— 同一组筛选条件从哪个入口进来
 * 都该得到同一批照片。解析与校验只写一份，口径便不会不一致。
 */
import { BadRequestException } from '@nestjs/common';
import type { ListFilter } from './photos.service';

/**
 * 校验 YYYY-MM-DD 是否为真实存在的日期。
 * 【为什么不能只校验格式】"2026-09-31" 格式完全合法，但 capture_at 是 PG 的 date 列，
 * 拿它比较会直接抛「date/time field value out of range」变成 500 —— 这里提前挡成 400。
 */
export function isValidDate(value: string): boolean {
  const parsed = new Date(`${value}T00:00:00Z`);
  // 不存在的日子会被 Date 自动进位（09-31 → 10-01），回环比对即可判定
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

/** 定位三态：未传 = 不限；'1'/'true' = 只看有定位；其余（含 '0'）= 只看无定位 */
function parseHasGps(raw: string | undefined): boolean | undefined {
  if (raw == null || raw === '') return undefined;
  return raw === '1' || raw === 'true';
}

/**
 * 取标量维度的首值。
 * 【为什么需要】Express 的 query 解析把重复出现的同名参数收成数组（`?from=a&from=b` → ['a','b']），
 * 而除标签外的维度都是单值语义 —— 重复出现时以第一个为准，不因一个多余的 &from 使整次检索返回 400。
 */
function firstOf(raw: string | string[] | undefined): string | undefined {
  return Array.isArray(raw) ? raw[0] : raw;
}

/**
 * 标签多值解析：标签是唯一的多值维度（`?tags=日落&tags=海边`）。
 * 【为什么不 trim】标签名来自 tags 表，检索时要与库里的值精确比对，
 * 这里一并 trim 会让「带空格的标签」永远搜不到；只丢掉空串，并用 Set 去重
 * （同一标签选两次没有意义，还会让 SQL 多跑一条 EXISTS）。
 */
function parseTags(raw: string | string[] | undefined): string[] | undefined {
  if (raw == null) return undefined;
  const list = Array.isArray(raw) ? raw : [raw];
  const names = [...new Set(list.filter((name) => name !== ''))];
  return names.length > 0 ? names : undefined;
}

/** 感光度：非数字一律按「不限」处理，不因单个输入错误使整次检索返回 400 */
function parseIso(raw: string | undefined): number | undefined {
  if (raw == null || raw.trim() === '') return undefined;
  const iso = Number(raw);
  return Number.isFinite(iso) ? iso : undefined;
}

/** 单页条数上限：再大即与「全量」无异，分页失去意义；同时可拦截异常的超大 limit */
const LIMIT_MAX = 500;

/**
 * 分页参数。
 * 【为什么不放进 ListFilter】分页是**传输层**概念，不是检索维度 —— ListFilter 的字段与
 * core 的 SearchQuery 对齐（同一份条件既能服务端筛、也能前端本地筛），
 * 把 limit/offset 混进去会让「条件」与「取多少条」两种语义纠缠在一起。
 */
export interface PageParams {
  /** 每页条数；缺省即不限制 */
  limit?: number;
  /** 起始偏移；仅在 limit 存在时有意义 */
  offset?: number;
}

/**
 * 解析分页参数。
 * 【为什么 limit 缺省是「不限」而不是某个常量】/photos 同时被后台管理端使用，那里期望
 * 「整份档案」；给一个隐式默认上限会使后台仅能看到前 N 张。想看分页的前台显式传 limit，
 * 既有的调用方因此零影响。非法值（非数字 / 非正数）一律按「未传」处理，不把读取打成 400。
 */
export function parsePage(query: Record<string, string | string[] | undefined>): PageParams {
  const raw = firstOf(query.limit);
  const parsed = raw == null || raw.trim() === '' ? NaN : Math.floor(Number(raw));
  if (!Number.isFinite(parsed) || parsed <= 0) return {};

  const rawOffset = firstOf(query.offset);
  const offset = rawOffset == null || rawOffset.trim() === '' ? 0 : Math.floor(Number(rawOffset));
  return {
    limit: Math.min(parsed, LIMIT_MAX),
    offset: Number.isFinite(offset) && offset > 0 ? offset : 0,
  };
}

/** 把所有检索维度从 query 里解析出来（含日期合法性校验） */
export function buildListFilter(query: Record<string, string | string[] | undefined>): ListFilter {
  const from = firstOf(query.from);
  const to = firstOf(query.to);
  if (from && !isValidDate(from)) throw new BadRequestException('开始日期格式不正确，请使用 YYYY-MM-DD');
  if (to && !isValidDate(to)) throw new BadRequestException('结束日期格式不正确，请使用 YYYY-MM-DD');

  return {
    category: firstOf(query.category),
    sort: firstOf(query.sort) === 'asc' ? 'asc' : 'desc',
    q: firstOf(query.q),
    from,
    to,
    cam: firstOf(query.cam),
    lens: firstOf(query.lens),
    aperture: firstOf(query.aperture),
    speed: firstOf(query.speed),
    iso: parseIso(firstOf(query.iso)),
    hasGps: parseHasGps(firstOf(query.hasGps)),
    // 唯一的数组维度，需要拿原始值（不能过 firstOf，否则多选只剩一枚）
    tags: parseTags(query.tags),
  };
}