/**
 * packages/core/src/exif.ts
 *
 * EXIF 卡片的展示内容。放在 core 而不是各端各写一遍：
 * Web 查看器与移动端查看器要展示的是同一批字段，重复维护迟早会出现不一致。
 *
 * 【两套输出并存，因为两端要的形状不同】
 *   - exifRows：平坦的「标签 → 值」表，字段顺序固定、空值也占一行 ——
 *     移动端的元数据列表按它渲染（空值行在那里是「字段存在但没读到」的答案）；
 *   - exifSections：分组卡片（基本信息 / 拍摄参数 / 设备信息），拍摄参数收成
 *     四枚「图标 + 值」标签、空值行不出现 —— Web 查看器的拍摄信息卡片按它渲染。
 */
import { fileSizeOf, formatDate, formatDateTime, megapixelsOf, resolutionOf } from './mock';
import type { Photo } from './types';

/** 顺序即展示顺序 */
export function exifRows(photo: Photo): ReadonlyArray<readonly [string, string]> {
  // 分辨率行只在像素宽高都到位时才出现 —— 旧照片若没读到 EXIF 尺寸，留空比写「 × 」更恰当
  const resolution = resolutionOf(photo);
  const rows: Array<readonly [string, string]> = [
    ['相机', photo.cam],
    ['镜头', photo.lens],
    ['焦距', photo.focal],
    ['光圈', photo.aperture],
    ['快门', photo.speed],
    // ISO 是唯一以数字存储的字段：没读到 EXIF 感光度时是 null，
    // 直接 String() 会渲染出字面量「null」。空值统一给空串，与其他行的留白口径一致。
    ['ISO', photo.iso == null ? '' : String(photo.iso)],
    ['色温', photo.temp],
    ['白平衡', photo.wb],
  ];
  if (resolution) rows.push(['分辨率', resolution]);
  // 拍摄地点同样只在真有定位时才落这一行：上面那些空值行是「字段存在但没读到」，
  // 而「这张照片本身没有定位」性质不同 —— 后者留一行空白只会使读者误判为数据缺失。
  if (photo.place) rows.push(['拍摄地点', photo.place]);
  rows.push(
    ['拍摄日期', formatDate(photo.date)],
    ['分类', photo.cat],
    ['喜爱', `${photo.likes}`],
  );
  return rows;
}

/**
 * 拍摄参数的一枚「图标 + 值」标签（焦距 / 光圈 / 快门 / ISO）。
 * icon 取的是 Web 端 Icon 组件的名字口径 —— core 不引任何渲染层依赖，
 * 这里只把「该配哪枚图标」这件展示决策定下来，两端各取所需。
 */
export interface ExifChip {
  icon: 'focus' | 'aperture' | 'timer' | 'gauge';
  value: string;
}

/** 卡片的一个分组：标题 + 顶部的图标标签（可为空）+ 「标签 → 值」行 */
export interface ExifSection {
  title: string;
  /** 只归「拍摄参数」使用；空数组即不渲染这一行 */
  chips: readonly ExifChip[];
  rows: ReadonlyArray<readonly [string, string]>;
}

/** 焦距统一成「200mm」：库里两种写法（「200.0 mm」与「200mm」）在卡片上必须同形 */
function tidyFocal(raw: string): string {
  const matched = /^([\d.]+)\s*mm$/i.exec(raw.trim());
  return matched ? `${Number(matched[1])}mm` : raw.trim();
}

/** 快门统一补上秒单位：「1/500」→「1/500s」（库里大于等于 1 秒的写法本就带 s） */
function tidySpeed(raw: string): string {
  const value = raw.trim();
  if (!value) return '';
  return value.endsWith('s') ? value : `${value}s`;
}

/** 空值行不进卡片：卡片回答的是「这张照片有什么」，留一行空白只会被读成数据缺失 */
function dropEmpty(rows: ReadonlyArray<readonly [string, string]>): Array<readonly [string, string]> {
  return rows.filter(([, value]) => value !== '');
}

/**
 * Web 查看器的拍摄信息卡片：分组 + 分组内的行，拍摄参数收成四枚图标标签。
 * 组件名与字段名一一对应（基本信息 / 拍摄参数 / 设备信息）。
 */
export function exifSections(photo: Photo): ExifSection[] {
  const chips: ExifChip[] = [
    { icon: 'focus', value: tidyFocal(photo.focal) },
    { icon: 'aperture', value: photo.aperture.trim() },
    { icon: 'timer', value: tidySpeed(photo.speed) },
    // ISO 是唯一以数字存储的字段，没读到感光度时为 null；带「ISO」前缀才自解释
    { icon: 'gauge', value: photo.iso == null ? '' : `ISO ${photo.iso}` },
  ];

  return [
    {
      title: '基本信息',
      chips: [],
      rows: dropEmpty([
        ['文件名', photo.originalName ?? ''],
        ['格式', photo.format],
        ['尺寸', resolutionOf(photo)],
        ['文件大小', fileSizeOf(photo.originalSize)],
        ['像素', megapixelsOf(photo)],
        ['拍摄时间', formatDateTime(photo.takenAt, photo.date)],
        ['拍摄地点', photo.place],
        ['分类', photo.cat],
        ['喜爱', `${photo.likes}`],
      ]),
    },
    {
      title: '拍摄参数',
      chips: chips.filter((chip) => chip.value !== ''),
      rows: dropEmpty([
        ['色温', photo.temp],
        ['白平衡', photo.wb],
      ]),
    },
    {
      title: '设备信息',
      chips: [],
      rows: dropEmpty([
        ['相机', photo.cam],
        ['镜头', photo.lens],
      ]),
    },
  ].filter((section) => section.chips.length > 0 || section.rows.length > 0);
}