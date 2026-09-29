/**
 * apps/api/src/privacy/policy.ts
 *
 * 隐私策略的「读」这一半：设置表 → 强类型策略，以及「某张照片对某人到底是什么策略」的判定。
 *
 * 【为什么单独成文件而不放进 PrivacyService】照片读接口（PhotosService）、静态文件服务
 * （FilesController）、隐私接口（PrivacyService）三处都要做同一个判定。放进可注入的服务里，
 * 就会让 PhotosModule ↔ PrivacyModule 互相 import 成环；这里的函数只依赖 Db（由调用方传入），
 * 是无状态的纯逻辑，三处共用同一份口径，不存在「列表标记为可见、图片却被模糊」的不一致。
 */
import { eq, inArray, isNull, ne, or } from 'drizzle-orm';
import type { SQL } from 'drizzle-orm';
import { media, settings } from '@shaping-memory/db';
import type { Db } from '@shaping-memory/db';
import {
  BLUR_STRENGTH_MIN,
  BLUR_STRENGTH_MAX,
  DEFAULT_BLUR_STRENGTH,
} from '@shaping-memory/image';
import { verifyGrant } from './tokens';

/** 单张照片对外的三种形态 */
export type PrivacyMode = 'visible' | 'blur' | 'hidden';

/** 单张照片上存的标记：inherit = 跟随全局默认 */
export type PhotoPrivacy = 'inherit' | PrivacyMode;

/** 隐私相关的设置键（其余设置项由 M3 的系统设置页使用） */
export const PRIVACY_KEYS = {
  defaultMode: 'privacy.defaultMode',
  accessRoles: 'privacy.accessRoles',
  passwordHash: 'privacy.passwordHash',
  blurStrength: 'privacy.blurStrength',
} as const;

/**
 * 模糊强度的取值范围与默认值。
 * 【唯一事实源在 image 包】范围是**算法参数**的一部分（下限 6 对应降采样底线 32px 这条
 * 专业隐私保护线），因此定义在 packages/image 里与 blurSpec() 放在一起；
 * 这里只做转出，避免「API 校验一套范围、算法实际用另一套」的不一致。
 */
export { BLUR_STRENGTH_MIN, BLUR_STRENGTH_MAX, DEFAULT_BLUR_STRENGTH };

/** 解析后的策略 */
export interface PrivacySettings {
  /** 全局默认策略：未单独标记的照片按它处理 */
  defaultMode: PrivacyMode;
  /** 可以直接查看隐私照片的角色（授权查看机制之一：登录指定授权账号） */
  accessRoles: string[];
  /** 全局查看密码的 bcrypt 哈希；为空表示没设全局密码 */
  passwordHash: string | null;
  /** 模糊占位图的总闸强度：越大越糊（派生参数见 image 包的 blurSpec） */
  blurStrength: number;
}

/**
 * 出厂默认：一律公开、只有 admin/editor 能看隐私照片、不设全局密码。
 * 【为什么默认 public】隐私是「按需开启」的开关；默认关闭，可避免出现
 * 「有人标记了一张却未设密码、导致整站照片对匿名者全部模糊」这类事故。
 */
export const DEFAULT_PRIVACY: PrivacySettings = {
  defaultMode: 'visible',
  accessRoles: ['admin', 'editor'],
  passwordHash: null,
  blurStrength: DEFAULT_BLUR_STRENGTH,
};

const MODES: readonly PrivacyMode[] = ['visible', 'blur', 'hidden'];

/** 从设置表读策略；缺项各自回落到出厂默认，读不到也不会让请求失败 */
export async function readPrivacySettings(db: Db): Promise<PrivacySettings> {
  const rows = await db
    .select()
    .from(settings)
    .where(
      inArray(settings.key, [
        PRIVACY_KEYS.defaultMode,
        PRIVACY_KEYS.accessRoles,
        PRIVACY_KEYS.passwordHash,
        PRIVACY_KEYS.blurStrength,
      ]),
    );

  const map = new Map(rows.map((row) => [row.key, row.value]));
  const roles = map
    .get(PRIVACY_KEYS.accessRoles)
    ?.split(',')
    .map((role) => role.trim())
    .filter(Boolean);

  return {
    defaultMode: asMode(map.get(PRIVACY_KEYS.defaultMode)) ?? DEFAULT_PRIVACY.defaultMode,
    accessRoles: roles && roles.length > 0 ? roles : DEFAULT_PRIVACY.accessRoles,
    passwordHash: map.get(PRIVACY_KEYS.passwordHash) ?? null,
    // 脏值（非整数 / 越界 / 非数字）一律回落到默认，避免设置表中的异常数据把模糊图变为原图
    blurStrength: asBlurStrength(map.get(PRIVACY_KEYS.blurStrength)) ?? DEFAULT_PRIVACY.blurStrength,
  };
}

