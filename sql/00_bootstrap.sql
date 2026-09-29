-- ============================================================
-- 00_bootstrap.sql —— 数据库与账号初始化
-- ------------------------------------------------------------
-- 【何时执行】只在新建一套环境时执行一次；已有库不要重复跑。
-- 【为什么不带口令】仓库里绝不出现任何口令，因此下面建的是「无密码登录角色」，
--   口令请在服务器上手工设置（不进仓库）：
--     ALTER ROLE shaping WITH PASSWORD '<强口令>';
-- 【执行方式】
--     psql -h 127.0.0.1 -U postgres -f sql/00_bootstrap.sql
-- ============================================================

-- 应用专用账号：不用超管跑业务（最小权限原则）。
-- 先建角色再建库，才能让库的 owner 直接是它。
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'shaping') THEN
        CREATE ROLE shaping LOGIN;
    END IF;
END
$$;

-- 数据库：owner 交给应用账号，之后所有表都由它创建（本项目按 public schema 使用）
-- 注：CREATE DATABASE 不能放在事务块里，因此这里用 \gexec 的方式判断存在性。
SELECT 'CREATE DATABASE shaping_memory OWNER shaping'
WHERE NOT EXISTS (SELECT 1 FROM pg_database WHERE datname = 'shaping_memory')
\gexec

-- public schema 的建表权限（PG 15+ 默认收紧了 public schema 的写权限）
\connect shaping_memory
GRANT ALL ON SCHEMA public TO shaping;
ALTER SCHEMA public OWNER TO shaping;