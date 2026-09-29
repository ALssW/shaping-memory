/**
 * apps/api/src/files/files.controller.ts
 *
 * 静态文件服务：按照片 id 返回缩略图 / 卡图 / 原片 / 实况视频。
 *
 * 【这一层是隐私系统的最后一道闸】照片读接口（/photos）只是「告诉前端该请求哪个地址」，
 * 真正把字节发出去的是这里。所以「模糊展示绝不能泄露原图」这条硬要求必须落在此处：
 * 对无权者，thumbnail/card 一律改写为**服务端生成的模糊图**（先降到 28px 再放大，
 * 细节已物理消失，无法反卷积还原），original/live 直接 403 —— 前端即便绕过所有 UI
 * 直接按 id 拼接地址，也无法获取原片字节。
 *
 * 授权凭证走 URL（?pt=）：浏览器给 <img> 发请求时不会带 Authorization 头，
 * 所以票据只能进 query，由投递这张照片的读接口负责拼上（见 PhotosService.toApi）。
 *
 * 【混合存储：衍生品恒本机，原片 / 实况才可能上云】
 *   · 缩略图 / 卡图 / 模糊图（thumbs、blur）**永远在本机**，直接交给 express 的 sendFile ——
 *     Range / ETag / 304 由其原生提供且久经验证，最热的端点零云端带宽。
 *   · 原片 / 实况视频：本机模式走 sendFile；云模式下本机没有字节，由 API 从桶里取回来**转发**。
 *     照片地址永不出 URL（桶可以是完全私有的，也不需要预签名），隐私照片因此不需要
 *     另建一套鉴权/防盗链体系 —— 能不能拿到字节，始终只由这里的 gate() 说了算。
 */
import {
  BadGatewayException,
  Controller,
  ForbiddenException,
  Get,
  Inject,
  NotFoundException,
  Param,
  Query,
  Req,
  Res,
  ServiceUnavailableException,
} from '@nestjs/common';
import { createReadStream, existsSync } from 'node:fs';
import { mkdir, rm, stat } from 'node:fs/promises';
import path from 'node:path';
// 【必须从 stream/promises 引】node:stream 的 pipeline 要求最后一个参数是回调，
// 写成 `await pipeline(src, res)` 会在运行时抛 TypeError（streams[length-1] 必须是函数）；
// stream/promises 版本才是「返回 Promise、两参即可」，与下面的 await 语义一致。
import { pipeline } from 'node:stream/promises';
import type { Request, Response } from 'express';
import { eq } from 'drizzle-orm';
import { exifMetadata, media } from '@shaping-memory/db';
import type { Db } from '@shaping-memory/db';
import { writeExifTags } from '@shaping-memory/exif';
import { blurPathFor, cardPathForThumb, generateBlurPlaceholder } from '@shaping-memory/image';
import { StorageError } from '@shaping-memory/storage';
import type { ByteRange, ObjectStore } from '@shaping-memory/storage';
import type { AppConfig } from '@shaping-memory/config';
import { APP_CONFIG, DB, OBJECT_STORE } from '../infra.module';
import { remoteStoreOf } from '../storage-config';
import { photoObjectKeys } from '../photo-objects';
import type { PhotoObjectKeys } from '../photo-objects';
import { stageOriginal } from '../original-staging';
import { privacyContextOf, readPrivacySettings, verdictOf } from '../privacy/policy';
import type { PrivacyMode } from '../privacy/policy';
import { exifWritesOf } from '../photos/exif-sync';

/** 被拦截时对外返回的提示（不透露「这张是隐私照片」，只提示无权限） */
const DENIED = '该资源需要授权后查看';

/**
 * 缓存策略三档。
 *
 * 【公开缩略图为什么敢 immutable 一年】缩略图的内容由 mediaId 唯一确定、且重导不会改变
 * 同一张照片的缩略图语义；真要更新，媒体 id 会变（源文件名的哈希），地址跟着变。
 * 【公开原片为什么反而必须回源】EXIF 是可以被后台改写的，改完必须立刻看到新图，
 * 所以只让浏览器存、但每次都要回源确认（must-revalidate）。
 * 【隐私相关的一切为什么一律 private】公开缓存（CDN、公司代理）会把响应原样存下来发给别人，
 * 而「谁能看这张」的判定结果只对当前请求者成立 —— 一旦进入共享缓存，隐私即被泄露。
 */
