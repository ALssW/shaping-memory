/**
 * apps/admin/src/pages/UserManager.tsx
 *
 * 账号管理：新建 / 改角色 / 重置密码 / 删除（仅 admin 可见本页）。
 *
 * 【不允许删自己】删除当前登录账号会使后台立即失去管理员（甚至导致自身无法登录），
 * 这是没有补救手段的高危操作，因此前端直接禁用，后端同样会拒绝。
 * 【改角色走行内下拉】角色的调整是高频小操作，为其单独开弹窗并不划算；修改后立即提交并刷新该行。
 */
import { useCallback, useEffect, useState } from 'react';
import { App, Button, Empty, Form, Input, Modal, Popconfirm, Select, Space, Table, Tag } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { userApi } from '@shaping-memory/sdk';
import type { AdminUser } from '@shaping-memory/sdk';

import { formatDateTime } from '../lib/format';
import type { Session } from '../lib/session';

/** 角色枚举：与后端一致，不做可配置（角色决定能调哪些接口，不是运营数据） */
const ROLE_OPTIONS = [
  { value: 'admin', label: 'admin（管理员）' },
  { value: 'editor', label: 'editor（编辑）' },
  { value: 'viewer', label: 'viewer（访客）' },
];

interface CreateFormValues {
  username: string;
  password: string;
  role: string;
}

interface PasswordFormValues {
  password: string;
}

interface UserManagerProps {
  /** 当前登录态：用于判断「哪一行是自己」 */
  session: Session;
}

