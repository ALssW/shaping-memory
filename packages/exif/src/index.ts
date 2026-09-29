/**
 * packages/exif/src/index.ts
 *
 * 用 exiftool.exe 抽取 / 写回照片的 EXIF。
 *
 * 【入参是「工具根目录」而不是 exiftool 目录】各函数首参统一传 TOOLS_DIR（第三方工具根目录，
 * 仓库内即 `tools/`），由 resolveExiftool 在里面定位 exiftool 的可执行文件。这样新增工具
 * 只需在 TOOLS_DIR 下多建一个子目录，不必再往环境变量里加一条路径。
 *
 * 【为什么必须传 cwd】exiftool 是 Oliver Betz 的 Strawberry Perl 打包版，
 * 它按「当前工作目录」去找 exiftool_files 与 perl532.dll —— 域名别名/绝对路径都不行，
 * 只有把 cwd 设到 exiftool.exe 所在目录才能成功加载（详见项目记忆）。
 *
 * 三处注意事项，都在这里一次性处理（详见 runExiftool / runExiftoolArgFile）：
 *   1) 路径必须是正斜杠：反斜杠会被启动器的转义处理吃掉 → perl532.dll code 126
 *   2) 启动器偶发竞态：空闲后的首次 spawn 会报 code 126，重试即可（不能仅靠「一次扫描全目录」规避）
 *   3) 命令行里的非 ASCII 参数会被启动器按 ANSI 代码页转换 → 中文变 "?"，
 *      因此**写入**一律走 -@ 参数文件（UTF-8），而不是把值拼在命令行上
 */
