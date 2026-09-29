-- ============================================================
-- 04_catalog.sql —— 分类目录 / 相册分组 / 相册
-- ------------------------------------------------------------
-- 【依赖】01_media.sql（albums.cover_media_id / album_media.media_id 引用 media）
-- 【对应代码】packages/db/src/schema.ts → categories / albumGroups / albums / albumMedia
-- 【初始数据】分类与相册由 `npm run db:seed:catalog` 写入，也可在后台增删改。
--             同一脚本会写入内置的「默认分组」（builtin = true）。
-- ============================================================

-- 分类：前台筛选条的数据源
CREATE TABLE public.categories (
    id text NOT NULL,                              -- 稳定 slug：取名称的稳定哈希（不用中文当主键）
    name text NOT NULL,                            -- 分类名，与 media.category 的取值一一对应
    sort_order integer DEFAULT 0 NOT NULL          -- 展示顺序，越小越靠前
);

ALTER TABLE ONLY public.categories
    ADD CONSTRAINT categories_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.categories
    ADD CONSTRAINT categories_name_unique UNIQUE (name);


-- 相册分组：前台「影集」页的一级归集（一个分组下挂若干个相册）
-- 「默认分组」由 seed:catalog 写入（builtin = true），它是删除分组时相册的回退去处，不可删除。
CREATE TABLE public.album_groups (
    id text NOT NULL,                              -- 稳定 slug：取分组名的稳定哈希
    name text NOT NULL,                            -- 分组名，全局唯一
    sort_order integer DEFAULT 0 NOT NULL,         -- 前台导航展示顺序，越小越靠前
    builtin boolean DEFAULT false NOT NULL,        -- 是否内置（仅「默认分组」为 true，不可删）
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE ONLY public.album_groups
    ADD CONSTRAINT album_groups_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.album_groups
    ADD CONSTRAINT album_groups_name_unique UNIQUE (name);


-- 相册：一组照片的归集
CREATE TABLE public.albums (
    id text NOT NULL,
    title text NOT NULL,
    description text,
    cover_media_id text,                                          -- 自定义封面；未设置时前台回退到册内第一张
    group_id text,                                                -- 所属分组（一对多）；删除分组时由服务层先迁册
    is_public boolean DEFAULT true NOT NULL,                      -- 是否对匿名可见
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE ONLY public.albums
    ADD CONSTRAINT albums_pkey PRIMARY KEY (id);

-- SET NULL 而非 CASCADE：封面照片被删不该把整册删掉
ALTER TABLE ONLY public.albums
    ADD CONSTRAINT albums_cover_media_id_media_id_fk FOREIGN KEY (cover_media_id)
    REFERENCES public.media(id) ON DELETE SET NULL;

-- SET NULL 仅是回退保障：正常删除分组前，服务层已在同一事务里把册迁到目标分组
ALTER TABLE ONLY public.albums
    ADD CONSTRAINT albums_group_id_album_groups_id_fk FOREIGN KEY (group_id)
    REFERENCES public.album_groups(id) ON DELETE SET NULL;


-- 相册 ↔ 照片 多对多：sort_order 由「PUT /albums/:id/media」按数组下标全量重写
CREATE TABLE public.album_media (
    album_id text NOT NULL,
    media_id text NOT NULL,
    sort_order integer DEFAULT 0 NOT NULL
);

ALTER TABLE ONLY public.album_media
    ADD CONSTRAINT album_media_album_id_media_id_pk PRIMARY KEY (album_id, media_id);

ALTER TABLE ONLY public.album_media
    ADD CONSTRAINT album_media_album_id_albums_id_fk FOREIGN KEY (album_id)
    REFERENCES public.albums(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.album_media
    ADD CONSTRAINT album_media_media_id_media_id_fk FOREIGN KEY (media_id)
    REFERENCES public.media(id) ON DELETE CASCADE;