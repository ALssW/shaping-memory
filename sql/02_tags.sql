-- ============================================================
-- 02_tags.sql —— 标签与照片标签关联
-- ------------------------------------------------------------
-- 【依赖】01_media.sql（media_tags.media_id 引用 media）
-- 【对应代码】packages/db/src/schema.ts → tags / mediaTags
-- ============================================================

-- 标签：id 直接取标签名（天然去重，省去一次反查）
CREATE TABLE public.tags (
    id text NOT NULL,
    name text NOT NULL
);

ALTER TABLE ONLY public.tags
    ADD CONSTRAINT tags_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.tags
    ADD CONSTRAINT tags_name_unique UNIQUE (name);


-- 照片 ↔ 标签 多对多
-- 【为什么来源与置信度挂在关联行上，而不是 tags 表】「沙发」这个词可能在这张照片是人工打的、
--   在另一张是 AI 认出来的 —— 来源是「这枚标签与这张照片的关系」，不是词本身的属性。
CREATE TABLE public.media_tags (
    media_id text NOT NULL,
    tag_id text NOT NULL,
    source text DEFAULT 'manual'::text NOT NULL,           -- manual = 人工打的（含改造前的存量数据）；ai = 模型识别
    confidence real,                                       -- AI 识别的置信度（0~100）；人工标签没有这个概念，恒为 NULL
    review_status text DEFAULT 'approved'::text NOT NULL,  -- approved 直接生效 / pending 待人工裁决 / rejected 已丢弃
    created_at timestamp with time zone DEFAULT now() NOT NULL  -- 这枚标签的落库时间（人工重新编辑标签时随重建刷新）
);

-- 【为什么 rejected 要留行而不是删掉】删了的话，下一次重新打标会把它原样写回来，待审队列永远清不干净；
--   留着这一行才能表达「用户否过这一枚，别再问」。

ALTER TABLE ONLY public.media_tags
    ADD CONSTRAINT media_tags_media_id_tag_id_pk PRIMARY KEY (media_id, tag_id);

ALTER TABLE ONLY public.media_tags
    ADD CONSTRAINT media_tags_media_id_media_id_fk FOREIGN KEY (media_id)
    REFERENCES public.media(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.media_tags
    ADD CONSTRAINT media_tags_tag_id_tags_id_fk FOREIGN KEY (tag_id)
    REFERENCES public.tags(id) ON DELETE CASCADE;