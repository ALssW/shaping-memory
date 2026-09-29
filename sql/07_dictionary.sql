-- ============================================================
-- 07_dictionary.sql —— 通用字典（可枚举字段的候选值）
-- ------------------------------------------------------------
-- 【依赖】无
-- 【对应代码】packages/db/src/schema.ts → dictionary
-- 【初始数据】内置标准档位（光圈 / 快门 / 感光度的常用值）由服务层按需铺设，
--             见 apps/api/src/dictionary/dictionary.service.ts 的 ensurePresets()，
--             无需单独的种子脚本。字典内容亦可由后台「整理」按钮触发重建。
-- ============================================================

-- 通用字典：一张表承载「机身型号 / 镜头型号 / 光圈 / 快门速度 / 感光度」等
-- 全部可枚举字段的候选值，供前后台搜索框做下拉选择与实时联想。
--
-- 【为什么是一张 kind + value 的通用表，而不是每类一张】字典种类会持续增加
--   （以后还可能有「白平衡 / 色彩空间 / 拍摄模式」），每加一类就建一张表意味着
--   一次迁移 + 一套 CRUD + 一套接口；这里只有 kind 在变，读、写、联想、整理四段
--   逻辑全部共用。
CREATE TABLE public.dictionary (
    id text NOT NULL,                                    -- 稳定 slug：kind + value 的稳定哈希，重复整理天然幂等
    kind text NOT NULL,                                  -- 字典类型：camera / lens / aperture / shutter / iso（可继续扩展）
    value text NOT NULL,                                 -- 值本体，同时用于搜索匹配（如 "NIKON Z 7_2" / "f/2.8" / "1/250" / "400"）
    label text,                                          -- 展示文案；为空时前端回落到 value
    sort_order integer DEFAULT 0 NOT NULL,               -- 展示顺序：数值类按数值大小铺，文本类按整理时的字序铺
    meta jsonb,                                          -- 类型专属信息：目前是 { order: number }（数值口径，用于排序与比较）
    builtin boolean DEFAULT false NOT NULL,              -- 是否内置标准档位：内置值不会被「整理」删除
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE ONLY public.dictionary
    ADD CONSTRAINT dictionary_pkey PRIMARY KEY (id);

-- 同一类型下值唯一：整理脚本反复执行只会命中原行，不会堆出重复候选项
CREATE UNIQUE INDEX dictionary_kind_value_idx ON public.dictionary USING btree (kind, value);

-- 按类型取候选值的访问路径（下拉联想与整理都只查单一 kind）
CREATE INDEX dictionary_kind_idx ON public.dictionary USING btree (kind);