const CACHE_IMMUTABLE = 'public, max-age=31536000, immutable';
const CACHE_REVALIDATE = 'private, max-age=0, must-revalidate';
const CACHE_PRIVATE_SHORT = 'private, max-age=300';
/** 隐私照片获准后下发的原片：连浏览器自己都不许存，杜绝「退出登录后回退还能看到」 */
const CACHE_NO_STORE = 'private, no-store';

/** 过闸结果：出口形态 + 照片自身策略 + 本次转发需要的全部路径与键 */
interface GateResult {
  /** 本次该以什么形态出口：'visible' 才允许发真实字节 */
  mode: PrivacyMode;
  /**
   * 这张照片**自身**是否受隐私保护（有效策略非 visible）。
   *
   * 【为什么不能用 verdict.locked 代替】获准的隐私照片与本来就公开的照片，locked 都是 false、
   * 出口形态都是 'visible' —— 两者被压成同一个值后就分不出「这份字节能不能缓存」，
   * 而获准下发的隐私原片一旦被缓存，隐私即被泄露。所以必须单独带出「这张本身是不是隐私照片」。
   */
  restricted: boolean;
  /** 模糊图、转发与下载都要用到的行信息 */
  id: string;
  /** 照片标题：下载时的文件名来源 */
  title: string;
  width: number | null;
  height: number | null;
  thumbPath: string | null;
  sourcePath: string;
  liveVideoPath: string | null;
  /** 桶内相对键（云模式转发用；本机模式用不到，但推导成本为零，一并带出） */
  keys: PhotoObjectKeys;
}

