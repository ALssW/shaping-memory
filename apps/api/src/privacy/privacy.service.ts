/**
 * apps/api/src/privacy/privacy.service.ts
 *
 * 隐私与授权系统的写入面：全局策略、全局密码、单张独立密码、时效分享链接。
 *
 * 三条授权通路（需求 4b + 4c）在这里落地：
 *   1) 授权账号 —— 角色命中 accessRoles，由登录态直接放行（无需密码）；
 *   2) 密码授权 —— 全局密码解锁全站隐私照片；单张独立密码只解锁那一张；
 *   3) 链接分享授权 —— 时效链接 + 提取码双重校验，通过后换一张限定 id 的访问票据。
 * 三者最终都收敛成同一种东西：一张 HMAC 签名的 AccessGrant（见 tokens.ts），
 * 前台把它带在图片地址上，静态文件层复核 —— 只有这一条通路能拿到原图字节。
 */
import { BadRequestException, Inject, Injectable, NotFoundException, UnauthorizedException } from '@nestjs/common';
import { and, desc, eq } from 'drizzle-orm';
import * as bcrypt from 'bcryptjs';
import { media, privacyShares, settings } from '@shaping-memory/db';
import type { Db } from '@shaping-memory/db';
import type { AppConfig } from '@shaping-memory/config';
import { APP_CONFIG, DB } from '../infra.module';
import { PRIVACY_KEYS, readPrivacySettings, asMode, asBlurStrength, BLUR_STRENGTH_MIN, BLUR_STRENGTH_MAX } from './policy';
import type { PrivacyMode } from './policy';
import { blurSpec, blurSpecTable } from '@shaping-memory/image';
import type { BlurSpec } from '@shaping-memory/image';
import { newAccessCode, newShareToken, signGrant } from './tokens';

/** 票据有效期：账号/密码授权给 8 小时（满足一次浏览），分享链接则不超过链接自身寿命 */
const GRANT_TTL_SECONDS = 8 * 3600;

/** 分享链接可选时长（小时）：下限 1 小时、上限 30 天 */
const MIN_SHARE_HOURS = 1;
const MAX_SHARE_HOURS = 24 * 30;

/** 提取码位数区间（需求定 4~6 位） */
const MIN_CODE_LEN = 4;
const MAX_CODE_LEN = 6;

/** 对外暴露的策略视图（绝不含密码哈希） */
export interface PolicyView {
  defaultMode: PrivacyMode;
  accessRoles: string[];
  /** 是否已设全局查看密码 */
  hasPassword: boolean;
  /** 模糊占位图的总闸强度 */
  blurStrength: number;
  /**
   * 当前强度对应的**完整规格参数**（降采样底线 / 高斯 sigma / 噪点 / 编码质量 / 输出尺寸）。
   * 【为什么由后端算而不是前端算】这几个值必须与算法真正用的完全一致；
   * 前端自己按公式推一遍，一旦公式改了就会「界面显示 A、算法实际用 B」。
   */
  blurSpec: BlurSpec;
  /** 全部可选强度的规格表：后台滑杆拖动时本地查表，避免前端复制一份算法公式 */
  blurSpecTable: BlurSpec[];
}

/** 后台看到的分享链接视图 */
export interface ShareView {
  id: string;
  mediaIds: string[];
  accessCode: string | null;
  expiresAt: string;
  revoked: boolean;
  expired: boolean;
  createdBy: string | null;
  createdAt: string;
  /** 前台可直接打开的地址（**不含**提取码，提取码另行告知） */
  url: string;
}

/** 分享链接满足提取码校验后的结果：票据 + 片单 */
export interface ShareUnlock {
  token: string;
  expiresAt: string;
  mediaIds: string[];
}

@Injectable()
export class PrivacyService {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  /* ----------------------------------------------------------------------
   * 全局策略与密码
   * -------------------------------------------------------------------- */

  async policy(): Promise<PolicyView> {
    const value = await readPrivacySettings(this.db);
    return {
      defaultMode: value.defaultMode,
      accessRoles: value.accessRoles,
      hasPassword: value.passwordHash != null,
      blurStrength: value.blurStrength,
      blurSpec: blurSpec(value.blurStrength),
      blurSpecTable: blurSpecTable(),
    };
  }

