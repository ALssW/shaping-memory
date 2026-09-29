/**
 * packages/config/src/index.ts
 *
 * 环境变量在这里集中校验，导出强类型的 AppConfig。
 * 后端 NestJS 与照片导入脚本共用这一份，避免两处各自手写取 env、漏填时才发现。
 *
 * 【路径一律可写相对形式】PHOTO_SOURCE_DIR / STORAGE_DIR / TOOLS_DIR 三个目录
 * 允许写成 `./data` 这类相对路径，由本模块统一按「仓库根」解析成绝对路径。
 * 这样同一份 .env 换台机器、换个盘符都能直接用，不必逐条改盘符。
 *
 * 说明：
 *  - DATABASE_URL 指向 PostgreSQL（数据库可装在远程服务器，直接填其地址即可，无需 SSH 隧道）。
 *  - PHOTO_SOURCE_DIR 是「原片来源目录」（只读），STORAGE_DIR 是生成物目录（可写）。
 *  - TOOLS_DIR 是第三方工具根目录，每个工具各占一个子目录（如 `tools/exiftool/`）；
 *    各个工具**内部**再自行定位自己的可执行文件与工作目录（详见 @shaping-memory/exif）。
 *    用系统包安装 exiftool 时（如 Linux 的 /usr/bin），TOOLS_DIR 直接指向该目录即可。
 */
import path from 'node:path';
import { z } from 'zod';

/**
 * 仓库根目录。
 * 本包位于 packages/config/src（编译产物在 packages/config/dist），
 * 两种形态向上三级都是仓库根，因此这个锚点在开发与构建后同样成立。
 */
const REPO_ROOT = path.resolve(__dirname, '../../..');

/** 相对路径按仓库根解析，绝对路径原样返回（Windows 盘符与 POSIX 根都能识别） */
function toAbsolutePath(value: string): string {
  return path.isAbsolute(value) ? value : path.resolve(REPO_ROOT, value);
}

