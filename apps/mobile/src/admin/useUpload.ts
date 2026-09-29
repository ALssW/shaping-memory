/**
 * apps/mobile/src/admin/useUpload.ts
 *
 * 移动端后台上传：系统相册选图 → photoApi.upload → 成功后返回新照片。
 * 权限（相机/相册）被拒时不抛异常，返回 null 让调用方静默忽略。
 */
import { useCallback, useState } from 'react';
import * as ImagePicker from 'expo-image-picker';
import { photoApi } from '@shaping-memory/sdk';
import type { Photo } from '@shaping-memory/core';

export interface UploadState {
  uploading: boolean;
  error: string | null;
  /** 选图 + 上传；取消或权限被拒返回 null */
  pickAndUpload: () => Promise<Photo | null>;
  resetError: () => void;
}

export function useUpload(onUploaded: (photo: Photo) => void): UploadState {
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const pickAndUpload = useCallback(async (): Promise<Photo | null> => {
    setError(null);
    // iOS/Android 14 起需显式申请媒体权限；被拒时静默返回，不打断后台使用
    const permission = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!permission.granted) return null;

    const result = await ImagePicker.launchImageLibraryAsync({
      /* SDK 52 起 MediaTypeOptions 已弃用，改用 MediaType 数组写法（与 lib/localExif.ts 同口径）；
         沿用旧写法会在界面上弹出一条弃用警告黄条 */
      mediaTypes: ['images'],
      quality: 1,
    });
    if (result.canceled) return null;
    const asset = result.assets[0];
    if (!asset) return null;

    setUploading(true);
    try {
      /* 返回值是「照片 + 云端同步结果」：移动端没有上传报告界面，这里只取照片本体，
         云端副本缺失（result.upload.failed > 0）留给服务器端 backfill 保底。 */
      const result = await photoApi.upload({
        uri: asset.uri,
        name: asset.fileName ?? `photo-${Date.now()}.jpg`,
        type: asset.mimeType,
      });
      onUploaded(result.photo);
      return result.photo;
    } catch (err) {
      setError(err instanceof Error ? err.message : '上传失败');
      return null;
    } finally {
      setUploading(false);
    }
  }, [onUploaded]);

  return { uploading, error, pickAndUpload, resetError: () => setError(null) };
}