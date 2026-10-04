/**
 * apps/admin/src/components/PurgeConfirmModal.tsx
 *
 * 彻底删除确认：本项目唯一「不可恢复」的破坏性操作，确认环节因此刻意做重。
 *
 * 【为什么不复用 Popconfirm】一行提示放不下三件必须在按确认前看清楚的事：
 * 删哪些、会清什么、不会动什么。缺了任何一件，用户都只能在信息不全的情况下做不可逆决定。
 *
 * 【为什么必须勾选才放行】彻底删除会同时抹掉云端副本、本机缓存与数据库记录，没有任何恢复路径；
 * 用一个复选框把「顺手点确认」变成一次有意识的操作，避免误触造成不可挽回的数据丢失。
 *
 * 【为什么分批提交】一次请求携带上千个 id 会让后端串行清理大量云端对象，极易请求超时；
 * 按 PURGE_BATCH_SIZE 分批，任一批失败立即停止并如实汇报，已完成的部分不做回滚（已物理删除，无从撤销）。
 */
import { useEffect, useState } from 'react';
import { Alert, App, Checkbox, Modal, Typography } from 'antd';
import { photoApi } from '@shaping-memory/sdk';
import type { PhotoPurgeResult } from '@shaping-memory/sdk';

/** 单次请求提交的最大 id 数：避免单个请求里串行删除过多云端对象 */
export const PURGE_BATCH_SIZE = 200;

/** 清单里最多逐条列出的文件名数：再多就以数量为准，避免弹层被上千行撑爆 */
const MAX_LISTED_NAMES = 30;

/** 彻底删除的目标：id 用于删除，name 仅用于让用户核对清单 */
export interface PurgeTarget {
  id: string;
  /** 展示用名称：优先标题，其次原始文件名，最后回落到 id */
  name: string;
}

interface PurgeConfirmModalProps {
  open: boolean;
  targets: PurgeTarget[];
  onClose: () => void;
  /** 删除成功后的回调（父组件负责清空选中并重拉列表） */
  onDone: () => void;
}

/** 计数累加器：分批提交时逐批把计数并进总和，结果只对外暴露一个整体数字 */
function accumulate(sum: PhotoPurgeResult, part: PhotoPurgeResult): PhotoPurgeResult {
  return {
    purged: sum.purged + part.purged,
    filesRemoved: sum.filesRemoved + part.filesRemoved,
    objectsRemoved: sum.objectsRemoved + part.objectsRemoved,
    sharesPruned: sum.sharesPruned + part.sharesPruned,
    tagsPruned: sum.tagsPruned + part.tagsPruned,
    failures: [...sum.failures, ...part.failures],
  };
}

const EMPTY_RESULT: PhotoPurgeResult = {
  purged: 0,
  filesRemoved: 0,
  objectsRemoved: 0,
  sharesPruned: 0,
  tagsPruned: 0,
  failures: [],
};

/** 把累计结果转成一句可读的汇报：只在真的清掉了东西时才提该项，避免出现一长串 0 */
function reportOf(result: PhotoPurgeResult): string {
  const parts = [
    `云端对象 ${result.objectsRemoved} 个`,
    `本机文件 ${result.filesRemoved} 个`,
  ];
  if (result.sharesPruned > 0) parts.push(`裁剪分享链接 ${result.sharesPruned} 条`);
  if (result.tagsPruned > 0) parts.push(`清理孤立标签 ${result.tagsPruned} 个`);
  return `已彻底删除 ${result.purged} 张：${parts.join('、')}`;
}

export function PurgeConfirmModal({ open, targets, onClose, onDone }: PurgeConfirmModalProps) {
  const { message } = App.useApp();
  const [acknowledged, setAcknowledged] = useState(false);
  const [running, setRunning] = useState(false);

  // 每次重新打开都回到「未勾选」：确认状态不能被上一次的操作记忆代劳
  useEffect(() => {
    if (!open) return;
    setAcknowledged(false);
    setRunning(false);
  }, [open]);

  const handleOk = async (): Promise<void> => {
    if (targets.length === 0) return;
    setRunning(true);
    let total = EMPTY_RESULT;
    try {
      for (let start = 0; start < targets.length; start += PURGE_BATCH_SIZE) {
        const ids = targets.slice(start, start + PURGE_BATCH_SIZE).map((target) => target.id);
        total = accumulate(total, await photoApi.purgeBatch(ids));
        // 失败批次：后端已保证这批的数据库记录原样保留，后续批次不再继续，交给用户修复环境后重试
        if (total.failures.length > 0) break;
      }

      if (total.failures.length > 0) {
        message.error(`彻底删除未完成：${total.failures.slice(0, 3).join('；')}`);
        return;
      }

      message.success(reportOf(total));
      onDone();
      onClose();
    } catch (error) {
      message.error(error instanceof Error ? error.message : '彻底删除失败');
    } finally {
      setRunning(false);
    }
  };

  const listed = targets.slice(0, MAX_LISTED_NAMES);
  const rest = targets.length - listed.length;

  return (
    <Modal
      open={open}
      title={`彻底删除（共 ${targets.length} 张）`}
      okText="彻底删除"
      cancelText="取消"
      // 未勾选「已知悉不可恢复」前，确认按钮保持禁用；按钮本身也用 danger 色以示破坏性
      okButtonProps={{ danger: true, disabled: !acknowledged }}
      confirmLoading={running}
      onOk={() => void handleOk()}
      onCancel={onClose}
      maskClosable={!running}
      width={560}
    >
      <Alert
        type="warning"
        showIcon
        message="此操作不可恢复"
        description="照片将从云端、本机与数据库中一并移除，系统不提供任何恢复入口。"
        style={{ marginBottom: 12 }}
      />

      <Typography.Paragraph style={{ marginBottom: 6 }}>
        以下 {targets.length} 张照片将被彻底删除：
      </Typography.Paragraph>
      <ul className="purge-list">
        {listed.map((target) => (
          <li key={target.id}>
            <span className="purge-list__name">{target.name}</span>
            <span className="purge-list__id t-qua">{target.id}</span>
          </li>
        ))}
      </ul>
      {rest > 0 && (
        <Typography.Paragraph className="t-qua" style={{ marginBottom: 8 }}>
          其余 {rest} 张未逐条列出，删除范围以上方数量为准。
        </Typography.Paragraph>
      )}

      <div className="purge-scope">
        <div>
          <Typography.Text strong>将会清除</Typography.Text>
          <ul>
            <li>云端对象存储中的原片与生成物副本</li>
            <li>本机缓存副本（上传暂存原片、实况视频、缩略图、卡片图、模糊图）</li>
            <li>数据库中的照片元数据、拍摄参数、标签关联与相册归属</li>
            <li>分享链接中的这些照片（链接因此清空时整条链接删除）</li>
          </ul>
        </div>
        <div>
          <Typography.Text strong>不会改动</Typography.Text>
          <ul>
            <li>原始档案目录（PHOTO_SOURCE_DIR）中的源文件</li>
            <li>EXIF 备份文件与操作审计日志</li>
          </ul>
        </div>
      </div>

      <Checkbox
        checked={acknowledged}
        onChange={(event) => setAcknowledged(event.target.checked)}
        disabled={running}
      >
        我已了解此操作不可恢复
      </Checkbox>
    </Modal>
  );
}