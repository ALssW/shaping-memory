# 贡献指南

感谢您对**塑忆（shaping-memory）**的关注。本文说明如何搭建开发环境、遵循哪些约定、以及提交改动的完整流程。

开始之前请先阅读：

1. [`README.md`](./README.md) —— 功能范围、配置项、部署方式；
2. [`docs/塑忆产品设计方案.md`](./docs/塑忆产品设计方案.md) —— 产品定位与领域模型；
3. [`docs/设计语言-Token规范.md`](./docs/设计语言-Token规范.md) —— 界面视觉的唯一事实源。

---

## 一、可参与的方向

| 类型 | 说明 | 入口 |
| --- | --- | --- |
| 缺陷报告 | 功能异常、界面错位、兼容性问题 | Issue（请附复现步骤与环境信息） |
| 功能建议 | 新能力、体验改进 | Issue（请说明使用场景与预期行为） |
| 代码贡献 | 缺陷修复、功能实现、重构、测试 | Pull Request |
| 文档贡献 | 文档纠错、补充示例、翻译 | Pull Request（直接改 `docs/`） |
| 安全漏洞 | 涉及隐私照片、访问票据、密钥的问题 | **不要开公开 Issue**，见第八节 |

---

## 二、搭建开发环境

### 2.1 环境依赖

| 依赖 | 版本要求 | 说明 |
| --- | --- | --- |
| Node.js | ≥ 20 | npm workspaces 需要 Node ≥ 18 |
| npm | ≥ 10 | 仓库使用 workspaces，在根目录安装一次即可 |
| PostgreSQL | ≥ 14 | 表结构见 `sql/` |
| ExifTool | 13.x | 读写 EXIF、提取实况视频，需手工放置（见下） |
| JDK / Android SDK | 17 / Platform 34+ | 仅移动端打包需要 |

### 2.2 准备 ExifTool

`tools/` 下的 exiftool 发行版体积较大、**不入库**，需要手工放置：从 <https://exiftool.org/> 下载 Windows Executable 打包版，解压后把 `exiftool.exe` 与 `exiftool_files/` 放入本仓库的 `tools/` 目录。

> 该打包版按「当前工作目录」定位 `exiftool_files` 与 `perl532.dll`，因此调用方必须把工作目录设在 `tools/`（`packages/exif` 已处理）。直接用绝对路径调用会报 `code 126`。

### 2.3 初始化项目

```bash
# 1. 取代码并安装依赖（在仓库根执行一次，workspaces 会装齐所有包）
git clone <仓库地址> && cd shaping-memory
npm install

# 2. 配置环境变量（模板见 .env.example，所有必填项都需显式填写）
cp .env.example .env

# 3. 建表并写入初始数据（建表另有两条路径：执行 sql/ 脚本，或 npm run db:push）
npm run db:migrate       # 应用 packages/db/drizzle/ 下的迁移，已执行的自动跳过
npm run db:seed          # 角色 / 权限 / 初始管理员
npm run db:seed:catalog  # 分类与相册初始数据（可选）

# 4. 导入照片（扫描 PHOTO_SOURCE_DIR）
npm run import:photos
```

> 数据库部署在远程主机时，直接在 `.env` 的 `DATABASE_URL` 中填写远程地址即可，不需要 SSH 隧道。远程地址与密钥属于内部资产，**不要写入仓库**，文档与脚本中一律使用 `<REMOTE_HOST>` 占位。

### 2.4 启动服务

```bash
npm run dev:api     # → http://127.0.0.1:3000
npm run dev:web     # → http://localhost:5173   前台
npm run dev:admin   # → http://localhost:5174   后台
npm run start:mobile  # Expo 开发服务器
```

后台登录使用 `.env` 中的 `ADMIN_USERNAME` / `ADMIN_PASSWORD`。

---

## 三、仓库结构

```
shaping-memory/
├── apps/
│   ├── api/               后端 API（NestJS 模块化单体）
│   ├── web/               前台（React + Vite）
│   ├── admin/             后台（React + Vite + Ant Design）
│   └── mobile/            移动端（Expo / React Native）
├── packages/
│   ├── core/              领域模型与纯函数 —— 三端共用
│   ├── sdk/               统一 API 客户端 —— 三端共用
│   ├── db/                Drizzle 表定义、客户端与迁移记录
│   ├── config/            环境变量校验（zod）
│   ├── exif/              exiftool 封装
│   ├── image/             Sharp 图像处理
│   ├── storage/           存储适配层（本地文件系统 / S3 兼容）
│   └── design-tokens/     设计 Token 与主题 CSS（唯一色彩字体来源）
├── docs/                  产品设计方案与设计规范
├── sql/                   数据库表结构脚本（换环境从零重建用）
├── tools/                 第三方工具程序（exiftool，不入库）
└── data/                  运行时生成物（不入库）
```