import { execFile, spawn } from 'node:child_process';
import { createWriteStream, existsSync } from 'node:fs';
import { rm, writeFile, copyFile, mkdir, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { EXIF_FIELDS } from '@shaping-memory/core';

const execFileAsync = promisify(execFile);

/** 归一后的 EXIF 展示值（对应 media.exifMetadata 与前端 Photo 的展示字段） */
export interface ExifData {
  fileType: string;
  width: number;
  height: number;
  cam: string;
  lens: string;
  focal: string;
  aperture: string;
  iso: number | null;
  speed: string;
  /** 原始拍摄时间 "YYYY:MM:DD HH:MM:SS"，导入层负责转 ISO 与日期 */
  takenAt: string;
  wb: string;
  temp: string;
  /** 是否实况照片（Motion Photo）：为真时照片尾部内嵌一段 MP4，可用 extractEmbeddedVideo 取出 */
  motionPhoto: boolean;
}

/** 要抽取的 tag（exiftool 短名），与 `-j -s` 输出的键一一对应 */
const WANTED_TAGS = [
  'FileType',
  'ImageWidth',
  'ImageHeight',
  'Model',
  'LensModel',
  'FocalLength',
  'FNumber',
  'ISO',
  'ExposureTime',
  'DateTimeOriginal',
  'WhiteBalance',
  'ColorTemperature',
  // 实况照片标记：小米/谷歌的 Motion Photo 会在 XMP-GCamera 组里写 MotionPhoto=1
  'MotionPhoto',
];

type RawRow = Record<string, unknown>;

const asString = (v: unknown): string => (typeof v === 'string' ? v : v == null ? '' : String(v));

const asNullableString = (v: unknown): string | null =>
  typeof v === 'string' && v.length > 0 ? v : null;

const asNumber = (v: unknown): number | null => {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : null;
};

/**
 * Windows 路径统一转正斜杠。
 * 关键：Oliver Betz 的 exiftool 启动器把「工作目录」传给 Perl 用于定位 perl532.dll，
 * 反斜杠在其内部转义处理里会被吃掉 → "Failed to load Perl DLL perl532.dll code 126"；
 * 正斜杠则稳定通过（Windows 对两者都接受）。因此传给 exiftool 的 cwd / 目标路径都转正斜杠。
 */
const toPosix = (p: string): string => p.replace(/\\/g, '/');

/**
 * exiftool 的可执行文件名。
 * Windows 打包版固定叫 `exiftool.exe`；Linux（apt / dnf 安装）是没有扩展名的 `exiftool`。
 * 【为什么不能写死 .exe】线上部署在 Linux 上，写死会让「读 EXIF / 提取实况视频 / 写回 EXIF」
 * 三条链路全部 spawn 失败（ENOENT），且报错信息与照片本身无关，很难定位。
 */
const EXE_NAME = process.platform === 'win32' ? 'exiftool.exe' : 'exiftool';

/**
 * exiftool 发行版在工具根目录下的子目录名。
 * 仓库内每个第三方工具各占一个子目录（`tools/exiftool/`、`tools/device-audit/`），
 * 因此 TOOLS_DIR 指向的是工具根目录，而不是某个具体工具。
 */
const EXIFTOOL_SUBDIR = 'exiftool';

/**
 * 工具根目录 → exiftool 的可执行文件路径与其所在目录（即 spawn 的工作目录）。
 *
 * 【为什么按「子目录 → 根目录」两级查找】
 *  - Windows 打包版解压在 `TOOLS_DIR/exiftool/` 下，exiftool_files 与 perl532.dll 都在那里；
 *  - Linux 用系统包（apt / dnf）安装时，可执行文件直接位于 `/usr/bin`，
 *    TOOLS_DIR 本就指向 /usr/bin，其下并不存在名为 exiftool 的子目录。
 * 两级查找同时覆盖这两种部署形态，且不必为平台各写一套配置。
 *
 * 【cwd 为什么跟着 exe 走】打包版按「当前工作目录」定位 exiftool_files 与 perl532.dll，
 * 因此工作目录只能是 exe 所在的那一级，不能固定写死成工具根目录。
 */
function resolveExiftool(toolsDir: string): { exe: string; cwd: string } {
  for (const dir of [path.join(toolsDir, EXIFTOOL_SUBDIR), toolsDir]) {
    if (existsSync(path.join(dir, EXE_NAME))) {
      return { exe: toPosix(path.join(dir, EXE_NAME)), cwd: toPosix(dir) };
    }
  }
  throw new Error(
    `未找到 exiftool：请确认 TOOLS_DIR（当前 ${toPosix(toolsDir)}）下存在 ` +
      `${EXIFTOOL_SUBDIR}/${EXE_NAME}，或该目录本身即包含 ${EXE_NAME}`,
  );
}

/* ==========================================================================
 * spawn 层：统一重试
 * ========================================================================== */

/** 启动器竞态的指纹：只有这一类失败值得重试，真正的文件损坏不应被重试掩盖 */
const LAUNCHER_RACE = /perl532\.dll|code 126/i;

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * 跑一次 exiftool，并对「启动器竞态」自动重试。
 *
 * 【为什么需要重试】Oliver Betz 的启动器在空闲一段时间后的首次 spawn 会
 * 间歇性报 `Failed to load Perl DLL "perl532.dll" code 126`（实测：同一张图、
 * 同一条命令，第一次失败、第二次成功）。这在只读导入里最多算一次重跑，
 * 但在「保存 EXIF」这条链路上会直接表现为「点了保存却报错」，必须通过重试消除。
 */
async function runExiftool(
  toolsDir: string,
  args: readonly string[],
  maxBuffer = 16 * 1024 * 1024,
): Promise<string> {
  const { exe, cwd } = resolveExiftool(toolsDir);
  let lastError: unknown;

  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const { stdout } = await execFileAsync(exe, args as string[], { cwd, maxBuffer });
      return stdout;
    } catch (err) {
      const message = `${(err as { stderr?: string }).stderr ?? ''}${(err as Error).message}`;
      if (!LAUNCHER_RACE.test(message)) throw err;
      lastError = err;
      await delay(150 * (attempt + 1));
    }
  }
  throw lastError;
}

