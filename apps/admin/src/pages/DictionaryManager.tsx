/**
 * apps/admin/src/pages/DictionaryManager.tsx
 *
 * 字典管理：维护搜索框的「候选值清单」（机身 / 镜头 / 光圈 / 快门 / ISO）。
 *
 * 【字典与照片是两条线】改字典只是改「下拉里能选什么」，不会回写照片 EXIF；
 * 反过来，已用过的值即使从字典删掉，照片本身也不受任何影响 —— 这条必须写在页面上，
 * 否则运营人员会误认为「删了就等于删数据」而不敢操作。
 * 【顺序由值本身决定，不做手动拖拽】光圈/快门/ISO 按数值、机身/镜头按字典序，
 * 这个口径由后端算好（order）并排好序，页面按其顺序展示即可；手工拖拽排序只会与之冲突。
 * 【类型元数据来自 core】有哪些类型、中文叫什么、有没有内置预设，全从 DICTIONARY_KINDS 取，
 * 与后端 / 搜索面板共用同一份契约，不会各写一版而导致不一致。
 */
import { useCallback, useEffect, useState } from 'react';
import { App, Button, Empty, Form, Input, Modal, Popconfirm, Segmented, Space, Table, Tag } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { DICTIONARY_KINDS, DICTIONARY_KIND_META } from '@shaping-memory/core';
import type { DictionaryKind } from '@shaping-memory/core';
import { dictionaryApi } from '@shaping-memory/sdk';
import type { DictionaryEntry } from '@shaping-memory/sdk';

/** 新增 / 编辑表单值：值必填，显示名选填（留空即按值本身展示） */
interface EntryFormValues {
  value: string;
  label?: string;
}

/** 类型切换器的选项与「当前类型」同源，避免两处各写一份造成不一致 */
const KIND_SEGMENT_OPTIONS = DICTIONARY_KINDS.map((meta) => ({ value: meta.kind, label: meta.label }));