@Controller('files')
export class FilesController {
  /** 远端对象存储；本机模式为 null（见 storage-config.ts 的 remoteStoreOf） */
  private readonly remote: ObjectStore | null;
  /** 本机模式的模糊图在途生成任务：同一张被并发请求时复用同一个 Promise，避免半成品被读到 */
  private readonly blurring = new Map<string, Promise<string>>();

  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(OBJECT_STORE) store: ObjectStore,
  ) {
    this.remote = remoteStoreOf(config, store);
  }

  @Get(':id/thumbnail')
  async thumbnail(@Param('id') id: string, @Req() req: Request, @Res() res: Response): Promise<void> {
    const gate = await this.gate(id, req);
    if (gate.mode !== 'visible') {
      // 受保护（且未获准）：只有模糊图能出口，原缩略图一律不给
      await this.sendBlur(gate, res);
      return;
    }
    // 缩略图恒在本机：直接 sendFile，云模式下也一样（混合存储刻意把衍生品留在本机）
    this.sendLocal(res, gate.thumbPath, gate.restricted ? CACHE_PRIVATE_SHORT : CACHE_IMMUTABLE);
  }

  /** 卡片档缩略图：瀑布流/列表用的小尺寸图，路径由详情档约定推导（见 image 包） */
  @Get(':id/card')
  async card(@Param('id') id: string, @Req() req: Request, @Res() res: Response): Promise<void> {
    const gate = await this.gate(id, req);
    if (gate.mode !== 'visible') {
      await this.sendBlur(gate, res);
      return;
    }
    const cacheControl = gate.restricted ? CACHE_PRIVATE_SHORT : CACHE_IMMUTABLE;
    // 卡片档缺失时回退到详情档，保证旧数据/未重导的照片始终有图可看
    if (gate.thumbPath) {
      const cardPath = cardPathForThumb(gate.thumbPath);
      if (existsSync(cardPath)) {
        this.sendFileWith(res, cardPath, cacheControl);
        return;
      }
    }
    this.sendLocal(res, gate.thumbPath, cacheControl);
  }

  @Get(':id/original')
  async original(@Param('id') id: string, @Req() req: Request, @Res() res: Response): Promise<void> {
    const gate = await this.gate(id, req);
    // 原片是「最不能被泄露的东西」：受保护时不存在模糊降级，直接拒绝
    if (gate.mode !== 'visible') throw new ForbiddenException(DENIED);
    // 隐私照片即使获准，也不许任何缓存留痕（见 GateResult.restricted 的说明）
    const cacheControl = gate.restricted ? CACHE_NO_STORE : CACHE_REVALIDATE;
    await this.deliver(res, req, gate.sourcePath, gate.keys.original, cacheControl);
  }

  /**
   * 实况照片的内嵌视频（Motion Photo 尾部的 MP4）。
   * 视频可达数十 MB，因此云模式也必须**流式转发**并支持 Range，
   * 播放器才能拖动进度条 / 边下边播。
   */
  @Get(':id/live')
  async live(@Param('id') id: string, @Req() req: Request, @Res() res: Response): Promise<void> {
    const gate = await this.gate(id, req);
    // 视频同样含原图内容，且无法可靠模糊，因此与 original 同等对待
    if (gate.mode !== 'visible') throw new ForbiddenException(DENIED);
    if (!gate.keys.live) throw new NotFoundException('该照片没有实况视频');
    const cacheControl = gate.restricted ? CACHE_NO_STORE : CACHE_REVALIDATE;
    await this.deliver(res, req, gate.liveVideoPath, gate.keys.live, cacheControl);
  }

  /**
   * 取「带最新 EXIF 的原片」：从库里读 EXIF 注入临时副本后下发。
   *
   * 【两种出口，同一份字节】
   *   · `?inline=1` → `Content-Disposition: inline`，供前台 viewer「加载原片」就地显示（不落盘）；
   *   · 不带参数   → `Content-Disposition: attachment`，点击下载真正落盘。
   *   之所以共用一个地址：两者要看到/拿到的必须是**同一份**字节（都带库里最新 EXIF），
   *   分开实现迟早会因注入逻辑改了一处而不一致。
   *
   * 【为什么不用 `/original` 来做预览】`/original` 是「快」路径（原片原样、可缓存、支持 Range）；
   * 这里要的是「注入后的原片」，每次都得落 tmp 副本 + 跑一趟 exiftool，语义与缓存策略都不同。
   * 【为什么不改原文件】云端原片自上传起不可变（混合存储决策）—— 这里动的是 tmp 里的副本，
   * 同时也解决了「写盘必须清理」的问题（finally 必删）。
   */
  @Get(':id/download')
  async download(
    @Param('id') id: string,
    @Req() req: Request,
    @Res() res: Response,
    @Query('inline') inline?: string,
  ): Promise<void> {
    const gate = await this.gate(id, req);
    // 原片没有模糊降级：无权者直接拒绝（与 /original 同一口径）
    if (gate.mode !== 'visible') throw new ForbiddenException(DENIED);

    let tmpPath: string;
    try {
      tmpPath = await stageOriginal(this.config, this.remote, gate);
    } catch (err) {
      return this.failStorage(res, err);
    }
    if (res.headersSent) return; // 存储层已直接回写状态码（如 416），无需继续
    try {
      // 从 DB 取最新 EXIF 注入副本；原文件与云端对象都保持不变
      const meta = await this.db.query.exifMetadata.findFirst({
        where: eq(exifMetadata.mediaId, gate.id),
      });
      await writeExifTags(this.config.TOOLS_DIR, tmpPath, exifWritesOf(meta?.extra));
      await this.streamDownload(res, tmpPath, gate, inline === '1');
    } finally {
      await rm(tmpPath, { force: true });
    }
  }

  /* ------------------------------------------------------------------------
   * 内部：下载（注入 EXIF → 流式下发）
   * ---------------------------------------------------------------------- */

  /**
   * 下发「注入后的原片」：禁缓存（下载件不该被任何层留存）。
   * `inline` 为真时用 `inline` 处置方式（viewer 就地显示），否则 `attachment`（落盘）。
   * 文件名走 RFC 5987 以支持中文标题。
   */
  private async streamDownload(
    res: Response,
    file: string,
    gate: GateResult,
    inline: boolean,
  ): Promise<void> {
    const ext = path.extname(gate.sourcePath).toLowerCase();
    const { size } = await stat(file);
    res.setHeader('Content-Type', guessContentType(gate.sourcePath));
    res.setHeader('Content-Length', String(size));
    res.setHeader('Content-Disposition', contentDisposition(gate.title, ext, inline));
    res.setHeader('Cache-Control', CACHE_NO_STORE);
    await pipeline(createReadStream(file), res);
  }

  /* ------------------------------------------------------------------------
   * 内部：投递（本机 sendFile / 云端代理转发）
   * ---------------------------------------------------------------------- */

  /**
   * 投递一份真实字节（仅 original / live 会走到这）。
   * 本机模式走 sendFile（本地文件是正本，且 Range/ETag/304 由 express 免费提供）；
   * 云模式走 proxy（从桶里取流转发）—— 判据是「有没有远端」，绝不看本地文件是否存在。
   */
  private async deliver(
    res: Response,
    req: Request,
    localPath: string | null,
    key: string,
    cacheControl: string,
  ): Promise<void> {
    if (!this.remote) {
      this.sendLocal(res, localPath, cacheControl);
      return;
    }
    await this.proxy(res, req, key, cacheControl);
  }

  /**
   * 本机投递：文件必须真实存在。
   * 衍生品（缩略图/卡图/模糊图）在两种模式下都留在本机，因此它们恒走这里。
   */
  private sendLocal(res: Response, localPath: string | null, cacheControl: string): void {
    if (!localPath || !existsSync(localPath)) throw new NotFoundException('文件尚未生成');
    this.sendFileWith(res, localPath, cacheControl);
  }

  /** 本机模式投递：交给 express 的 sendFile（它会自己处理 Range / ETag / 304） */
  private sendFileWith(res: Response, filePath: string, cacheControl: string): void {
    // cacheControl: false 关掉 express 默认的 max-age=0，缓存策略由上面那三档统一决定
    res.sendFile(filePath, { cacheControl: false, headers: { 'Cache-Control': cacheControl } });
  }

  /**
   * 云模式投递：把对象存储里的字节转发给客户端。
   * 一次 GetObject 就拿到流 + 长度 + ETag + 内容类型，不额外发 HeadObject。
   */
  private async proxy(res: Response, req: Request, key: string, cacheControl: string): Promise<void> {
    const remote = this.remote;
    if (!remote) throw new NotFoundException('文件尚未生成'); // 不该发生：本机模式不走这里

    const range = parseRange(req.headers.range);
    let read;
    try {
      read = await remote.get(key, range ?? undefined);
    } catch (err) {
      return this.failStorage(res, err);
    }

    // 条件请求：带 Range 时不回 304 —— 播放器要的是「那一段字节」，回空体会让它彻底卡住
    if (!range && matchesEtag(req.headers['if-none-match'], read.etag)) {
      res.status(304).end();
      return;
    }

    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('Content-Type', read.contentType ?? guessContentType(key));
    res.setHeader('Content-Length', String(read.size));
    res.setHeader('ETag', read.etag);
    res.setHeader('Cache-Control', cacheControl);
    if (range) {
      // 末端以服务端**实际**给出的长度为准（请求越界时桶会自行截断），两边必须自洽
      const end = range.start + read.size - 1;
      res.setHeader('Content-Range', `bytes ${range.start}-${end}/${read.totalSize}`);
      res.status(206);
    } else {
      res.status(200);
    }

    // 客户端中途关掉页面 / 取消下载时，上游那条 S3 连接必须跟着断，
    // 否则它会一直挂起等待数据读取完成 —— 单张图可达数 MB，数十个僵死连接即可耗尽内存
    req.on('close', () => read.stream.destroy());
    try {
      // 用 pipeline 而不是 pipe：它会把两端的错误互相传导，并在失败时自动销毁流
      await pipeline(read.stream, res);
    } catch {
      // 头已经发出去了（或客户端已断开），状态码改不了，只能断开连接
      if (!res.headersSent) res.status(502).end();
    }
  }

  /** 存储层错误 → HTTP 状态码。上游细节只进日志，不进响应体 */
  private failStorage(res: Response, err: unknown): void {
    const code = err instanceof StorageError ? err.code : 'unknown';
    if (code === 'not_found') throw new NotFoundException('文件尚未生成');
    if (code === 'range_invalid') {
      // RFC 7233 要求回 416；总长度这次拿不到（正是它越界才失败的），Content-Range 一并省略
      res.status(416).end();
      return;
    }
    if (code === 'unreachable') throw new ServiceUnavailableException('存储服务暂时连不上，请稍后重试');
    // eslint-disable-next-line no-console
    console.error('[files] 对象存储读取失败', err);
    throw new BadGatewayException('存储服务读取失败');
  }

  /* ------------------------------------------------------------------------
   * 内部：闸门与模糊图
   * ---------------------------------------------------------------------- */

  /**
   * 过闸：判定这张照片对当前请求者该以什么形态出口。
   * 返回 'visible' 才允许发真实字节；'blur' 时上层改写为模糊图；'hidden' 直接 404。
   */
  private async gate(id: string, req: Request): Promise<GateResult> {
    const row = await this.db.query.media.findFirst({ where: eq(media.id, id) });
    if (!row || row.deleted) throw new NotFoundException('照片不存在');

    const { settings, ctx } = await privacyContextOf(this.db, this.config.JWT_SECRET, {
      query: req.query as Record<string, unknown>,
    });
    const verdict = verdictOf(row, settings, ctx);
    // 获准了就是完全公开形态；否则按它自己的策略走（visible 也照常发）
    const mode: PrivacyMode = verdict.locked ? verdict.mode : 'visible';

    // 隐藏的照片对无权者按「不存在」处理：不暴露「存在一张被隐藏的照片」这一信息
    if (mode === 'hidden') throw new NotFoundException('照片不存在');

    return {
      mode,
      restricted: verdict.mode !== 'visible',
      id: row.id,
      title: row.title,
      width: row.width,
      height: row.height,
      thumbPath: row.thumbPath,
      sourcePath: row.sourcePath,
      liveVideoPath: row.liveVideoPath,
      keys: photoObjectKeys(row),
    };
  }

  /* ---------------------------- 模糊图（本机） ---------------------------- */

  /**
   * 取（必要时生成）**本机落盘版**模糊图。
   * 源图优先用缩略图：它已在本地、尺寸小，比动原片快得多，且模糊后画质无差别。
   * 【在途任务按 id + 强度去重】强度是可配置项，若只按 id 去重，改完强度后仍会复用
   * 旧强度那次生成的 Promise，改强度看起来「没生效」。
   */
  private async blurFile(id: string): Promise<string> {
    const { blurStrength } = await readPrivacySettings(this.db);
    const runningKey = `${id}@${blurStrength}`;
    const running = this.blurring.get(runningKey);
    if (running) return running;

    const task = this.generateBlur(id, blurStrength).finally(() => this.blurring.delete(runningKey));
    this.blurring.set(runningKey, task);
    return task;
  }

  private async generateBlur(id: string, strength: number): Promise<string> {
    // 强度编进文件名：换强度即换缓存键，新强度必然重新生成，旧文件留着无害
    const dest = blurPathFor(this.config.STORAGE_DIR, id, strength);
    if (existsSync(dest)) return dest;

    const row = await this.db.query.media.findFirst({ where: eq(media.id, id) });
    if (!row) throw new NotFoundException('照片不存在');
    const src = row.thumbPath && existsSync(row.thumbPath) ? row.thumbPath : row.sourcePath;
    if (!existsSync(src)) throw new NotFoundException('缩略图尚未生成');

    await mkdir(path.dirname(dest), { recursive: true });
    const aspect = row.width && row.height ? row.width / row.height : 1;
    return generateBlurPlaceholder(src, dest, aspect, strength);
  }

  /**
   * 模糊图出口：恒本机落盘 + existsSync 缓存。
   *
   * 【为什么云模式下也留本机】模糊图是隐私照片的唯一出口（无从反卷积还原），
   * 但它属于「衍生产物」——推上云只会多一条可被绕过的暴露面（一旦桶挂了公开域名，
   * `blur/{id}-v2s12.jpg` 就能被直接取到），而且改强度还得再同步一次，得不偿失。
   */
  private async sendBlur(gate: GateResult, res: Response): Promise<void> {
    const file = await this.blurFile(gate.id);
    this.sendFileWith(res, file, CACHE_PRIVATE_SHORT);
  }
}