/**
 * 用 `-@ 参数文件` 的方式跑 exiftool（写入路径专用）。
 *
 * 【为什么必须绕这一道】Windows 上命令行参数要经启动器转成 ANSI 代码页，
 * 中文会整片变成 "?"（实测 Artist="塑忆" 写进文件成了 "????"）。
 * `-@` 读的是 UTF-8 文本文件，绕开命令行编码，中文才能原样落盘。
 * 参数文件里一行一个参数，因此值里不能有换行（sanitize 里压成空格）。
 */
async function runExiftoolArgFile(toolsDir: string, args: readonly string[]): Promise<string> {
  const argFile = path.join(
    os.tmpdir(),
    `shaping-memory-exif-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.txt`,
  );
  const content = args.map((arg) => arg.replace(/[\r\n]+/g, ' ')).join('\n');
  await writeFile(argFile, content, 'utf8');
  try {
    return await runExiftool(toolsDir, ['-charset', 'utf8', '-@', toPosix(argFile)]);
  } finally {
    await rm(argFile, { force: true });
  }
}

/* ==========================================================================
 * 读取（展示口径）
 * ========================================================================== */

/** 光圈：FNumber 4 → "f/4.0" */
function formatAperture(value: unknown): string {
  const n = asNumber(value);
  return n == null ? '' : `f/${n}`;
}

/** 色温：5226 → "5226K"（前端 EXIF 卡片直接展示） */
function formatTemp(value: unknown): string {
  const n = asNumber(value);
  return n == null ? '' : `${Math.round(n)}K`;
}

function toExifData(raw: RawRow): ExifData {
  return {
    fileType: asString(raw.FileType),
    width: asNumber(raw.ImageWidth) ?? 0,
    height: asNumber(raw.ImageHeight) ?? 0,
    cam: asString(raw.Model),
    lens: asString(raw.LensModel),
    focal: asNullableString(raw.FocalLength) ?? '',
    aperture: formatAperture(raw.FNumber),
    iso: asNumber(raw.ISO),
    speed: asNullableString(raw.ExposureTime) ?? asNullableString(raw.ShutterSpeed) ?? '',
    takenAt: asNullableString(raw.DateTimeOriginal) ?? asNullableString(raw.CreateDate) ?? '',
    wb: asNullableString(raw.WhiteBalance) ?? '',
    temp: formatTemp(raw.ColorTemperature),
    motionPhoto: asString(raw.MotionPhoto) === '1',
  };
}

/** 抽取一张照片的 EXIF；exiftool 失败（非图片/损坏）时抛错，由调用方决定是否跳过 */
export async function extractExif(toolsDir: string, filePath: string): Promise<ExifData> {
  // 每个 tag 必须带 - 前缀：不带前缀的裸词会被 exiftool 当成文件名（实测 "File not found - FileType"）
  const tagArgs = WANTED_TAGS.map((tag) => `-${tag}`);
  const stdout = await runExiftool(toolsDir, ['-j', '-s', ...tagArgs, toPosix(filePath)]);
  const rows = JSON.parse(stdout) as RawRow[];
  const row = rows[0];
  if (!row) throw new Error(`exiftool 未返回数据：${filePath}`);
  return toExifData(row);
}

/**
 * 一次性抽取整个目录的 EXIF，返回「文件名 → ExifData」映射。
 *
 * 【为什么批量而不是逐张】逐张 spawn 会成倍撞上启动器竞态与进程开销；
 * 一次扫描全目录只 spawn 一次，既绕开竞态也更快。
 */
export async function extractExifDirectory(
  toolsDir: string,
  dirPath: string,
): Promise<Map<string, ExifData>> {
  const tagArgs = WANTED_TAGS.map((tag) => `-${tag}`);
  const stdout = await runExiftool(
    toolsDir,
    ['-j', '-s', ...tagArgs, toPosix(dirPath)],
    256 * 1024 * 1024,
  );
  const rows = JSON.parse(stdout) as RawRow[];
  const map = new Map<string, ExifData>();
  for (const row of rows) {
    const source = asString(row.SourceFile);
    if (!source) continue;
    map.set(path.basename(source), toExifData(row));
  }
  return map;
}

