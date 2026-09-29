/**
 * packages/db/src/schema.ts
 *
 * Drizzle 表定义，对应产品设计方案 §7 的核心表：
 *   - media          照片主表（标题/分类/格式/拍摄时间/尺寸/源文件与缩略图路径/点赞/软删除）
 *   - exif_metadata  与 media 一一对应的完整 EXIF（机身/镜头/曝光/色温）
 *   - tags / media_tags  标签多对多
 *   - users / roles / permissions / role_permissions  账号与 RBAC（M2）
 *
 * 命名一律 snake_case（后端表列），前端字段名（camelCase）由 API 返回值映射。
 */
import {
  bigint,
  boolean,
  date,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  real,
  serial,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core';

/** 照片主表：一条 = 一张照片（media 行，见产品方案 §7） */
export const media = pgTable(
  'media',
  {
    /** 稳定 id：取源文件名的稳定哈希（导入幂等，重复导入不会新增重复行） */
    id: text('id').primaryKey(),
    title: text('title').notNull(),
    /**
     * 上传时的**原始文件名**（含扩展名）。
     * 【为什么必须单独存一列】media.id 取自「落盘文件名」的稳定哈希，而落盘名带随机前缀，
     * 同一个文件重复上传会算出不同 id —— 想判断「这个文件以前是不是传过」就只剩原始名可依。
     * 文件夹上传的「同名文件」比对（原始名 + 文件大小）正建立在它之上。
     * 批量导入（没有上传动作）时为 NULL；上传时一律写入。
     */
    originalName: text('original_name'),
    /** 上传时的原始字节数。与 originalName 一起构成「同名文件」的判定键（同名同大小才算同一个文件） */
    originalSize: bigint('original_size', { mode: 'number' }),
    /**
     * 照片描述：后台手写的正文，前台在查看器的拍摄信息里整段展示。
     * 【为什么是纯文本而不是富文本】描述只需要分段，换行与空行由文本本身携带即可；
     * 存 HTML/Markdown 就得再引入一套渲染与转义，收益远不抵复杂度。空串与 NULL 同义（都是「没写」）。
     */
    description: text('description'),
    /** 分类（对应 frontend 的 PhotoCategory 固定枚举，M1 暂由文件名推断） */
    category: text('category').notNull(),
    /** 展示用格式名：JPG / PNG（实际由 EXIF FileType 归一） */
    format: text('format').notNull(),
    /** 拍摄日期 YYYY-MM-DD（用于分组、排序、进度轨读取） */
    captureAt: date('capture_at'),
    /** 精确拍摄时间（EXIF DateTimeOriginal 解析） */
    takenAt: timestamp('taken_at', { withTimezone: true }),
    width: integer('width'),
    height: integer('height'),
    /** 横向 / 纵向，决定瀑布流占位比例与缩略图档位 */
    orientation: text('orientation').notNull().default('landscape'),
    /** 原片在本机文件系统上的绝对路径（本地存储一期） */
    sourcePath: text('source_path').notNull(),
    /** 缩略图绝对路径（由 image 包生成），未生成时为空 */
    thumbPath: text('thumb_path'),
    /**
     * 实况照片（Motion Photo）内嵌视频的绝对路径；导入时从照片尾部提取到 STORAGE_DIR/live/。
     * 非实况照片为空 —— 它同时充当「这张是不是实况照片」的判定依据（无需另建布尔列）。
     */
    liveVideoPath: text('live_video_path'),
    likes: integer('likes').notNull().default(0),
    /**
     * 隐私标记（单张覆盖全局默认）：
     *   inherit = 跟随系统设置里的全局默认策略
     *   visible = 强制公开（即使全局默认是模糊/隐藏）
     *   blur    = 前台模糊展示（只给经过处理的模糊图，原片一律不出口）
     *   hidden  = 前台完全不出现（对匿名者按「不存在」处理）
     */
    privacy: text('privacy').notNull().default('inherit'),
    /** 单张独立查看密码的 bcrypt 哈希；为空表示这张未单独设密码（只认全局密码 / 授权账号 / 分享链接） */
    privacyPasswordHash: text('privacy_password_hash'),
    /** 软删除标记：后台删除不物理删除文件，只打标（资源管理「软删除」） */
    deleted: boolean('deleted').notNull().default(false),
    /**
     * 保留列：早期「自动打标」功能遗留的进度字段，现已不再写入。
     * 为免无谓迁移暂不删除（当前恒为 NULL / 0）。
     */
    taggedAt: timestamp('tagged_at', { withTimezone: true }),
    tagAttempts: integer('tag_attempts').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index('media_capture_at_idx').on(table.captureAt)],
);

/** EXIF：一行对应一张照片（1:1，media_id 同时是主键与外键） */
export const exifMetadata = pgTable('exif_metadata', {
  mediaId: text('media_id')
    .primaryKey()
    .references(() => media.id, { onDelete: 'cascade' }),
  cam: text('cam'),
  lens: text('lens'),
  focal: text('focal'),
  aperture: text('aperture'),
  iso: integer('iso'),
  speed: text('speed'),
  temp: text('temp'),
  wb: text('wb'),
  /**
   * 拍摄地点：把下面的 gps_lat / gps_lon 反解成可读地名（如「广东省深圳市南山区」）后落库。
   * 【为什么要专门存一列而不是每次现解】反解要调高德、有配额与延迟；照片的定位极少变动，
   * 解一次存下来即可 —— 读接口因此不必等网络，地图在外网不可达时旧地名也仍在。
   */
  place: text('place'),
  /** GPS 纬度（WGS-84，南纬为负）。单独建列而非塞 extra：地图选点与「附近照片」都要能查询 */
  gpsLat: doublePrecision('gps_lat'),
  /** GPS 经度（WGS-84，西经为负） */
  gpsLon: doublePrecision('gps_lon'),
  /** 海拔（米） */
  gpsAlt: doublePrecision('gps_alt'),
  /**
   * 全量可编辑 EXIF 的原始值（键 = exiftool 短名，值 = -n 口径的字符串）。
   * 【为什么用 jsonb 而不是逐字段建列】可编辑 tag 有 40+ 个且会随需求增删，
   * 逐列建表意味着每加一个参数就要一次迁移；上面的展示列（cam/lens/...）是
   * 前台卡片真正消费的字段，保留为实列以便索引与排序，其余一律落在这里。
   */
  extra: jsonb('extra').$type<Record<string, string>>(),
});

/** 标签：id 直接取标签名（天然去重，省一次反查） */
export const tags = pgTable('tags', {
  id: text('id').primaryKey(),
  name: text('name').notNull().unique(),
});

/**
 * 照片 ↔ 标签 多对多。
 *
 * 【为什么来源与置信度挂在关联行上，而不是 tags 表】「沙发」这个词可能在这张照片
 * 是人工打的、在另一张是 AI 认出来的 —— 来源是「这枚标签与这张照片的关系」，
 * 不是词本身的属性，挂到 tags 上会把两种来源搅成一种。
 */
export const mediaTags = pgTable(
  'media_tags',
  {
    mediaId: text('media_id')
      .notNull()
      .references(() => media.id, { onDelete: 'cascade' }),
    tagId: text('tag_id')
      .notNull()
      .references(() => tags.id, { onDelete: 'cascade' }),
    /** manual = 人工打的（含改造前的存量数据）；ai = 模型识别 */
    source: text('source').notNull().default('manual'),
    /** AI 识别的置信度（0~100）；人工标签没有这个概念，恒为 NULL */
    confidence: real('confidence'),
    /**
     * 审核态：approved 直接生效 / pending 待人工裁决 / rejected 已丢弃。
     * 【为什么 rejected 要留行而不是删掉】删了的话，下一次重新打标会把它原样写回来，
     * 待审队列永远清不干净。留着这一行才能表达「用户否过这一枚，别再问」。
     */
    reviewStatus: text('review_status').notNull().default('approved'),
    /** 这枚标签的落库时间（人工重新编辑标签时会随重建刷新） */
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.mediaId, table.tagId] })],
);

