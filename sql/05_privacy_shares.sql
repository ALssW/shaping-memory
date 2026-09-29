-- ============================================================
-- 05_privacy_shares.sql —— 隐私照片的时效分享链接
-- ------------------------------------------------------------
-- 【依赖】无外键（media_ids 以 jsonb 数组存，不建关联表，见下）
-- 【对应代码】packages/db/src/schema.ts → privacyShares
-- 【安全提醒】本表存的是「一条链接能看哪几张 + 提取码 + 失效时刻」：
--   提取码为明文短数字（4~6 位），本身不是凭据强度的保证，
--   真正的授权来自 unguessable 的 token 主键 + 有效期，两者叠加使用。
--   因此本表内容不可对外暴露，只允许后端服务读取。
-- ============================================================

CREATE TABLE public.privacy_shares (
    id text NOT NULL,                                     -- 随机 token（同时也是主键）；用自增会被顺序猜出
    media_ids jsonb NOT NULL,                             -- 被授权的照片 id 数组
    access_code text,                                     -- 提取码（4~6 位数字）；为空表示该链接不带提取码
    expires_at timestamp with time zone NOT NULL,         -- 失效时刻（含），过期即视为不存在
    revoked boolean DEFAULT false NOT NULL,               -- 撤销标记；保留记录便于追溯
    created_by text,                                      -- 创建者用户名（审计用）
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE ONLY public.privacy_shares
    ADD CONSTRAINT privacy_shares_pkey PRIMARY KEY (id);

-- 【为什么不建 media_ids 关联表】一条分享链接就是「一次性授权给这一批照片」，
-- 它本身是短生命周期对象、不需要按照片反查，数组省掉一次 join。