**依赖方向（改动时务必遵守）**：

- `core` 不依赖任何其它包；
- `sdk` 与 `api` 都依赖 `core`；
- `sdk` **不得**依赖 `api`。

---

## 四、开发约定

| 约定 | 要求 |
| --- | --- |
| 语言 | 代码注释、提交信息、界面文案统一使用中文 |
| 类型 | `strict` 全开，禁止 `any`；新增依赖前先确认 `packages/` 中是否已有等价能力 |
| 图片地址 | 前端一律使用后端下发的 `url` / `cardUrl` / `originalUrl`，不自行拼接 |
| 设计取值 | 颜色、字体、间距一律取自 `packages/design-tokens`，`npm run check:tokens` 会拦截硬编码 |
| 配置项 | 所有配置必须显式声明并经 `packages/config` 校验，不设置隐式默认值 |
| 审计日志 | 全局拦截器为所有写操作留痕，且强制剥离 query（隐私票据不入库），新增写接口无需自行记日志 |
| 路由顺序 | NestJS 按声明顺序匹配，`@Patch('batch')` 这类字面量路由必须写在 `@Patch(':id')` 之前 |
| 注释风格 | 解释「为什么这样设计、不这么做会有什么后果」，不重复代码字面含义 |

---

## 五、分支与提交

### 5.1 分支命名

```
feat/<简短描述>      新功能
fix/<简短描述>       缺陷修复
docs/<简短描述>      文档
refactor/<简短描述>  重构
```

不要直接向 `main` 推送。

### 5.2 提交信息

遵循 Angular 风格，说明「为什么」而不只是「做了什么」：

```
feat(privacy): 支持为单张照片设置独立查看密码
fix(web): 修复分享页验证失败后按钮卡在「验证中」
docs(readme): 补充生产部署的 nginx 子路径说明
```

一次提交只做一件事；重构与功能改动不要混在同一次提交中。

---

## 六、提交前自检

```bash
npm run typecheck       # 四端类型检查，必须全绿
npm run check:tokens    # 动过样式时执行
```

涉及界面或接口的改动，请手动验证关键路径（至少覆盖改动直接影响的功能），并在 PR 描述中写明验证方式。

---

## 七、Pull Request 流程

1. **保持改动聚焦**：一个 PR 解决一个问题，避免顺带做无关重构。
2. **写清 PR 描述**：
   - 背景：要解决的问题与触发场景；
   - 改动：涉及哪些模块与文件；
   - 验证：执行了哪些检查与手动验证步骤；
   - 风险与取舍：有什么副作用、哪些情况尚未覆盖。
3. **涉及数据库结构**：`schema.ts`、`sql/` 脚本与迁移记录（`npm run db:generate`）必须一起改动；
   破坏性变更（删列 / 改类型）需在描述中给出迁移方案。
4. **涉及 API 契约**：同步更新 `packages/sdk` 的类型，三端共用同一份定义。
5. **评审关注点**：依赖方向是否正确、隐私与原片地址是否泄露、是否引入硬编码样式、注释是否说明了设计取舍。

---

## 八、安全与隐私

**请勿提交**下列内容：

- `.env` 及任何含口令、密钥、证书的文件；
- `data/`（缩略图、模糊图、实况视频等运行时生成物）；
- `tools/` 下的 exiftool 二进制；
- 含真实个人信息的照片；
- 任何形式的访问票据、签名密钥。

提交前可用 `git status` 与 `git diff --staged` 复核。仓库的 `.gitignore` 已覆盖上述条目，但请勿依赖它作为唯一保障。

**报告安全漏洞**：请勿提交公开 Issue，也不要附带可利用的复现细节与真实数据。请通过仓库维护者的私密渠道说明问题范围与影响，维护者确认并修复后再行公开。

---

## 九、许可

本项目采用 **GNU Affero General Public License v3.0（AGPL-3.0）**，详见 [`LICENSE`](./LICENSE)。

您提交的贡献将以同一许可发布；提交 PR 即表示您同意这一授权安排，并确认您有权提交所贡献的代码。