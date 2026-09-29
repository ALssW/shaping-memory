/**
 * packages/core/src/exif.ts
 *
 * EXIF 面板的展示行（标签 + 值）。放在 core 而不是各端各写一遍：
 * Web 查看器与移动端查看器要展示的是同一张表，重复维护迟早会出现不一致。
 */
import { formatDate, resolutionOf } from './mock';
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