/**
 * packages/core/src/tools.ts
 *
 * 插件化工具集（对应产品设计方案 §5.2 的 ToolRegistry）。
 *
 * 【核心思想】每个工具「自描述」：声明自己的输入字段（label/type/单位/选项/default），
 * 并提供纯函数 `compute()`。前端（Web / RN）只遍历 fields 渲染表单、把结果交给 compute，
 * 因此**新增工具无需改动前端与 API 主流程**——只需在这里注册一条 ToolDef。
 *
 * 计算逻辑全部是纯函数、零网络、零副作用，保证两端算出的结果逐位一致。
 */

/** 下拉/选项组的单个选项：value 用 number，compute 里可映射到常量表（如传感器尺寸） */
export interface ToolOption {
  label: string;
  value: number;
}

/** 一个输入字段的自描述，前端据此渲染对应控件 */
export interface ToolField {
  /** 字段键：compute 收到的 values 以此取数 */
  key: string;
  /** 展示标签 */
  label: string;
  /** 控件类型：number 用数字输入，select 用 chip / 分段按钮 */
  type: 'number' | 'select';
  /** 数值单位，展示在输入框右侧 */
  unit?: string;
  /** number 型：步进与边界 */
  step?: number;
  min?: number;
  max?: number;
  /** 缺省值 */
  default: number;
  /** select 型：选项清单 */
  options?: readonly ToolOption[];
  /** 输入区说明（可选） */
  hint?: string;
}

/** 工具计算结果：一个主值 + 若干解释行（前端统一卡片布局） */
export interface ToolResult {
  /** 主数值（大字） */
  primary: string;
  /** 主数值下的补充说明 */
  primarySub?: string;
  /** 解释行：标签 → 值 */
  rows: readonly { label: string; value: string }[];
}

/** 工具自描述：前端遍历 fields 渲染表单，把数值对象交给 compute 得到 ToolResult */
export interface ToolDef {
  key: string;
  name: string;
  desc: string;
  fields: readonly ToolField[];
  compute(values: Record<string, number>): ToolResult;
}

/* --------------------------------------------------------------------------
 * 数值格式化：保留有限位再去尾 0；非法/无穷统一落一个占位符
 * -------------------------------------------------------------------------- */

/** '1.500' → '1.5'，'2.00' → '2'；纯整数（无小数点）原样保留，避免 '5500' 被削成 '55' */
function trimZero(text: string): string {
  if (!text.includes('.')) return text;
  return text.replace(/\.?0+$/, '');
}

/** 有限值 → 保留 digits 位的字符串；非有限 → '∞'；非数 → '—' */
function fmt(value: number, digits = 2): string {
  if (Number.isNaN(value)) return '—';
  if (!Number.isFinite(value)) return '∞';
  return trimZero(value.toFixed(digits));
}

/* --------------------------------------------------------------------------
 * 长曝光 · ND
 * -------------------------------------------------------------------------- */

/** ND 减光镜档位（stops 为等效减光档数） */
export interface NdFilter {
  name: string;
  stops: number;
}

/** 常用减光镜预设 */
export const ND_FILTERS: readonly NdFilter[] = [
  { name: 'ND2 · 1档', stops: 1 },
  { name: 'ND4 · 2档', stops: 2 },
  { name: 'ND8 · 3档', stops: 3 },
  { name: 'ND16 · 4档', stops: 4 },
  { name: 'ND32 · 5档', stops: 5 },
  { name: 'ND64 · 6档', stops: 6 },
  { name: 'ND1000 · 10档', stops: 10 },
];

/** 长曝光换算：加 N 档减光 = 曝光时间乘以 2 的 N 次方 */
export function computeLongExposure(baseSeconds: number, stops: number): number {
  if (!Number.isFinite(baseSeconds) || baseSeconds <= 0) return 0;
  return baseSeconds * 2 ** stops;
}

/** 结果文案：主数值 + 解释性副标题 */
export interface ExposureText {
  value: string;
  sub: string;
}