/* --------------------------------------------------------------------------
 * 账号与 RBAC（M2）：users → roles → permissions，用户经角色获得权限
 * -------------------------------------------------------------------------- */

/** 角色：id 直接取角色名（admin / editor / viewer），天然去重 */
export const roles = pgTable('roles', {
  id: text('id').primaryKey(),
  name: text('name').notNull().unique(),
});

/** 权限点：如 photo:write / photo:delete，粒度为「动作」 */
export const permissions = pgTable('permissions', {
  id: text('id').primaryKey(),
  name: text('name').notNull().unique(),
});

/** 角色 ↔ 权限 多对多 */
export const rolePermissions = pgTable(
  'role_permissions',
  {
    roleId: text('role_id')
      .notNull()
      .references(() => roles.id, { onDelete: 'cascade' }),
    permissionId: text('permission_id')
      .notNull()
      .references(() => permissions.id, { onDelete: 'cascade' }),
  },
  (table) => [primaryKey({ columns: [table.roleId, table.permissionId] })],
);

/** 用户：密码只存 bcrypt 哈希，绝不存明文 */
export const users = pgTable('users', {
  id: text('id').primaryKey(),
  username: text('username').notNull().unique(),
  passwordHash: text('password_hash').notNull(),
  roleId: text('role_id')
    .notNull()
    .references(() => roles.id),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

/* --------------------------------------------------------------------------
 * 分类目录与相册（M2 动态化）：把原先写死在前端的分类 / 影集搬进数据库，
 * 后台可增删改，前台拉取渲染。
 * -------------------------------------------------------------------------- */

/**
 * 分类：与 media.category 以「名称文本」关联（故意不建外键）。
 * 【为什么不建外键】media.category 里已经存着历史数据的分类名，改成 id 关联需要
 * 一次数据迁移；这里保持 text 关联，改名时由服务层在**同一事务**里同步 media.category。
 */
export const categories = pgTable('categories', {
  /** 稳定 slug：取名称的稳定哈希（见 apps/api/src/catalog/ids.ts），不用中文当主键 */
  id: text('id').primaryKey(),
  /** 分类名，与 media.category 的值一一对应（如「风光」） */
  name: text('name').notNull().unique(),
  /** 前台筛选条的展示顺序，越小越靠前 */
  sortOrder: integer('sort_order').notNull().default(0),
});

/**
 * 相册分组：前台「影集」页的一级归集（一个分组下挂若干个相册）。
 *
 * 【为什么是独立一张表而不是 albums 上的一个文本列】分组自己有名字、排序权重、创建时间，
 * 且要被前台当导航条单独列出；做成文本列会让「分组改名」变成一次跨表批量 UPDATE。
 */
export const albumGroups = pgTable('album_groups', {
  /** 稳定 slug：取分组名的稳定哈希（见 apps/api/src/catalog/ids.ts） */
  id: text('id').primaryKey(),
  /** 分组名，全局唯一 */
  name: text('name').notNull().unique(),
  /** 前台导航条的展示顺序，越小越靠前（后台拖拽排序写回此列） */
  sortOrder: integer('sort_order').notNull().default(0),
  /**
   * 内置标记：仅「默认分组」为 true。
   * 【为什么需要它】删除分组时相册必须有个去处，因此默认分组不能被删掉 ——
   * 这一列就是「不可删」的判定依据，也让前端能据此隐藏删除按钮。
   */
  builtin: boolean('builtin').notNull().default(false),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

/**
 * 相册：一组照片的归集（对应原前端的 ALBUM_DEFS）。
 * 【分组关系是一对多】一个相册只属于一个分组（group_id 一列即可），
 * 删除分组时由服务层在同一事务里把册迁走，因此外键给了 SET NULL 只是保底。
 */
export const albums = pgTable('albums', {
  id: text('id').primaryKey(),
  title: text('title').notNull(),
  description: text('description'),
  /** 自定义封面；未设置时前台回退到相册内第一张（onDelete set null：照片被删不清空整册） */
  coverMediaId: text('cover_media_id').references(() => media.id, { onDelete: 'set null' }),
  /** 所属分组；为空视为「默认分组」（服务层会补上，正常不会有空值） */
  groupId: text('group_id').references(() => albumGroups.id, { onDelete: 'set null' }),
  /** 是否公开可见 */
  isPublic: boolean('is_public').notNull().default(true),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

/** 相册 ↔ 照片 多对多：sortOrder 由「PUT /albums/:id/media」按数组下标全量重写 */
export const albumMedia = pgTable(
  'album_media',
  {
    albumId: text('album_id')
      .notNull()
      .references(() => albums.id, { onDelete: 'cascade' }),
    mediaId: text('media_id')
      .notNull()
      .references(() => media.id, { onDelete: 'cascade' }),
    sortOrder: integer('sort_order').notNull().default(0),
  },
  (table) => [primaryKey({ columns: [table.albumId, table.mediaId] })],
);

/**
 * 通用字典（M4）：一张表承载「机身型号 / 镜头型号 / 光圈 / 快门速度 / 感光度」等
 * 全部可枚举字段的候选值，供前后台搜索框做下拉选择与实时联想。
 *
 * 【为什么是一张 kind + value 的通用表，而不是每类一张】
 * 字典种类会持续增加（以后还可能有「白平衡 / 色彩空间 / 拍摄模式」），
 * 每加一类就建一张表意味着一次迁移 + 一套 CRUD + 一套接口；这里只有 kind 在变，
 * 读、写、联想、整理四段逻辑全部共用。
 *
 * 【为什么还要 meta 这一列 jsonb】kind+value 只够「列出来」，不够「排对序」：
 * 光圈 f/2 → f/32、快门 1/8000 → 30"、ISO 50 → 102400 都必须按数值排，
 * 而机身/镜头是纯文本序。把数值口径放进 meta.order，排序、归位、与「还没有
 * 解析结果的新值」的先后关系就都有依据了，且以后加类型无需改表结构。
 */
export const dictionary = pgTable(
  'dictionary',
  {
    /** 稳定 id：kind + value 的稳定哈希（见 ids.ts），重复整理天然幂等 */
    id: text('id').primaryKey(),
    /** 字典类型：camera / lens / aperture / shutter / iso（可继续扩展） */
    kind: text('kind').notNull(),
    /** 值本体：同时用于搜索匹配（如 "NIKON Z 7_2" / "f/2.8" / "1/250" / "400"） */
    value: text('value').notNull(),
    /** 展示文案；为空时前端回落到 value */
    label: text('label'),
    /** 展示顺序：数值类按数值大小铺，文本类按整理时的字序铺 */
    sortOrder: integer('sort_order').notNull().default(0),
    /** 类型专属信息：目前是 { order: number }（数值口径，用于排序与比较） */
    meta: jsonb('meta').$type<Record<string, unknown>>(),
    /** 是否内置标准档位：内置值不会被「整理」删除（曝光三要素的常用档） */
    builtin: boolean('builtin').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // 同一类型下值唯一：整理脚本反复执行只会命中原行，不会堆出重复候选项
    uniqueIndex('dictionary_kind_value_idx').on(table.kind, table.value),
    index('dictionary_kind_idx').on(table.kind),
  ],
);

/** 表形态导出：供 Drizzle 触发类型推断与 join 使用 */
export type MediaRow = typeof media.$inferSelect;
export type MediaInsert = typeof media.$inferInsert;
export type ExifRow = typeof exifMetadata.$inferSelect;
export type UserRow = typeof users.$inferSelect;
export type UserInsert = typeof users.$inferInsert;
export type CategoryRow = typeof categories.$inferSelect;
export type AlbumRow = typeof albums.$inferSelect;
export type AlbumInsert = typeof albums.$inferInsert;
export type AlbumGroupRow = typeof albumGroups.$inferSelect;
export type AlbumGroupInsert = typeof albumGroups.$inferInsert;
export type SettingRow = typeof settings.$inferSelect;
export type DictionaryRow = typeof dictionary.$inferSelect;
export type DictionaryInsert = typeof dictionary.$inferInsert;
export type PrivacyShareRow = typeof privacyShares.$inferSelect;
export type AuditLogRow = typeof auditLogs.$inferSelect;

/* --------------------------------------------------------------------------
 * 操作审计（M3）：后台的每一次写操作留一条记录。
 *
 * 【为什么要真的落库，而不是只打日志】「谁在什么时候把哪张照片改成了私有」这类问题
 * 事后必须答得出来；进程日志会随容器重建丢失，因此落成一行数据。
 * 【为什么不在表里存请求体】请求体可能含密码等敏感内容，且体积不可控 ——
 * 只记「谁 / 做了什么动作 / 结果如何」，需要细节时按时间点回查应用日志。
 * -------------------------------------------------------------------------- */
export const auditLogs = pgTable(
  'audit_logs',
  {
    id: serial('id').primaryKey(),
    /** 操作者用户名；未登录（理论上不该有写操作）为 null */
    actor: text('actor'),
    /** HTTP 方法（POST / PATCH / PUT / DELETE） */
    method: text('method').notNull(),
    /** 请求路径（含 query 以外的部分） */
    path: text('path').notNull(),
    /** 响应状态码：>= 400 即「尝试失败」，同样要留痕 */
    status: integer('status').notNull(),
    at: timestamp('at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index('audit_logs_at_idx').on(table.at)],
);

/* --------------------------------------------------------------------------
 * 系统设置（M3）：一张「键 → 值」的通用设置表。
 * 【为什么不做成每个设置一列】设置项会随需求不断增删（隐私默认策略、授权角色、
 * 全局密码哈希、站点标题…），逐项建列意味着每加一项就要一次迁移；
 * 这里统一存文本，读取侧由一个 SettingsService 负责解析与默认值保底。
 * -------------------------------------------------------------------------- */
export const settings = pgTable('settings', {
  /** 设置键，如 privacy.defaultMode / privacy.accessRoles / privacy.passwordHash */
  key: text('key').primaryKey(),
  value: text('value').notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

/**
 * 隐私照片的时效分享链接（可选带提取码，即「分享链接 + 提取码」双重校验）。
 * 【为什么存 mediaIds 数组而不是另建关联表】一条分享链接就是「一次性授权给这一批照片」，
 * 它本身是短生命周期对象、不需要按照片反查，数组更省一次 join。
 */
export const privacyShares = pgTable('privacy_shares', {
  /** 随机 token（同时也是主键）：URL 里出现的就是它，不用自增 id 以免被顺序猜出 */
  id: text('id').primaryKey(),
  /** 被授权的照片 id 列表 */
  mediaIds: jsonb('media_ids').$type<string[]>().notNull(),
  /** 提取码（4~6 位数字）；为空表示这条链接不带提取码 */
  accessCode: text('access_code'),
  /** 失效时刻（含）；过期即视为不存在 */
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  /** 撤销标记：后台「立即失效」用，保留记录便于追溯 */
  revoked: boolean('revoked').notNull().default(false),
  /** 创建者用户名（审计用） */
  createdBy: text('created_by'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});