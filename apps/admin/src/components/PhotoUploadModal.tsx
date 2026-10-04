/**
 * apps/admin/src/components/PhotoUploadModal.tsx
 *
 * 单文件 / 多文件上传（Modal + Upload.Dragger）。
 *
 * 【为什么先看清单再传】拖入即传意味着用户看不到本次会传哪些文件、也无法排除某几个。
 * 因此改为 pick → confirm → uploading → done：确认页列出全部候选文件并逐文件勾选，
 * 库中存在同名照片的项被明确标出，并提供「取消勾选全部同名文件」等快捷操作。
 * 【为什么统一走分片上传】单 / 多文件与文件夹上传共用 lib/chunkUpload 的一条路径：
 * 断点续传、并发控制与「覆盖」（overwriteId）能力都只需维护一份实现。
 * 【同名与覆盖的口径】见 lib/uploadPlan：文件名相同即标「该文件存在同名文件」；
 * 文件名与字节数都相同才允许覆盖（沿用原照片 id，相册归属与已编辑的信息全部保住）。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Alert, App, Button, Modal, Progress, Space, Tag, Upload } from 'antd';
import type { UploadProps } from 'antd';
import { photoApi } from '@shaping-memory/sdk';

import { uploadFileInChunks } from '../lib/chunkUpload';
import { formatBytes } from '../lib/format';
import { runPool } from '../lib/pool';
import { ACCEPT, FALLBACK_RULES, loadUploadRules } from '../lib/uploadRules';
import type { UploadRules } from '../lib/uploadRules';
import {
  buildNameIndex,
  classifyFiles,
  selectedCandidatesOf,
} from '../lib/uploadPlan';
import type { RejectedFile, UploadRoot } from '../lib/uploadPlan';
import { UploadPlanTree } from './UploadPlanTree';

type Stage = 'pick' | 'confirm' | 'uploading' | 'done';

/** 上传进度项（本组件自己的列表，与 antd 内部列表无关） */
interface UploadItem {
  key: string;
  name: string;
  size: number;
  status: 'waiting' | 'uploading' | 'done' | 'error' | 'skipped';
  error?: string;
  /** 文件已入库，但云端副本未完整上传（对象存储不稳定或凭据错误）—— 不影响本机与前台 */
  cloudFailed?: boolean;
}

interface Report {
  ok: number;
  fail: number;
  skipped: number;
  failedNames: string[];
  cloudFailedNames: string[];
}

interface PhotoUploadModalProps {
  open: boolean;
  onClose: () => void;
  /** 本轮有成功上传时回调（用于刷新照片列表） */
  onUploaded: () => void;
}

