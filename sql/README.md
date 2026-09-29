# sql —— 数据库表结构脚本

本项目 PostgreSQL 的表结构定义。脚本取自线上库的真实结构（`pg_dump --schema-only`），
与 `packages/db/src/schema.ts` 的 Drizzle 定义一一对应，包含完整的建表语句、字段定义、索引与约束。

## 执行顺序

文件按 `数字_模块.sql` 命名，**必须按编号顺序执行**（外键依赖靠前模块）：

| 顺序 | 文件 | 内容 | 依赖 |
| --- | --- | --- | --- |
| 0 | [00_bootstrap.sql](00_bootstrap.sql) | 建库 + 应用账号 + schema 授权（新环境执行一次） | — |
| 1 | [01_media.sql](01_media.sql) | `media`（照片主表）、`exif_metadata` | — |
| 2 | [02_tags.sql](02_tags.sql) | `tags`、`media_tags` | 01 |
| 3 | [03_auth_rbac.sql](03_auth_rbac.sql) | `roles`、`permissions`、`role_permissions`、`users` | — |
| 4 | [04_catalog.sql](04_catalog.sql) | `categories`、`album_groups`、`albums`、`album_media` | 01 |
| 5 | [05_privacy_shares.sql](05_privacy_shares.sql) | `privacy_shares` | — |
| 6 | [06_system.sql](06_system.sql) | `settings`、`audit_logs` | — |
| 7 | [07_dictionary.sql](07_dictionary.sql) | `dictionary`（可枚举字段的候选值） | — |

## 怎么用

两条路径二选一，目标都是把空库建成完整结构：

**路径 A：迁移驱动（推荐）** —— 读 [packages/db/drizzle/](../packages/db/drizzle/) 下的迁移记录，已应用的自动跳过：

```bash
npm run db:migrate
```

**路径 B：手工脚本** —— 不依赖 Node，按编号顺序逐文件执行：

```bash
# 建库与账号（首次，需要超管）
psql -h 127.0.0.1 -U postgres -f sql/00_bootstrap.sql

# 建表（用应用账号执行，1→7 顺序）
for f in sql/0[1-7]_*.sql; do psql -h 127.0.0.1 -U shaping -d shaping_memory -f "$f"; done
```

> 日常开发**不必手工跑这些脚本**：改完 `packages/db/src/schema.ts` 直接 `npm run db:push` 即可
> （Drizzle 会比对并补齐差异）。本目录的用途是「换环境时从零重建」与「结构留档」。

## 建表之后

结构建好仍是空库，还需要写入初始数据：

```bash
npm run db:seed          # 角色 / 权限 / 初始管理员账号（幂等，可反复执行）
npm run db:seed:catalog  # 分类与相册初始数据
npm run import:photos    # 扫描 PHOTO_SOURCE_DIR 导入照片
```

## 约定与注意事项

- **分类是文本关联**：`media.category` 与 `categories.name` 故意不建外键，改名时由服务层在同一事务里同步两处。
- **口令与密码**：`users.password_hash`、`media.privacy_password_hash` 只存 bcrypt 哈希；
  `privacy_shares.access_code` 是明文短数字，其授权强度来自「不可猜的 token + 有效期」，因此该表只允许后端读取。
- **软删除**：`media.deleted` 为真即视为已删除，物理文件不动，所有业务查询都要带上 `deleted = false`。
- **实况照片**：`media.live_video_path` 非空即代表这张是实况照片，不另建布尔列。
- 脚本中不含任何真实口令 —— `00_bootstrap.sql` 建的是无密码角色，口令请在服务器上手工 `ALTER ROLE` 设置。

## 结构变更与升级

结构变更的唯一事实源是 `packages/db/src/schema.ts`，迁移记录在 `packages/db/drizzle/`。

| 场景 | 做法 |
| --- | --- |
| 日常开发 | 改 `schema.ts` 后 `npm run db:push`，由 Drizzle 比对并补齐差异 |
| 变更留档 | `npm run db:generate` 生成一条增量迁移（`drizzle/000N_*.sql`），与代码一并提交 |
| 升级已有环境 | `npm run db:migrate`，按 `meta/_journal.json` 顺序应用尚未执行的迁移 |

**已有库如何接入迁移管理**：`0000_init.sql` 是覆盖全部既有结构的基线迁移，对「结构已经建好」的库
直接执行会因表已存在而报错。此时把基线登记为「已应用」即可，之后便能正常增量升级 ——
迁移器判定「是否已应用」的依据是 `drizzle.__drizzle_migrations` 里最后一条记录的 `created_at`
与迁移的 `when` 时间戳（见 `drizzle-orm` 的 `pg-core/dialect` 实现），因此登记脚本为：

```sql
CREATE SCHEMA IF NOT EXISTS drizzle;
CREATE TABLE IF NOT EXISTS drizzle.__drizzle_migrations (
    id serial PRIMARY KEY, hash text NOT NULL, created_at bigint
);
-- hash 取基线文件的 sha256，created_at 取 meta/_journal.json 里该条的 when
INSERT INTO drizzle.__drizzle_migrations (hash, created_at)
VALUES (
    '<0000_init.sql 的 sha256>',
    1790654794679
);

-- 在仓库根执行下面这行取 hash：
-- node -e "console.log(require('crypto').createHash('sha256').update(require('fs').readFileSync('packages/db/drizzle/0000_init.sql','utf8')).digest('hex'))"
```