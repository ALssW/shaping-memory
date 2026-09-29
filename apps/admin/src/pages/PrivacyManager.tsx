/**
 * apps/admin/src/pages/PrivacyManager.tsx
 *
 * 隐私与分享：全局策略 / 全局查看密码 / 时效分享链接 / 单张独立密码。
 *
 * 【三层隐私是叠加的，不是三选一】
 *   ① 全局默认策略：没做单张标记的照片按它生效
 *   ② 全局查看密码：访客输入后拿到票据，可看隐私照片
 *   ③ 授权角色：这些角色登录后**直接**可看，不必输密码
 * 页面因此分块呈现，各块的读改各自独立（避免一次大表单把互不相干的设置绑在一起提交）。
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { App, Button, Card, Descriptions, Empty, Form, Input, Popconfirm, Select, Slider, Space, Table, Tag } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { privacyApi } from '@shaping-memory/sdk';
import type { PrivacyPolicy, PrivacyShare } from '@shaping-memory/sdk';

import { ShareCreateModal } from '../components/ShareCreateModal';
import { formatDateTime } from '../lib/format';

/** 全局默认策略文案（与 Photo.privacy 的可见程度一一对应） */
const MODE_OPTIONS = [
  { value: 'visible', label: '公开' },
  { value: 'blur', label: '模糊展示' },
  { value: 'hidden', label: '完全隐藏' },
];

const ROLE_OPTIONS = [
  { value: 'admin', label: 'admin（管理员）' },
  { value: 'editor', label: 'editor（编辑）' },
  { value: 'viewer', label: 'viewer（访客）' },
];

interface PolicyFormValues {
  defaultMode: PrivacyPolicy['defaultMode'];
  accessRoles: string[];
  blurStrength: number;
}

/** 分享链接状态：撤销优先于过期（撤销是人为动作，更该被强调） */
function shareState(share: PrivacyShare): { label: string; color: string } {
  if (share.revoked) return { label: '已撤销', color: 'default' };
  if (share.expired) return { label: '已过期', color: 'red' };
  return { label: '有效', color: 'green' };
}

