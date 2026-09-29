/**
 * apps/admin/src/pages/AlbumGroupManager.tsx
 *
 * 相册分组管理：新建 / 改名 / 删除（含相册迁移）/ 拖拽排序。
 *
 * 【排序为什么「全量上送」】后端 reorder 按下标重写 sortOrder，
 * 因此本地把顺序调好后，直接把整个 id 列表传上去即可，无需自行计算差异。
 * 【删除为什么要弹窗而不是 Popconfirm】删组时组内相册必须有去处，
 * 弹窗里让用户在「其它分组」中选一个（默认落到内置的「默认分组」）。
 * 【为什么拖拽只认把手】antd 表格行整行 draggable 会把「点按钮、选文字」都变成拖拽，
 * 因此行只在「拖拽把手」上真正发起拖动；上移 / 下移按钮供不便拖拽时使用。
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { App, Button, Empty, Form, Input, Modal, Select, Space, Table, Tag } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { albumGroupApi } from '@shaping-memory/sdk';
import type { AlbumGroup } from '@shaping-memory/sdk';

/** 把 key 移到 target 的位置（与照片管理页的列换位同一套语义） */
function moveId(ids: string[], key: string, target: string): string[] {
  const from = ids.indexOf(key);
  const to = ids.indexOf(target);
  if (from < 0 || to < 0 || from === to) return ids;
  const next = [...ids];
  next.splice(from, 1);
  next.splice(to, 0, key);
  return next;
}