/** 解析单段 Range。 */
function parseRange(header: string | undefined): ByteRange | null {
  if (!header) return null;
  const match = /^bytes=(\d+)-(\d*)$/.exec(header.trim());
  if (!match) return null;
  const start = Number(match[1]);
  if (match[2] === '') return { start }; // `bytes=5-` 表示「从 5 到末尾」
  const end = Number(match[2]);
  // end 小于 start 属于畸形请求：按 RFC 7233「忽略这个头」处理（回 200 全量），
  // 比直接 416 更宽容 —— 一个坏请求不该把播放器彻底卡死
  return end < start ? null : { start, end };
}

/** If-None-Match 的比对：只支持单值精确匹配（够用，且不必处理 `*` 这种极少见情形） */
function matchesEtag(header: string | undefined, etag: string): boolean {
  return header === etag;
}

/** 本机实现不提供内容类型时的回退（云模式的 ContentType 优先） */
function guessContentType(key: string): string {
  const ext = path.extname(key).toLowerCase();
  if (ext === '.mp4') return 'video/mp4';
  if (ext === '.png') return 'image/png';
  return 'image/jpeg';
}

/**
 * Content-Disposition：中文标题走 RFC 5987 的 `filename*`，同时给一个纯 ASCII 回退名 ——
 * 不支持 filename* 的旧浏览器至少能落成一个合法文件名，不会变为乱码或空名。
 * `inline` 为真时浏览器会就地渲染（viewer 预览），为假时触发「另存为」。
 */
function contentDisposition(title: string, ext: string, inline: boolean): string {
  const safe = title.replace(/[\\/:*?"<>|\r\n]+/g, '_').trim() || 'photo';
  const kind = inline ? 'inline' : 'attachment';
  return `${kind}; filename="photo${ext}"; filename*=UTF-8''${encodeURIComponent(`${safe}${ext}`)}`;
}