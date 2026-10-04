/**
 * apps/admin/src/components/UploadPlanTree.tsx
 *
 * 待上传文件清单：按文件夹根分组、逐文件勾选、同名文件明确标出。
 * 单文件 / 多文件上传与文件夹上传共用这一份清单，因此「同名怎么标、勾选怎么算」只有一处实现。
 *
 * 【为什么用 Tree 而不是 Table】文件夹根需要可收起展开（需求 f），Tree 原生支持；
 * 节点树的两层结构即「文件夹根 → 文件」，单 / 多文件上传时只有一个根节点「本次选择的文件」。
 * 【为什么勾选状态由调用方持有】上传时要按勾选结果取文件（selectedCandidatesOf），
 * 状态放在调用方可以避免「清单内部状态」与「待上传列表」两份真相。
 * 【节点的 fileName 为什么能直接做 key】勾选键与上传身份键同源（fileKeyOf = 名 | 大小 | 修改时间）。
 * 同一批里出现两个身份键相同的文件时，服务端算出的 uploadId 也相同，本就被视为同一个文件。
 */
import { useMemo } from 'react';
import { Alert, Button, Radio, Space, Tag, Tooltip, Tree } from 'antd';
import type { TreeDataNode } from 'antd';

import { formatBytes } from '../lib/format';
import {
  allCandidatesOf,
  candidateKeysOf,
  overwritableCandidatesOf,
  sameNameCandidatesOf,
  selectedCandidatesOf,
} from '../lib/uploadPlan';
import type { RejectedFile, UploadCandidate, UploadRoot } from '../lib/uploadPlan';

/** 覆盖选择的两种取向（与上传时是否携带 overwriteId 一一对应） */
const OVERWRITE = 'overwrite';
const AS_NEW = 'new';

interface UploadPlanTreeProps {
  roots: readonly UploadRoot[];
  /** 未进清单的文件（格式 / 体积不符），清单下方如实说明 */
  rejected?: readonly RejectedFile[];
  checkedKeys: readonly string[];
  onCheckedKeysChange: (keys: string[]) => void;
  /** 选择「覆盖原有照片」的候选键集合；不在集合中即「另存为新照片」 */
  overwriteKeys: ReadonlySet<string>;
  onOverwriteKeysChange: (keys: Set<string>) => void;
  /** 清单可视高度（px），超出即虚拟滚动 —— 长列表不截断的前提 */
  height?: number;
}

/** 单个文件行的右侧信息：同名标识与覆盖选择 */
function CandidateMeta({
  candidate,
  overwrite,
  onOverwriteChange,
}: {
  candidate: UploadCandidate;
  overwrite: boolean;
  onOverwriteChange: (next: boolean) => void;
}) {
  if (!candidate.sameName) return null;
  const existing = candidate.sameName;
  return (
    <>
      <Tooltip
        title={`库中已存在：${existing.title ?? existing.id}（${existing.id}）`}
        placement="topLeft"
      >
        <Tag color="orange">该文件存在同名文件</Tag>
      </Tooltip>
      {candidate.canOverwrite ? (
        // 行内的单选按钮不应连带触发展开 / 勾选等节点行为，因此就地截断冒泡
        <span onClick={(event) => event.stopPropagation()}>
          <Radio.Group
            size="small"
            value={overwrite ? OVERWRITE : AS_NEW}
            onChange={(event) => onOverwriteChange(event.target.value === OVERWRITE)}
          >
            <Radio value={OVERWRITE}>覆盖原有照片</Radio>
            <Radio value={AS_NEW}>另存为新照片</Radio>
          </Radio.Group>
        </span>
      ) : (
        <Tag>同名但大小不同，无法覆盖</Tag>
      )}
    </>
  );
}

/** 文件夹根节点：文件夹名、文件数与总体积、本文件夹的快捷取消勾选 */
function RootRow({
  root,
  sameNameCount,
  onUncheckSameName,
}: {
  root: UploadRoot;
  sameNameCount: number;
  onUncheckSameName: () => void;
}) {
  const totalBytes = root.candidates.reduce((sum, candidate) => sum + candidate.size, 0);
  return (
    <span className="upload-plan__root">
      <span className="upload-plan__root-name">{root.name}</span>
      <span className="upload-plan__root-meta">
        {root.candidates.length} 个文件 · {formatBytes(totalBytes)}
      </span>
      {sameNameCount > 0 && (
        <Button
          type="link"
          size="small"
          onClick={(event) => {
            event.stopPropagation();
            onUncheckSameName();
          }}
        >
          取消勾选本文件夹同名文件（{sameNameCount}）
        </Button>
      )}
    </span>
  );
}