/* ==========================================================================
 * 实况照片（Motion Photo）：把照片尾部内嵌的 MP4 取出来单独落盘
 * ========================================================================== */

/** 取文件大小，不存在即 0（用于判断本次提取是否确实取得内容） */
async function fileSize(p: string): Promise<number> {
  try {
    return (await stat(p)).size;
  } catch {
    return 0;
  }
}

/**
 * 跑一次提取：exiftool 将二进制视频输出到 stdout，本模块接收后写入 destPath。
 * 返回是否确实取得内容（非实况照片会输出一个 0 字节文件，这里一并清除）。
 */
function extractOnce(exe: string, cwd: string, src: string, dest: string): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const child = spawn(exe, ['-b', '-MotionPhotoVideo', src], { cwd });
    const sink = createWriteStream(dest);
    let broken = false;
    child.stdout.pipe(sink);
    child.stderr.on('data', (chunk: Buffer) => {
      // 启动器竞态同样视为「本次失败」，交给外层重试
      if (LAUNCHER_RACE.test(String(chunk))) broken = true;
    });
    child.on('error', () => {
      broken = true;
    });
    child.on('close', (code) => {
      sink.end(() => {
        void (async () => {
          const size = await fileSize(dest);
          if (broken || code !== 0 || size === 0) {
            await rm(dest, { force: true });
            resolve(false);
            return;
          }
          resolve(true);
        })();
      });
    });
  });
}

/**
 * 提取实况照片尾部内嵌的视频并写入 destPath（目录会自动创建）。
 *
 * 【为什么不用 `exiftool -o out.mp4`】`-o` 会让 exiftool **再启动一个自身进程**去写文件，
 * 那个子进程的工作目录不是 exe 所在目录 → perl532.dll 加载失败（实测必现 code 126）。
 * 改为让 exiftool 将二进制输出到 stdout、由本模块通过管道写出，全程只 spawn 一次。
 *
 * @returns 拿到视频为 true；不是实况照片（或多次重试都失败）为 false，此时不会留下空文件
 */
export async function extractEmbeddedVideo(
  toolsDir: string,
  filePath: string,
  destPath: string,
): Promise<boolean> {
  await mkdir(path.dirname(destPath), { recursive: true });
  const { exe, cwd } = resolveExiftool(toolsDir);

  for (let attempt = 0; attempt < 3; attempt += 1) {
    if (await extractOnce(exe, cwd, toPosix(filePath), destPath)) return true;
    await delay(150 * (attempt + 1));
  }
  return false;
}

/* ==========================================================================
 * 全量 EXIF 读写（M2：后台元数据编辑，真实写回照片文件）
 *
 * 与上面 extractExif 的区别：
 *   - extractExif 走「展示口径」（FNumber → "f/4.0"），只服务导入与前台卡片；
 *   - 这里走「原始口径」（-n，FNumber → 4），因为要能原样改完再写回去。
 * ========================================================================== */

/** 读全量时额外要的展示用 tag（不在可编辑清单里，但后台详情要显示） */
const EXTRA_READ_TAGS = [
  'FileType',
  'ImageWidth',
  'ImageHeight',
  'MIMEType',
  // 经纬度本体不在 EXIF_FIELDS 里（它由地图选点写入，不走通用表单），
  // 但**必须显式列进读取清单** —— exiftool 只返回被点名的 tag，
  // 少列这两个就会读出一份「有 GPSLatitudeRef 却没有 GPSLatitude」的残缺数据。
  'GPSLatitude',
  'GPSLongitude',
  // 经纬度/海拔的正负号与本体是分开存的（本体恒为正，方向由 Ref 决定），
  // 因此方向 tag 必须一起读，否则南纬/西经/海平面以下会被读成正值。
  'GPSLatitudeRef',
  'GPSLongitudeRef',
  'GPSAltitudeRef',
];

