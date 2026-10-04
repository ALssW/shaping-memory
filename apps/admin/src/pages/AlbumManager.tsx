/**
 * apps/admin/src/pages/AlbumManager.tsx
 *
 * 相册管理：按分组树形展示 + 新建 / 改信息 / 删除 + 「管理照片」抽屉（选片与排序）。
 *
 * 【为什么改成树形】分组原来只是表格里的一列文本标签，看不出「哪个分组下有哪些相册」；
 * 树形把分组作为父行、相册作为子行，收起展开即可按分组浏览。
 * 【照片顺序 = ids 顺序】后端 setMedia 是全量替换：传进去的 ids 数组下标即册内 sortOrder，
 * 因此抽屉里的多选结果必须保持「点选顺序」—— 这里直接采用 antd rowSelection 返回的 keys 数组
 * （它在未开 preserveSelectedRowKeys 时就是按点选先后追加的），不做二次排序。
 * 【为什么 rowSelection 用 checkStrictly】父子联动会让「勾中分组」连带勾中它的全部相册；
 * 批量移动分组只应作用于用户逐个挑出的相册行，因此父子不联动，且分组行的勾选框直接禁用。
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { Key } from 'react';
import {
  App,
  Button,
  Divider,
  Drawer,
  Empty,
  Form,
  Image,
  Input,
  Modal,
  Popconfirm,
  Select,
  Space,
  Switch,
  Table,
  Tag,
  Tooltip,
} from 'antd';
import type { ColumnsType } from 'antd/es/table';
import type { Photo } from '@shaping-memory/core';
import { albumApi, albumGroupApi, photoApi } from '@shaping-memory/sdk';
import type { Album, AlbumGroup } from '@shaping-memory/sdk';

import { FolderUploadModal } from '../components/FolderUploadModal';
import { formatDateTime } from '../lib/format';

interface AlbumFormValues {
  title: string;
  description: string;
  isPublic: boolean;
  /** 所属分组 id；不选则落到「默认分组」 */
  groupId?: string;
}

/** 兜底桶的键：分组已不存在或相册没有归属时收在这里 */
const UNGROUPED_KEY = 'g:__none__';

/** 树的父行：一个分组（或兜底桶） */
interface GroupRow {
  key: string;
  isGroup: true;
  name: string;
  builtin: boolean;
  albumCount: number;
  photoCount: number;
  /** 兜底桶不对应任何真实的 group，因此没有可操作的对象 */
  group: AlbumGroup | null;
  children: AlbumRow[];
}

/** 树的子行：一个相册 */
interface AlbumRow {
  key: string;
  isGroup: false;
  album: Album;
}

type AlbumTreeNode = GroupRow | AlbumRow;

