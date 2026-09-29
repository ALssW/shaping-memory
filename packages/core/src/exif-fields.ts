/**
 * packages/core/src/exif-fields.ts
 *
 * 全量可编辑 EXIF 字段规格 —— 后台编辑器与后端写回共用同一份「单一事实源」。
 *
 * 【为什么放在 core】这份规格要被两端同时消费：
 *   - 后台前端：按 group 分组渲染表单，按 type 选组件（Input/InputNumber/Select/DatePicker/Tags）
 *   - 后端 packages/exif：据此拼 exiftool 的读 tag 列表与写参数
 * 放在 core（纯数据 + 纯类型，不依赖 node / DOM）才能被浏览器安全引入。
 *
 * 【约定：tag 一律用 exiftool 短名，读写都带 -n】
 * `-n` 关闭 exiftool 的「打印转换」，读出来即原始值（FNumber 读作 4 而非 "f/4.0"，
 * WhiteBalance 读作 1 而非 "Manual"），写回去也是同一个数值 —— 这样「读 → 改 → 写」
 * 能无损往返。因此下面所有枚举型字段的 option.value 都是**数字字符串**。
 * 面向人的可读形态（f/4.0、1/200、5226K）由前端的展示列（cam/lens/...）单独负责。
 */

/** 表单控件形态：决定后台用哪个 AntD 组件渲染 */
export type ExifFieldType = 'text' | 'textarea' | 'number' | 'select' | 'datetime' | 'tags';

export interface ExifFieldOption {
  /** exiftool -n 下的原始值（枚举型一律数字字符串） */
  value: string;
  label: string;
}

export interface ExifField {
  /** exiftool 短名，读写都用它 */
  tag: string;
  label: string;
  group: string;
  type: ExifFieldType;
  /** 单位后缀（数字型），仅用于输入框右侧提示 */
  unit?: string;
  placeholder?: string;
  /** 一行灰字说明，解释该参数的实际作用 */
  hint?: string;
  options?: readonly ExifFieldOption[];
  min?: number;
  max?: number;
  step?: number;
}

/** 分组顺序 = 后台表单的 tab / 折叠面板顺序 */
export const EXIF_GROUPS = [
  '基本信息',
  '相机与镜头',
  '曝光参数',
  '日期时间',
  '地理位置',
  '作者与版权',
  '其他',
] as const;

export type ExifGroup = (typeof EXIF_GROUPS)[number];

/** 方向：1..8，写错会让浏览器/看图软件把竖片当横片 */
const ORIENTATION_OPTIONS: readonly ExifFieldOption[] = [
  { value: '1', label: '1 · 正常' },
  { value: '2', label: '2 · 水平镜像' },
  { value: '3', label: '3 · 旋转 180°' },
  { value: '4', label: '4 · 垂直镜像' },
  { value: '5', label: '5 · 顺时针 90° + 镜像' },
  { value: '6', label: '6 · 顺时针 90°' },
  { value: '7', label: '7 · 逆时针 90° + 镜像' },
  { value: '8', label: '8 · 逆时针 90°' },
];

/** 三态型参数（对比度/饱和度/锐度）共用同一组取值 */
const TRISTATE_OPTIONS: readonly ExifFieldOption[] = [
  { value: '0', label: '标准' },
  { value: '1', label: '低' },
  { value: '2', label: '高' },
];

/**
 * 全量字段清单。顺序即表单内顺序。
 * 覆盖面：文件描述 / 相机机身镜头 / 曝光三要素与测光闪光 / 拍摄时间 / GPS / 版权作者 / 关键词分类。
 * 清单之外的冷门 tag 由后台的「自定义 tag」区块保底（任意 Tag=Value 都能写）。
 */
