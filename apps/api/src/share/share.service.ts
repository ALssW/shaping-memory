/**
 * apps/api/src/share/share.service.ts
 *
 * 公开分享：把一个公开相册渲染成带 OpenGraph 元数据的 HTML。
 * 社交爬虫（微信 / 微博 / Twitter / Facebook 等）抓这个 URL 时读到 og:* 标签用于预览卡片，
 * 真人点开则被 meta refresh 跳转到 Web 前台的相册页。
 */
import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { asc, eq } from 'drizzle-orm';
import { albumMedia, albums } from '@shaping-memory/db';
import type { Db } from '@shaping-memory/db';
import type { AppConfig } from '@shaping-memory/config';
import { APP_CONFIG, DB } from '../infra.module';

/** HTML 里出现的文本一律转义，防止相册标题/描述夹带标签破坏页面 */
function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

@Injectable()
export class ShareService {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  /**
   * 渲染相册的分享页 HTML。
   * 仅公开相册可分享；私有相册对所有人（含爬虫）一律按 404 处理，不泄露其存在性。
   */
  async renderAlbum(id: string): Promise<string> {
    const album = await this.db.query.albums.findFirst({ where: eq(albums.id, id) });
    if (!album || !album.isPublic) throw new NotFoundException('相册不存在');

    // 封面优先自定义 coverMediaId，未设则取相册内第一张（与 albume.service 的口径一致）
    const first = album.coverMediaId
      ? null
      : await this.db
          .select({ mediaId: albumMedia.mediaId })
          .from(albumMedia)
          .where(eq(albumMedia.albumId, id))
          .orderBy(asc(albumMedia.sortOrder))
          .limit(1);
    const coverId = album.coverMediaId ?? first?.[0]?.mediaId ?? null;

    // og:image 必须是绝对地址，社交平台才能抓到图
    const image = coverId ? `${this.config.PUBLIC_BASE_URL}/files/${coverId}/thumbnail` : null;
    const title = album.title;
    const description = album.description ?? '公开影集 · 塑忆';

    const og = [
      '<meta property="og:type" content="website" />',
      `<meta property="og:title" content="${escapeHtml(title)}" />`,
      `<meta property="og:description" content="${escapeHtml(description)}" />`,
      image ? `<meta property="og:image" content="${escapeHtml(image)}" />` : '',
    ]
      .filter(Boolean)
      .join('\n    ');

    return `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="utf-8" />
    <title>${escapeHtml(title)} · 塑忆</title>
    ${og}
    <meta name="twitter:card" content="summary_large_image" />
    <meta http-equiv="refresh" content="0; url=${escapeHtml(this.albumUrl(id))}" />
  </head>
  <body style="background:#1c1c1e;color:#f5f5f7;font-family:system-ui;display:grid;place-items:center;height:100vh;margin:0">
    <p>正在打开影集《${escapeHtml(title)}》…</p>
  </body>
</html>`;
  }

  /** 相册在前台对应的地址（hash 路由，需要 encode 以防 id 里出现特殊字符） */
  private albumUrl(albumId: string): string {
    return `${this.config.WEB_BASE_URL}/#gallery?album=${encodeURIComponent(albumId)}`;
  }
}