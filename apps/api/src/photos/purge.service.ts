/**
 * apps/api/src/photos/purge.service.ts
 *
 * 彻底删除：把一张（或一批）照片从云端、本机与数据库里全部抹掉，且不误删用户档案。
 *
 * 【为什么单独成服务而不是写进 photos.service】photos.service 已达 750+ 行，
 * 再往上堆「物理清理 + 关联记录裁剪 + 事务编排」会把它变成什么都管的巨类。
 *
 * 【执行顺序与原子性】
 *   ① 读出目标行（**含已软删除的**，让「先软删除、再彻底删除」也走得通；不存在的 id 直接跳过，因此幂等）
 *   ② 物理清理：云端副本（原片 + 生成物）与本机副本（uploads 暂存原片、实况、缩略图、卡片图、模糊图变体）
 *      任一失败立即中止且**数据库一行都不动** —— 物理删除本身幂等，重试即可；
 *      反过来（先删库再删文件）一旦失败，文件就永远留在了磁盘上且界面上再也找不到入口。
 *   ③ 数据库事务：全成或全不成，杜绝「照片删了、标签 / 分享链接还挂着」这类半成品状态。
 *
 * 【不做的事】不删 PHOTO_SOURCE_DIR 的原始档案、不删 originals-backup 的 EXIF 备份、不动 audit_logs。
 */
import { Inject, Injectable } from '@nestjs/common';
import { and, eq, inArray, notExists } from 'drizzle-orm';
import { media, mediaTags, privacyShares, tags } from '@shaping-memory/db';
import type { Db } from '@shaping-memory/db';
import type { ObjectStore } from '@shaping-memory/storage';
import type { AppConfig } from '@shaping-memory/config';
import { APP_CONFIG, DB, OBJECT_STORE } from '../infra.module';
import { remoteStoreOf } from '../storage-config';
import { removePhotoObjects } from '../photo-objects';
import { purgeLocalAssets } from '../local-assets';

/** 彻底删除的结果：计数 + 失败明细（失败非空即代表本次未删库，可重试） */
export interface PurgeResult {
  /** 已从数据库删除的照片数 */
  purged: number;
  /** 已删除的本机文件数 */
  filesRemoved: number;
  /** 已删除的云端对象数 */
  objectsRemoved: number;
  /** 被裁剪掉这些照片的分享链接数（含因清空而被整条删除的） */
  sharesPruned: number;
  /** 清理掉的孤立标签数 */
  tagsPruned: number;
  failures: string[];
}

/** 物理清理阶段的结果（事务前的计数先攒在这里，事务提交后才并入最终结果） */
interface PhysicalResult {
  filesRemoved: number;
  objectsRemoved: number;
}

/** 清理所需的 media 行切片 */
interface MediaAssetRow {
  id: string;
  sourcePath: string;
  thumbPath: string | null;
  liveVideoPath: string | null;
}