/** 把秒数格式化成摄影人习惯的读法（秒 / 分之一秒 / 分钟 / 小时） */
export function formatExposure(seconds: number): ExposureText {
  if (!seconds) return { value: '—', sub: '请输入大于 0 的基准快门' };
  if (seconds > 3600) return { value: `${trimZero((seconds / 3600).toFixed(2))} h`, sub: `约 ${trimZero((seconds / 60).toFixed(0))} 分钟` };
  if (seconds > 60) return { value: `${trimZero((seconds / 60).toFixed(1))} m`, sub: `约 ${trimZero(seconds.toFixed(0))} 秒` };
  if (seconds >= 1) return { value: `${trimZero(seconds.toFixed(2))} s`, sub: `${trimZero(seconds.toFixed(0))} 秒` };
  if (seconds >= 1 / 1000) return { value: `${trimZero((1 / seconds).toFixed(0))} 分之一秒`, sub: `1/${Math.round(1 / seconds)}s` };
  return { value: '自定义', sub: `${trimZero((1 / seconds).toFixed(0))} 分之一秒` };
}

/* --------------------------------------------------------------------------
 * 曝光三角 · EV 换算
 * -------------------------------------------------------------------------- */

/** EV = log2(光圈² / 快门)；EV@ISO100 再按 ISO 归一 */
function computeEv(values: Record<string, number>): ToolResult {
  const aperture = values.aperture ?? 5.6;
  const shutter = values.shutter ?? 1 / 125;
  const iso = values.iso ?? 100;
  if (aperture <= 0 || shutter <= 0 || iso <= 0) {
    return { primary: '—', primarySub: '光圈 / 快门 / ISO 都需大于 0', rows: [] };
  }
  const ev = Math.log2((aperture * aperture) / shutter);
  const ev100 = ev - Math.log2(iso / 100);
  return {
    primary: `${fmt(ev, 1)} EV`,
    primarySub: '该组合的曝光值',
    rows: [
      { label: 'EV @ ISO100', value: `${fmt(ev100, 1)}` },
      { label: '相对中性灰', value: `${ev100 >= 0 ? '+' : ''}${fmt(ev100, 1)} 档` },
    ],
  };
}

/* --------------------------------------------------------------------------
 * 景深 / 超焦距
 * -------------------------------------------------------------------------- */

/** 传感器预设：弥散圆 CoC（mm）与画幅尺寸（mm）。下标即 select 选项的 value */
const SENSORS = [
  { label: '全画幅 36×24', coc: 0.03, w: 36, h: 24 },
  { label: 'APS-C 23.6×15.6', coc: 0.02, w: 23.6, h: 15.6 },
  { label: 'M4/3 17.3×13.0', coc: 0.015, w: 17.3, h: 13 },
] as const;

/** 景深：焦距 / 光圈 / 对焦距离 / 传感器 → 总景深 + 超焦距 + 前后景深点 */
function computeDof(values: Record<string, number>): ToolResult {
  const sensor = SENSORS[values.sensor ?? 0] ?? SENSORS[0];
  const focal = values.focal ?? 50; // mm
  const aperture = values.aperture ?? 2.8;
  const distance = values.distance ?? 5; // m
  if (focal <= 0 || aperture <= 0 || distance <= 0) {
    return { primary: '—', primarySub: '焦距 / 光圈 / 距离都需大于 0', rows: [] };
  }

  // 统一米制：f 与 c 都换算到米，套标准薄透镜景深公式
  const f = focal / 1000;
  const c = sensor.coc / 1000;
  const s = distance;
  const hyperfocal = (f * f) / (aperture * c) + f;

  let near: number;
  let far: number;
  if (s < hyperfocal) {
    near = (s * (hyperfocal - f)) / (hyperfocal + s - 2 * f);
    far = (s * (hyperfocal - f)) / (hyperfocal - s);
  } else {
    // 对焦达到/超过超焦距：远景深无穷，近景深约超焦距的一半
    near = hyperfocal / 2;
    far = Number.POSITIVE_INFINITY;
  }
  const total = far - near;

  return {
    primary: `${fmt(total)} m`,
    primarySub: '总景深范围',
    rows: [
      { label: '超焦距', value: `${fmt(hyperfocal)} m` },
      { label: '最近清晰点', value: `${fmt(near)} m` },
      { label: '最远清晰点', value: `${fmt(far)} m` },
    ],
  };
}