/** 全量读取的 tag 列表：可编辑清单 ∪ 展示 tag */
const FULL_READ_TAGS: readonly string[] = [
  ...new Set([...EXTRA_READ_TAGS, ...EXIF_FIELDS.map((field) => field.tag)]),
];

/** 写入值：字符串 / 数字 / 多值数组（Keywords 这类多值 tag）/ null（清除该 tag） */
export type ExifWriteValue = string | number | readonly string[] | null;

/** 读到的全量 EXIF：tag（exiftool 短名）→ 原始值字符串；缺的 tag 不出现在结果里 */
export type ExifFull = Record<string, string>;

/** 一行的原始输出 → 全量 EXIF（剔除 exiftool 自行添加的 SourceFile；数组按读取口径 join 成 ", "） */
function toExifFull(row: RawRow): ExifFull {
  const result: ExifFull = {};
  for (const [key, value] of Object.entries(row)) {
    // SourceFile 是 exiftool 自行添加的元信息，不是照片元数据
    if (key === 'SourceFile' || value == null) continue;
    result[key] = Array.isArray(value) ? value.map((v) => asString(v)).join(', ') : asString(value);
  }
  return result;
}

/**
 * 读取一张照片的全量 EXIF 原始值（-n 关闭打印转换）。
 * 不抛「字段缺失」错：真实照片本就没有 GPS / 版权等信息，缺失即不出现在返回对象里。
 */
export async function readExifFull(toolsDir: string, filePath: string): Promise<ExifFull> {
  const tagArgs = FULL_READ_TAGS.map((tag) => `-${tag}`);
  const stdout = await runExiftool(toolsDir, [
    '-j',
    '-s',
    '-n',
    '-charset',
    'utf8',
    // IPTC 组默认按 Latin-1 解码，而本模块写入的 IPTC 一律是 UTF-8 —— 读写两侧必须一致
    '-charset',
    'iptc=utf8',
    ...tagArgs,
    toPosix(filePath),
  ]);
  const rows = JSON.parse(stdout) as RawRow[];
  const row = rows[0];
  if (!row) throw new Error(`exiftool 未返回数据：${filePath}`);
  return toExifFull(row);
}

/**
 * 一次性抽取整个目录的全量 EXIF 原始值，返回「文件名 → ExifFull」映射。
 * 与 extractExifDirectory 同一套「一次 spawn 扫全目录」的做法：既绕开启动器竞态也更快，
 * 供导入管线把全量 EXIF 写进 exif_metadata.extra（数据库成为唯一事实源）。
 */
export async function extractFullDirectory(
  toolsDir: string,
  dirPath: string,
): Promise<Map<string, ExifFull>> {
  const tagArgs = FULL_READ_TAGS.map((tag) => `-${tag}`);
  const stdout = await runExiftool(
    toolsDir,
    ['-j', '-s', '-n', '-charset', 'utf8', '-charset', 'iptc=utf8', ...tagArgs, toPosix(dirPath)],
    256 * 1024 * 1024,
  );
  const rows = JSON.parse(stdout) as RawRow[];
  const map = new Map<string, ExifFull>();
  for (const row of rows) {
    const source = asString(row.SourceFile);
    if (!source) continue;
    map.set(path.basename(source), toExifFull(row));
  }
  return map;
}

/** 单个 tag 转成 exiftool 参数：数组重复出现即写多值；null/空串即清除 */
function tagToArgs(tag: string, value: ExifWriteValue): string[] {
  if (value == null || value === '') return [`-${tag}=`];
  const values = Array.isArray(value) ? value : [value];
  return values.map((item) => `-${tag}=${item}`);
}

