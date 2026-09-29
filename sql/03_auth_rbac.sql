-- ============================================================
-- 03_auth_rbac.sql —— 账号与 RBAC
-- ------------------------------------------------------------
-- 【依赖】无（但建议在 01/02 之后执行，保持阅读顺序）
-- 【对应代码】packages/db/src/schema.ts → roles / permissions / rolePermissions / users
-- 【初始数据】角色与权限的取值由 apps/api/src/seed-admin.ts 写入，见 `npm run db:seed`。
--   口令只存 bcrypt 哈希（password_hash），任何接口与日志都不会吐出明文。
-- ============================================================

-- 角色：id 直接取角色名（admin / editor / viewer）
CREATE TABLE public.roles (
    id text NOT NULL,
    name text NOT NULL
);

ALTER TABLE ONLY public.roles
    ADD CONSTRAINT roles_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.roles
    ADD CONSTRAINT roles_name_unique UNIQUE (name);


-- 权限点：粒度为「动作」，如 photo:read / photo:write / photo:delete
CREATE TABLE public.permissions (
    id text NOT NULL,
    name text NOT NULL
);

ALTER TABLE ONLY public.permissions
    ADD CONSTRAINT permissions_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.permissions
    ADD CONSTRAINT permissions_name_unique UNIQUE (name);


-- 角色 ↔ 权限 多对多
CREATE TABLE public.role_permissions (
    role_id text NOT NULL,
    permission_id text NOT NULL
);

ALTER TABLE ONLY public.role_permissions
    ADD CONSTRAINT role_permissions_role_id_permission_id_pk PRIMARY KEY (role_id, permission_id);

ALTER TABLE ONLY public.role_permissions
    ADD CONSTRAINT role_permissions_role_id_roles_id_fk FOREIGN KEY (role_id)
    REFERENCES public.roles(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.role_permissions
    ADD CONSTRAINT role_permissions_permission_id_permissions_id_fk FOREIGN KEY (permission_id)
    REFERENCES public.permissions(id) ON DELETE CASCADE;


-- 用户：密码只存 bcrypt 哈希
CREATE TABLE public.users (
    id text NOT NULL,
    username text NOT NULL,
    password_hash text NOT NULL,
    role_id text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_username_unique UNIQUE (username);

-- 注意：这里没有 ON DELETE CASCADE —— 还有用户在用的角色不允许被删除
ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_role_id_roles_id_fk FOREIGN KEY (role_id)
    REFERENCES public.roles(id);