/* --------------------------------------------------------------------------
 * 焦距 - 视角
 * -------------------------------------------------------------------------- */

/** 视角：2·atan(画幅 / 2·焦距)，按传感器画幅给出水平/垂直/对角视角 + 等效焦距 */
function computeFov(values: Record<string, number>): ToolResult {
  const sensor = SENSORS[values.sensor ?? 0] ?? SENSORS[0];
  const focal = values.focal ?? 50; // mm
  if (focal <= 0) return { primary: '—', primarySub: '焦距需大于 0', rows: [] };

  const rad = (size: number): number => (2 * Math.atan(size / (2 * focal)) * 180) / Math.PI;
  const horizontal = rad(sensor.w);
  const vertical = rad(sensor.h);
  const diagonal = rad(Math.hypot(sensor.w, sensor.h));
  // 全画幅对角线 43.27mm 为基准的裁切系数 → 等效焦距
  const crop = 43.27 / Math.hypot(sensor.w, sensor.h);

  return {
    primary: `${fmt(diagonal, 1)}°`,
    primarySub: '对角视角',
    rows: [
      { label: '水平视角', value: `${fmt(horizontal, 1)}°` },
      { label: '垂直视角', value: `${fmt(vertical, 1)}°` },
      { label: '等效全画幅焦距', value: `${fmt(focal * crop, 0)} mm` },
    ],
  };
}

/* --------------------------------------------------------------------------
 * 白平衡 · 色温
 * -------------------------------------------------------------------------- */

/** 色温 K → mired，并判断常见场景 */
function computeColorTemp(values: Record<string, number>): ToolResult {
  const kelvin = values.kelvin ?? 5500;
  if (kelvin <= 0) return { primary: '—', primarySub: '色温需大于 0', rows: [] };

  const mired = 1_000_000 / kelvin;
  let scene = '日光 / 阴天';
  if (kelvin <= 2000) scene = '烛光';
  else if (kelvin <= 3000) scene = '钨丝灯 / 日出日落';
  else if (kelvin <= 4000) scene = '荧光灯 / 暖白';
  else if (kelvin <= 5000) scene = '日光灯 / 工作室';
  else if (kelvin <= 6500) scene = '日光 / 阴天';
  else if (kelvin <= 8000) scene = '阴影 / 蓝天';
  else scene = '深蓝天空';

  return {
    primary: `${fmt(mired, 0)} mired`,
    primarySub: scene,
    rows: [
      { label: '色温', value: `${fmt(kelvin, 0)} K` },
      { label: '白平衡倾向', value: mired > 154 ? '偏暖 (补偿黄)' : '偏冷 (补偿蓝)' },
    ],
  };
}

/* --------------------------------------------------------------------------
 * ToolRegistry：注册所有工具（前端唯一事实源）
 * -------------------------------------------------------------------------- */