const EnvSchema = z.object({
  DATABASE_URL: z.string().min(1, 'DATABASE_URL 不能为空'),
  PHOTO_SOURCE_DIR: z.string().min(1, 'PHOTO_SOURCE_DIR 不能为空').transform(toAbsolutePath),
  STORAGE_DIR: z.string().min(1, 'STORAGE_DIR 不能为空').transform(toAbsolutePath),
  TOOLS_DIR: z.string().min(1, 'TOOLS_DIR 不能为空').transform(toAbsolutePath),
  API_PORT: z.coerce.number().int().positive().default(3000),
  API_HOST: z.string().default('127.0.0.1'),
  // 密钥与初始口令都**不给默认值**：默认口令一旦被带到线上就是后门
  JWT_SECRET: z.string().min(16, 'JWT_SECRET 至少 16 位随机字符'),
  ADMIN_USERNAME: z.string().default('admin'),
  ADMIN_PASSWORD: z.string().min(8, 'ADMIN_PASSWORD 至少 8 位'),
  /** API 自身的对外基址（社交爬虫抓 OpenGraph 时，og:image 需绝对地址由此拼接） */
  PUBLIC_BASE_URL: z.string().default('http://127.0.0.1:3000'),
  /** Web 前台地址（用户点开分享链接后跳转过去） */
  WEB_BASE_URL: z.string().default('http://localhost:5173'),
  /**
   * 允许跨域的前端来源，逗号分隔；留空 = 放行所有（仅适合本地开发）。
   * 生产填 `https://<YOUR_DOMAIN>` 这样的白名单（三端同域，前台/后台都从这个源发出请求）。
   */
  CORS_ORIGINS: z.string().default(''),
  /**
   * 高德开放平台「Web 服务」的 key，只给后端代理用（地点搜索）。
   * 【为什么不给默认值】带默认值就可能在没配的环境里静默走空串，报出来的错会变成
   * 「key 无效」而不是「没配 key」；留空由服务层显式抛「暂不可用」，定位更准。
   * 【为什么必须放后端】key 一旦进前端产物就等于公开，配额会被别人刷掉；
   * 且前端直连高德还会撞上浏览器的跨域限制。
   */
  AMAP_KEY: z.string().default(''),

  /* --------------------------------------------------------------------------
   * 对象存储（可选）—— 对应 README 的 storage 配置模板
   *
   * 【默认 local，什么都不配就能跑】照片与生成物都留在本机 STORAGE_DIR。
   * 只有想借对象存储省磁盘 / 做异地副本时才切 s3，此时才需要下面那几个字段。
   *
   * 【为什么字段是 STORAGE_* 而不是照抄模板里的 bucket / region】
   * 模板是「概念配置」（provider/bucket/region/prefix/customDomain），
   * .env 里则是平铺的大写键，两者一一对应，映射关系只写在 .env.example 的注释里。
   * -------------------------------------------------------------------------- */
  STORAGE_PROVIDER: z.enum(['local', 's3']).default('local'),
  STORAGE_BUCKET: z.string().default(''),
  STORAGE_REGION: z.string().default(''),
  /** 自定义服务地址；留空走 AWS 官方，阿里云 OSS / MinIO / R2 等必须填 */
  STORAGE_ENDPOINT: z.string().default(''),
  /**
   * 寻址风格：`true` = path-style（桶名写在路径里，`endpoint/bucket/key`）；
   * `false` = virtual-hosted（桶名进子域名，`bucket.endpoint/key`）。
   *
   * 【为什么必须显式配】两种风格不通用：自建 MinIO 等依赖 path-style（免去为每个桶配 DNS），
   * 而阿里云 OSS 会直接 403（`Please use virtual hosted style to access.`）。
   * 默认 `true` 保留自建服务的既有行为；用云厂商托管 OSS 时改成 `false`。
   */
  STORAGE_PATH_STYLE: z
    .enum(['true', 'false'])
    .default('true')
    .transform((value) => value === 'true'),
  STORAGE_PREFIX: z.string().default(''),
  /** 绑定了该桶的自定义域名；留空则所有图片都经 API 转发（桶可保持完全私有） */
  STORAGE_CUSTOM_DOMAIN: z.string().default(''),
  /**
   * 访问密钥。**只有 s3 模式才需要**，且绝不给默认值 ——
   * 默认值意味着「忘了配」会静默退化成一个能跑但权限不对的状态，比直接报错更难排查。
   */
  S3_ACCESS_KEY_ID: z.string().default(''),
  S3_SECRET_ACCESS_KEY: z.string().default(''),
}).superRefine((env, ctx) => {
  // 选了 s3 就把必需项一次报全，避免用户配一个报一个、来回重启
  if (env.STORAGE_PROVIDER !== 's3') return;
  const missing = (
    [
      ['STORAGE_BUCKET', env.STORAGE_BUCKET],
      ['STORAGE_REGION', env.STORAGE_REGION],
      ['S3_ACCESS_KEY_ID', env.S3_ACCESS_KEY_ID],
      ['S3_SECRET_ACCESS_KEY', env.S3_SECRET_ACCESS_KEY],
    ] as const
  )
    .filter(([, value]) => value.trim() === '')
    .map(([key]) => key);
  if (missing.length === 0) return;
  ctx.addIssue({
    code: z.ZodIssueCode.custom,
    message: `已选择对象存储（STORAGE_PROVIDER=s3），但还缺少：${missing.join('、')}`,
  });
});

export type AppConfig = z.infer<typeof EnvSchema>;

/** 逗号分隔的来源串 → 去空白的数组；空串得到空数组（上层据此决定是否全放行） */
export function parseOrigins(raw: string): string[] {
  return raw
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item !== '');
}

/** 校验并返回配置；env 缺省取 process.env（调用前需先加载 .env，见 dotenv） */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  return EnvSchema.parse(env);
}