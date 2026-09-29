/**
 * apps/admin/src/pages/SettingsPage.tsx
 *
 * 系统设置：站点标题 / 标语 / 上传体积上限 / 允许的扩展名 / 上传默认分类 / 分片大小 / 分片并发数。
 *
 * 【只提交改动过的项】后端是 PUT + 局部补丁语义，值型 token（如 upload.maxMb）没有默认值，
 * 全量提交会重写未改动的项（还可能覆盖他人刚修改的值）；
 * 因此这里先把读回来的值留一份基线，保存时逐项比对。
 */
import { useCallback, useEffect, useState } from 'react';
import { App, Button, Card, Form, Input, InputNumber, Space, Spin } from 'antd';
import { settingsApi } from '@shaping-memory/sdk';
import type { SiteSettings } from '@shaping-memory/sdk';

/** 表单值：与 SiteSettings 同构，但体积上限用数字控件，提交时再转字符串 */
interface SettingsFormValues {
  title: string;
  slogan: string;
  maxMb: number;
  formats: string;
  defaultCategory: string;
  chunkMb: number;
  concurrency: number;
}

function toFormValues(settings: SiteSettings): SettingsFormValues {
  return {
    title: settings['site.title'],
    slogan: settings['site.slogan'],
    maxMb: Number(settings['upload.maxMb']) || 0,
    formats: settings['upload.formats'],
    defaultCategory: settings['upload.defaultCategory'],
    chunkMb: Number(settings['upload.chunkMb']) || 0,
    concurrency: Number(settings['upload.concurrency']) || 0,
  };
}

export function SettingsPage() {
  const { message } = App.useApp();
  const [form] = Form.useForm<SettingsFormValues>();
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  /** 读回来的基线：用于判断哪些项真的被改过 */
  const [baseline, setBaseline] = useState<SettingsFormValues | null>(null);

  const load = useCallback(async (): Promise<void> => {
    setLoading(true);
    try {
      setBaseline(toFormValues(await settingsApi.all()));
    } catch (error) {
      message.error(error instanceof Error ? error.message : '设置读取失败');
    } finally {
      setLoading(false);
    }
  }, [message]);

  useEffect(() => {
    void load();
  }, [load]);

  // 值读回来后再铺进表单：必须等 Form 挂载完成，否则作用于未连接的表单实例会导致值丢失
  useEffect(() => {
    if (baseline) form.setFieldsValue(baseline);
  }, [baseline, form]);

  const handleSave = async (): Promise<void> => {
    if (!baseline) return;
    setSaving(true);
    try {
      const values = await form.validateFields();
      const patch: Partial<SiteSettings> = {};
      if (values.title !== baseline.title) patch['site.title'] = values.title.trim();
      if (values.slogan !== baseline.slogan) patch['site.slogan'] = values.slogan.trim();
      if (values.maxMb !== baseline.maxMb) patch['upload.maxMb'] = String(values.maxMb);
      if (values.formats !== baseline.formats) patch['upload.formats'] = values.formats.trim();
      if (values.defaultCategory !== baseline.defaultCategory) {
        patch['upload.defaultCategory'] = values.defaultCategory.trim();
      }
      if (values.chunkMb !== baseline.chunkMb) patch['upload.chunkMb'] = String(values.chunkMb);
      if (values.concurrency !== baseline.concurrency) patch['upload.concurrency'] = String(values.concurrency);
      if (Object.keys(patch).length === 0) {
        message.info('没有需要保存的改动');
        return;
      }
      const updated = await settingsApi.update(patch);
      setBaseline(toFormValues(updated));
      message.success('设置已保存');
    } catch (error) {
      if (error instanceof Error) message.error(error.message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div>
      <div className="admin-toolbar">
        <span className="admin-page-title">系统设置</span>
        <div className="admin-toolbar__spacer" />
        <Button onClick={() => void load()} loading={loading}>
          重新读取
        </Button>
        <Button type="primary" loading={saving} disabled={loading} onClick={handleSave}>
          保存修改
        </Button>
      </div>

      <Spin spinning={loading}>
        <Card size="small" className="admin-form-card">
          <Form<SettingsFormValues> form={form} layout="vertical" requiredMark={false}>
            <Form.Item name="title" label="站点标题" rules={[{ required: true, message: '请输入站点标题' }]}>
              <Input placeholder="塑忆" allowClear />
            </Form.Item>
            <Form.Item name="slogan" label="站点标语">
              <Input placeholder="shape of my memory" allowClear />
            </Form.Item>
            <Form.Item
              name="maxMb"
              label="上传体积上限"
              rules={[{ required: true, message: '请填写体积上限' }]}
              extra="单位 MB，超过该体积的照片将无法上传；建议与服务器上传限制保持一致"
            >
              <InputNumber style={{ width: '100%' }} min={1} step={1} suffix="MB" />
            </Form.Item>
            <Form.Item
              name="formats"
              label="允许的扩展名"
              extra="逗号分隔，如 .jpg,.jpeg,.png,.webp,.heic；仅允许上传这里列出的格式"
            >
              <Input placeholder=".jpg,.jpeg,.png,.webp,.heic" allowClear />
            </Form.Item>
            <Form.Item
              name="defaultCategory"
              label="上传默认分类"
              extra="无法从文件名与照片信息判断分类时使用的默认分类"
            >
              <Input placeholder="未分类" allowClear />
            </Form.Item>
            <Form.Item
              name="chunkMb"
              label="分片大小"
              rules={[{ required: true, message: '请填写分片大小' }]}
              extra="单位 MB，文件夹上传时每个分片的字节数；调小可提高弱网下的重传效率，调大可减少请求数"
            >
              <InputNumber style={{ width: '100%' }} min={1} step={1} suffix="MB" />
            </Form.Item>
            <Form.Item
              name="concurrency"
              label="分片并发数"
              rules={[{ required: true, message: '请填写并发数' }]}
              extra="同时上传的分片数（1–8）；调大可充分利用带宽，但并发过高容易使网关过载"
            >
              <InputNumber style={{ width: '100%' }} min={1} max={8} step={1} />
            </Form.Item>
            <Space>
              <Button type="primary" loading={saving} onClick={handleSave}>
                保存修改
              </Button>
              <Button onClick={() => baseline && form.setFieldsValue(baseline)}>撤销未保存的修改</Button>
            </Space>
          </Form>
        </Card>
      </Spin>
    </div>
  );
}