export const EXIF_FIELDS: readonly ExifField[] = [
  /* ---------------- 基本信息 ---------------- */
  {
    tag: 'ImageDescription',
    label: '图像描述',
    group: '基本信息',
    type: 'textarea',
    placeholder: '这张照片拍的是什么',
  },
  {
    tag: 'Orientation',
    label: '方向',
    group: '基本信息',
    type: 'select',
    options: ORIENTATION_OPTIONS,
    hint: '决定看图软件是否自动旋转；改错会让竖片显示成横片',
  },
  {
    tag: 'Rating',
    label: '星级',
    group: '基本信息',
    type: 'number',
    min: 0,
    max: 5,
    step: 1,
    hint: '0–5 星，用于选片排序',
  },

  /* ---------------- 相机与镜头 ---------------- */
  { tag: 'Make', label: '相机厂商', group: '相机与镜头', type: 'text', placeholder: 'SONY / Canon / NIKON' },
  { tag: 'Model', label: '相机型号', group: '相机与镜头', type: 'text', placeholder: 'ILCE-7M4' },
  { tag: 'LensMake', label: '镜头厂商', group: '相机与镜头', type: 'text' },
  { tag: 'LensModel', label: '镜头型号', group: '相机与镜头', type: 'text', placeholder: 'FE 24-70mm F2.8 GM II' },
  { tag: 'SerialNumber', label: '机身序列号', group: '相机与镜头', type: 'text' },
  { tag: 'LensSerialNumber', label: '镜头序列号', group: '相机与镜头', type: 'text' },
  { tag: 'OwnerName', label: '机身所有者', group: '相机与镜头', type: 'text' },

  /* ---------------- 曝光参数 ---------------- */
  {
    tag: 'ExposureProgram',
    label: '曝光程序',
    group: '曝光参数',
    type: 'select',
    options: [
      { value: '0', label: '未定义' },
      { value: '1', label: '手动 M' },
      { value: '2', label: '程序自动 P' },
      { value: '3', label: '光圈优先 A' },
      { value: '4', label: '快门优先 S' },
      { value: '5', label: '创意程序' },
      { value: '6', label: '运动程序' },
      { value: '7', label: '人像程序' },
      { value: '8', label: '风景程序' },
    ],
  },
  {
    tag: 'ExposureTime',
    label: '快门速度',
    group: '曝光参数',
    type: 'number',
    unit: 's',
    step: 0.0001,
    hint: '以秒为单位：0.005 即 1/200s',
  },
  { tag: 'FNumber', label: '光圈', group: '曝光参数', type: 'number', unit: 'f/', step: 0.1, hint: '2.8 即 f/2.8' },
  { tag: 'ISO', label: 'ISO', group: '曝光参数', type: 'number', step: 1 },
  {
    tag: 'ExposureCompensation',
    label: '曝光补偿',
    group: '曝光参数',
    type: 'number',
    unit: 'EV',
    step: 0.1,
    hint: '负数为减曝，正数为加曝',
  },
  {
    tag: 'MeteringMode',
    label: '测光模式',
    group: '曝光参数',
    type: 'select',
    options: [
      { value: '0', label: '未知' },
      { value: '1', label: '平均测光' },
      { value: '2', label: '中央重点' },
      { value: '3', label: '点测光' },
      { value: '4', label: '多点测光' },
      { value: '5', label: '评价测光' },
      { value: '6', label: '局部测光' },
      { value: '255', label: '其他' },
    ],
  },
  {
    tag: 'Flash',
    label: '闪光灯',
    group: '曝光参数',
    type: 'select',
    options: [
      { value: '0', label: '未闪光' },
      { value: '1', label: '闪光' },
      { value: '9', label: '强制闪光' },
      { value: '16', label: '强制不闪光' },
      { value: '24', label: '自动不闪光' },
      { value: '25', label: '自动闪光' },
      { value: '32', label: '无闪光功能' },
    ],
  },
  {
    tag: 'WhiteBalance',
    label: '白平衡',
    group: '曝光参数',
    type: 'select',
    options: [
      { value: '0', label: '自动' },
      { value: '1', label: '手动' },
    ],
  },
  {
    tag: 'ColorTemperature',
    label: '色温',
    group: '曝光参数',
    type: 'number',
    unit: 'K',
    step: 1,
    hint: '仅在手动白平衡下有效',
  },
  { tag: 'FocalLength', label: '焦距', group: '曝光参数', type: 'number', unit: 'mm', step: 1 },
  {
    tag: 'FocalLengthIn35mmFormat',
    label: '等效焦距',
    group: '曝光参数',
    type: 'number',
    unit: 'mm',
    step: 1,
    hint: '折算到 135 画幅后的焦距',
  },
  { tag: 'MaxApertureValue', label: '最大光圈', group: '曝光参数', type: 'number', unit: 'f/', step: 0.1 },
  { tag: 'SubjectDistance', label: '对焦距离', group: '曝光参数', type: 'number', unit: 'm', step: 0.01 },
  { tag: 'DigitalZoomRatio', label: '数码变焦', group: '曝光参数', type: 'number', unit: '×', step: 0.1 },
  {
    tag: 'SceneCaptureType',
    label: '场景类型',
    group: '曝光参数',
    type: 'select',
    options: [
      { value: '0', label: '标准' },
      { value: '1', label: '风景' },
      { value: '2', label: '人像' },
      { value: '3', label: '夜景' },
    ],
  },
  { tag: 'Contrast', label: '对比度', group: '曝光参数', type: 'select', options: TRISTATE_OPTIONS },
  { tag: 'Saturation', label: '饱和度', group: '曝光参数', type: 'select', options: TRISTATE_OPTIONS },
  { tag: 'Sharpness', label: '锐度', group: '曝光参数', type: 'select', options: TRISTATE_OPTIONS },

  /* ---------------- 日期时间 ---------------- */
  {
    tag: 'DateTimeOriginal',
    label: '原始拍摄时间',
    group: '日期时间',
    type: 'datetime',
    hint: '时间线分组按它排序，改动会改变照片在时间线中的位置',
  },
  { tag: 'CreateDate', label: '创建时间', group: '日期时间', type: 'datetime' },
  { tag: 'ModifyDate', label: '修改时间', group: '日期时间', type: 'datetime' },
  { tag: 'OffsetTimeOriginal', label: '时区偏移', group: '日期时间', type: 'text', placeholder: '+08:00' },

  /* ---------------- 地理位置（经纬度由地图选点写入，这里只放补充项） ---------------- */
  { tag: 'GPSAltitude', label: '海拔', group: '地理位置', type: 'number', unit: 'm', step: 0.1 },
  {
    tag: 'GPSImgDirection',
    label: '镜头朝向',
    group: '地理位置',
    type: 'number',
    unit: '°',
    min: 0,
    max: 360,
    step: 1,
    hint: '正北为 0°，顺时针增大',
  },
  { tag: 'GPSImgDirectionRef', label: '朝向参考', group: '地理位置', type: 'select', options: [
    { value: 'T', label: '真北 (T)' },
    { value: 'M', label: '磁北 (M)' },
  ] },

  /* ---------------- 作者与版权 ---------------- */
  { tag: 'Artist', label: '作者', group: '作者与版权', type: 'text' },
  { tag: 'Copyright', label: '版权', group: '作者与版权', type: 'text', placeholder: '© 2026 你的名字' },
  { tag: 'Software', label: '处理软件', group: '作者与版权', type: 'text' },
  { tag: 'UserComment', label: '用户备注', group: '作者与版权', type: 'textarea' },

  /* ---------------- 其他 ---------------- */
  {
    tag: 'Subject',
    label: '关键词',
    group: '其他',
    type: 'tags',
    hint: '用于标记照片拍了什么，支持中文；输入后回车可添加多个关键词',
  },
  {
    tag: 'Category',
    label: 'EXIF 分类',
    group: '其他',
    type: 'text',
    hint: '随照片一起保存的分类信息，与站内分类（风光/街拍…）互不影响',
  },
];

/** 按 tag 取字段规格（后台渲染 / 后端校验都要用） */
export function exifFieldOf(tag: string): ExifField | undefined {
  return EXIF_FIELDS.find((field) => field.tag === tag);
}

/** 按分组切分字段，返回「分组名 → 字段数组」，供后台直接 map 渲染 */
export function exifFieldsByGroup(): ReadonlyArray<readonly [ExifGroup, readonly ExifField[]]> {
  return EXIF_GROUPS.map((group) => [group, EXIF_FIELDS.filter((f) => f.group === group)] as const).filter(
    ([, fields]) => fields.length > 0,
  );
}

/** 可编辑 tag 的只读集合（后端白名单：拒绝写清单之外的 tag 走常规通道） */
export const EXIF_EDITABLE_TAGS: ReadonlySet<string> = new Set(EXIF_FIELDS.map((f) => f.tag));

/** GPS 三要素的 tag 名（地图选点直接写这三个） */
export const GPS_TAGS = {
  lat: 'GPSLatitude',
  lon: 'GPSLongitude',
  alt: 'GPSAltitude',
} as const;