export function AlbumManager() {
  const { message } = App.useApp();
  const [albums, setAlbums] = useState<Album[]>([]);
  const [groups, setGroups] = useState<AlbumGroup[]>([]);
  const [loading, setLoading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  /** 编辑目标；null = 未打开。editingNew 区分「新建」与「编辑」，两者共用一个表单 */
  const [editing, setEditing] = useState<Album | null>(null);
  const [editingNew, setEditingNew] = useState(false);
  const [form] = Form.useForm<AlbumFormValues>();
  /** 文件夹上传弹窗：选若干本地文件夹，各自以文件夹名建相册 */
  const [folderUpload, setFolderUpload] = useState(false);
  /** 新建分组的内联输入框内容（在分组下拉底部展开） */
  const [newGroupName, setNewGroupName] = useState('');
  const [creatingGroup, setCreatingGroup] = useState(false);
  /** 表格多选（批量移动分组用） */
  const [checkedIds, setCheckedIds] = useState<string[]>([]);
  const [batchOpen, setBatchOpen] = useState(false);
  const [batchTarget, setBatchTarget] = useState<string | undefined>(undefined);
  /** 分组行的展开状态（键为分组行的 key） */
  const [expandedKeys, setExpandedKeys] = useState<string[]>([]);
  /** 分组改名弹窗 */
  const [groupEditing, setGroupEditing] = useState<AlbumGroup | null>(null);
  const [groupName, setGroupName] = useState('');
  /** 分组删除弹窗（组内相册必须有去处）与迁移目标 */
  const [groupRemoving, setGroupRemoving] = useState<AlbumGroup | null>(null);
  const [moveTo, setMoveTo] = useState('');

  /* ---- 管理照片抽屉 ---- */
  const [mediaAlbum, setMediaAlbum] = useState<Album | null>(null);
  const [photos, setPhotos] = useState<Photo[]>([]);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [mediaLoading, setMediaLoading] = useState(false);

  /**
   * 分组 → 相册 的树。顺序沿用分组自身的 sortOrder（服务端已排好），
   * 无归属或指向已不存在分组的相册收进末尾的「未分组」兜底桶 —— 否则它们会从界面上消失。
   */
  const treeData = useMemo<AlbumTreeNode[]>(() => {
    const known = new Set(groups.map((group) => group.id));
    const rows: GroupRow[] = groups.map((group) => {
      const children: AlbumRow[] = albums
        .filter((album) => album.groupId === group.id)
        .map((album) => ({ key: album.id, isGroup: false, album }));
      return {
        key: `g:${group.id}`,
        isGroup: true,
        name: group.name,
        builtin: group.builtin,
        albumCount: children.length,
        photoCount: children.reduce((sum, child) => sum + child.album.count, 0),
        group,
        children,
      };
    });

    const loose = albums.filter((album) => !album.groupId || !known.has(album.groupId));
    if (loose.length > 0) {
      const children: AlbumRow[] = loose.map((album) => ({ key: album.id, isGroup: false, album }));
      rows.push({
        key: UNGROUPED_KEY,
        isGroup: true,
        name: '未分组',
        builtin: false,
        albumCount: children.length,
        photoCount: children.reduce((sum, child) => sum + child.album.count, 0),
        group: null,
        children,
      });
    }
    return rows;
  }, [albums, groups]);

  const load = useCallback(async (): Promise<void> => {
    setLoading(true);
    try {
      // 相册与分组一起拉：列表要显示分组名、树要按分组归类
      const [albumList, groupList] = await Promise.all([albumApi.list(), albumGroupApi.list()]);
      setAlbums(albumList);
      setGroups(groupList);
      // 已不存在的相册要从勾选中剔除，否则批量移动会包含已失效的 id
      const alive = new Set(albumList.map((album) => album.id));
      setCheckedIds((prev) => prev.filter((id) => alive.has(id)));
      // 首次加载默认展开全部分组；此后保留用户的收起 / 展开选择
      setExpandedKeys((prev) =>
        prev.length > 0 ? prev : [`${UNGROUPED_KEY}`, ...groupList.map((group) => `g:${group.id}`)],
      );
    } catch (error) {
      message.error(error instanceof Error ? error.message : '相册列表加载失败');
    } finally {
      setLoading(false);
    }
  }, [message]);

  useEffect(() => {
    void load();
  }, [load]);

  // 打开抽屉时并行拉「全部照片」与「册内照片」：前者是候选池，后者给初始选中与顺序
  useEffect(() => {
    if (!mediaAlbum) return;
    let cancelled = false;
    setMediaLoading(true);
    Promise.all([photoApi.list(), albumApi.detail(mediaAlbum.id)])
      .then(([all, detail]) => {
        if (cancelled) return;
        setPhotos(all);
        setSelectedIds(detail.photos.map((photo) => photo.id));
      })
      .catch((error: unknown) => {
        if (!cancelled) message.error(error instanceof Error ? error.message : '照片加载失败');
      })
      .finally(() => {
        if (!cancelled) setMediaLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [mediaAlbum, message]);

  /**
   * 打开编辑器（album 为 null 即新建）：**状态与表单值一起设**。
   *
   * 【为什么必须显式回填，不能只靠 Form 的 initialValues】
   * `Form.useForm()` 拿到的实例比弹窗存活更久，而 rc-field-form 在重挂载时算的是
   * `merge(initialValues, store)` —— 旧 store 会盖过新的 initialValues；卸载时又只有
   * `clearOnDestroy` 为真才清 store，本项目没传这个属性。因此「先编辑相册 A、再打开相册 B」
   * 时标题栏仍为 A 的标题。这里 resetFields（顺带清掉上次的校验红字）+ setFieldsValue，
   * 把值在本次打开的目标上固定，与弹窗是否重挂载无关。
   */
  const openEditor = useCallback(
    (album: Album | null, presetGroupId?: string): void => {
      form.resetFields();
      form.setFieldsValue({
        title: album?.title ?? '',
        description: album?.description ?? '',
        isPublic: album?.isPublic ?? false,
        groupId: album?.groupId ?? presetGroupId ?? undefined,
      });
      setEditing(album);
      setEditingNew(album === null);
    },
    [form],
  );

  const closeEditor = useCallback((): void => {
    setEditing(null);
    setEditingNew(false);
    setNewGroupName('');
  }, []);

  /** 分组下拉的候选；内置「默认分组」加个标注，便于识别回退目标 */
  const groupOptions = useMemo(
    () => groups.map((group) => ({ label: group.builtin ? `${group.name}（默认）` : group.name, value: group.id })),
    [groups],
  );

  /** 分组名回显：找不到时显示「默认分组」，因为服务端会把无归属的册落到那里 */
  const groupNameOf = useCallback(
    (groupId: string | null): string => {
      if (!groupId) return '默认分组';
      return groups.find((group) => group.id === groupId)?.name ?? '默认分组';
    },
    [groups],
  );

  /** 在分组下拉底部直接新建一个分组，并把它设为当前表单的选中值 */
  const handleAddGroup = async (): Promise<void> => {
    const name = newGroupName.trim();
    if (!name) {
      message.warning('请输入新分组名称');
      return;
    }
    setCreatingGroup(true);
    try {
      const created = await albumGroupApi.create(name);
      message.success(`分组「${created.name}」已创建`);
      setNewGroupName('');
      // 新建后立即选中它：用户不必再回下拉里找一遍
      form.setFieldValue('groupId', created.id);
      setGroups(await albumGroupApi.list());
    } catch (error) {
      message.error(error instanceof Error ? error.message : '分组创建失败');
    } finally {
      setCreatingGroup(false);
    }
  };

  const handleSubmit = async (): Promise<void> => {
    setSubmitting(true);
    try {
      const values = await form.validateFields();
      const input = {
        title: values.title.trim(),
        description: values.description.trim(),
        isPublic: values.isPublic,
        ...(values.groupId ? { groupId: values.groupId } : {}),
      };
      if (editing) {
        await albumApi.update(editing.id, input);
        message.success('相册已更新');
      } else {
        await albumApi.create(input);
        message.success('相册已创建');
      }
      closeEditor();
      await load();
    } catch (error) {
      if (error instanceof Error) message.error(error.message);
    } finally {
      setSubmitting(false);
    }
  };

  /** 批量把勾选的相册移到目标分组 */
  const handleBatchMove = async (): Promise<void> => {
    if (!batchTarget) {
      message.warning('请选择目标分组');
      return;
    }
    setSubmitting(true);
    try {
      const result = await albumApi.assignGroup(checkedIds, batchTarget);
      message.success(`已将 ${result.moved} 个相册移动到「${groupNameOf(batchTarget)}」`);
      setBatchOpen(false);
      setCheckedIds([]);
      await load();
    } catch (error) {
      message.error(error instanceof Error ? error.message : '移动失败');
    } finally {
      setSubmitting(false);
    }
  };

  const handleRemove = async (album: Album): Promise<void> => {
    try {
      await albumApi.remove(album.id);
      message.success(`已删除相册「${album.title}」`);
      await load();
    } catch (error) {
      message.error(error instanceof Error ? error.message : '删除失败');
    }
  };

  /** 分组改名 */
  const handleRenameGroup = async (): Promise<void> => {
    if (!groupEditing) return;
    const name = groupName.trim();
    if (!name) {
      message.warning('请输入分组名称');
      return;
    }
    setSubmitting(true);
    try {
      await albumGroupApi.update(groupEditing.id, { name });
      message.success('分组已更新');
      setGroupEditing(null);
      await load();
    } catch (error) {
      message.error(error instanceof Error ? error.message : '分组更新失败');
    } finally {
      setSubmitting(false);
    }
  };

  /** 删除分组并把组内相册迁移到指定分组（默认迁到内置的「默认分组」） */
  const handleRemoveGroup = async (): Promise<void> => {
    if (!groupRemoving) return;
    setSubmitting(true);
    try {
      const result = await albumGroupApi.remove(groupRemoving.id, moveTo || undefined);
      message.success(
        result.moved > 0
          ? `已删除分组「${groupRemoving.name}」，${result.moved} 个相册已转移`
          : `已删除分组「${groupRemoving.name}」`,
      );
      setGroupRemoving(null);
      await load();
    } catch (error) {
      message.error(error instanceof Error ? error.message : '删除失败');
    } finally {
      setSubmitting(false);
    }
  };

  const handleSaveMedia = async (): Promise<void> => {
    if (!mediaAlbum) return;
    setSubmitting(true);
    try {
      await albumApi.setMedia(mediaAlbum.id, selectedIds);
      message.success(`册内照片已更新（共 ${selectedIds.length} 张，顺序按选择先后）`);
      setMediaAlbum(null);
      await load();
    } catch (error) {
      message.error(error instanceof Error ? error.message : '册内照片保存失败');
    } finally {
      setSubmitting(false);
    }
  };

  /** 分组行的操作：改名 / 在本分组新建相册 / 删除并迁移 */
  const renderGroupAction = (record: GroupRow): React.ReactNode => {
    if (!record.group) return <span className="t-qua">—</span>;
    const group = record.group;
    return (
      <Space size={2}>
        <Button type="link" size="small" onClick={() => openEditor(null, group.id)}>
          新建相册
        </Button>
        <Button
          type="link"
          size="small"
          disabled={group.builtin}
          onClick={() => {
            setGroupName(group.name);
            setGroupEditing(group);
          }}
        >
          改名
        </Button>
        <Button
          type="link"
          size="small"
          danger
          disabled={group.builtin}
          onClick={() => {
            // 默认迁到「默认分组」；它一定存在，因此这里的初始值永远有效
            const fallback =
              groups.find((item) => item.builtin)?.id ?? groups.find((item) => item.id !== group.id)?.id ?? '';
            setMoveTo(fallback);
            setGroupRemoving(group);
          }}
        >
          删除并迁移
        </Button>
      </Space>
    );
  };

  const columns: ColumnsType<AlbumTreeNode> = [
    {
      title: '标题',
      width: 260,
      render: (_, record) =>
        record.isGroup ? (
          record.group ? (
            <Space size={6}>
              <span>{record.name}</span>
              {record.builtin && <Tag color="blue">默认</Tag>}
              <span className="t-qua" style={{ fontSize: 11 }}>
                {record.albumCount} 个相册 · {record.photoCount} 张照片
              </span>
            </Space>
          ) : (
            <span>{record.name}</span>
          )
        ) : (
          <div>
            <div>{record.album.title || '（无标题）'}</div>
            <div className="t-qua" style={{ fontSize: 11, fontFamily: 'var(--font-family-mono)' }}>
              {record.album.id}
            </div>
          </div>
        ),
    },
    {
      title: '描述',
      render: (_, record) =>
        record.isGroup ? (
          <span className="t-qua">—</span>
        ) : (
          record.album.description || <span className="t-qua">—</span>
        ),
    },
    {
      title: '照片数',
      width: 90,
      align: 'right',
      render: (_, record) => (record.isGroup ? record.photoCount : record.album.count),
    },
    {
      title: '分组',
      width: 130,
      render: (_, record) =>
        record.isGroup ? <span className="t-qua">—</span> : <Tag color="blue">{groupNameOf(record.album.groupId)}</Tag>,
    },
    {
      title: '是否公开',
      width: 100,
      render: (_, record) =>
        record.isGroup ? (
          <span className="t-qua">—</span>
        ) : (
          <Tag color={record.album.isPublic ? 'green' : 'default'}>{record.album.isPublic ? '公开' : '私有'}</Tag>
        ),
    },
    {
      title: '创建时间',
      width: 160,
      render: (_, record) => (record.isGroup ? <span className="t-qua">—</span> : formatDateTime(record.album.createdAt)),
    },
    {
      title: '操作',
      key: 'action',
      width: 260,
      fixed: 'right',
      render: (_, record) => {
        if (record.isGroup) return renderGroupAction(record);
        const album = record.album;
        return (
          <Space size={2}>
            <Button type="link" size="small" onClick={() => openEditor(album)}>
              编辑
            </Button>
            <Button type="link" size="small" onClick={() => setMediaAlbum(album)}>
              管理照片
            </Button>
            <Popconfirm
              title="确认删除该相册？"
              description="只删除相册本身，照片不会被删；册内顺序信息会丢失。"
              okText="删除"
              cancelText="取消"
              okButtonProps={{ danger: true }}
              onConfirm={() => handleRemove(album)}
            >
              <Button type="link" size="small" danger>
                删除
              </Button>
            </Popconfirm>
          </Space>
        );
      },
    },
  ];

  /** 抽屉里的候选照片行：只留挑片必需的几列 */
  const photoColumns = useMemo<ColumnsType<Photo>>(
    () => [
      {
        title: '缩略图',
        dataIndex: 'url',
        width: 64,
        render: (_url: string, record) => (
          <Image className="admin-thumb" src={record.cardUrl ?? record.url} alt={record.title} preview={false} />
        ),
      },
      { title: '标题', dataIndex: 'title', render: (title: string) => title || '（无标题）' },
      { title: '分类', dataIndex: 'cat', width: 90, render: (cat: string) => <Tag color="gold">{cat}</Tag> },
      { title: '拍摄日期', dataIndex: 'date', width: 110 },
    ],
    [],
  );

  const albumTotal = albums.length;

  return (
    <div>
      <div className="admin-toolbar">
        <span className="admin-page-title">相册管理</span>
        <div className="admin-toolbar__spacer" />
        <span className="t-qua" style={{ fontSize: 11 }}>
          共 {groups.length} 个分组 · {albumTotal} 个相册
        </span>
        {checkedIds.length > 0 && <span className="t-qua" style={{ fontSize: 11 }}>已选 {checkedIds.length} 个</span>}
        <Button
          disabled={checkedIds.length === 0}
          onClick={() => {
            setBatchTarget(undefined);
            setBatchOpen(true);
          }}
        >
          批量移动到分组
        </Button>
        <Button onClick={() => void load()} loading={loading}>
          刷新
        </Button>
        <Tooltip title="可选多个本地文件夹：各自以文件夹名建相册，大文件自动分片、支持断点续传">
          <Button onClick={() => setFolderUpload(true)}>文件夹上传</Button>
        </Tooltip>
        <Button type="primary" onClick={() => openEditor(null)}>
          新建相册
        </Button>
      </div>

      <Table<AlbumTreeNode>
        rowKey="key"
        size="small"
        loading={loading}
        columns={columns}
        dataSource={treeData}
        scroll={{ x: 1100 }}
        expandable={{
          expandedRowKeys: expandedKeys,
          onExpandedRowsChange: (keys: readonly Key[]) => setExpandedKeys(keys.map(String)),
        }}
        rowSelection={{
          selectedRowKeys: checkedIds,
          // 父子不联动：勾中分组不该连带勾中它的全部相册（批量移动只作用于用户逐个挑出的册）
          checkStrictly: true,
          onChange: (keys: Key[]) => setCheckedIds(keys.map(String).filter((key) => !key.startsWith('g:'))),
          // 跨页勾选要保留：批量移动往往跨多个分组挑册
          preserveSelectedRowKeys: true,
          getCheckboxProps: (record) => ({ disabled: record.isGroup }),
        }}
        locale={{ emptyText: <Empty description="暂无相册" /> }}
        pagination={false}
      />

      <Modal
        open={editingNew || editing !== null}
        title={editing ? `编辑相册 · ${editing.title}` : '新建相册'}
        okText="保存"
        cancelText="取消"
        confirmLoading={submitting}
        onOk={handleSubmit}
        onCancel={closeEditor}
        // key / destroyOnHidden 只负责让 DOM 每次重来；表单值的正确性由 openEditor 保证
        key={editing?.id ?? 'new'}
        destroyOnHidden
      >
        <Form<AlbumFormValues> form={form} layout="vertical" requiredMark={false}>
          <Form.Item name="title" label="标题" rules={[{ required: true, message: '请输入相册标题' }]}>
            <Input placeholder="相册标题" allowClear />
          </Form.Item>
          <Form.Item
            name="groupId"
            label="分组"
            extra="留空则归入「默认分组」；可直接在下方新建分组"
          >
            {/* 下拉底部嵌一个输入框 + 添加按钮：新建分组不必离开本表单 */}
            <Select
              placeholder="选择分组"
              allowClear
              options={groupOptions}
              dropdownRender={(menu) => (
                <>
                  {menu}
                  <Divider style={{ margin: '4px 0' }} />
                  <Space.Compact style={{ width: '100%' }}>
                    <Input
                      placeholder="新分组名称"
                      value={newGroupName}
                      onChange={(event) => setNewGroupName(event.target.value)}
                      onKeyDown={(event) => event.stopPropagation()}
                    />
                    <Button loading={creatingGroup} onClick={() => void handleAddGroup()}>
                      新建
                    </Button>
                  </Space.Compact>
                </>
              )}
            />
          </Form.Item>
          <Form.Item name="description" label="描述">
            <Input.TextArea rows={3} placeholder="相册收录的内容" />
          </Form.Item>
          <Form.Item name="isPublic" label="公开" valuePropName="checked" extra="不公开时前台不展示该相册">
            <Switch />
          </Form.Item>
        </Form>
      </Modal>

      <Modal
        open={groupEditing !== null}
        title={groupEditing ? `分组改名 · ${groupEditing.name}` : '分组改名'}
        okText="保存"
        cancelText="取消"
        confirmLoading={submitting}
        onOk={handleRenameGroup}
        onCancel={() => setGroupEditing(null)}
      >
        <Input
          placeholder="分组名称"
          value={groupName}
          onChange={(event) => setGroupName(event.target.value)}
        />
      </Modal>

      <Modal
        open={groupRemoving !== null}
        title={groupRemoving ? `删除分组 · ${groupRemoving.name}` : '删除分组'}
        okText="删除并迁移"
        cancelText="取消"
        okButtonProps={{ danger: true }}
        confirmLoading={submitting}
        onOk={handleRemoveGroup}
        onCancel={() => setGroupRemoving(null)}
      >
        <p>分组内的相册会转移到下方所选分组，相册与照片本身不会被删除。</p>
        <Select
          style={{ width: '100%', marginTop: 8 }}
          value={moveTo || undefined}
          onChange={setMoveTo}
          options={groupOptions.filter((option) => option.value !== groupRemoving?.id)}
          placeholder="选择迁移目标分组"
        />
      </Modal>

      <Modal
        open={batchOpen}
        title="批量移动到分组"
        okText="确认移动"
        cancelText="取消"
        confirmLoading={submitting}
        onOk={handleBatchMove}
        onCancel={() => setBatchOpen(false)}
      >
        <p>
          已选中 <b>{checkedIds.length}</b> 个相册，移动到：
        </p>
        <Select
          style={{ width: '100%', marginTop: 8 }}
          value={batchTarget}
          onChange={setBatchTarget}
          options={groupOptions}
          placeholder="选择目标分组"
        />
      </Modal>

      <Drawer
        open={mediaAlbum !== null}
        width={900}
        title={mediaAlbum ? `管理照片 · ${mediaAlbum.title}` : '管理照片'}
        onClose={() => setMediaAlbum(null)}
        extra={
          <Space>
            <Button onClick={() => setMediaAlbum(null)}>取消</Button>
            <Button type="primary" loading={submitting} onClick={handleSaveMedia}>
              保存册内照片
            </Button>
          </Space>
        }
      >
        <div className="admin-toolbar">
          <span className="t-qua" style={{ fontSize: 11 }}>
            共 {photos.length} 张候选，已选 {selectedIds.length} 张；点选先后即册内展示顺序
          </span>
          <div className="admin-toolbar__spacer" />
          <Button size="small" disabled={selectedIds.length === 0} onClick={() => setSelectedIds([])}>
            清空选择
          </Button>
        </div>

        <Table<Photo>
          rowKey="id"
          size="small"
          loading={mediaLoading}
          columns={photoColumns}
          dataSource={photos}
          rowSelection={{
            selectedRowKeys: selectedIds,
            onChange: (keys: Key[]) => setSelectedIds(keys.map(String)),
            // 不保留跨页选中：顺序信息只对当前这次保存有效，跨页拼接会使顺序难以确定
            preserveSelectedRowKeys: false,
          }}
          locale={{ emptyText: <Empty description="暂无可加入的照片" /> }}
          pagination={{ pageSize: 10, showSizeChanger: false, showTotal: (total) => `共 ${total} 张` }}
        />
      </Drawer>

      <FolderUploadModal
        open={folderUpload}
        onClose={() => setFolderUpload(false)}
        onUploaded={() => void load()}
      />
    </div>
  );
}