export function UploadPlanTree({
  roots,
  rejected = [],
  checkedKeys,
  onCheckedKeysChange,
  overwriteKeys,
  onOverwriteKeysChange,
  height = 280,
}: UploadPlanTreeProps) {
  const candidates = useMemo(() => allCandidatesOf(roots), [roots]);
  const selected = useMemo(() => selectedCandidatesOf(roots, checkedKeys), [roots, checkedKeys]);
  const sameName = useMemo(() => sameNameCandidatesOf(roots), [roots]);
  const overwritable = useMemo(() => overwritableCandidatesOf(roots), [roots]);
  const selectedBytes = selected.reduce((sum, candidate) => sum + candidate.size, 0);

  /** 单个候选的覆盖取向切换：只增删这一项，其余项的选择不受影响 */
  const setOverwrite = (candidate: UploadCandidate, next: boolean): void => {
    const keys = new Set(overwriteKeys);
    if (next) keys.add(candidate.key);
    else keys.delete(candidate.key);
    onOverwriteKeysChange(keys);
  };

  /** 取消勾选给定的一批候选，其余勾选项保留（同名项与文件夹根都走这里） */
  const uncheck = (targets: readonly UploadCandidate[]): void => {
    const removed = new Set(targets.map((candidate) => candidate.key));
    onCheckedKeysChange(checkedKeys.filter((key) => !removed.has(key)));
  };

  const treeData: TreeDataNode[] = useMemo(
    () =>
      roots.map((root, index) => ({
        // 根节点键只用于渲染，不参与勾选口径（selectedCandidatesOf 按候选键过滤）
        key: `root:${index}`,
        title: (
          <RootRow
            root={root}
            sameNameCount={root.candidates.filter((candidate) => candidate.sameName).length}
            onUncheckSameName={() =>
              uncheck(root.candidates.filter((candidate) => candidate.sameName))
            }
          />
        ),
        children: root.candidates.map((candidate) => ({
          key: candidate.key,
          isLeaf: true,
          title: (
            <span className="upload-plan__row">
              <span className="upload-plan__name" title={candidate.name}>
                {candidate.name}
              </span>
              <span className="upload-plan__size">{formatBytes(candidate.size)}</span>
              <CandidateMeta
                candidate={candidate}
                overwrite={overwriteKeys.has(candidate.key)}
                onOverwriteChange={(next) => setOverwrite(candidate, next)}
              />
            </span>
          ),
        })),
      })),
    // setOverwrite / uncheck 只依赖上面这几个状态，随它们一起重建即可
    [roots, checkedKeys, overwriteKeys, onCheckedKeysChange, onOverwriteKeysChange],
  );

  return (
    <div className="upload-plan">
      <div className="upload-plan__head">
        <Space size={4} wrap>
          <Button size="small" onClick={() => onCheckedKeysChange(candidateKeysOf(roots))}>
            全部勾选
          </Button>
          <Button size="small" onClick={() => onCheckedKeysChange([])}>
            全部取消
          </Button>
          <Button
            size="small"
            disabled={sameName.length === 0}
            onClick={() => uncheck(sameName)}
          >
            取消勾选全部同名文件
          </Button>
          <Button
            size="small"
            disabled={overwritable.length === 0}
            onClick={() =>
              onOverwriteKeysChange(new Set(overwritable.map((candidate) => candidate.key)))
            }
          >
            同名文件全部覆盖
          </Button>
        </Space>
      </div>

      <Tree
        className="upload-plan__tree"
        checkable
        selectable={false}
        blockNode
        defaultExpandAll
        /* 设了 height 才启用虚拟滚动：清单不再截断，数千个文件也能完整勾选 */
        height={height}
        treeData={treeData}
        checkedKeys={[...checkedKeys]}
        onCheck={(keys) => onCheckedKeysChange((Array.isArray(keys) ? keys : keys.checked).map(String))}
      />

      <div className="upload-plan__foot">
        <span>
          将上传 {selected.length} 个文件（{formatBytes(selectedBytes)}），跳过{' '}
          {candidates.length - selected.length} 个
        </span>
      </div>

      {rejected.length > 0 && (
        <Alert
          type="warning"
          showIcon
          message={`${rejected.length} 个文件未加入清单（格式或体积不符）`}
          description={rejected
            .slice(0, 5)
            .map((item) => `${item.name}：${item.reason}`)
            .join('；')
            .concat(rejected.length > 5 ? ` 等 ${rejected.length} 个` : '')}
        />
      )}
    </div>
  );
}