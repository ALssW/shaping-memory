/**
 * packages/core/src/exposure-presets.ts
 *
 * 曝光三要素（快门 / 光圈 / ISO）的**标准档位表 + 文本归一化** —— 四端（Web 前台、
 * Web 工具模块、后台、手机端）「自由输入 + 档位快速选择」共用同一份事实源。
 *
 * 【为什么必须放在 core】四个界面都要给这三个参数提供档位下拉。各端自行列一份档位，
 * 迟早出现「后台能选 1/6400、前台没有」这种分叉；写在 core 里是编译期保证的一致。
 *
 * 【档位范围（产品约定）】
 *   - 快门：1/8000s ~ 900s（1/3 档全铺，含 900 这一端极值）
 *   - 光圈：f/0.95 ~ f/32（1/3 档全铺）
 *   - ISO ：64 ~ 30000（1/3 档全铺，30000 为端极值）
 *
 * 【三种参数的 canonical 文本形态（写入与比较都用它）】
 *   - shutter ：秒的十进制小数，如 `0.005`（= 1/200s）、`2`（= 2"）
 *   - aperture：纯 f 数，如 `2.8`
 *   - iso     ：整数，如 `400`
 * 之所以统一成十进制而不是 `1/200`：exiftool 的 `-n` 口径就是这个形态，
 * 而「有没有改」的判断（exifSameText）按数值比较也依赖它。`1/200`、`2"`、`f/2.8`
 * 这类摄影习惯写法由 `parseExposureValue` 宽容解析后归一到 canonical。
 */

/** 三要素标识 */
export type ExposureKind = 'shutter' | 'aperture' | 'iso';

/** 一个档位：写入值 + 展示文案 + 数值序 */
export interface ExposurePreset {
  /** canonical 写入值（十进制秒 / f 数 / ISO 整数） */
  value: string;
  /** 展示文案：`1/200`、`f/2.8`、`400` */
  label: string;
  /** 数值序：快门按秒、光圈按 f 数、ISO 按数值 —— 排序与「当前值在档位里的位置」都用它 */
  order: number;
}

/** 档位覆盖范围（界面提示「已超出常用档位」时用；不是写入的硬约束） */
export const EXPOSURE_PRESET_RANGE: Record<ExposureKind, { min: number; max: number }> = {
  shutter: { min: 1 / 8000, max: 900 },
  aperture: { min: 0.95, max: 32 },
  iso: { min: 64, max: 30000 },
};

/** 快门分数档的分母（1/3 档，从 1/8000 到 1/1.3；1s 及更长的档位由秒表承担） */
const SHUTTER_DENOMINATORS: readonly number[] = [
  8000, 6400, 5000, 4000, 3200, 2500, 2000, 1600, 1250, 1000, 800, 640, 500, 400, 320, 250, 200, 160, 125, 100, 80,
  60, 50, 40, 30, 25, 20, 15, 13, 10, 8, 6, 5, 4, 3, 2.5, 2, 1.6, 1.3,
];

/** 快门秒档（1" 起的长曝档，1/3 档 + 900 这一端极值） */
const SHUTTER_SECONDS: readonly number[] = [
  1, 1.3, 1.6, 2, 2.5, 3, 4, 5, 6, 8, 10, 13, 15, 20, 25, 30, 40, 50, 60, 80, 100, 125, 160, 200, 250, 320, 400,
  500, 640, 800, 900,
];

/** 光圈 1/3 档（f/0.95 与 f/32 是两端极值，中间为标准 1/3 档序列） */
const APERTURES: readonly number[] = [
  0.95, 1, 1.1, 1.2, 1.4, 1.6, 1.8, 2, 2.2, 2.5, 2.8, 3.2, 3.5, 4, 4.5, 5, 5.6, 6.3, 7.1, 8, 9, 10, 11, 13, 14, 16,
  18, 20, 22, 25, 29, 32,
];

/** ISO 1/3 档（64 与 30000 是两端极值） */
const ISOS: readonly number[] = [
  64, 80, 100, 125, 160, 200, 250, 320, 400, 500, 640, 800, 1000, 1250, 1600, 2000, 2500, 3200, 4000, 5000, 6400,
  8000, 10000, 12800, 16000, 20000, 25600, 30000,
];

/** 数值 → canonical 文本：去掉浮点尾巴（0.30000000000000004 这类） */
const canonicalOf = (num: number): string => String(Number(num.toPrecision(12)));

/** 小数分母要显示成 `1/2.5` 而不是 `1/2.500000`；整数分母显示成 `1/200` */
const slimNumber = (num: number): string => canonicalOf(num);