export function PhotoUploadModal({ open, onClose, onUploaded }: PhotoUploadModalProps) {
  const { message } = App.useApp();
  const [stage, setStage] = useState<Stage>('pick');
  const [rules, setRules] = useState<UploadRules>(FALLBACK_RULES);
  /** 待上传清单：单 / 多文件上传只有一个根节点，结构上与文件夹上传保持一致 */
  const [roots, setRoots] = useState<UploadRoot[]>([]);
  const [rejected, setRejected] = useState<RejectedFile[]>([]);
  const [checkedKeys, setCheckedKeys] = useState<string[]>([]);
  const [overwriteKeys, setOverwriteKeys] = useState<Set<string>>(new Set());
  const [items, setItems] = useState<UploadItem[]>([]);
  const [transferred, setTransferred] = useState(0);
  const [settled, setSettled] = useState(0);
  const [totalBytes, setTotalBytes] = useState(0);
  const [report, setReport] = useState<Report | null>(null);
  const [preparing, setPreparing] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

  // 每次打开重置整轮状态，并读取最新的体积上限 / 允许格式 / 并发档位
  useEffect(() => {
    if (!open) return;
    setStage('pick');
    setRoots([]);
    setRejected([]);
    setCheckedKeys([]);
    setOverwriteKeys(new Set());
    setItems([]);
    setTransferred(0);
    setSettled(0);
    setTotalBytes(0);
    setReport(null);
    abortRef.current = null;
    void loadUploadRules().then((loaded) => {
      // 读取不到设置时不阻断上传：使用保底值，后端落盘前还会再校验一次
      if (loaded) setRules(loaded);
    });
  }, [open]);

  const patchItem = useCallback((key: string, patch: Partial<UploadItem>): void => {
    setItems((prev) => prev.map((item) => (item.key === key ? { ...item, ...patch } : item)));
  }, []);

  /**
   * 收到选择 / 拖入的文件：先比对同名照片，再进确认页。
   *
   * 【同名从哪来】库中照片的 original_name / original_size 是唯一可依据的比对键，
   * 因此确认前要先取一次全库列表；这一步不发任何写请求。
   */
  const openPlan = useCallback(
    async (files: readonly File[]): Promise<void> => {
      setPreparing(true);
      try {
        const photos = await photoApi.list();
        const { accepted, rejected: blocked } = classifyFiles(files, rules, buildNameIndex(photos));
        if (accepted.length === 0) {
          message.warning(`本次选择的文件均不符合上传规则（允许 ${rules.formats.join(' ')}，单个不超过 ${rules.maxMb} MB）`);
          return;
        }
        const plan: UploadRoot[] = [{ name: '本次选择的文件', candidates: accepted }];
        setRoots(plan);
        setRejected(blocked);
        setCheckedKeys(accepted.map((candidate) => candidate.key));
        // 默认沿用既有行为：同名且同大小的项按「覆盖原有照片」处理，用户可在清单里逐条改回
        setOverwriteKeys(new Set(accepted.filter((candidate) => candidate.canOverwrite).map((candidate) => candidate.key)));
        setStage('confirm');
      } catch (error) {
        message.error(error instanceof Error ? error.message : '读取照片库失败，无法比对同名文件');
      } finally {
        setPreparing(false);
      }
    },
    [message, rules],
  );

  /** antd 对每个文件各调一次 beforeUpload（每次都带完整列表），因此在最后一个文件上处理整批 */
  const beforeUpload: UploadProps['beforeUpload'] = (file, fileList) => {
    if (file === fileList[fileList.length - 1]) void openPlan(fileList as unknown as File[]);
    // 返回 false：文件只进清单，不由 antd 发起上传
    return false;
  };

  const targets = useMemo(
    () => selectedCandidatesOf(roots, checkedKeys),
    [roots, checkedKeys],
  );
  const percent = totalBytes === 0 ? 0 : Math.min(100, Math.round(((transferred + settled) / totalBytes) * 100));
  const uploading = stage === 'uploading';

  /**
   * 开始上传：文件之间并发，每个文件内部再按分片并发，两层乘积贴近站点设置 upload.concurrency。
   * 进度用「已传输字节 + 已结束文件的剩余字节」统计，因此并发也不会让进度条提前到达 100%。
   */
  const startUpload = async (): Promise<void> => {
    if (targets.length === 0) return;
    const controller = new AbortController();
    abortRef.current = controller;
    setStage('uploading');
    setItems(targets.map((candidate) => ({
      key: candidate.key,
      name: candidate.name,
      size: candidate.size,
      status: 'waiting',
    })));

    const fileConcurrency = Math.max(1, Math.min(rules.concurrency, targets.length));
    const chunkConcurrency = Math.max(1, Math.floor(rules.concurrency / fileConcurrency));
    const total = targets.reduce((sum, candidate) => sum + candidate.size, 0);
    setTotalBytes(total);
    setTransferred(0);
    setSettled(0);

    let transferredBytes = 0;
    let settledBytes = 0;
    let ok = 0;
    let fail = 0;
    let skipped = 0;
    const failedNames: string[] = [];
    const cloudFailedNames: string[] = [];

    await runPool(targets, fileConcurrency, async (candidate) => {
      if (controller.signal.aborted) {
        skipped += 1;
        patchItem(candidate.key, { status: 'skipped' });
        return;
      }
      patchItem(candidate.key, { status: 'uploading' });
      // 本文件已确认到达服务端的字节：只计其自身，避免并发文件之间互相干扰
      let confirmedBytes = 0;
      try {
        const result = await uploadFileInChunks(candidate.file, {
          concurrency: chunkConcurrency,
          // 仅「同名且同大小」且用户选择覆盖时传目标 id：服务端沿用旧落盘名，因此 id 不变
          overwriteId: candidate.canOverwrite && overwriteKeys.has(candidate.key)
            ? candidate.sameName?.id
            : undefined,
          onProgress: (delta) => {
            confirmedBytes += delta;
            transferredBytes += delta;
            setTransferred(transferredBytes);
          },
          signal: controller.signal,
        });
        ok += 1;
        // 云端副本未完整上传不计为失败：照片已入库、本地也存在，仅缺少一份异地副本
        const cloudBroken = result.upload.failed > 0;
        if (cloudBroken) cloudFailedNames.push(candidate.name);
        patchItem(candidate.key, { status: 'done', cloudFailed: cloudBroken });
      } catch (error) {
        if (controller.signal.aborted) {
          skipped += 1;
          patchItem(candidate.key, { status: 'skipped' });
        } else {
          fail += 1;
          failedNames.push(candidate.name);
          patchItem(candidate.key, {
            status: 'error',
            error: error instanceof Error ? error.message : '上传失败',
          });
        }
      } finally {
        // 未传输的字节计入 settled：与 onProgress 累加的 transferred 相加恰好等于文件体积
        settledBytes += Math.max(0, candidate.size - confirmedBytes);
        setSettled(settledBytes);
      }
    });

    setReport({
      ok,
      fail,
      skipped,
      failedNames,
      cloudFailedNames,
    });
    setStage('done');
    if (ok > 0) onUploaded();
  };

  const footer = ((): React.ReactNode => {
    if (stage === 'confirm') {
      return (
        <Space>
          <Button onClick={onClose}>取消</Button>
          <Button type="primary" disabled={targets.length === 0} onClick={() => void startUpload()}>
            开始上传
          </Button>
        </Space>
      );
    }
    if (uploading) {
      return (
        <Space>
          <span className="t-qua" style={{ fontSize: 11 }}>
            {formatBytes(transferred)} / {formatBytes(totalBytes)}
          </span>
          <Button onClick={() => abortRef.current?.abort()}>停止</Button>
        </Space>
      );
    }
    if (stage === 'done') {
      return (
        <Button type="primary" onClick={onClose}>
          关闭
        </Button>
      );
    }
    return (
      <Space>
        <span className="t-qua" style={{ fontSize: 11 }}>
          单文件不超过 {rules.maxMb} MB
        </span>
        <Button onClick={onClose}>关闭</Button>
      </Space>
    );
  })();

  return (
    <Modal
      open={open}
      width={720}
      title="上传照片"
      footer={footer}
      onCancel={uploading ? () => abortRef.current?.abort() : onClose}
      maskClosable={!uploading}
      destroyOnHidden
    >
      {stage === 'pick' && (
        <Upload.Dragger
          multiple
          accept={ACCEPT}
          showUploadList={false}
          beforeUpload={beforeUpload}
          disabled={preparing}
        >
          <p className="t-sec" style={{ marginBottom: 4 }}>
            点击或拖拽照片到此处
          </p>
          <p className="t-qua" style={{ fontSize: 11, margin: 0 }}>
            支持 {rules.formats.join(' ')}，可一次选多张；选择后会先列出清单，确认后再上传
          </p>
          <p className="t-qua" style={{ fontSize: 11, margin: 0 }}>
            整个文件夹一次上传请用工具条上的「文件夹上传」，大文件会自动分片并支持断点续传
          </p>
        </Upload.Dragger>
      )}

      {stage === 'confirm' && (
        <Space direction="vertical" size={12} style={{ width: '100%' }}>
          <UploadPlanTree
            roots={roots}
            rejected={rejected}
            checkedKeys={checkedKeys}
            onCheckedKeysChange={setCheckedKeys}
            overwriteKeys={overwriteKeys}
            onOverwriteKeysChange={setOverwriteKeys}
          />
        </Space>
      )}

      {uploading && (
        <Space direction="vertical" size={12} style={{ width: '100%' }}>
          <Progress percent={percent} />
          <div className="upload-progress__list">
            {items.map((item) => (
              <div key={item.key} className="upload-progress__row">
                <span className="upload-progress__name">{item.name}</span>
                <span className="t-qua" style={{ fontSize: 11 }}>
                  {formatBytes(item.size)}
                </span>
                {item.status === 'waiting' && <Tag>等待</Tag>}
                {item.status === 'uploading' && <Tag color="processing">上传中</Tag>}
                {item.status === 'done' && <Tag color="green">已完成</Tag>}
                {/* 已完成但缺少一份云端副本：单独标出，便于在报告中区分具体文件 */}
                {item.status === 'done' && item.cloudFailed && <Tag color="orange">未上云</Tag>}
                {item.status === 'skipped' && <Tag>已停止</Tag>}
                {item.status === 'error' && <Tag color="red">{item.error ?? '失败'}</Tag>}
              </div>
            ))}
          </div>
        </Space>
      )}

      {stage === 'done' && report && (
        <Space direction="vertical" size={12} style={{ width: '100%' }}>
          <div className="t-sec" style={{ fontSize: 13 }}>
            成功 {report.ok} 张 · 失败 {report.fail} 张 · 未传 {report.skipped} 张
          </div>
          {report.failedNames.length > 0 && (
            <Alert
              type="error"
              showIcon
              message={`${report.failedNames.length} 张照片未上传成功`}
              description={
                report.failedNames.slice(0, 8).join('、') +
                (report.failedNames.length > 8 ? ' 等' : '') +
                '；重新选择这些文件即可从断点继续，已完成的分片不会重复传输。'
              }
            />
          )}
          {report.cloudFailedNames.length > 0 && (
            <Alert
              type="warning"
              showIcon
              message={`${report.cloudFailedNames.length} 张照片未同步到云端`}
              description={
                report.cloudFailedNames.slice(0, 8).join('、') +
                (report.cloudFailedNames.length > 8 ? ' 等' : '') +
                '；照片已上传并入库，本机与前台均不受影响，仅对象存储中缺少一份异地副本。' +
                '可在服务器上执行 npm run backfill:objects 补传。'
              }
            />
          )}
          {report.ok > 0 && report.fail === 0 && report.cloudFailedNames.length === 0 && (
            <Alert type="success" showIcon message="本次上传已全部完成" />
          )}
        </Space>
      )}
    </Modal>
  );
}