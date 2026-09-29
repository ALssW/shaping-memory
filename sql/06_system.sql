-- ============================================================
-- 06_system.sql —— 系统设置与操作审计
-- ------------------------------------------------------------
-- 【依赖】无
-- 【对应代码】packages/db/src/schema.ts → settings / auditLogs
-- ============================================================

-- 系统设置：一张「键 → 值」的通用表
-- 【为什么不做成每个设置一列】设置项会随需求不断增删（隐私默认策略、授权角色、
-- 全局密码哈希、站点标题…），逐项建列意味着每加一项就要一次迁移。
CREATE TABLE public.settings (
    key text NOT NULL,                                          -- 如 site.title / privacy.passwordHash
    value text NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE ONLY public.settings
    ADD CONSTRAINT settings_pkey PRIMARY KEY (key);


-- 操作审计：后台的每一次写操作留一条记录
-- 【为什么不存请求体】请求体可能含密码等敏感内容且体积不可控；
--   只记「谁 / 做了什么动作 / 结果如何」，需要细节时按时间点回查应用日志。
--   path 入库前已剥掉 query —— 隐私票据（?pt=）与提取码都在 query 里。
CREATE TABLE public.audit_logs (
    id integer NOT NULL,
    actor text,                                                 -- 操作者用户名；未登录请求为 null
    method text NOT NULL,                                       -- POST / PATCH / PUT / DELETE
    path text NOT NULL,                                         -- 请求路径（不含 query）
    status integer NOT NULL,                                    -- 响应状态码，>= 400 即「尝试失败」也留痕
    at timestamp with time zone DEFAULT now() NOT NULL
);

-- 自增序列：与 audit_logs.id 绑定，随表删除一并回收
CREATE SEQUENCE public.audit_logs_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.audit_logs_id_seq OWNED BY public.audit_logs.id;

ALTER TABLE ONLY public.audit_logs
    ALTER COLUMN id SET DEFAULT nextval('public.audit_logs_id_seq'::regclass);

ALTER TABLE ONLY public.audit_logs
    ADD CONSTRAINT audit_logs_pkey PRIMARY KEY (id);

-- 日志一律按时间倒序翻页，这条索引是唯一被用到的访问路径
CREATE INDEX audit_logs_at_idx ON public.audit_logs USING btree (at);