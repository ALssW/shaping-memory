/**
 * apps/api/src/privacy/privacy.controller.ts
 *
 * 隐私与授权接口。分三类：
 *   1) 策略面（GET/PATCH /privacy/policy、POST /privacy/password）—— 需 admin；
 *   2) 解锁面（POST /privacy/unlock、/privacy/photos/:id/unlock）—— 公开，凭密码换票据；
 *   3) 分享面（POST/GET/DELETE /privacy/shares）—— 管理需 admin，打开需 token + 提取码。
 */
import { Body, Controller, Delete, Get, Param, Patch, Post, Query, Req, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import type { MaybeAuthedRequest } from '../auth/optional-jwt.guard';
import { Roles, RolesGuard } from '../auth/roles.guard';
import type { PrivacyContext } from './policy';
import { DEFAULT_BLUR_STRENGTH } from './policy';
import { PrivacyService } from './privacy.service';
import type { PolicyView, ShareView } from './privacy.service';
import type { ApiPhoto } from '../photos/photos.service';
import { PhotosService } from '../photos/photos.service';

/** 打开分享链接的返回：票据 + 照片（照片地址里已带票据，可直接渲染） */
interface ShareViewResult {
  token: string;
  expiresAt: string;
  photos: ApiPhoto[];
}

@Controller('privacy')
export class PrivacyController {
  constructor(
    private readonly privacy: PrivacyService,
    private readonly photos: PhotosService,
  ) {}

  /* ---- 策略面（admin） ---- */

  /** 前台也要读这个（据此决定是否显示「隐私照片」提示与解锁入口），因此不加守卫 */
  @Get('policy')
  policy(): Promise<PolicyView> {
    return this.privacy.policy();
  }

  @Patch('policy')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('admin')
  updatePolicy(
    @Body() body: { defaultMode?: string; accessRoles?: string[]; blurStrength?: number },
  ): Promise<PolicyView> {
    return this.privacy.updatePolicy(body);
  }

  /** 设 / 清全局查看密码（password 传 null 表示清除） */
  @Post('password')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('admin')
  setPassword(@Body() body: { password?: string | null }): Promise<PolicyView> {
    return this.privacy.setPassword(body.password ?? null);
  }

  /* ---- 解锁面（公开，凭密码换票据） ---- */

  /** 全局密码解锁：换一张覆盖全站隐私照片的票据 */
  @Post('unlock')
  unlock(@Body() body: { password?: string }): Promise<{ token: string; expiresIn: number }> {
    return this.privacy.unlock(body.password ?? '');
  }

  /** 给某张照片设 / 清独立密码（需 admin/editor） */
  @Post('photos/:id/password')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('admin', 'editor')
  async setPhotoPassword(
    @Param('id') id: string,
    @Body() body: { password?: string | null },
  ): Promise<{ ok: true }> {
    await this.privacy.setPhotoPassword(id, body.password ?? null);
    return { ok: true };
  }

  /** 单张独立密码解锁：只换到这一张的票据 */
  @Post('photos/:id/unlock')
  unlockPhoto(
    @Param('id') id: string,
    @Body() body: { password?: string },
  ): Promise<{ token: string; expiresIn: number }> {
    return this.privacy.unlockPhoto(id, body.password ?? '');
  }

  /* ---- 分享面 ---- */

  @Get('shares')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('admin', 'editor')
  listShares(): Promise<ShareView[]> {
    return this.privacy.listShares();
  }

  @Post('shares')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('admin', 'editor')
  createShare(
    @Body() body: { ids?: string[]; expiresInHours?: number; code?: string | null },
    @Req() req: MaybeAuthedRequest,
  ): Promise<ShareView> {
    return this.privacy.createShare({
      ids: body.ids ?? [],
      expiresInHours: body.expiresInHours,
      code: body.code,
      createdBy: req.user?.username,
    });
  }

  @Delete('shares/:id')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('admin', 'editor')
  async revokeShare(@Param('id') id: string): Promise<{ ok: true }> {
    await this.privacy.revokeShare(id);
    return { ok: true };
  }

  /**
   * 打开分享链接（无需登录）。
   * 提取码缺失/错误时后端抛 401，前端据此弹出「输入提取码」——链接本身不携带提取码，
   * 这就是「分享链接 + 提取码」的双重校验。
   */
  @Get('shares/:token')
  async openShare(@Param('token') token: string, @Query('code') code?: string): Promise<ShareViewResult> {
    const unlock = await this.privacy.openShare(token, code);
    // 只放行票据里列出的 id：ctx 用 sharedIds 而非 authorized，权限范围严格等同于这条链接
    const ctx: PrivacyContext = { authorized: false, sharedIds: new Set(unlock.mediaIds) };
    const photos = await this.photos.photosByIds(unlock.mediaIds, {
      // 分享场景下 defaultMode 固定 hidden：只有票据列出的 id 放行，其余一律当不可见
      settings: { defaultMode: 'hidden', accessRoles: [], passwordHash: null, blurStrength: DEFAULT_BLUR_STRENGTH },
      ctx,
    });
    return { token: unlock.token, expiresAt: unlock.expiresAt, photos };
  }
}