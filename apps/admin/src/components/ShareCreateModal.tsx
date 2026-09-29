/**
 * apps/admin/src/components/ShareCreateModal.tsx
 *
 * 创建时效分享链接：选照片 → 定有效期 → 选提取码模式 → 创建后把「链接 + 提取码」一起给出。
 *
 * 【为什么要单独把提取码展示出来】后端返回的 share.url 只带 token、**不含**提取码
 * （提取码单独放在 accessCode 字段里），这是刻意的：链接会被复制/转发出去，
 * 提取码必须由分享者另行告知，两者混在同一串中等同于取消二次校验。
 * 因此这里分两行展示、各自带复制按钮。
 *
 * 【默认只列隐私照片】该机制本身即用于隐私照片；「显示全部照片」开关留给
 * 「临时把几张公开片打包给客户」这类场景。
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { Key } from 'react';
import { App, Button, Empty, Image, Input, InputNumber, Modal, Radio, Space, Switch, Table, Tag } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import type { Photo } from '@shaping-memory/core';
import { photoApi, privacyApi } from '@shaping-memory/sdk';
import type { PrivacyShare } from '@shaping-memory/sdk';

import { formatDateTime } from '../lib/format';

/** 提取码模式：不要 / 后端自动生成 / 自定义 */
type CodeMode = 'auto' | 'none' | 'custom';

/** 自定义提取码：4~6 位字母数字（与后端校验口径一致） */
const CUSTOM_CODE_RE = /^[A-Za-z0-9]{4,6}$/;

/** 判定「隐私照片」：有效策略不是公开、对访客锁着、或单独设了密码，任一成立即算 */
function isPrivacyPhoto(photo: Photo): boolean {
  const priv = photo.privacy;
  return Boolean(priv && (priv.mode !== 'visible' || priv.locked || priv.hasOwnPassword));
}

interface ShareCreateModalProps {
  open: boolean;
  onClose: () => void;
  /** 创建成功（用于刷新列表）；关闭时机交给用户点「完成」 */
  onCreated: (share: PrivacyShare) => void;
}