export function PrivacyManager() {
  const { message } = App.useApp();
  const [policyForm] = Form.useForm<PolicyFormValues>();
  /** 滑杆当前值：用来在标签里回显数字，比只看滑杆位置直观 */
  const blurStrength = Form.useWatch('blurStrength', policyForm);
  const [policy, setPolicy] = useState<PrivacyPolicy | null>(null);
  /**
   * 当前滑杆档位对应的完整规格。
   * 【为什么查表而不是自己算】派生参数（降采样底线 / 高斯 σ / 噪点）的公式只存在于
   * 后端 image 包里；前端照着推一遍等于将算法实现重复两份，修改公式时必然不一致。
   * 后端把全量规格表随策略一起下发，这里只是查一下 —— 拖动滑杆即可实时预览。
   * 【为什么带 ?. 回退】前后端是分开部署的，存在「前端已更新、后端仍是旧版本」的
   * 窗口期，旧后端不会下发这两个字段。缺少该回退时此处会抛出 TypeError 导致整页白屏 ——
   * 一块只读面板不应导致整个页面不可用，字段缺失时隐藏面板即可。
   */
  const activeSpec = useMemo(() => {
    if (!policy) return null;
    if (typeof blurStrength !== 'number') return policy.blurSpec ?? null;
    return policy.blurSpecTable?.find((row) => row.strength === blurStrength) ?? policy.blurSpec ?? null;
  }, [policy, blurStrength]);
  const [shares, setShares] = useState<PrivacyShare[]>([]);
  const [loading, setLoading] = useState(false);
  const [savingPolicy, setSavingPolicy] = useState(false);
  const [creatingShare, setCreatingShare] = useState(false);
  const [revokingId, setRevokingId] = useState<string | null>(null);

  /* ---- 全局密码 ---- */
  const [passwordDraft, setPasswordDraft] = useState('');
  const [passwordConfirm, setPasswordConfirm] = useState('');
  const [savingPassword, setSavingPassword] = useState(false);

  /* ---- 单张独立密码 ---- */
  const [photoId, setPhotoId] = useState('');
  const [photoPassword, setPhotoPassword] = useState('');
  const [savingPhotoPassword, setSavingPhotoPassword] = useState(false);

  const load = useCallback(async (): Promise<void> => {
    setLoading(true);
    try {
      const [nextPolicy, nextShares] = await Promise.all([privacyApi.policy(), privacyApi.shares()]);
      setPolicy(nextPolicy);
      setShares(nextShares);
    } catch (error) {
      message.error(error instanceof Error ? error.message : '隐私设置加载失败');
    } finally {
      setLoading(false);
    }
  }, [message]);

  useEffect(() => {
    void load();
  }, [load]);

  // 策略读回来后铺进表单；必须等渲染完成再 setFieldsValue，否则作用于未连接的表单实例会导致值丢失
  useEffect(() => {
    if (!policy) return;
    policyForm.setFieldsValue({
      defaultMode: policy.defaultMode,
      accessRoles: policy.accessRoles,
      blurStrength: policy.blurStrength,
    });
  }, [policy, policyForm]);

  const handleSavePolicy = async (): Promise<void> => {
    setSavingPolicy(true);
    try {
      const values = await policyForm.validateFields();
      const updated = await privacyApi.updatePolicy({
        defaultMode: values.defaultMode,
        accessRoles: values.accessRoles,
        blurStrength: values.blurStrength,
      });
      setPolicy(updated);
      message.success('全局隐私策略已更新');
    } catch (error) {
      if (error instanceof Error) message.error(error.message);
    } finally {
      setSavingPolicy(false);
    }
  };

  /** 写全局密码：传具体值即设置，传 null 即清除 */
  const handleSetPassword = async (password: string | null): Promise<void> => {
    if (password !== null) {
      if (password.length < 4) {
        message.error('查看密码至少 4 位');
        return;
      }
      if (password !== passwordConfirm) {
        message.error('两次输入的密码不一致');
        return;
      }
    }
    setSavingPassword(true);
    try {
      const updated = await privacyApi.setPassword(password);
      setPolicy(updated);
      setPasswordDraft('');
      setPasswordConfirm('');
      message.success(password === null ? '已清除全局查看密码' : '全局查看密码已设置');
    } catch (error) {
      message.error(error instanceof Error ? error.message : '查看密码保存失败');
    } finally {
      setSavingPassword(false);
    }
  };

  /** 单张独立密码：同样用 null 表示清除 */
  const handleSetPhotoPassword = async (password: string | null): Promise<void> => {
    const id = photoId.trim();
    if (id === '') {
      message.error('请先填写照片 ID');
      return;
    }
    if (password !== null && password.length < 4) {
      message.error('照片密码至少 4 位');
      return;
    }
    setSavingPhotoPassword(true);
    try {
      await privacyApi.setPhotoPassword(id, password);
      setPhotoPassword('');
      message.success(password === null ? `已清除照片 ${id} 的独立密码` : `已为照片 ${id} 设置独立密码`);
    } catch (error) {
      message.error(error instanceof Error ? error.message : '照片密码保存失败');
    } finally {
      setSavingPhotoPassword(false);
    }
  };

  const handleRevoke = async (share: PrivacyShare): Promise<void> => {
    setRevokingId(share.id);
    try {
      await privacyApi.revokeShare(share.id);
      message.success('分享链接已撤销');
      setShares(await privacyApi.shares());
    } catch (error) {
      message.error(error instanceof Error ? error.message : '撤销失败');
    } finally {
      setRevokingId(null);
    }
  };

  const columns: ColumnsType<PrivacyShare> = [
    {
      title: '照片数',
      dataIndex: 'mediaIds',
      width: 90,
      align: 'right',
      render: (mediaIds: string[]) => mediaIds.length,
    },
    {
      title: '提取码',
      dataIndex: 'accessCode',
      width: 120,
      render: (code: string | null) =>
        code ? <Tag color="gold">{code}</Tag> : <span className="t-qua">不需要</span>,
    },
    {
      title: '到期时间',
      dataIndex: 'expiresAt',
      width: 160,
      render: (expiresAt: string) => formatDateTime(expiresAt),
    },
    {
      title: '状态',
      key: 'state',
      width: 90,
      render: (_, record) => {
        const state = shareState(record);
        return <Tag color={state.color}>{state.label}</Tag>;
      },
    },
    {
      title: '创建者',
      dataIndex: 'createdBy',
      width: 120,
      render: (createdBy: string | null) => createdBy ?? <span className="t-qua">—</span>,
    },
    {
      title: '创建时间',
      dataIndex: 'createdAt',
      width: 160,
      render: (createdAt: string) => formatDateTime(createdAt),
    },
    {
      title: '操作',
      key: 'action',
      width: 120,
      fixed: 'right',
      render: (_, record) => (
        <Popconfirm
          title="确认撤销这条分享链接？"
          description="撤销后链接立即失效，已发出的链接也无法再打开。"
          okText="撤销"
          cancelText="取消"
          okButtonProps={{ danger: true }}
          disabled={record.revoked}
          onConfirm={() => handleRevoke(record)}
        >
          <Button type="link" size="small" danger loading={revokingId === record.id} disabled={record.revoked}>
            撤销
          </Button>
        </Popconfirm>
      ),
    },
  ];

  return (
    <div>
      <div className="admin-toolbar">
        <span className="admin-page-title">隐私与分享</span>
        <div className="admin-toolbar__spacer" />
        <Button onClick={() => void load()} loading={loading}>
          刷新
        </Button>
      </div>

      {/* ① 全局策略 */}
      <Card size="small" title="全局隐私策略" style={{ marginBottom: 16 }}>
        <Form<PolicyFormValues> form={policyForm} layout="vertical" requiredMark={false}>
          <Form.Item
            name="defaultMode"
            label="未标记照片的默认策略"
            rules={[{ required: true, message: '请选择默认策略' }]}
            extra="单张照片的隐私标记优先于这里；该策略只作用于没做单张标记的照片"
          >
            <Select options={MODE_OPTIONS} style={{ maxWidth: 280 }} />
          </Form.Item>
          <Form.Item name="accessRoles" label="可直接查看隐私照片的角色" extra="这些角色登录后免输密码">
            <Select mode="multiple" options={ROLE_OPTIONS} style={{ maxWidth: 420 }} placeholder="选择角色" />
          </Form.Item>
          {/* 模糊强度：只影响「模糊展示」的照片在前台看到的观感，不影响隐私强度、也不影响谁能看 */}
          <Form.Item
            name="blurStrength"
            label={`模糊强度${typeof blurStrength === 'number' ? `（当前 ${blurStrength}）` : ''}`}
            extra="只影响模糊照片在前台看起来的柔和程度，不改变隐私保护强度 —— 隐私保护由始终生效的安全底线保证，任何档位都安全。左端最柔和、右端最浓重；修改后，已生成的模糊照片会按新强度重新生成"
          >
            {/* 刻度只标数字：带中文的长标签在滑杆两端会被容器裁掉（实测「20 最浓重」换行后截断），
                语义改由上面的 extra 文案承担 */}
            <Slider min={6} max={20} step={1} marks={{ 6: '6', 12: '12', 20: '20' }} style={{ maxWidth: 480 }} />
          </Form.Item>

          {/* 完整规格参数：将当前档位实际生效的算法参数展开供管理员查看 */}
          {activeSpec ? (
            <Descriptions
              size="small"
              bordered
              column={3}
              style={{ maxWidth: 760, marginBottom: 16 }}
              title="完整规格参数（当前档位实际生效值）"
              items={[
                { key: 'strength', label: '模糊强度', children: `${activeSpec.strength} / 20` },
                {
                  key: 'floorPx',
                  label: '隐私安全底线',
                  children: `${activeSpec.floorPx} px（固定，不随档位变化）`,
                },
                { key: 'sigma', label: '高斯模糊 σ', children: `${activeSpec.sigma} px` },
                { key: 'noiseSigma', label: '噪点抖动 σ', children: `${activeSpec.noiseSigma} / 255` },
                { key: 'quality', label: 'JPEG 质量', children: activeSpec.quality },
                { key: 'outputPx', label: '输出长边', children: `${activeSpec.outputPx} px` },
              ]}
            />
          ) : null}
          <Button type="primary" loading={savingPolicy} onClick={handleSavePolicy}>
            保存策略
          </Button>
        </Form>
      </Card>

      {/* ② 全局查看密码 */}
      <Card size="small" title="全局查看密码" style={{ marginBottom: 16 }}>
        <Space direction="vertical" size={12} style={{ width: '100%' }}>
          <Space size={8}>
            <span className="t-sec" style={{ fontSize: 12 }}>
              当前状态
            </span>
            <Tag color={policy?.hasPassword ? 'green' : 'default'}>
              {policy?.hasPassword ? '已设置' : '未设置'}
            </Tag>
          </Space>
          <Space size={8} wrap>
            <Input.Password
              value={passwordDraft}
              onChange={(event) => setPasswordDraft(event.target.value)}
              placeholder="新的查看密码"
              autoComplete="new-password"
              style={{ width: 200 }}
            />
            <Input.Password
              value={passwordConfirm}
              onChange={(event) => setPasswordConfirm(event.target.value)}
              placeholder="再次输入"
              autoComplete="new-password"
              style={{ width: 200 }}
            />
            <Button
              type="primary"
              loading={savingPassword}
              disabled={passwordDraft === ''}
              onClick={() => void handleSetPassword(passwordDraft)}
            >
              设置密码
            </Button>
            <Popconfirm
              title="确认清除全局查看密码？"
              description="清除后任何访客都能直接查看隐私照片（受策略与角色限制）。"
              okText="确认清除"
              cancelText="取消"
              okButtonProps={{ danger: true }}
              onConfirm={() => void handleSetPassword(null)}
            >
              <Button danger disabled={!policy?.hasPassword} loading={savingPassword}>
                清除密码
              </Button>
            </Popconfirm>
          </Space>
          <span className="t-qua" style={{ fontSize: 11 }}>
            密码只存哈希，设置后无法查看原值，只能重设或清除。
          </span>
        </Space>
      </Card>

      {/* ③ 分享链接 */}
      <Card
        size="small"
        title="时效分享链接"
        style={{ marginBottom: 16 }}
        extra={
          <Button type="primary" onClick={() => setCreatingShare(true)}>
            创建分享链接
          </Button>
        }
      >
        <Table<PrivacyShare>
          rowKey="id"
          size="small"
          loading={loading}
          columns={columns}
          dataSource={shares}
          scroll={{ x: 900 }}
          locale={{ emptyText: <Empty description="暂无分享链接" /> }}
          pagination={{ pageSize: 10, showTotal: (total) => `共 ${total} 条` }}
        />
      </Card>

      {/* ④ 单张独立密码 */}
      <Card size="small" title="单张独立密码">
        <Space direction="vertical" size={12} style={{ width: '100%' }}>
          <Space size={8} wrap>
            <Input
              value={photoId}
              onChange={(event) => setPhotoId(event.target.value)}
              placeholder="照片编号"
              style={{ width: 320 }}
              allowClear
            />
            <Input.Password
              value={photoPassword}
              onChange={(event) => setPhotoPassword(event.target.value)}
              placeholder="该照片的独立密码"
              autoComplete="new-password"
              style={{ width: 200 }}
            />
            <Button
              type="primary"
              loading={savingPhotoPassword}
              disabled={photoId.trim() === '' || photoPassword === ''}
              onClick={() => void handleSetPhotoPassword(photoPassword)}
            >
              设置独立密码
            </Button>
            <Popconfirm
              title="确认清除这张照片的独立密码？"
              description="清除后将改由全局策略与全局密码控制。"
              okText="确认清除"
              cancelText="取消"
              okButtonProps={{ danger: true }}
              onConfirm={() => void handleSetPhotoPassword(null)}
            >
              <Button danger disabled={photoId.trim() === ''} loading={savingPhotoPassword}>
                清除独立密码
              </Button>
            </Popconfirm>
          </Space>
          <span className="t-qua" style={{ fontSize: 11 }}>
            照片 ID 可在「照片管理」列表的标题下方复制。
          </span>
        </Space>
      </Card>

      <ShareCreateModal
        open={creatingShare}
        onClose={() => setCreatingShare(false)}
        onCreated={(share) => setShares((prev) => [share, ...prev])}
      />
    </div>
  );
}