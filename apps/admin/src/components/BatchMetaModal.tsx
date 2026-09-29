/**
 * apps/admin/src/components/BatchMetaModal.tsx
 *
 * 批量改元数据：把同一个补丁套到选中的每张照片上（photoApi.updateBatch）。
 *
 * 【空着的项 = 不动它】这里不是「编辑某一张」，而是「统一成某个值」，
 * 因此表单不给初始值、也不做必填：只有用户真的填了/选了的项才会进补丁。
 * 若把所有字段都带上，没动过的字段会被写成空值，等同于清空整批照片的数据。
 * 【标签是例外】标签框被打开过就表示用户动过它（哪怕清空成空数组），
 * 空数组按「清空这批照片的标签」提交，与「没打开过（undefined）」区分开。
 */
import { App, Form, InputNumber, Modal, Select } from 'antd';
import { photoApi } from '@shaping-memory/sdk';
import type { PhotoPatch } from '@shaping-memory/sdk';

import { PRIVACY_MARK_OPTIONS } from '../lib/privacy-modes';
import type { PrivacyMark } from '../lib/privacy-modes';

interface BatchMetaFormValues {
  category?: string;
  tags?: string[];
  privacy?: PrivacyMark;
  likes?: number;
}

interface BatchMetaModalProps {
  open: boolean;
  /** 本次要改的照片 id 列表 */
  ids: string[];
  /** 分类候选（从照片列表去重得到） */
  categoryOptions: string[];
  onClose: () => void;
  /** 保存成功后的回调（父组件负责清空选中并重拉列表） */
  onDone: () => void;
}

export function BatchMetaModal({ open, ids, categoryOptions, onClose, onDone }: BatchMetaModalProps) {
  const { message } = App.useApp();
  const [form] = Form.useForm<BatchMetaFormValues>();

  const handleOk = async (): Promise<void> => {
    const values = form.getFieldsValue();
    const patch: PhotoPatch = {};
    if (values.category) patch.category = values.category;
    if (values.tags !== undefined) patch.tags = values.tags;
    if (values.privacy) patch.privacy = values.privacy;
    if (values.likes !== undefined && values.likes !== null) patch.likes = values.likes;

    if (Object.keys(patch).length === 0) {
      message.info('没有填写要统一修改的项');
      return;
    }

    try {
      const result = await photoApi.updateBatch(ids, patch);
      message.success(`已更新 ${result.updated} 张照片`);
      form.resetFields();
      onDone();
      onClose();
    } catch (error) {
      message.error(error instanceof Error ? error.message : '批量修改失败');
    }
  };

  return (
    <Modal
      open={open}
      title={`批量改元数据（已选 ${ids.length} 张）`}
      okText="应用到选中的照片"
      cancelText="取消"
      onOk={handleOk}
      onCancel={onClose}
      destroyOnHidden
    >
      <div className="t-qua" style={{ fontSize: 11, marginBottom: 12 }}>
        只修改填写过的项，留空的内容保持原样。这里的改动只影响站内信息，不会改动照片文件。
      </div>
      <Form<BatchMetaFormValues> form={form} layout="vertical" requiredMark={false}>
        <Form.Item name="category" label="分类">
          <Select
            showSearch
            allowClear
            placeholder="不修改分类"
            options={categoryOptions.map((name) => ({ value: name, label: name }))}
          />
        </Form.Item>
        <Form.Item name="tags" label="标签">
          <Select
            mode="tags"
            allowClear
            placeholder="不改动标签；清空后保存，即清除这批照片的全部标签"
            tokenSeparators={[',', '，']}
          />
        </Form.Item>
        <Form.Item name="privacy" label="隐私标记">
          <Select allowClear placeholder="不修改隐私标记" options={PRIVACY_MARK_OPTIONS} />
        </Form.Item>
        <Form.Item name="likes" label="点赞数">
          <InputNumber min={0} step={1} style={{ width: '100%' }} placeholder="不修改点赞数" />
        </Form.Item>
      </Form>
    </Modal>
  );
}