  /** 改全局默认策略 / 授权角色 / 模糊强度（三者都可单独改） */
  async updatePolicy(patch: {
    defaultMode?: string;
    accessRoles?: string[];
    blurStrength?: number;
  }): Promise<PolicyView> {
    if (patch.defaultMode !== undefined) {
      const mode = asMode(patch.defaultMode);
      if (!mode) throw new BadRequestException('默认策略只能是 visible / blur / hidden');
      await this.put(PRIVACY_KEYS.defaultMode, mode);
    }
    if (patch.accessRoles !== undefined) {
      // 去重 + 去空：角色 id 直接拼进设置串，异常数据会使「谁能看」变得不可预期
      const roles = [...new Set(patch.accessRoles.map((role) => role.trim()).filter(Boolean))];
      await this.put(PRIVACY_KEYS.accessRoles, roles.join(','));
    }
    if (patch.blurStrength !== undefined) {
      // 复用读侧的收敛口径：非整数 / 越界一律拒绝，而非隐式取整或夹紧
      const strength = asBlurStrength(String(patch.blurStrength));
      if (strength === null) {
        throw new BadRequestException(`模糊强度需为 ${BLUR_STRENGTH_MIN}~${BLUR_STRENGTH_MAX} 之间的整数`);
      }
      await this.put(PRIVACY_KEYS.blurStrength, String(strength));
    }
    return this.policy();
  }

  /** 设置 / 清除全局查看密码；只存 bcrypt 哈希 */
  async setPassword(password: string | null): Promise<PolicyView> {
    if (password) {
      if (password.length < 4) throw new BadRequestException('密码至少 4 位');
      await this.put(PRIVACY_KEYS.passwordHash, await bcrypt.hash(password, 10));
    } else {
      await this.db.delete(settings).where(eq(settings.key, PRIVACY_KEYS.passwordHash));
    }
    return this.policy();
  }

  /**
   * 全局密码解锁：校验通过即签发一张「不限定 id」的访问票据。
   * 未设全局密码时一律拒绝 —— 否则密码授权这条通路会变为无门槛开放。
   */
  async unlock(password: string): Promise<{ token: string; expiresIn: number }> {
    const value = await readPrivacySettings(this.db);
    if (!value.passwordHash) throw new BadRequestException('尚未设置全局查看密码');
    if (!(await bcrypt.compare(password, value.passwordHash))) throw new UnauthorizedException('密码错误');
    return { token: this.mint({ role: 'password', exp: this.expiry(GRANT_TTL_SECONDS) }), expiresIn: GRANT_TTL_SECONDS };
  }

  /* ----------------------------------------------------------------------
   * 单张独立密码
   * -------------------------------------------------------------------- */

  /** 给某张照片单独设密码（null 表示清除，回到只认全局密码） */
  async setPhotoPassword(id: string, password: string | null): Promise<void> {
    const hash = password ? await bcrypt.hash(password, 10) : null;
    const result = await this.db
      .update(media)
      .set({ privacyPasswordHash: hash })
      .where(and(eq(media.id, id), eq(media.deleted, false)));
    if ((result.rowCount ?? 0) === 0) throw new NotFoundException('照片不存在');
  }

  /** 单张密码解锁：签一张只覆盖这一张的票据 */
  async unlockPhoto(id: string, password: string): Promise<{ token: string; expiresIn: number }> {
    const row = await this.db.query.media.findFirst({ where: eq(media.id, id) });
    if (!row || row.deleted) throw new NotFoundException('照片不存在');
    if (!row.privacyPasswordHash) throw new BadRequestException('这张照片没有设置独立密码');
    if (!(await bcrypt.compare(password, row.privacyPasswordHash))) throw new UnauthorizedException('密码错误');
    return {
      token: this.mint({ role: 'photo', ids: [id], exp: this.expiry(GRANT_TTL_SECONDS) }),
      expiresIn: GRANT_TTL_SECONDS,
    };
  }

  /* ----------------------------------------------------------------------
   * 时效分享链接（含提取码双重校验）
   * -------------------------------------------------------------------- */

  async listShares(): Promise<ShareView[]> {
    const rows = await this.db.select().from(privacyShares).orderBy(desc(privacyShares.createdAt));
    return rows.map((row) => this.toShareView(row));
  }

