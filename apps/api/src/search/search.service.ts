/**
 * apps/api/src/search/search.service.ts
 *
 * 专用检索服务：全部「搜索相关请求」都从这里走 —— 照片多维检索 + 字典联想。
 *
 * 【为什么不自己写一套 SQL】检索的 SQL 只有一份（PhotosService.conditionsOf）：
 * /photos、/search/photos、相册详情三处的筛选口径必须永远一致，否则会出现
 * 「同一个条件从两个入口进来结果不同」这种最难查的 bug。这里做的就是
 * 「把检索语义收口到一处」——入口独立、实现唯一。
 *
 * 【为什么独立成模块】检索会持续长出只属于它自己的东西：当前是字典联想，
 * 之后可能是按相似度排序、检索历史、结果计数。把它们挂在照片 CRUD 上会让
 * PhotosService 既有资源管理又有检索策略，两个变化原因缠在一起。
 */
import { BadRequestException, Injectable } from '@nestjs/common';
import type { PrivacyPass } from '../privacy/policy';
import { DictionaryService, isDictionaryKind } from '../dictionary/dictionary.service';
import type { ApiDictionaryEntry } from '../dictionary/dictionary.service';
import { PhotosService } from '../photos/photos.service';
import type { ApiPhoto, ListFilter } from '../photos/photos.service';
import type { PageParams } from '../photos/filter-params';

/** 联想默认返回条数：一屏下拉够用，也不会让首次展开就拉回整份字典 */
const SUGGEST_LIMIT = 20;

@Injectable()
export class SearchService {
  constructor(
    private readonly photos: PhotosService,
    private readonly dictionary: DictionaryService,
  ) {}

  /** 照片检索：筛选条件与分页参数已由控制器解析好（见 filter-params.ts） */
  listPhotos(filter: ListFilter, page: PageParams, pass: PrivacyPass): Promise<ApiPhoto[]> {
    return this.photos.list(filter, page, pass);
  }

  /**
   * 字典联想：某类型下与输入片段匹配的候选值。
   * 【为什么空关键词也返回一屏】下拉一展开就该有内容 —— 先给最常用的一段，
   * 用户接着敲字才逐字收窄，不必「先输一个字才敢展开」。
   */
  suggest(kind: string, q: string, limit?: number): Promise<ApiDictionaryEntry[]> {
    if (!isDictionaryKind(kind)) throw new BadRequestException('不支持的字典类型，请从页面上的候选项中选择');
    const size = limit == null || !Number.isFinite(limit) ? SUGGEST_LIMIT : Math.round(limit);
    return this.dictionary.suggest(kind, q ?? '', size);
  }

  /** 隐私上下文：与 /photos 同一套口径（匿名只看公开，带票据可见已解锁） */
  pass(req: Parameters<PhotosService['pass']>[0]): Promise<PrivacyPass> {
    return this.photos.pass(req);
  }
}