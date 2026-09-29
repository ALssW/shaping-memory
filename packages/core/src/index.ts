/**
 * packages/core/src/index.ts
 *
 * 领域层统一出口。Web 前台与 RN 移动端都从这里取数据与纯函数：
 * 单一事实源，从编译期保证两端功能与内容一致（产品设计方案 §4.1）。
 */
export * from './types';
export * from './mock';
export * from './dictionary';
export * from './exposure-presets';
export * from './exif';
export * from './exif-fields';
export * from './exif-container';
export * from './exif-io';
export * from './exif-read';
export * from './exif-tiff-write';
export * from './exif-png-write';
export * from './exif-write';
export * from './exif-values';
export * from './geo';
export * from './geocode';
export * from './map-cluster';
export * from './layout';
export * from './timeline';
export * from './timeGroups';
export * from './rail';
export * from './tools';
export * from './tagging';
export * from './theme';