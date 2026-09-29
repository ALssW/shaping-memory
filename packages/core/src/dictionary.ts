/**
 * packages/core/src/dictionary.ts
 *
 * 通用字典的「类型元数据 + 内置预设 + 数值排序助手」。
 *
 * 【为什么类型定义放 core 而不是后端】字典类型是**跨端契约**：后端要按 kind 建目录、
 * 后台要列出可管理的类型、前后台搜索框要按 kind 拉候选并显示同名标签。
 * 放一份在这里，三端就不可能对「有哪些类型、中文叫什么」产生分歧。
 *
 * 【为什么只给光圈/快门/ISO 内置预设】机身与镜头是随器材购置变化的运营数据，
 * 只有从真实照片里整理才有意义；而曝光三要素是摄影的**标准档位**，先铺好常用值，
 * 用户一打开下拉就能选，不必等数据里出现过。
 */
import { EXPOSURE_PRESETS } from './exposure-presets';
import type { ExposureKind } from './exposure-presets';

/** 字典类型键：与后端 dictionary.kind 一一对应 */
export type DictionaryKind = 'camera' | 'lens' | 'aperture' | 'shutter' | 'iso';

/** 一条字典值的预设形态（内置档位用） */
export interface DictionaryPreset {
  /** 落库与匹配用的值，如 "f/2.8" / "1/200" / "400" */
  value: string;
  /** 展示文案；缺省与 value 相同 */
  label?: string;
  /** 数值序（光圈值 / 快门秒数 / ISO），用于排序与「由小到大」归位 */
  order: number;
}

/** 字典类型的元数据：三端共用的「有哪些类型、怎么称呼、有没有预设」 */
export interface DictionaryKindMeta {
  kind: DictionaryKind;
  /** 类型名（后台字典管理页、类型切换器上用） */
  label: string;
  /** 搜索字段名（搜索面板的字段标题用，比类型名更贴合语境） */
  fieldLabel: string;
  placeholder: string;
  /** 是否有内置标准档位 */
  preset: boolean;
}

/** 全部字典类型，顺序即前端展示顺序 */
export const DICTIONARY_KINDS: readonly DictionaryKindMeta[] = [
  { kind: 'camera', label: '机身型号', fieldLabel: '相机型号', placeholder: '如 NIKON Z 7_2', preset: false },
  { kind: 'lens', label: '镜头型号', fieldLabel: '镜头型号', placeholder: '如 NIKKOR Z 24-120mm', preset: false },
  { kind: 'aperture', label: '光圈', fieldLabel: '光圈', placeholder: '如 f/2.8', preset: true },
  { kind: 'shutter', label: '快门速度', fieldLabel: '快门速度', placeholder: '如 1/250', preset: true },
  { kind: 'iso', label: '感光度', fieldLabel: '感光度', placeholder: '如 400', preset: true },
];

/** kind → 元数据（查表用，避免各处 find） */
export const DICTIONARY_KIND_META: Record<DictionaryKind, DictionaryKindMeta> = DICTIONARY_KINDS.reduce(
  (acc, item) => {
    acc[item.kind] = item;
    return acc;
  },
  {} as Record<DictionaryKind, DictionaryKindMeta>,
);

/**
 * 曝光三要素的字典值直接由「档位表」推导 —— 档位只在 exposure-presets.ts 里定义一次。
 * 【为什么不再各写一份】档位同时服务两件事：字典（供搜索联想与数据整理）与编辑控件
 * （供「自由输入 + 档位下拉」）。两处各写一份就会出现「下拉里有 1/6400、字典里没有」，
 * 推导出来则永远同步。
 * 字典的 value 取摄影习惯写法（`f/2.8` / `1/200` / `2"` / `400`），order 取数值序。
 */
function exposurePresetsOf(kind: ExposureKind): DictionaryPreset[] {
  return EXPOSURE_PRESETS[kind].map((preset) => ({ value: preset.label, order: preset.order }));
}

/** 内置预设值：只有曝光三要素有（机身/镜头留给「从现有数据整理」） */
export const DICTIONARY_PRESETS: Record<DictionaryKind, readonly DictionaryPreset[]> = {
  camera: [],
  lens: [],
  aperture: exposurePresetsOf('aperture'),
  shutter: exposurePresetsOf('shutter'),
  iso: exposurePresetsOf('iso'),
};

/**
 * 由值反推数值序：整理数据时用它给「非预设、但真实存在」的值定位（如 f/7.1、1/13000）。
 * 解析不出来时返回 null，调用方把它排到末尾 —— 排序不应因一个异常值而失败。
 */
export function dictionaryOrderOf(kind: DictionaryKind, value: string): number | null {
  const text = value.trim();
  if (!text) return null;

  if (kind === 'aperture') {
    // 兼容 f/4、F4、f4.0 三种写法
    const match = /^f\/?\s*([\d.]+)$/i.exec(text);
    const f = match ? Number(match[1]) : NaN;
    return Number.isFinite(f) && f > 0 ? f : null;
  }

  if (kind === 'shutter') {
    // 分数档：1/200 → 0.005
    const fraction = /^1\s*\/\s*(\d+(?:\.\d+)?)$/.exec(text);
    if (fraction) {
      const den = Number(fraction[1]);
      return den > 0 ? 1 / den : null;
    }
    // 长曝档：2" / 2s / 2sec
    const seconds = /^(\d+(?:\.\d+)?)\s*(?:"|s|sec|秒)$/i.exec(text);
    if (seconds) {
      const sec = Number(seconds[1]);
      return Number.isFinite(sec) ? sec : null;
    }
    return null;
  }

  if (kind === 'iso') {
    const iso = Number(text);
    return Number.isFinite(iso) ? iso : null;
  }

  // 机身 / 镜头是文本值：没有数值序
  return null;
}

/**
 * 按字典顺序比较两枚值：有数值序的按数值排，纯文本按本地化字序排。
 * 【为什么不需要传 kind】数值口径已经落在 order 上（光圈 f 数 / 快门秒数 / ISO），
 * 有了它就不必再回头判断「这是哪一类」—— 同一个函数可以直接服务任意类型。
 */
export function compareDictionaryValues(
  a: { value: string; order: number | null },
  b: { value: string; order: number | null },
): number {
  if (a.order != null && b.order != null && a.order !== b.order) return a.order - b.order;
  // 有数值序的排在无解析结果的之前（异常值始终排在最后，不会插入 f/4 与 f/8 之间）
  if (a.order != null && b.order == null) return -1;
  if (a.order == null && b.order != null) return 1;
  return a.value.localeCompare(b.value, 'zh-Hans-CN');
}