/** 把库里的字符串收窄成合法模式；无法识别的值一律视为「未设置」（由默认值回退） */
export function asMode(value: string | null | undefined): PrivacyMode | null {
  return MODES.includes(value as PrivacyMode) ? (value as PrivacyMode) : null;
}

/** 把库里的字符串收窄成合法模糊强度；非整数或越界一律返回 null，由默认值回退 */
export function asBlurStrength(value: string | null | undefined): number | null {
  if (value == null) return null;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < BLUR_STRENGTH_MIN || parsed > BLUR_STRENGTH_MAX) return null;
  return parsed;
}

/** 单张照片上存的标记是否合法（非法值按 inherit 处理，避免异常数据使照片变为不可见） */
export function asPhotoPrivacy(value: string | null | undefined): PhotoPrivacy {
  if (value === 'inherit' || value == null) return 'inherit';
  return asMode(value) ?? 'inherit';
}

/** 有效策略：单张标记优先，inherit 时回落到全局默认 */
export function effectiveMode(photoPrivacy: string | null | undefined, settingsValue: PrivacySettings): PrivacyMode {
  const own = asPhotoPrivacy(photoPrivacy);
  return own === 'inherit' ? settingsValue.defaultMode : own;
}

/** 请求者身份：谁能看隐私照片，以及能看哪几张 */
export interface PrivacyContext {
  /** 授权账号（角色命中 accessRoles）——可看全部隐私照片 */
  authorized: boolean;
  /** 该账号的角色（写进文件访问凭证里，静态文件层复核用） */
  role?: string;
  /** 分享链接授权：只有这批 id 可看；为空表示没有分享授权 */
  sharedIds?: ReadonlySet<string>;
  /**
   * 写进图片地址的票据有效期（秒）。分享链接要跟着链接自己的失效时刻，
   * 不能比它活得更久；账号授权则用默认时长。
   */
  grantTtlSeconds?: number;
  /** 请求里已经带着的有效票据：能复用就直接复用，不必每次响应都重签一张 */
  token?: string;
}

/** 匿名请求者：什么都不能看 */
export const ANONYMOUS: PrivacyContext = { authorized: false };

/**
 * 全局密码解锁后签发的票据角色。
 * 【为什么要单独一个角色】它不是系统里的账号角色，而是一次「密码换来的通行证」，
 * 权限范围是全站隐私照片；且一旦后台把全局密码清掉，旧票据必须立刻失效 ——
 * 所以它在下面 isFullAccessGrant 里要额外复核「现在还有没有密码」。
 */
export const PASSWORD_GRANT_ROLE = 'password';

/** 限定 id 的票据角色：分享链接与单张密码都只放行票据里列的 id */
const SCOPED_GRANT_ROLES = ['share', 'photo'];

/** 票据角色是否等价于「授权账号」 */
function isFullAccessGrant(role: string, settingsValue: PrivacySettings): boolean {
  if (role === PASSWORD_GRANT_ROLE) return settingsValue.passwordHash != null;
  return settingsValue.accessRoles.includes(role);
}

/** 当前请求者是否已获准查看这一张 */
export function isGranted(id: string, ctx: PrivacyContext): boolean {
  return ctx.authorized || ctx.sharedIds?.has(id) === true;
}

/**
 * 一张照片对当前请求者的最终判定。
 *   mode   = 有效策略（与请求者无关，纯粹看这张怎么标）
 *   locked = 对请求者锁着 —— 真实原图不可见，只能拿到模糊图或什么都拿不到
 */
export interface PrivacyVerdict {
  mode: PrivacyMode;
  locked: boolean;
  /** 这张是否单独设了查看密码（前台据此提示「这张有独立密码」） */
  hasOwnPassword: boolean;
}