export function UserManager({ session }: UserManagerProps) {
  const { message } = App.useApp();
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [loading, setLoading] = useState(false);
  const [creating, setCreating] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  /** 正在重置密码的账号；null = 弹窗关闭 */
  const [passwordTarget, setPasswordTarget] = useState<AdminUser | null>(null);
  const [createForm] = Form.useForm<CreateFormValues>();
  const [passwordForm] = Form.useForm<PasswordFormValues>();

  const load = useCallback(async (): Promise<void> => {
    setLoading(true);
    try {
      setUsers(await userApi.list());
    } catch (error) {
      message.error(error instanceof Error ? error.message : '账号列表加载失败');
    } finally {
      setLoading(false);
    }
  }, [message]);

  useEffect(() => {
    void load();
  }, [load]);

  const handleCreate = async (): Promise<void> => {
    setSubmitting(true);
    try {
      const values = await createForm.validateFields();
      await userApi.create({
        username: values.username.trim(),
        password: values.password,
        role: values.role,
      });
      message.success('账号已创建');
      setCreating(false);
      createForm.resetFields();
      await load();
    } catch (error) {
      if (error instanceof Error) message.error(error.message);
    } finally {
      setSubmitting(false);
    }
  };

  const handleRoleChange = async (user: AdminUser, role: string): Promise<void> => {
    try {
      const updated = await userApi.update(user.id, { role });
      // 单行结果原地替换，避免整表重拉导致下拉框闪烁
      setUsers((prev) => prev.map((item) => (item.id === updated.id ? updated : item)));
      message.success(`「${user.username}」的角色已改为 ${role}`);
    } catch (error) {
      message.error(error instanceof Error ? error.message : '角色修改失败');
    }
  };

  const handleResetPassword = async (): Promise<void> => {
    if (!passwordTarget) return;
    setSubmitting(true);
    try {
      const values = await passwordForm.validateFields();
      await userApi.update(passwordTarget.id, { password: values.password });
      message.success(`已重置「${passwordTarget.username}」的密码`);
      setPasswordTarget(null);
      passwordForm.resetFields();
    } catch (error) {
      if (error instanceof Error) message.error(error.message);
    } finally {
      setSubmitting(false);
    }
  };

  const handleRemove = async (user: AdminUser): Promise<void> => {
    try {
      await userApi.remove(user.id);
      message.success(`已删除账号「${user.username}」`);
      await load();
    } catch (error) {
      message.error(error instanceof Error ? error.message : '删除失败');
    }
  };

  const columns: ColumnsType<AdminUser> = [
    { title: '用户名', dataIndex: 'username', render: (username: string) => username },
    {
      title: '角色',
      dataIndex: 'role',
      width: 220,
      render: (role: string, record) => (
        <Select
          size="small"
          value={role}
          style={{ width: 180 }}
          options={ROLE_OPTIONS}
          onChange={(next) => void handleRoleChange(record, next)}
        />
      ),
    },
    {
      title: '创建时间',
      dataIndex: 'createdAt',
      width: 180,
      render: (createdAt: string) => formatDateTime(createdAt),
    },
    {
      title: '操作',
      key: 'action',
      width: 180,
      render: (_, record) => {
        const isSelf = record.username === session.username;
        return (
          <Space size={2}>
            <Button type="link" size="small" onClick={() => setPasswordTarget(record)}>
              重置密码
            </Button>
            {isSelf ? (
              <Tag color="default">当前账号</Tag>
            ) : (
              <Popconfirm
                title="确认删除该账号？"
                description="删除后该账号立即失效，且不可恢复。"
                okText="删除"
                cancelText="取消"
                okButtonProps={{ danger: true }}
                onConfirm={() => handleRemove(record)}
              >
                <Button type="link" size="small" danger>
                  删除
                </Button>
              </Popconfirm>
            )}
          </Space>
        );
      },
    },
  ];

  return (
    <div>
      <div className="admin-toolbar">
        <span className="admin-page-title">账号管理</span>
        <div className="admin-toolbar__spacer" />
        <Button onClick={() => void load()} loading={loading}>
          刷新
        </Button>
        <Button type="primary" onClick={() => setCreating(true)}>
          新建账号
        </Button>
      </div>

      <Table<AdminUser>
        rowKey="id"
        size="small"
        loading={loading}
        columns={columns}
        dataSource={users}
        locale={{ emptyText: <Empty description="暂无账号" /> }}
        pagination={false}
      />

      <Modal
        open={creating}
        title="新建账号"
        okText="创建"
        cancelText="取消"
        confirmLoading={submitting}
        onOk={handleCreate}
        onCancel={() => {
          setCreating(false);
          createForm.resetFields();
        }}
        destroyOnHidden
      >
        <Form<CreateFormValues>
          form={createForm}
          layout="vertical"
          requiredMark={false}
          initialValues={{ username: '', password: '', role: 'editor' }}
        >
          <Form.Item name="username" label="用户名" rules={[{ required: true, message: '请输入用户名' }]}>
            <Input placeholder="登录账号" allowClear />
          </Form.Item>
          <Form.Item
            name="password"
            label="密码"
            rules={[
              { required: true, message: '请输入密码' },
              { min: 6, message: '密码至少 6 位' },
            ]}
          >
            <Input.Password placeholder="初始密码" />
          </Form.Item>
          <Form.Item name="role" label="角色" rules={[{ required: true, message: '请选择角色' }]}>
            <Select options={ROLE_OPTIONS} />
          </Form.Item>
        </Form>
      </Modal>

      <Modal
        open={passwordTarget !== null}
        title={passwordTarget ? `重置「${passwordTarget.username}」的密码` : '重置密码'}
        okText="确认重置"
        cancelText="取消"
        confirmLoading={submitting}
        onOk={handleResetPassword}
        onCancel={() => {
          setPasswordTarget(null);
          passwordForm.resetFields();
        }}
        destroyOnHidden
      >
        <Form<PasswordFormValues> form={passwordForm} layout="vertical" requiredMark={false}>
          <Form.Item
            name="password"
            label="新密码"
            rules={[
              { required: true, message: '请输入新密码' },
              { min: 6, message: '密码至少 6 位' },
            ]}
          >
            <Input.Password placeholder="新密码" autoComplete="new-password" />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  );
}