export const TOOL_REGISTRY: readonly ToolDef[] = [
  {
    key: 'nd',
    name: '长曝光 · ND 计算',
    desc: '加 N 档减光 = 快门时间 × 2 的 N 次方',
    fields: [
      { key: 'base', label: '基准快门', type: 'number', unit: 's', step: 0.001, min: 0, default: 1 },
      { key: 'stops', label: '减光档位', type: 'select', default: ND_FILTERS[0].stops, options: ND_FILTERS.map((f) => ({ label: f.name, value: f.stops })) },
    ],
    compute(values) {
      const seconds = computeLongExposure(values.base ?? 1, values.stops ?? ND_FILTERS[0].stops);
      const text = formatExposure(seconds);
      const preset = ND_FILTERS.find((f) => f.stops === (values.stops ?? ND_FILTERS[0].stops))!;
      return { primary: text.value, primarySub: text.sub, rows: [{ label: '减光镜', value: preset.name }] };
    },
  },
  {
    key: 'ev',
    name: '曝光三角 · EV 换算',
    desc: '由光圈 / 快门 / ISO 计算曝光值与档位',
    fields: [
      { key: 'aperture', label: '光圈', type: 'number', unit: 'f/', step: 0.1, min: 0.5, default: 5.6 },
      { key: 'shutter', label: '快门', type: 'number', unit: 's', step: 0.001, min: 0, default: 1 / 125 },
      { key: 'iso', label: '感光度', type: 'number', unit: 'ISO', step: 50, min: 50, default: 100 },
    ],
    compute: computeEv,
  },
  {
    key: 'dof',
    name: '景深 / 超焦距',
    desc: '输入焦距 / 光圈 / 距离，计算前后景深范围',
    fields: [
      { key: 'sensor', label: '传感器', type: 'select', default: 0, options: SENSORS.map((s, i) => ({ label: s.label, value: i })) },
      { key: 'focal', label: '焦距', type: 'number', unit: 'mm', step: 1, min: 1, default: 50 },
      { key: 'aperture', label: '光圈', type: 'number', unit: 'f/', step: 0.1, min: 0.5, default: 2.8 },
      { key: 'distance', label: '对焦距离', type: 'number', unit: 'm', step: 0.1, min: 0.1, default: 5 },
    ],
    compute: computeDof,
  },
  {
    key: 'fov',
    name: '焦距 - 视角',
    desc: '由焦距与传感器换算水平 / 垂直 / 对角视角',
    fields: [
      { key: 'sensor', label: '传感器', type: 'select', default: 0, options: SENSORS.map((s, i) => ({ label: s.label, value: i })) },
      { key: 'focal', label: '焦距', type: 'number', unit: 'mm', step: 1, min: 1, default: 50 },
    ],
    compute: computeFov,
  },
  {
    key: 'color_temp',
    name: '白平衡 · 色温',
    desc: '色温 K 与 mired 换算，判断常见场景',
    fields: [
      { key: 'kelvin', label: '色温', type: 'number', unit: 'K', step: 100, min: 1000, default: 5500 },
    ],
    compute: computeColorTemp,
  },
];

/** 由 key 取工具；找不到返回 undefined（前端用它来决定是否已有实现） */
export function toolOf(key: string): ToolDef | undefined {
  return TOOL_REGISTRY.find((tool) => tool.key === key);
}

/* --------------------------------------------------------------------------
 * 面板型工具注册表（本地 EXIF 编辑这类需要独立面板的工具）
 *
 * 与上面的 ToolDef 是**平行的两条契约**：
 *   - ToolDef 是「纯计算器」：声明 fields + compute，前端遍历渲染即可，零副作用；
 *   - PanelToolDef 是「工作台」：本身不带 compute，点开进入各端单独实现的独立面板
 *     （本地 EXIF 编辑需要选文件、改字节、导出，无法纳入 compute 的形态）。
 * 因此新增注册表而不动 TOOL_REGISTRY —— 既有工具与两端渲染逻辑完全不受影响。
 * -------------------------------------------------------------------------- */

/** 面板型工具：不自带 compute，而是打开一个两端各自实现的独立工作台 */
export interface PanelToolDef {
  key: string;
  name: string;
  desc: string;
  /** 图标名，两端各自的 Icon 组件里按同名实现 */
  icon: string;
  /** 是否免登录可用（本地工具为 true；避免误挂到需鉴权的工具上） */
  local: boolean;
}

export const PANEL_TOOL_REGISTRY: readonly PanelToolDef[] = [
  { key: 'exif-edit', name: '拍摄参数编辑', desc: '在本机导入照片，批量修改拍摄信息后导出（免登录 · 断网可用）', icon: 'sliders', local: true },
];