/** 写入时的固定开关（顺序无关，集中一处便于解释） */
const WRITE_FLAGS = [
  // 不加它 exiftool 会在照片旁生成 `xxx_original.jpg` 备份，而导入管线按扩展名扫目录，
  // 那堆备份会被当成新照片重新导入；备份职责交给调用方
  '-overwrite_original',
  // PNG 不支持部分 EXIF 标签，exiftool 会报 minor error，忽略即可
  '-m',
  // 保留文件修改时间：EXIF 编辑不该让照片的 mtime 变化
  '-P',
  // 与读取时一致：关闭打印转换，读到的 4 原样写成 4
  '-n',
  // IPTC 组默认 Latin-1，中文会变 "?"；显式声明 UTF-8 才能原样落盘
  '-charset',
  'iptc=utf8',
];

/** exiftool 拒绝写入时的「扩展名与真实内容不符」指纹 */
const EXT_MISMATCH = /Not a valid \w+ \(looks more like a (\w+)\)/i;

/** 真实容器类型 → 扩展名（exiftool 按扩展名选写回模块，名字对不上就直接拒写） */
const EXT_BY_FILE_TYPE: Record<string, string> = {
  JPEG: '.jpg',
  PNG: '.png',
  TIFF: '.tif',
  WEBP: '.webp',
  HEIC: '.heic',
  HEIF: '.heif',
  GIF: '.gif',
};

/** 写不进去时 exiftool 不一定抛错，只在输出里提示 0 image files updated —— 必须由调用方判断 */
function assertUpdated(output: string, filePath: string): void {
  if (output.includes('0 image files updated')) {
    throw new Error(`EXIF 写入未生效：${path.basename(filePath)}｜${output.trim()}`);
  }
}

/**
 * 保底方案：把原片复制成「扩展名与真实格式一致」的临时副本，写副本，再覆盖回原路径。
 *
 * 【为什么需要】exiftool 写回时按**扩展名**挑容器模块，扩展名与真实格式不符的文件会被直接拒写
 * （实测源目录里的 DSC_2153_W.png 实际为 JPEG，报 "Not a valid PNG (looks more like a JPEG)"）。
 * 文件名属于用户资产，不应由本模块修改，因此只能换一个名字写完再复制回来。
 * 代价是这一次写入会刷新文件 mtime（-P 只保住了临时副本的时间），属可接受的取舍。
 */
async function writeViaTempCopy(
  toolsDir: string,
  filePath: string,
  tagArgs: readonly string[],
  ext: string,
): Promise<void> {
  const tmp = path.join(
    os.tmpdir(),
    `shaping-memory-fix-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}${ext}`,
  );
  await copyFile(filePath, tmp);
  try {
    const output = await runExiftoolArgFile(toolsDir, [...WRITE_FLAGS, ...tagArgs, toPosix(tmp)]);
    assertUpdated(output, tmp);
    await copyFile(tmp, filePath);
  } finally {
    await rm(tmp, { force: true });
  }
}

/**
 * 把 EXIF 真实写回照片文件。
 * 正常路径直接原地改写；只有「扩展名与内容不符」时才退到临时副本方案。
 */
export async function writeExifTags(
  toolsDir: string,
  filePath: string,
  tags: Readonly<Record<string, ExifWriteValue>>,
): Promise<void> {
  const entries = Object.entries(tags);
  if (entries.length === 0) return;

  const tagArgs: string[] = [];
  for (const [tag, value] of entries) tagArgs.push(...tagToArgs(tag, value));

  try {
    assertUpdated(
      await runExiftoolArgFile(toolsDir, [...WRITE_FLAGS, ...tagArgs, toPosix(filePath)]),
      filePath,
    );
    return;
  } catch (err) {
    const realType = EXT_MISMATCH.exec(String((err as Error).message))?.[1]?.toUpperCase();
    const ext = realType ? EXT_BY_FILE_TYPE[realType] : undefined;
    // 不是「扩展名与真实格式不符」就原样抛出，避免掩盖真实错误
    if (!ext) throw err;
    await writeViaTempCopy(toolsDir, filePath, tagArgs, ext);
  }
}
