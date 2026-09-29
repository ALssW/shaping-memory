/**
 * apps/admin/src/components/PhotoMetaModal.tsx
 *
 * 单张照片的基础信息编辑：标题 / 分类 / 点赞 / 标签（photoApi.update）。
 * 只改数据库里的展示字段，不触碰照片文件；EXIF 写入在 ExifDrawer 里做。
 */
import { useEffect } from 'react';
import { App, Form, Input, InputNumber, Modal, Select } from 'antd';
import type { Photo } from '@shaping-memory/core';
import { photoApi } from '@shaping-memory/sdk';
import type { PhotoPatch } from '@shaping-memory/sdk';

interface PhotoMetaModalProps {
  /** 待编辑的照片；null = 关闭 */
  photo: Photo | null;
  /** 分类候选项（从列表数据去重得到） */
  categoryOptions: string[];
  onClose: () => void;
  onSaved: (photo: Photo) => void;
}

export function PhotoMetaModal({ photo, categoryOptions, onClose, onSaved }: PhotoMetaModalProps) {
  const { message } = App.useApp();
  const [form] = Form.useForm<PhotoPatch>();

  /**
   * 换照片时把值算死在当前这一张上。
   *
   * 【为什么不用 Form 的 initialValues】`Form.useForm()` 的实例比弹窗存活更久，
   * rc-field-form 重挂载时算的是 `merge(initialValues, store)` —— 旧 store 会盖过新的
   * initialValues；卸载时又只有 `clearOnDestroy` 为真才清 store。因此「先编辑照片 A、
   * 再打开照片 B」时输入框里仍保留 A 的内容。resetFields（顺带清掉上次的校验红字）+
   * setFieldsValue 与弹窗是否重挂载无关，才是可靠的。
   */
  useEffect(() => {
    if (!photo) return;
    form.resetFields();
    form.setFieldsValue({
      title: photo.title ?? '',
      description: photo.description ?? '',
      category: photo.cat,
      likes: photo.likes ?? 0,
      // 标签编辑器只认名字：来源与审核态由后端维护，这里编辑的是「有哪些标签」
      tags: (photo.tags ?? []).map((tag) => tag.name),
    });
  }, [photo, form]);

  const handleOk = async (): Promise<void> => {
    if (!photo) return;
    try {
      const values = await form.validateFields();
      const updated = await photoApi.update(photo.id, values);
      message.success('基础信息已更新');
      onSaved(updated);
      onClose();
    } catch (error) {
      // validateFields 失败是表单校验错误（antd 已在字段上标红），不必再弹提示
      if (error instanceof Error) message.error(error.message);
    }
  };

  return (
    <Modal
      open={photo !== null}
      title="编辑基础信息"
      okText="保存"
      cancelText="取消"
      onOk={handleOk}
      onCancel={onClose}
      // key 只负责让 DOM 每次重来；表单值的正确性由上面的 useEffect 保证
      key={photo?.id ?? 'none'}
      destroyOnHidden
    >
      <Form<PhotoPatch> form={form} layout="vertical" requiredMark={false}>
        <Form.Item name="title" label="标题" rules={[{ required: true, message: '标题不能为空' }]}>
          <Input placeholder="这张照片的标题" allowClear />
        </Form.Item>
        {/* 描述是纯文本：换行与空行由文本本身携带，前台查看器整段展示（故用多行文本域） */}
        <Form.Item
          name="description"
          label="描述"
          extra={<span style={{ fontSize: 11 }}>换行会原样保留，前台在查看器的拍摄信息里整段展示</span>}
        >
          <Input.TextArea rows={5} placeholder="填写这张照片的描述…" allowClear />
        </Form.Item>
        <Form.Item name="category" label="分类" rules={[{ required: true, message: '请选择分类' }]}>
          <Select
            showSearch
            placeholder="选择分类"
            options={categoryOptions.map((name) => ({ value: name, label: name }))}
          />
        </Form.Item>
        <Form.Item name="likes" label="点赞数">
          <InputNumber min={0} step={1} style={{ width: '100%' }} />
        </Form.Item>
        <Form.Item name="tags" label="标签" extra={<span style={{ fontSize: 11 }}>输入后回车添加，可多个</span>}>
          <Select mode="tags" placeholder="标签" tokenSeparators={[',', '，']} />
        </Form.Item>
      </Form>
    </Modal>
  );
}
