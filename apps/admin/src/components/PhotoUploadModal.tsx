/**
 * apps/admin/src/components/PhotoUploadModal.tsx
 *
 * 批量上传照片（Modal + Upload.Dragger）。
 *
 * 【校验在前、上传在后】拖入后先按扩展名与体积校验（体积上限、允许的扩展名都读系统设置），
 * 不合格的文件直接以 LIST_IGNORE 移出列表，避免数 GB 的文件在传输后被后端拒绝。
 * 【为什么自己维护进度列表】用 showUploadList={false} 关掉 antd 的列表，
 * 进度项由本组件自己维护（key = RcFile.uid）——这样「本轮成功/失败各几张」「全部结束后刷新列表」
 * 都能精确控制，不必和 antd 的内部状态互相同步。
 * 【入参形态说明】sdk 的 photoApi.upload 接受 UploadFileBody = Blob | { uri, name, type }，
 * Web 端直接把 antd 给的 File 传进去即可（File 是 Blob 的子类，FormData 原生支持）。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { App, Button, Modal, Progress, Space, Tag, Upload } from 'antd';
import type { UploadProps } from 'antd';
import { photoApi } from '@shaping-memory/sdk';

import { ACCEPT, FALLBACK_RULES, extOf, loadUploadRules } from '../lib/uploadRules';
import type { UploadRules } from '../lib/uploadRules';

/** 上传进度项（本组件自己的列表，与 antd 内部列表无关） */
interface UploadItem {
  uid: string;
  name: string;
  status: 'uploading' | 'done' | 'error';
  error?: string;
  /** 文件已入库，但云端副本未完整上传（对象存储不稳定或凭据错误）—— 不影响本机与前台 */
  cloudFailed?: boolean;
}

interface PhotoUploadModalProps {
  open: boolean;
  onClose: () => void;
  /** 本轮有成功上传时回调（用于刷新照片列表） */
  onUploaded: () => void;
}