export function AlbumGroupManager() {
  const { message } = App.useApp();
  const [groups, setGroups] = useState<AlbumGroup[]>([]);
  const [loading, setLoading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  /** 编辑目标：null = 未打开；editingNew 区分「新建」与「改名」 */
  const [editing, setEditing] = useState<AlbumGroup | null>(null);
  const [editingNew, setEditingNew] = useState(false);
  /** 待删除的分组；非 null 时删除弹窗打开 */
  const [removing, setRemoving] = useState<AlbumGroup | null>(null);
  /** 删除时的迁移目标（默认「默认分组」） */
  const [moveTo, setMoveTo] = useState<string>('');
  const [form] = Form.useForm<{ name: string }>();
  /** 正在被拖动的分组 id，用于给行加高亮 */
  const [dragId, setDragId] = useState<string | null>(null);

  const load = useCallback(async (): Promise<void> => {
    setLoading(true);
    try {
      setGroups(await albumGroupApi.list());
    } catch (error) {
      message.error(error instanceof Error ? error.message : '分组列表加载失败');
    } finally {
      setLoading(false);
    }
  }, [message]);

  useEffect(() => {
    void load();
  }, [load]);

  /** 删除弹窗里的候选去处：除自己以外的全部分组，内置的「默认分组」排最前 */
  const moveTargets = useMemo(() => {
    if (!removing) return [];
    return groups
      .filter((group) => group.id !== removing.id)
      .map((group) => ({ label: group.builtin ? `${group.name}（推荐）` : group.name, value: group.id }));
  }, [groups, removing]);

  const openRemoving = useCallback(
    (group: AlbumGroup): void => {
      // 默认迁到「默认分组」；它一定存在，因此这里的初始值永远有效
      const fallback = groups.find((item) => item.builtin)?.id ?? groups.find((item) => item.id !== group.id)?.id ?? '';
      setRemoving(group);
      setMoveTo(fallback);
    },
    [groups],
  );

  /**
   * 打开弹窗（group 为 null 即新建）：状态与表单值一起设。
   *
   * 【为什么不用 Form 的 initialValues】`Form.useForm()` 的实例比弹窗存活更久，
   * rc-field-form 重挂载时算的是 `merge(initialValues, store)`，旧 store 会盖过新 initialValues；
   * 因此「先改名 A 组、再改名 B 组」时输入框里仍为 A 的名字。显式回填才能对齐本次的目标。
   */
  const openEditor = useCallback(
    (group: AlbumGroup | null): void => {
      form.resetFields();
      form.setFieldsValue({ name: group?.name ?? '' });
      setEditing(group);
      setEditingNew(group === null);
    },
    [form],
  );

  const handleSubmit = async (): Promise<void> => {
    setSubmitting(true);
    try {
      const values = await form.validateFields();
      if (editing) {
        await albumGroupApi.update(editing.id, { name: values.name.trim() });
        message.success('分组已更新');
      } else {
        await albumGroupApi.create(values.name.trim());
        message.success('分组已创建');
      }
      setEditing(null);
      setEditingNew(false);
      await load();
    } catch (error) {
      // 表单校验失败不是 Error 实例，只有接口报错才提示
      if (error instanceof Error) message.error(error.message);
    } finally {
      setSubmitting(false);
    }
  };

  const handleRemove = async (): Promise<void> => {
    if (!removing) return;
    setSubmitting(true);
    try {
      const result = await albumGroupApi.remove(removing.id, moveTo || undefined);
      message.success(
        result.moved > 0
          ? `已删除分组「${removing.name}」，${result.moved} 个相册已转移`
          : `已删除分组「${removing.name}」`,
      );
      setRemoving(null);
      await load();
    } catch (error) {
      message.error(error instanceof Error ? error.message : '删除失败');
    } finally {
      setSubmitting(false);
    }
  };

  /** 本地先换位（界面立即响应），再把整份顺序上送；失败则回滚并重拉 */
  const persistOrder = useCallback(
    async (next: AlbumGroup[]): Promise<void> => {
      const previous = groups;
      setGroups(next);
      try {
        setGroups(await albumGroupApi.reorder(next.map((group) => group.id)));
      } catch (error) {
        setGroups(previous);
        message.error(error instanceof Error ? error.message : '排序保存失败');
      }
    },
    [groups, message],
  );

  const shift = useCallback(
    (group: AlbumGroup, delta: number): void => {
      const index = groups.findIndex((item) => item.id === group.id);
      const target = groups[index + delta];
      if (!target) return;
      // moveId 只处理 id 序列，因此先取出 id 列表，换位后再映射回分组对象
      const ids = moveId(groups.map((item) => item.id), group.id, target.id);
      void persistOrder(ids.map((id) => groups.find((item) => item.id === id)!));
    },
    [groups, persistOrder],
  );

  const columns: ColumnsType<AlbumGroup> = [
    {
      title: '',
      key: 'drag',
      width: 44,
      align: 'center',
      render: () => (
        <span className="group-drag-handle" title="按住拖动可调整顺序">
          ≡
        </span>
      ),
    },
    {
      title: '名称',
      dataIndex: 'name',
      render: (name: string, record) => (
        <Space size={6}>
          <span>{name}</span>
          {record.builtin && <Tag color="blue">默认</Tag>}
        </Space>
      ),
    },
    { title: '相册数', dataIndex: 'count', width: 90, align: 'right' },
    { title: '排序', dataIndex: 'sortOrder', width: 80, align: 'right' },
    {
      title: '操作',
      key: 'action',
      width: 200,
      render: (_, record, index) => (
        <Space size={2}>
          <Button type="link" size="small" disabled={index === 0} onClick={() => shift(record, -1)}>
            上移
          </Button>
          <Button type="link" size="small" disabled={index === groups.length - 1} onClick={() => shift(record, 1)}>
            下移
          </Button>
          <Button
            type="link"
            size="small"
            disabled={record.builtin}
            onClick={() => openEditor(record)}
          >
            改名
          </Button>
          <Button type="link" size="small" danger disabled={record.builtin} onClick={() => openRemoving(record)}>
            删除
          </Button>
        </Space>
      ),
    },
  ];

  return (
    <div>
      <div className="admin-toolbar">
        <span className="admin-page-title">分组管理</span>
        <div className="admin-toolbar__spacer" />
        <Button onClick={() => void load()} loading={loading}>
          刷新
        </Button>
        <Button
          type="primary"
          onClick={() => openEditor(null)}
        >
          新建分组
        </Button>
      </div>

      <div className="t-qua" style={{ fontSize: 11, marginBottom: 8 }}>
        拖动左侧把手可调整分组在前台影集页的展示顺序；「默认分组」不可改名、不可删除。
      </div>

      <Table<AlbumGroup>
        rowKey="id"
        size="small"
        loading={loading}
        columns={columns}
        dataSource={groups}
        pagination={false}
        locale={{ emptyText: <Empty description="暂无分组" /> }}
        // 行只在「拖拽把手」上发起拖动：避免按住按钮或选中文字时误触发
        onRow={(record) => ({
          draggable: true,
          className: dragId === record.id ? 'group-row--dragging' : undefined,
          onDragStart: (event) => {
            if (!(event.target as HTMLElement).closest('.group-drag-handle')) {
              event.preventDefault();
              return;
            }
            setDragId(record.id);
          },
          onDragOver: (event) => event.preventDefault(),
          onDrop: () => {
            if (dragId && dragId !== record.id) {
              const ids = moveId(groups.map((item) => item.id), dragId, record.id);
              void persistOrder(ids.map((id) => groups.find((item) => item.id === id)!));
            }
            setDragId(null);
          },
          onDragEnd: () => setDragId(null),
        })}
      />

      <Modal
        open={editingNew || editing !== null}
        title={editing ? `分组改名 · ${editing.name}` : '新建分组'}
        okText="保存"
        cancelText="取消"
        confirmLoading={submitting}
        onOk={handleSubmit}
        onCancel={() => {
          setEditing(null);
          setEditingNew(false);
        }}
        key={editing?.id ?? 'new'}
        destroyOnHidden
      >
        <Form<{ name: string }> form={form} layout="vertical" requiredMark={false}>
          <Form.Item
            name="name"
            label="分组名称"
            rules={[
              { required: true, message: '请输入分组名称' },
              { max: 20, message: '分组名不能超过 20 个字' },
            ]}
            extra="名称需唯一；不能包含 < > & 等字符"
          >
            <Input placeholder="如 2024 秋季旅行" allowClear />
          </Form.Item>
        </Form>
      </Modal>

      <Modal
        open={removing !== null}
        title={removing ? `删除分组 · ${removing.name}` : '删除分组'}
        okText="确认删除"
        cancelText="取消"
        okButtonProps={{ danger: true }}
        confirmLoading={submitting}
        onOk={handleRemove}
        onCancel={() => setRemoving(null)}
      >
        <p>
          分组「{removing?.name}」下有 <b>{removing?.count ?? 0}</b> 个相册，删除后它们会被移动到：
        </p>
        <Select
          style={{ width: '100%', marginTop: 8 }}
          value={moveTo || undefined}
          onChange={setMoveTo}
          options={moveTargets}
          placeholder="选择接收这些相册的分组"
        />
      </Modal>
    </div>
  );
}