/**
 * packages/core/src/map-cluster.ts
 *
 * 地图画廊的「按缩放级别分组」算法 —— 纯函数、零依赖，Web 与移动端共用一份事实源。
 *
 * 【为什么用屏幕像素网格，而不是 DBSCAN / 地面距离分档】
 * 地图本身就是屏幕像素空间：同一批点在缩放一层后，投到像素网格里的密度**自动**减半，
 * 于是「缩小时并簇、放大时散开」是自然涌现的结果，不需要额外写 zoom → 阈值的对照表。
 * DBSCAN 之类要在地面距离上调参，缩放时还得再配一张 ε 表，两套参数相互制约，
 * 总会在某几档上出现抖动。像素网格只留一个参数（格边长），且它是**屏幕**常量。
 *
 * 【坐标系口径】聚类在 WGS-84 空间做，标记落点由调用方再转底图坐标系。
 * GCJ-02 的偏移在国内是 300–600 米的近似平移，同一格（最细约 33 米）内的照片
 * 在两种坐标系下几乎必然仍同格 —— 因此切底图时分组不会重排，只是整体挪到真实位置。
 */
import { isValidLatLon } from './geo';
import type { Photo } from './types';

/** 一张照片是否「可上图」：有定位，且不是 (0,0) 这种未设置的空点 */
export function hasGps(photo: Photo): boolean {
  const gps = photo.gps;
  if (!gps) return false;
  return isValidLatLon(gps.lat, gps.lon);
}

/** 读出照片的定位（调用前需确认 hasGps；0,0 已被过滤，因此这里可以直接取值） */
function gpsOf(photo: Photo): { lat: number; lon: number } {
  return { lat: photo.gps?.lat ?? 0, lon: photo.gps?.lon ?? 0 };
}

/**
 * 一个聚类结果。
 * `photos.length === 1` → 渲染缩略图针脚；`>= 2` → 渲染「圆点 + 张数」。
 */
export interface PhotoCluster {
  /** 网格键：同一批照片跨渲染稳定，用作 marker 复用依据与列表 key */
  key: string;
  /** 成员定位的质心（WGS-84） */
  lat: number;
  lon: number;
  /** 成员照片（保持入参顺序） */
  photos: Photo[];
}

export interface ClusterOptions {
  /** 地图当前缩放级 */
  zoom: number;
  /**
   * 聚类格边长（**屏幕**像素）。Web 64 / 移动端竖屏 56。
   * 这是唯一的算法参数：它决定了「多近算相邻」。
   */
  cellPx: number;
  /** 标记数上限：超出则把格边长翻倍重算，避免给 Leaflet 塞上千个节点 */
  maxMarkers: number;
}

/** 瓦片边长（Leaflet 默认 256），用于把归一化墨卡托坐标还原成像素 */
const TILE_SIZE = 256;
/** 墨卡托能表示的最大纬度 */
const MAX_LAT = 85.05112878;
/** 撞上 maxMarkers 后最多粗化几轮，避免病态数据下无限循环 */
const MAX_COARSEN_STEPS = 3;

/** 经度 → 归一化墨卡托 x（0..1） */
function projectX(lon: number): number {
  return (lon + 180) / 360;
}

/** 纬度 → 归一化墨卡托 y（0..1，北为 0） */
function projectY(lat: number): number {
  const clamped = lat > MAX_LAT ? MAX_LAT : lat < -MAX_LAT ? -MAX_LAT : lat;
  const rad = (clamped * Math.PI) / 180;
  return (1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2;
}

/** 散列里的累加器：边求和边记成员，省掉一次中间数组 */
interface Bucket {
  sumLat: number;
  sumLon: number;
  photos: Photo[];
}

/** 按「屏幕像素网格」切桶，返回未排序的簇 */
function bucketize(photos: readonly Photo[], zoom: number, cellPx: number): PhotoCluster[] {
  const worldPx = TILE_SIZE * 2 ** zoom;
  const buckets = new Map<string, Bucket>();

  for (const photo of photos) {
    const { lat, lon } = gpsOf(photo);
    // 归一化坐标 → 当前 zoom 下的像素坐标 → 除以格边长取整，即格号
    const gx = Math.floor((projectX(lon) * worldPx) / cellPx);
    const gy = Math.floor((projectY(lat) * worldPx) / cellPx);
    const key = `${gx}:${gy}`;
    const bucket = buckets.get(key);
    if (bucket) {
      bucket.sumLat += lat;
      bucket.sumLon += lon;
      bucket.photos.push(photo);
    } else {
      buckets.set(key, { sumLat: lat, sumLon: lon, photos: [photo] });
    }
  }

  const clusters: PhotoCluster[] = [];
  for (const [key, bucket] of buckets) {
    const count = bucket.photos.length;
    clusters.push({
      key,
      lat: bucket.sumLat / count,
      lon: bucket.sumLon / count,
      photos: bucket.photos,
    });
  }
  return clusters;
}

/**
 * 把照片按当前缩放级聚成簇。
 *
 * 【为什么不做视口裁剪】视口外的簇照常算出来。这样平移时标记是「本来就在那儿」，
 * 而不是「滚进来才长出来」——后者会读成闪烁。
 *
 * 【返回顺序】按成员数升序（同数量再按键升序）。大簇排在后面，视图层据此把
 * 它画在上层，密集区不会把计数点埋在小针脚底下。
 */
export function clusterPhotosByZoom(photos: readonly Photo[], options: ClusterOptions): PhotoCluster[] {
  const { zoom, cellPx, maxMarkers } = options;
  let currentCell = cellPx;
  let clusters = bucketize(photos, zoom, currentCell);

  // 节点数超上限就粗化网格重算：优先减少标记数量，避免地图卡顿
  for (let step = 0; step < MAX_COARSEN_STEPS && clusters.length > maxMarkers; step += 1) {
    currentCell *= 2;
    clusters = bucketize(photos, zoom, currentCell);
  }

  clusters.sort((a, b) => {
    if (a.photos.length !== b.photos.length) return a.photos.length - b.photos.length;
    return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
  });
  return clusters;
}