export function ShareCreateModal({ open, onClose, onCreated }: ShareCreateModalProps) {
  const { message } = App.useApp();
  const [photos, setPhotos] = useState<Photo[]>([]);
  const [loading, setLoading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [showAll, setShowAll] = useState(false);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [hours, setHours] = useState(24);
  const [codeMode, setCodeMode] = useState<CodeMode>('auto');
  const [customCode, setCustomCode] = useState('');
  /** 创建结果：非 null 时弹窗切换为「展示链接与提取码」态 */
  const [created, setCreated] = useState<PrivacyShare | null>(null);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setLoading(true);
    photoApi
      .list()
      .then((list) => {
        if (!cancelled) setPhotos(list);
      })
      .catch((error: unknown) => {
        if (!cancelled) message.error(error instanceof Error ? error.message : '照片列表加载失败');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open, message]);

  /** 关闭时清除全部临时状态，避免下次打开仍保留上次的选片与结果 */
  const resetAndClose = useCallback((): void => {
    setPhotos([]);
    setShowAll(false);
    setSelectedIds([]);
    setHours(24);
    setCodeMode('auto');
    setCustomCode('');
    setCreated(null);
    onClose();
  }, [onClose]);

  const visiblePhotos = useMemo(
    () => (showAll ? photos : photos.filter(isPrivacyPhoto)),
    [photos, showAll],
  );

  const copyText = async (text: string, label: string): Promise<void> => {
    try {
      await navigator.clipboard.writeText(text);
      message.success(`${label}已复制`);
    } catch {
      message.error('复制失败，请手动选中复制');
    }
  };

  const handleCreate = async (): Promise<void> => {
    if (selectedIds.length === 0) {
      message.error('请至少选择一张照片');
      return;
    }
    if (codeMode === 'custom' && !CUSTOM_CODE_RE.test(customCode)) {
      message.error('自定义提取码需为 4~6 位字母或数字');
      return;
    }
    // 三态入参：auto = 不传 code（后端自动生成）、none = null（不要提取码）、custom = 具体值
    const code = codeMode === 'auto' ? undefined : codeMode === 'none' ? null : customCode;
    setSubmitting(true);
    try {
      const share = await privacyApi.createShare({ ids: selectedIds, expiresInHours: hours, code });
      setCreated(share);
      onCreated(share);
    } catch (error) {
      message.error(error instanceof Error ? error.message : '分享链接创建失败');
    } finally {
      setSubmitting(false);
    }
  };

  const columns: ColumnsType<Photo> = [
    {
      title: '缩略图',
      dataIndex: 'url',
      width: 64,
      render: (_url: string, record) => (
        <Image className="admin-thumb" src={record.cardUrl ?? record.url} alt={record.title} preview={false} />
      ),
    },
    { title: '标题', dataIndex: 'title', render: (title: string) => title || '（无标题）' },
    {
      title: '隐私',
      key: 'privacy',
      width: 100,
      render: (_, record) => (
        <Tag color={record.privacy?.mode === 'visible' ? 'green' : 'orange'}>
          {record.privacy?.mode === 'visible' ? '公开' : '隐私'}
        </Tag>
      ),
    },
    { title: '拍摄日期', dataIndex: 'date', width: 110 },
  ];

  return (
    <Modal
      open={open}
      width={860}
      title={created ? '分享链接已创建' : '创建分享链接'}
      okText={created ? '完成' : '创建链接'}
      cancelText="取消"
      confirmLoading={submitting}
      onOk={created ? resetAndClose : handleCreate}
      onCancel={resetAndClose}
      destroyOnHidden
    >
      {created ? (
        <div className="share-result">
          <div className="share-result__row">
            <span className="share-result__label">分享链接</span>
            <span className="share-result__value">{created.url}</span>
            <Button size="small" onClick={() => void copyText(created.url, '链接')}>
              复制链接
            </Button>
          </div>
          <div className="share-result__row">
            <span className="share-result__label">提取码</span>
            <span className="share-result__value share-result__value--code">
              {created.accessCode ?? '（这条链接不需要提取码）'}
            </span>
            {created.accessCode && (
              <Button size="small" onClick={() => void copyText(created.accessCode ?? '', '提取码')}>
                复制提取码
              </Button>
            )}
          </div>
          <div className="t-qua" style={{ fontSize: 11 }}>
            链接里不含提取码，请把两者分别发给对方；到期时间 {formatDateTime(created.expiresAt, true)}。
          </div>
        </div>
      ) : (
        <>
          <div className="admin-toolbar">
            <Space size={12}>
              <span className="t-sec" style={{ fontSize: 12 }}>
                只列隐私照片
              </span>
              <Switch size="small" checked={showAll} onChange={setShowAll} />
              <span className="t-sec" style={{ fontSize: 12 }}>
                显示全部照片
              </span>
            </Space>
            <div className="admin-toolbar__spacer" />
            <span className="t-qua" style={{ fontSize: 11 }}>
              已选 {selectedIds.length} 张
            </span>
          </div>

          <Table<Photo>
            rowKey="id"
            size="small"
            loading={loading}
            columns={columns}
            dataSource={visiblePhotos}
            rowSelection={{
              selectedRowKeys: selectedIds,
              onChange: (keys: Key[]) => setSelectedIds(keys.map(String)),
              preserveSelectedRowKeys: false,
            }}
            locale={{ emptyText: <Empty description={showAll ? '暂无照片' : '暂无隐私照片'} /> }}
            pagination={{ pageSize: 6, showSizeChanger: false, showTotal: (total) => `共 ${total} 张` }}
          />

          <div className="admin-form-inline">
            <div>
              <div className="share-form__label">有效期（小时）</div>
              <InputNumber min={1} step={1} value={hours} onChange={(value) => setHours(value ?? 24)} />
            </div>
            <div>
              <div className="share-form__label">提取码</div>
              <Radio.Group
                value={codeMode}
                onChange={(event) => setCodeMode(event.target.value as CodeMode)}
                options={[
                  { label: '自动生成 4 位', value: 'auto' },
                  { label: '不要提取码', value: 'none' },
                  { label: '自定义', value: 'custom' },
                ]}
              />
            </div>
            {codeMode === 'custom' && (
              <div>
                <div className="share-form__label">自定义提取码（4~6 位字母或数字）</div>
                <Input
                  value={customCode}
                  maxLength={6}
                  style={{ width: 180 }}
                  placeholder="如 7F2K"
                  onChange={(event) => setCustomCode(event.target.value.trim())}
                />
              </div>
            )}
          </div>
        </>
      )}
    </Modal>
  );
}