export function PhotoUploadModal({ open, onClose, onUploaded }: PhotoUploadModalProps) {
  const { message } = App.useApp();
  const [items, setItems] = useState<UploadItem[]>([]);
  const [rules, setRules] = useState<UploadRules>(FALLBACK_RULES);
  const [uploading, setUploading] = useState(false);
  /**
   * 当前上传批次：pending=在途数、ok/fail=成败数、cloudFailed=已入库但云端副本未完整上传的张数。
   * 用「对象」而非几个独立 useRef —— 每次打开弹窗换一个新对象，
   * 「后台继续上传」留在途的旧请求闭包仍指向旧对象，计数不会混入新一轮。
   */
  const batchRef = useRef({ pending: 0, ok: 0, fail: 0, cloudFailed: 0 });

  // 每次打开重置进度与计数器，并读取最新的体积上限 / 允许格式
  useEffect(() => {
    if (!open) return;
    setItems([]);
    setUploading(false);
    batchRef.current = { pending: 0, ok: 0, fail: 0, cloudFailed: 0 };
    let cancelled = false;
    loadUploadRules()
      .then((loaded) => {
        if (cancelled) return;
        // 读取不到设置时不阻断上传：使用保底值，后端落盘前还会再校验一次
        if (!loaded) {
          message.warning(`系统设置读取失败，本次按默认限制校验（${FALLBACK_RULES.maxMb} MB）`);
          return;
        }
        setRules(loaded);
      })
      .catch(() => {
        if (!cancelled) message.warning('系统设置读取失败，本次按默认限制校验');
      });
    return () => {
      cancelled = true;
    };
  }, [open, message]);

  /** 单文件上传：更新自己那条进度项，最后一个请求结束时汇总提示 */
  const doUpload = useCallback(
    async (file: File & { uid: string }, options: Parameters<NonNullable<UploadProps['customRequest']>>[0]) => {
      // 捕获本请求所属批次：重开后 batchRef 指向新对象，旧请求的计数不会混入新一轮
      const batch = batchRef.current;
      try {
        const result = await photoApi.upload(file);
        batch.ok += 1;
        // 云端副本未完整上传不计为失败：照片已入库、本地也存在，仅缺少一份异地副本
        const cloudFailed = result.upload.failed > 0;
        if (cloudFailed) batch.cloudFailed += 1;
        setItems((prev) =>
          prev.map((item) =>
            item.uid === file.uid ? { ...item, status: 'done' as const, cloudFailed } : item,
          ),
        );
        options.onSuccess?.(result.photo);
      } catch (error) {
        batch.fail += 1;
        const text = error instanceof Error ? error.message : '上传失败';
        setItems((prev) =>
          prev.map((item) =>
            item.uid === file.uid ? { ...item, status: 'error' as const, error: text } : item,
          ),
        );
        options.onError?.(error instanceof Error ? error : new Error(text));
      } finally {
        batch.pending -= 1;
        if (batch.pending > 0) return;
        setUploading(false);
        if (batch.ok > 0) message.success(`上传成功 ${batch.ok} 张`);
        if (batch.fail > 0) message.error(`上传失败 ${batch.fail} 张`);
        // 使用 warning 而非 error：照片本身已正常入库，缺失的仅为「异地副本」
        if (batch.cloudFailed > 0) {
          message.warning(
            `${batch.cloudFailed} 张未同步到云端，可在服务器执行 npm run backfill:objects 补传`,
          );
        }
        if (batch.ok > 0) onUploaded();
      }
    },
    [message, onUploaded],
  );

  const beforeUpload: UploadProps['beforeUpload'] = (file) => {
    if (!rules.formats.includes(extOf(file.name))) {
      message.error(`「${file.name}」格式不支持，仅允许 ${rules.formats.join(' ')}`);
      return Upload.LIST_IGNORE;
    }
    if (file.size / 1024 / 1024 > rules.maxMb) {
      message.error(`「${file.name}」超过 ${rules.maxMb} MB 上限`);
      return Upload.LIST_IGNORE;
    }
    // 先挂上进度项：customRequest 收到的是同一个 RcFile，uid 一致，能对上
    setItems((prev) => [...prev, { uid: file.uid, name: file.name, status: 'uploading' }]);
    batchRef.current.pending += 1;
    setUploading(true);
    return true;
  };

  const customRequest: UploadProps['customRequest'] = (options) => {
    void doUpload(options.file as unknown as File & { uid: string }, options);
  };

  const doneCount = items.filter((item) => item.status === 'done').length;
  const errorCount = items.filter((item) => item.status === 'error').length;
  const settled = doneCount + errorCount;

  return (
    <Modal
      open={open}
      width={640}
      title="批量上传照片"
      footer={
        <Space>
          <span className="t-qua" style={{ fontSize: 11 }}>
            单文件不超过 {rules.maxMb} MB
          </span>
          <Button onClick={onClose}>{uploading ? '后台继续上传' : '关闭'}</Button>
        </Space>
      }
      onCancel={onClose}
      destroyOnHidden
    >
      <Upload.Dragger
        multiple
        accept={ACCEPT}
        showUploadList={false}
        beforeUpload={beforeUpload}
        customRequest={customRequest}
      >
        <p className="t-sec" style={{ marginBottom: 4 }}>
          点击或拖拽照片到此处
        </p>
        <p className="t-qua" style={{ fontSize: 11, margin: 0 }}>
          支持 {rules.formats.join(' ')}，可一次选多张；上传后会自动读取照片的拍摄信息
        </p>
        <p className="t-qua" style={{ fontSize: 11, margin: 0 }}>
          整个文件夹一次上传请用工具条上的「文件夹上传」，大文件会自动分片并支持断点续传
        </p>
      </Upload.Dragger>

      {items.length > 0 && (
        <div className="upload-progress">
          <div className="upload-progress__head">
            <span className="t-sec" style={{ fontSize: 12 }}>
              本轮 {items.length} 个文件
            </span>
            <div className="admin-toolbar__spacer" />
            <Progress
              percent={items.length === 0 ? 0 : Math.round((settled / items.length) * 100)}
              size="small"
              style={{ width: 180 }}
            />
          </div>
          <div className="upload-progress__list">
            {items.map((item) => (
              <div key={item.uid} className="upload-progress__row">
                <span className="upload-progress__name">{item.name}</span>
                {item.status === 'uploading' && <Tag color="processing">上传中</Tag>}
                {item.status === 'done' && <Tag color="green">已完成</Tag>}
                {/* 已完成但缺少一份云端副本：单独标出，便于在报告中区分具体文件 */}
                {item.status === 'done' && item.cloudFailed && <Tag color="orange">未上云</Tag>}
                {item.status === 'error' && <Tag color="red">{item.error ?? '失败'}</Tag>}
              </div>
            ))}
          </div>
        </div>
      )}
    </Modal>
  );
}