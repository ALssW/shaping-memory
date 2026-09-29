-- ============================================================
-- 01_media.sql —— 照片主表与 EXIF
-- ------------------------------------------------------------
-- 【依赖】无 —— 本模块是其余模块的基础，必须最先执行。
-- 【对应代码】packages/db/src/schema.ts → media / exifMetadata
-- ============================================================

-- 照片主表：一行 = 一张照片
CREATE TABLE public.media (
    id text NOT NULL,                                      -- 稳定 id：源文件名的稳定哈希（导入幂等，重复导入不新增行）
    title text NOT NULL,                                   -- 展示标题
    original_name text,                                    -- 上传时的原始文件名（含扩展名）；批量导入无此信息时为 NULL。media.id 取自带随机前缀的落盘名，故需要它来判断「文件以前是否传过」
    original_size bigint,                                  -- 上传时的原始字节数；与 original_name 一起构成「同名文件」判定键（同名同大小）
    description text,                                      -- 描述正文（纯文本，保留换行）；为空即「没写」，前台在查看器的拍摄信息里整段展示
    category text NOT NULL,                                -- 分类名；与 categories.name 文本关联（故意不建外键，改名由服务层同事务同步）
    format text NOT NULL,                                  -- 展示用格式名 JPG / PNG（由 EXIF FileType 归一）
    capture_at date,                                       -- 拍摄日期（分组/排序/进度轨读取用）
    taken_at timestamp with time zone,                     -- 精确拍摄时间
    width integer,                                         -- 原始宽度
    height integer,                                        -- 原始高度
    orientation text DEFAULT 'landscape'::text NOT NULL,   -- landscape / portrait，决定瀑布流占位比例
    source_path text NOT NULL,                             -- 原片在本机文件系统上的路径
    thumb_path text,                                       -- 缩略图路径，未生成时为空
    likes integer DEFAULT 0 NOT NULL,                      -- 点赞数
    created_at timestamp with time zone DEFAULT now() NOT NULL,  -- 入库时间
    deleted boolean DEFAULT false NOT NULL,                -- 软删除标记（不物理删文件）
    live_video_path text,                                  -- 实况照片内嵌视频路径；非空即视为实况照片（无需另建布尔列）
    privacy text DEFAULT 'inherit'::text NOT NULL,         -- inherit / visible / blur / hidden（单张覆盖全局默认）
    privacy_password_hash text                             -- 单张独立查看密码的 bcrypt 哈希；为空表示未单独设密码
);

ALTER TABLE ONLY public.media
    ADD CONSTRAINT media_pkey PRIMARY KEY (id);

-- 时间线/分组查询的主路径：按拍摄日期过滤与排序
CREATE INDEX media_capture_at_idx ON public.media USING btree (capture_at);


-- EXIF：一行对应一张照片（1:1，media_id 同时是主键与外键）
CREATE TABLE public.exif_metadata (
    media_id text NOT NULL,          -- 与 media.id 一一对应
    cam text,                        -- 机身型号
    lens text,                       -- 镜头型号
    focal text,                      -- 焦距（展示口径，如 35mm）
    aperture text,                   -- 光圈（展示口径，如 f/4.0）
    iso integer,                     -- 感光度
    speed text,                      -- 快门速度
    temp text,                       -- 色温（如 5226K）
    wb text,                         -- 白平衡
    gps_lat double precision,        -- GPS 纬度（WGS-84，南纬为负）
    gps_lon double precision,        -- GPS 经度（WGS-84，西经为负）
    gps_alt double precision,        -- 海拔（米）
    extra jsonb                      -- 其余 40+ 个可编辑 tag 的原始值（键 = exiftool 短名）
);

ALTER TABLE ONLY public.exif_metadata
    ADD CONSTRAINT exif_metadata_pkey PRIMARY KEY (media_id);

-- 照片被删（含物理删）时，EXIF 一并消失
ALTER TABLE ONLY public.exif_metadata
    ADD CONSTRAINT exif_metadata_media_id_media_id_fk FOREIGN KEY (media_id)
    REFERENCES public.media(id) ON DELETE CASCADE;