  async createShare(input: {
    ids: string[];
    expiresInHours?: number;
    code?: string | null;
    createdBy?: string;
  }): Promise<ShareView> {
    const ids = [...new Set(input.ids ?? [])];
    if (ids.length === 0) throw new BadRequestException('至少要选择一张照片');

    const hours = Math.min(MAX_SHARE_HOURS, Math.max(MIN_SHARE_HOURS, Math.round(input.expiresInHours ?? 24)));
    // 三态入参：undefined（不传）= 自动生成 4 位码（默认双重校验更安全）；
    // null 或空串 = 明确「不要提取码」；其它 = 自定义码
    const code =
      input.code === undefined
        ? newAccessCode()
        : input.code === null || input.code.trim() === ''
          ? null
          : input.code.trim();
    if (code && (code.length < MIN_CODE_LEN || code.length > MAX_CODE_LEN)) {
      throw new BadRequestException(`提取码需为 ${MIN_CODE_LEN}~${MAX_CODE_LEN} 位`);
    }

    const row = {
      id: newShareToken(),
      mediaIds: ids,
      accessCode: code,
      expiresAt: new Date(Date.now() + hours * 3600 * 1000),
      revoked: false,
      createdBy: input.createdBy ?? null,
    };
    await this.db.insert(privacyShares).values(row);
    return this.toShareView({ ...row, createdAt: new Date() });
  }

  /** 立即失效（保留记录）：只打撤销标记，方便后台看到「这条链接曾存在」 */
  async revokeShare(id: string): Promise<void> {
    const result = await this.db.update(privacyShares).set({ revoked: true }).where(eq(privacyShares.id, id));
    if ((result.rowCount ?? 0) === 0) throw new NotFoundException('分享链接不存在');
  }

  /**
   * 打开分享链接：先验链接本身（存在 / 未撤销 / 未过期），再验提取码。
   * 任一环失败都抛 404 或 401 —— 不区分「链接不存在」与「已过期」，
   * 避免外部靠错误信息推断出哪些 token 曾经有效。
   */
  async openShare(token: string, code?: string): Promise<ShareUnlock> {
    const row = await this.db.query.privacyShares.findFirst({ where: eq(privacyShares.id, token) });
    if (!row || row.revoked || row.expiresAt.getTime() <= Date.now()) throw new NotFoundException('分享链接不存在或已失效');

    if (row.accessCode && code !== row.accessCode) {
      throw new UnauthorizedException('请输入正确的提取码');
    }

    // 票据寿命取「链接剩余寿命」，绝不超出：链接一过期，图片地址同时失效
    const remain = Math.max(60, Math.floor((row.expiresAt.getTime() - Date.now()) / 1000));
    return {
      token: this.mint({ role: 'share', ids: row.mediaIds, exp: this.expiry(Math.min(remain, GRANT_TTL_SECONDS)) }),
      expiresAt: row.expiresAt.toISOString(),
      mediaIds: row.mediaIds,
    };
  }

  /* ----------------------------------------------------------------------
   * 内部工具
   * -------------------------------------------------------------------- */

  private mint(grant: Parameters<typeof signGrant>[1]): string {
    return signGrant(this.config.JWT_SECRET, grant);
  }

  private expiry(seconds: number): number {
    return Math.floor(Date.now() / 1000) + seconds;
  }

  /** upsert 一个设置项 */
  private async put(key: string, value: string): Promise<void> {
    await this.db
      .insert(settings)
      .values({ key, value })
      .onConflictDoUpdate({ target: settings.key, set: { value, updatedAt: new Date() } });
  }

  private toShareView(row: {
    id: string;
    mediaIds: string[];
    accessCode: string | null;
    expiresAt: Date;
    revoked: boolean;
    createdBy: string | null;
    createdAt: Date;
  }): ShareView {
    return {
      id: row.id,
      mediaIds: row.mediaIds,
      accessCode: row.accessCode,
      expiresAt: row.expiresAt.toISOString(),
      revoked: row.revoked,
      expired: row.expiresAt.getTime() <= Date.now(),
      createdBy: row.createdBy,
      createdAt: row.createdAt.toISOString(),
      url: `${this.config.WEB_BASE_URL}/#privacy-share?token=${encodeURIComponent(row.id)}`,
    };
  }
}