export function verdictOf(
  row: { id: string; privacy: string | null; privacyPasswordHash: string | null },
  settingsValue: PrivacySettings,
  ctx: PrivacyContext,
): PrivacyVerdict {
  const mode = effectiveMode(row.privacy, settingsValue);
  return {
    mode,
    locked: !isGranted(row.id, ctx) && mode !== 'visible',
    hasOwnPassword: row.privacyPasswordHash != null,
  };
}

/**
 * 「哪些行对当前请求者不可见」——是 verdictOf 的 **SQL 表达**，两处永远是同一套口径。
 *
 * 【为什么必须下推到 SQL 而不能继续在内存里丢弃】列表要分页：先在 SQL 里取 60 行、
 * 再在内存里丢弃几张隐藏照片，这一页就只剩 57 张 —— 前端按「不足一页即到底」判断时
 * 会提前结束分页，用户将无法看到后续照片。把判定交给 SQL，每页条数才是稳定的。
 *
 * 【哪些行算隐藏】有效策略等于 hidden 的那些：单张标了 hidden 的恒算；
 * 单张标 inherit（或完全未标记）的按全局默认处理，全局默认是 hidden 时它们同样计入。
 * 注意模糊（blur）**不算**隐藏 —— 它照常出现在列表里，只是给的是模糊图。
 */
export function hiddenExclusion(settingsValue: PrivacySettings, ctx: PrivacyContext): SQL | undefined {
  // 获准全站可看（授权账号 / 全局密码票据）：隐藏照片对他同样可见，一行都不用排除
  if (ctx.authorized) return undefined;

  // 票据里限定了 id 时，列出的那几张即使标了隐藏也要放行（分享链接 / 单张密码）
  const shared = ctx.sharedIds && ctx.sharedIds.size > 0 ? inArray(media.id, [...ctx.sharedIds]) : undefined;

  /**
   * 【为什么必须显式判 IS NULL】PostgreSQL 里 `NULL <> 'hidden'` 的求值结果是 NULL 而不是 true，
   * 遗漏这一条会把所有「未单独标记」的照片全部误排除 —— 而它们恰是绝大多数。
   */
  const notHidden =
    settingsValue.defaultMode === 'hidden'
      ? or(eq(media.privacy, 'visible'), eq(media.privacy, 'blur'))
      : or(isNull(media.privacy), ne(media.privacy, 'hidden'));

  return shared ? or(notHidden, shared) : notHidden;
}

/**
 * 从一次请求里解出「请求者是谁、能看哪几张」。
 *
 * 两条授权通路在这里合流：
 *   1) 登录态（req.user，由 OptionalJwtGuard 挂上）——角色命中 accessRoles 即全站可看；
 *   2) URL 上的票据（?pt=，静态文件与分享链接走这条）——只有票据里列的 id 可看。
 * 【为什么要合并】读接口与静态文件服务必须用同一套判定，否则会出现
 * 「列表判定为已解锁、图片仍为模糊」这种前后不一致的状态。
 */
export async function privacyContextOf(
  db: Db,
  secret: string,
  req: { user?: { role: string }; query?: Record<string, unknown> },
): Promise<PrivacyPass> {
  const settingsValue = await readPrivacySettings(db);
  const token = typeof req.query?.pt === 'string' ? req.query.pt : undefined;
  const grant = verifyGrant(secret, token);

  // 「限定 id」的票据只放行列出的那几张；其余票据必须过 isFullAccessGrant 才是全站可看
  const scoped = grant?.ids != null && grant.ids.length > 0;
  const scopedRole = scoped && SCOPED_GRANT_ROLES.includes(grant?.role ?? '') ? grant : null;
  const fullRole = !scoped && grant && isFullAccessGrant(grant.role, settingsValue) ? grant.role : undefined;
  const accountRole = req.user && settingsValue.accessRoles.includes(req.user.role) ? req.user.role : undefined;

  return {
    settings: settingsValue,
    ctx: {
      authorized: accountRole != null || fullRole != null,
      role: accountRole ?? fullRole,
      sharedIds: scopedRole?.ids ? new Set(scopedRole.ids) : undefined,
      token: token && grant ? token : undefined,
    },
  };
}

/** 一次请求的隐私上下文：策略（怎么标）+ 身份（谁能看），读接口与静态文件服务共用 */
export interface PrivacyPass {
  settings: PrivacySettings;
  ctx: PrivacyContext;
}