@Injectable()
export class PurgeService {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(OBJECT_STORE) private readonly store: ObjectStore,
  ) {}

  /** 读取清理所需的 media 行（含已软删除的行；不存在的 id 不报错） */
  private async rowsOf(ids: readonly string[]): Promise<MediaAssetRow[]> {
    return this.db
      .select({
        id: media.id,
        sourcePath: media.sourcePath,
        thumbPath: media.thumbPath,
        liveVideoPath: media.liveVideoPath,
      })
      .from(media)
      .where(inArray(media.id, [...ids]));
  }

  /**
   * 物理清理一批行：云端与本机各删一遍，任一失败即中止。
   * 返回失败明细；明细非空时调用方必须放弃数据库操作。
   */
  private async removePhysical(rows: MediaAssetRow[]): Promise<PhysicalResult & { failures: string[] }> {
    const store = remoteStoreOf(this.config, this.store);
    const result: PhysicalResult & { failures: string[] } = {
      filesRemoved: 0,
      objectsRemoved: 0,
      failures: [],
    };

    for (const row of rows) {
      const cloud = await removePhotoObjects(store, row);
      const local = await purgeLocalAssets(this.config, row);
      result.objectsRemoved += cloud.removed;
      result.filesRemoved += local.removed;
      result.failures.push(...cloud.failures, ...local.failures);
      // 立即中止：本机模式（store 为 null）下只可能因本机文件而失败
      if (result.failures.length > 0) break;
    }
    return result;
  }

  /**
   * 数据库事务：删行 + 裁剪关联记录。
   *
   * 级联关系（见 schema）：exif_metadata / media_tags / album_media 随 media 行级联删除，
   * albums.cover_media_id 由外键 ON DELETE SET NULL 自动置空，因此这里只需处理两张表：
   *   - privacy_shares.media_ids：数组里剔除目标 id，数组变空则整条链接删除（空链接没有任何意义）
   *   - tags：本次涉及的标签里，删除后不再被任何照片引用的那些（否则标签列表会越积越脏）
   */
  private async pruneRecords(ids: readonly string[]): Promise<Omit<PurgeResult, 'filesRemoved' | 'objectsRemoved' | 'failures'>> {
    return this.db.transaction(async (tx) => {
      const target = new Set(ids);
      let sharesPruned = 0;

      const shares = await tx
        .select({ id: privacyShares.id, mediaIds: privacyShares.mediaIds })
        .from(privacyShares);
      for (const share of shares) {
        if (!share.mediaIds.some((id) => target.has(id))) continue;
        const kept = share.mediaIds.filter((id) => !target.has(id));
        if (kept.length === 0) {
          await tx.delete(privacyShares).where(eq(privacyShares.id, share.id));
        } else {
          await tx.update(privacyShares).set({ mediaIds: kept }).where(eq(privacyShares.id, share.id));
        }
        sharesPruned += 1;
      }

      /* 先取出本次涉及的标签 id：删掉 media 之后 media_tags 就被级联清空了，那时再查只剩不到任何线索 */
      const involved = await tx
        .selectDistinct({ tagId: mediaTags.tagId })
        .from(mediaTags)
        .where(inArray(mediaTags.mediaId, [...ids]));
      const tagIds = involved.map((row) => row.tagId);

      await tx.delete(media).where(inArray(media.id, [...ids]));

      let tagsPruned = 0;
      if (tagIds.length > 0) {
        const orphaned = await tx
          .delete(tags)
          .where(
            and(
              inArray(tags.id, tagIds),
              // 已无任何照片引用：子查询里命中一行即代表标签仍在被使用
              notExists(tx.select({ hit: mediaTags.tagId }).from(mediaTags).where(eq(mediaTags.tagId, tags.id))),
            ),
          )
          .returning({ id: tags.id });
        tagsPruned = orphaned.length;
      }

      return { purged: ids.length, sharesPruned, tagsPruned };
    });
  }

  /**
   * 彻底删除给定照片。幂等：已不存在的 id 被忽略，不视为错误。
   * 失败时返回 failures 明细且数据库保持原样，调用方可直接重试。
   */
  async purge(rawIds: readonly string[]): Promise<PurgeResult> {
    // 去重：同一个 id 传两次会让物理清理重复一轮，没有任何意义
    const ids = [...new Set(rawIds.filter((id) => id.length > 0))];
    const empty: PurgeResult = {
      purged: 0,
      filesRemoved: 0,
      objectsRemoved: 0,
      sharesPruned: 0,
      tagsPruned: 0,
      failures: [],
    };
    if (ids.length === 0) return empty;

    // 已不存在的 id 直接跳过：物理清理与数据库删除都以实际读到的行为准
    const rows = await this.rowsOf(ids);
    if (rows.length === 0) return empty;

    const physical = await this.removePhysical(rows);
    if (physical.failures.length > 0) {
      return {
        ...empty,
        filesRemoved: physical.filesRemoved,
        objectsRemoved: physical.objectsRemoved,
        failures: physical.failures,
      };
    }

    const records = await this.pruneRecords(rows.map((row) => row.id));
    return {
      ...records,
      filesRemoved: physical.filesRemoved,
      objectsRemoved: physical.objectsRemoved,
      failures: [],
    };
  }
}