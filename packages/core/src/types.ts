/**
 * packages/core/src/types.ts
 *
 * 领域模型：与 docs/塑忆产品设计方案.md §7 的 media / exif_metadata 表一一对应。
 * 这里只保留前端界面真正消费的字段；后端字段命名（snake_case）在 sdk 层做映射。
 */
import type { PhotoTag } from './tagging';

/** 片子方向：决定瀑布流占位比例与生成图尺寸档 */
export type PhotoSize = 'landscape' | 'portrait';

/** 分类体系里的固定枚举（对应 categories 表） */
export type PhotoCategory = '风光' | '街拍' | '人像' | '建筑' | '微距' | '纪实';

/** 文件格式（对应 media_files.format），只列出当前会上架拍摄的几种 */
export type PhotoFormat = 'JPG' | 'RAW' | 'DNG' | 'HEIC';

/** 照片定位（WGS-84）：海拔可能缺失，经纬度必须成对存在才有意义 */
export interface PhotoGps {
  lat: number;
  lon: number;
  alt: number | null;
}

/** 隐私形态：公开 / 模糊展示 / 前台不展示 */
export type PrivacyMode = 'visible' | 'blur' | 'hidden';

/**
 * 一张照片对当前访客的隐私状态（由服务端判定，前端只做呈现）。
 * locked 为真时：这张照片的原片地址、EXIF、定位都已被服务端摘掉，
 * 前端拿到的图片字节本身就是模糊图 —— 所以前端不需要、也无法「不小心」泄露原图。
 */
export interface PhotoPrivacy {
  /** 有效策略（单张标记优先，未标记时跟随后台设置的全局默认） */
  mode: PrivacyMode;
  /** 对当前访客锁着（看不到原片） */
  locked: boolean;
  /** 这张单独设了查看密码 */
  hasOwnPassword: boolean;
}

/** 一张照片 = media 行 + exif_metadata 行的展平视图 */
export interface Photo {
  /** media.id */
  id: string;
  /** media.title */
  title: string;
  /**
   * 上传时的原始文件名（含扩展名）；批量导入的照片没有这条信息，为空。
   * 后台的文件夹上传靠「originalName + originalSize」判断一个文件是否已经传过。
   */
  originalName?: string | null;
  /** 上传时的原始字节数；与 originalName 成对出现 */
  originalSize?: number | null;
  /** media.description —— 描述正文（纯文本，保留换行）；没写时为空串 */
  description: string;
  /** categories.name */
  cat: PhotoCategory;
  /** media_files.format —— 展示用的格式名 */
  format: PhotoFormat;
  /**
   * 标签 + 来源 + 审核态。
   * 【为什么不是纯字符串】后台要区分「人工 / AI」并显示置信度，前台要按审核态筛掉待审的，
   * 只给名字的话两边都得多发一次请求才能判断。前台展示用 approvedTagNames() 一次筛干净。
   */
  tags: PhotoTag[];
  /** exif_metadata.* */
  cam: string;
  lens: string;
  focal: string;
  aperture: string;
  iso: number;
  speed: string;
  temp: string;
  wb: string;
  /** 拍摄地（GPS 反解后的可读地址） */
  place: string;
  /** 拍摄日期，统一 YYYY-MM-DD，便于字符串直接切片分组 */
  date: string;
  /** 喜爱数 */
  likes: number;
  size: PhotoSize;
  /** 原片像素宽高（EXIF ImageWidth/Height）；缺失时由 photoAspect() 回退到 size 口径的固定比例 */
  width: number | null;
  height: number | null;
  /** 缩略图可访问地址（由 sdk 拼成绝对地址） */
  url: string;
  /** 卡片档缩略图（小尺寸，瀑布流/列表用，由 sdk 拼成绝对地址） */
  cardUrl?: string;
  /** 原片可访问地址（「在新标签打开原图」用）；无原片时为空 */
  originalUrl?: string;
  /**
   * 原片下载地址（点击后落盘）。与原片同一份文件，但会先注入数据库里最新的 EXIF；
   * 无原片或被隐私锁住时为空。由 sdk 从 originalUrl 派生，因此自动带上隐私票据。
   */
  downloadUrl?: string;
  /** 原片就地预览地址（viewer 内显示、不落盘）；与 downloadUrl 是同一份字节，仅处置方式不同 */
  originalPreviewUrl?: string;
  /** 是否实况照片（Motion Photo）：真时卡片带「实况」角标、查看器可播放 */
  isLive?: boolean;
  /** 实况视频地址（内嵌 MP4，已提取落盘）；非实况照片为空 */
  liveUrl?: string;
  /** 照片文件里的定位（WGS-84）；文件本身没有 GPS 时为空 —— 仅由地图选点写入的照片才有 */
  gps?: PhotoGps | null;
  /** 隐私状态（服务端判定）；缺失即按「公开且未锁」处理 */
  privacy?: PhotoPrivacy;
}

/** 时间线的一个「日」分组：同一天拍的所有照片 */
export interface DayGroup {
  /** YYYY-MM-DD，同时也是滚动锚点 id 的来源；无拍摄日期时为空串 */
  date: string;
  /** 分组标题用的拆解值，避免渲染时反复 slice。哨兵组的 year 是「未知时间」 */
  year: string;
  month: string;
  day: number;
  /** 0=周日 … 6=周六 */
  weekday: number;
  /** 是否为「无拍摄日期」的哨兵组：为 true 时 month/day/weekday 无意义，渲染层必须跳过 */
  undated: boolean;
  /** 当天的照片，已按时间线当前排序方向排好 */
  photos: Photo[];
}

/** 时间线的一个「年」区块：年份大标题 + 其下所有日分组 */
export interface YearBlock {
  year: string;
  /** 该年共多少天有片子 */
  days: number;
  /** 该年共多少张片子 */
  count: number;
  daysGroups: DayGroup[];
}

/** 时间线排列顺序：从旧到新 / 从新到旧 */
export type SortOrder = 'asc' | 'desc';

/** 画廊视图：墙面（多列瀑布流）/ 列表（单列横向行）。「时间线式」已取消 —— 时间线改由左侧进度轨承担。 */
export type GalleryView = 'wall' | 'list';