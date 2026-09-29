/**
 * apps/admin/src/pages/CategoryManager.tsx
 *
 * 分类管理：新建 / 改名 / 删除。
 *
 * 【改名会连带改照片】后端在同一个事务里把该分类下照片的分类值一起改掉，
 * 因此前端改名后必须重拉列表（照片的 cat 已经变了，缓存的旧值不能再用）。
 * 【有照片时不许删】后端对「分类下仍有照片」返回 409；这里捕获状态码给出定向提示，
 * 而不是把 sdk 的 'API 409: /categories/xx' 原样返回给用户。
 */
import { useCallback, useEffect, useState } from 'react';
import { App, Button, Empty, Form, Input, InputNumber, Modal, Popconfirm, Space, Table } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { categoryApi } from '@shaping-memory/sdk';
import type { Category } from '@shaping-memory/sdk';

import { apiStatus } from '../lib/api-error';

/** 新建表单值：名称必填，排序可留空（后端按末尾追加处理） */
interface CreateFormValues {
  name: string;
  sortOrder?: number;
}

export function CategoryManager() {
  const { message } = App.useApp();
  const [categories, setCategories] = useState<Category[]>([]);
  const [loading, setLoading] = useState(false);
  const [creating, setCreating] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  /** 正在改名的分类 id：行内编辑态，同一时刻只允许一行 */
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState('');
  const [form] = Form.useForm<CreateFormValues>();

  const load = useCallback(async (): Promise<void> => {
    setLoading(true);
    try {
      setCategories(await categoryApi.list());
    } catch (error) {
      message.error(error instanceof Error ? error.message : '分类列表加载失败');
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
      const values = await form.validateFields();
      await categoryApi.create(values.name.trim(), values.sortOrder ?? undefined);
      message.success('分类已创建');
      setCreating(false);
      form.resetFields();
      await load();
    } catch (error) {
      if (error instanceof Error) message.error(error.message);
    } finally {
      setSubmitting(false);
    }
  };

  const handleRename = async (category: Category): Promise<void> => {
    const name = renameDraft.trim();
    if (name === '' || name === category.name) {
      setRenamingId(null);
      return;
    }
    try {
      await categoryApi.rename(category.id, name);
      message.success('分类已改名，该分类下的照片已同步更新');
      setRenamingId(null);
      await load();
    } catch (error) {
      message.error(error instanceof Error ? error.message : '改名失败');
    }
  };

  const handleRemove = async (category: Category): Promise<void> => {
    try {
      await categoryApi.remove(category.id);
      message.success(`已删除分类「${category.name}」`);
      await load();
    } catch (error) {
      // 409 = 分类下还有照片：这是最常见的失败原因，单独提示怎么处理
      if (apiStatus(error) === 409) {
        message.error(`「${category.name}」下还有 ${category.count} 张照片，请先改到其它分类再删除`);
        return;
      }
      message.error(error instanceof Error ? error.message : '删除失败');
    }
  };

  const columns: ColumnsType<Category> = [
    {
      title: '名称',
      dataIndex: 'name',
      render: (name: string, record) =>
        renamingId === record.id ? (
          <Space size={4}>
            <Input
              size="small"
              value={renameDraft}
              autoFocus
              onChange={(event) => setRenameDraft(event.target.value)}
              onPressEnter={() => void handleRename(record)}
              style={{ width: 180 }}
            />
            <Button type="link" size="small" onClick={() => void handleRename(record)}>
              保存
            </Button>
            <Button type="link" size="small" onClick={() => setRenamingId(null)}>
              取消
            </Button>
          </Space>
        ) : (
          name
        ),
    },
    {
      title: '照片数',
      dataIndex: 'count',
      width: 100,
      align: 'right',
    },
    {
      title: '排序',
      dataIndex: 'sortOrder',
      width: 90,
      align: 'right',
    },
    {
      title: '操作',
      key: 'action',
      width: 160,
      render: (_, record) => (
        <Space size={2}>
          <Button
            type="link"
            size="small"
            onClick={() => {
              setRenamingId(record.id);
              setRenameDraft(record.name);
            }}
          >
            改名
          </Button>
          <Popconfirm
            title="确认删除该分类？"
            description="分类下仍有照片时无法删除；删除后不可恢复。"
            okText="删除"
            cancelText="取消"
            okButtonProps={{ danger: true }}
            onConfirm={() => handleRemove(record)}
          >
            <Button type="link" size="small" danger>
              删除
            </Button>
          </Popconfirm>
        </Space>
      ),
    },
  ];

  return (
    <div>
      <div className="admin-toolbar">
        <span className="admin-page-title">分类管理</span>
        <div className="admin-toolbar__spacer" />
        <Button onClick={() => void load()} loading={loading}>
          刷新
        </Button>
        <Button type="primary" onClick={() => setCreating(true)}>
          新建分类
        </Button>
      </div>

      <Table<Category>
        rowKey="id"
        size="small"
        loading={loading}
        columns={columns}
        dataSource={categories}
        locale={{ emptyText: <Empty description="暂无分类" /> }}
        pagination={{ pageSize: 20, showTotal: (total) => `共 ${total} 个分类` }}
      />

      <Modal
        open={creating}
        title="新建分类"
        okText="创建"
        cancelText="取消"
        confirmLoading={submitting}
        onOk={handleCreate}
        onCancel={() => {
          setCreating(false);
          form.resetFields();
        }}
        destroyOnHidden
      >
        <Form<CreateFormValues> form={form} layout="vertical" requiredMark={false}>
          <Form.Item name="name" label="分类名称" rules={[{ required: true, message: '请输入分类名称' }]}>
            <Input placeholder="如 风光" allowClear />
          </Form.Item>
          <Form.Item name="sortOrder" label="排序值" extra="数值越小越靠前；留空即排在末尾">
            <InputNumber style={{ width: '100%' }} step={1} />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  );
}