export function DictionaryManager() {
  const { message } = App.useApp();
  const [kind, setKind] = useState<DictionaryKind>('camera');
  const [entries, setEntries] = useState<DictionaryEntry[]>([]);
  const [loading, setLoading] = useState(false);
  /** 正在整理中（sync 为耗时操作，单独一个状态控制按钮加载态） */
  const [syncing, setSyncing] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  /** 表单弹层：editing 为 null 即「新增」模式，否则是编辑该条 */
  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<DictionaryEntry | null>(null);
  const [form] = Form.useForm<EntryFormValues>();

  const meta = DICTIONARY_KIND_META[kind];

  const load = useCallback(async (): Promise<void> => {
    setLoading(true);
    // 用 try/catch/finally：只在 await 之后调用 setLoading(false) 会在请求抛错时使加载态永久停留
    try {
      setEntries(await dictionaryApi.list(kind));
    } catch (error) {
      message.error(error instanceof Error ? error.message : '字典加载失败');
    } finally {
      setLoading(false);
    }
  }, [kind, message]);

  // 切换类型即重拉该类型的清单
  useEffect(() => {
    void load();
  }, [load]);

  /** 从现有照片 EXIF 整理候选值（幂等，可反复执行） */
  const handleSync = async (): Promise<void> => {
    setSyncing(true);
    try {
      const reports = await dictionaryApi.sync();
      // 把逐类报告聚合为一句：「机身型号 +5 / 镜头型号 +4 / 光圈 +0 …」
      const summary = reports.map((report) => `${report.label} +${report.added}`).join(' / ');
      message.success(summary ? `整理完成：${summary}` : '整理完成，没有新增候选值');
      await load();
    } catch (error) {
      message.error(error instanceof Error ? error.message : '整理失败');
    } finally {
      setSyncing(false);
    }
  };

  /**
   * 打开弹层：新增即清空，编辑即铺入原值 —— **值在打开时即固定**。
   *
   * 【为什么不用 Form 的 initialValues】`Form.useForm()` 的实例比弹层存活更久，
   * rc-field-form 重挂载时算的是 `merge(initialValues, store)`，旧 store 会盖过新的
   * initialValues；卸载时又只有 `clearOnDestroy` 为真才清 store。因此「先编辑 A、
   * 再编辑 B」时输入框里仍保留 A 的值。resetFields + setFieldsValue 与是否重挂载无关。
   */
  const openForm = (entry: DictionaryEntry | null): void => {
    form.resetFields();
    form.setFieldsValue({ value: entry?.value ?? '', label: entry?.label ?? '' });
    setEditing(entry);
    setFormOpen(true);
  };

  const closeForm = useCallback((): void => {
    setFormOpen(false);
    setEditing(null);
    form.resetFields();
  }, [form]);

  const handleSubmit = async (): Promise<void> => {
    setSubmitting(true);
    try {
      const values = await form.validateFields();
      const value = values.value.trim();
      // 空串的显示名统一按 null 提交（后端缺省即为「用值展示」），避免存储大量空字符串
      const label = values.label?.trim() ? values.label.trim() : null;
      if (editing) {
        await dictionaryApi.update(editing.id, { value, label });
        message.success('字典项已更新');
      } else {
        await dictionaryApi.create({ kind, value, label });
        message.success('字典项已新增');
      }
      closeForm();
      await load();
    } catch (error) {
      if (error instanceof Error) message.error(error.message);
    } finally {
      setSubmitting(false);
    }
  };

  const handleRemove = async (entry: DictionaryEntry): Promise<void> => {
    try {
      await dictionaryApi.remove(entry.id);
      message.success(`已删除「${entry.label || entry.value}」`);
      await load();
    } catch (error) {
      message.error(error instanceof Error ? error.message : '删除失败');
    }
  };

  const columns: ColumnsType<DictionaryEntry> = [
    {
      title: '值',
      dataIndex: 'value',
      // 值是要被精确匹配与核对的，等宽字体更易扫读（如 1/200 与 1/20 不易混淆）
      render: (value: string) => <span style={{ fontFamily: 'var(--font-family-mono)' }}>{value}</span>,
    },
    {
      title: '显示名',
      dataIndex: 'label',
      render: (label: string | null) => (label ? label : <span className="t-qua">—</span>),
    },
    {
      title: '排序序号',
      dataIndex: 'sortOrder',
      width: 100,
      align: 'right',
    },
    {
      title: '来源',
      dataIndex: 'builtin',
      width: 110,
      render: (builtin: boolean) => (builtin ? <Tag color="gold">内置预设</Tag> : <Tag>自建</Tag>),
    },
    {
      title: '操作',
      key: 'action',
      width: 150,
      render: (_, record) => (
        <Space size={2}>
          <Button type="link" size="small" onClick={() => openForm(record)}>
            编辑
          </Button>
          <Popconfirm
            title="确认从字典中删除该值？"
            description="只影响候选项，不会改动已使用这个值的照片。"
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
        <span className="admin-page-title">字典管理</span>
        <Segmented<DictionaryKind>
          value={kind}
          onChange={setKind}
          options={KIND_SEGMENT_OPTIONS}
        />
        <div className="admin-toolbar__spacer" />
        <Button onClick={() => void handleSync()} loading={syncing}>
          从现有数据整理
        </Button>
        <Button onClick={() => void load()} loading={loading}>
          刷新
        </Button>
        <Button type="primary" onClick={() => openForm(null)}>
          新增
        </Button>
      </div>

      {/* 一句说明：明确字典与照片的关系，避免运营人员将「删除候选值」误认为「删除数据」 */}
      <div className="t-qua" style={{ fontSize: 12, marginBottom: 12 }}>
        字典只是搜索框的「候选值清单」：在这里增删改都不会改动照片本身；已用过的值即使删掉，也不影响照片。
      </div>

      <Table<DictionaryEntry>
        rowKey="id"
        size="small"
        loading={loading}
        columns={columns}
        dataSource={entries}
        locale={{ emptyText: <Empty description={`${meta.label}下暂无候选值`} /> }}
        pagination={{ pageSize: 20, showTotal: (total) => `共 ${total} 条` }}
      />

      <Modal
        open={formOpen}
        title={editing ? `编辑${meta.label}` : `新增${meta.label}`}
        okText={editing ? '保存' : '新增'}
        cancelText="取消"
        confirmLoading={submitting}
        onOk={handleSubmit}
        onCancel={closeForm}
        destroyOnHidden
      >
        {/* key 只负责让 DOM 每次重来；表单值的正确性由 openForm 保证 */}
        <Form<EntryFormValues> key={editing?.id ?? 'new'} form={form} layout="vertical" requiredMark={false}>
          <Form.Item name="value" label="值" rules={[{ required: true, message: '请输入字典值' }]}>
            <Input placeholder={meta.placeholder} allowClear />
          </Form.Item>
          <Form.Item
            name="label"
            label="显示名"
            extra={meta.preset ? '该类型内置标准档位；显示名留空即按值本身展示' : '显示名留空即按值本身展示'}
          >
            <Input placeholder="选填" allowClear />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  );
}