function shutterPresets(): ExposurePreset[] {
  const fractions = SHUTTER_DENOMINATORS.map((den) => {
    const seconds = Number((1 / den).toPrecision(12));
    // 分母保留摄影习惯写法（2.5 / 1.6 / 1.3），值仍是秒
    return { value: canonicalOf(seconds), label: `1/${slimNumber(den)}`, order: seconds };
  });
  const seconds = SHUTTER_SECONDS.map((sec) => ({ value: canonicalOf(sec), label: `${sec}"`, order: sec }));
  return [...fractions, ...seconds];
}

function aperturePresets(): ExposurePreset[] {
  return APERTURES.map((f) => ({ value: canonicalOf(f), label: `f/${f}`, order: f }));
}

function isoPresets(): ExposurePreset[] {
  return ISOS.map((iso) => ({ value: String(iso), label: String(iso), order: iso }));
}

/** 三要素的全部档位，顺序即数值序（由小到大：快门快→慢、光圈小→大、ISO 低→高） */
export const EXPOSURE_PRESETS: Record<ExposureKind, readonly ExposurePreset[]> = {
  shutter: shutterPresets(),
  aperture: aperturePresets(),
  iso: isoPresets(),
};

/** tag → 三要素标识；其余 tag 返回 null（决定用不用「双输入」控件） */
export function exposureKindOfTag(tag: string): ExposureKind | null {
  if (tag === 'ExposureTime') return 'shutter';
  if (tag === 'FNumber') return 'aperture';
  if (tag === 'ISO') return 'iso';
  return null;
}

/**
 * 宽容解析用户输入 → 数值。
 * 接受：`1/200`（分数秒）、`0.005`（十进制秒）、`2"` `2s`（长曝）、`f/2.8` `2.8`（光圈）、`400`（ISO）。
 * 解析不出或非正数返回 null —— 由调用方给出中文提示。
 */
export function parseExposureValue(kind: ExposureKind, text: string): number | null {
  // 先剥掉长曝的引号/秒后缀，再统一处理剩下两种写法
  const trimmed = text.trim().replace(/["'″]|s(ec)?$/i, '').trim();
  if (trimmed === '') return null;

  if (kind === 'shutter') {
    const fraction = /^(\d+(?:\.\d+)?)\s*\/\s*(\d+(?:\.\d+)?)$/.exec(trimmed);
    if (fraction) {
      const den = Number(fraction[2]);
      if (!(den > 0)) return null;
      const value = Number(fraction[1]) / den;
      return value > 0 ? value : null;
    }
  }

  if (kind === 'aperture') {
    const labelled = /^f\s*\/?\s*([\d.]+)$/i.exec(trimmed);
    if (labelled) {
      const value = Number(labelled[1]);
      return value > 0 ? value : null;
    }
  }

  const num = Number(trimmed);
  return Number.isFinite(num) && num > 0 ? num : null;
}

/** 用户输入 → canonical 文本；非法返回空串（由调用方决定「提示」还是「当作未填」） */
export function canonicalExposureText(kind: ExposureKind, text: string): string {
  const num = parseExposureValue(kind, text);
  if (num == null) return '';
  // ISO 只能是整数：写 400.7 到 SHORT 型 tag 上会被取整，提前收口避免「所见非所写」
  return kind === 'iso' ? String(Math.round(num)) : canonicalOf(num);
}

/** canonical 值 → 摄影习惯写法（`0.005` → `1/200`、`2.8` → `f/2.8`） */
export function exposureLabelOf(kind: ExposureKind, value: string): string {
  const num = parseExposureValue(kind, value);
  if (num == null) return value;
  if (kind === 'aperture') return `f/${canonicalOf(num)}`;
  if (kind === 'iso') return String(Math.round(num));
  if (num < 1) {
    const inverse = 1 / num;
    // 1/3 档的倒数不总是整数（1/1.3 = 0.769），四舍五入后再回代确认，避免把 0.769 说成 1/1
    const rounded = Math.round(inverse);
    if (Math.abs(inverse - rounded) < 0.05) return `1/${rounded}`;
  }
  return `${canonicalOf(num)}"`;
}

/** 该值命中的档位；没有命中（用户手输了非档位值）返回 null —— 下拉据此显示「自定义」 */
export function findExposurePreset(kind: ExposureKind, value: string): ExposurePreset | null {
  const num = parseExposureValue(kind, value);
  if (num == null) return null;
  // 按相对误差比对：文件里可能是 0.00012500000000000003 这类浮点尾巴
  return EXPOSURE_PRESETS[kind].find((preset) => Math.abs(preset.order - num) <= Math.abs(num) * 1e-6) ?? null;
}

/** 该值是否落在档位覆盖范围内（超出只提示、不阻断 —— 文件里本来就可能是 1/16000） */
export function withinExposureRange(kind: ExposureKind, value: string): boolean {
  const num = parseExposureValue(kind, value);
  if (num == null) return true;
  const { min, max } = EXPOSURE_PRESET_RANGE[kind];
  return num >= min * 0.999 && num <= max * 1.001;
}