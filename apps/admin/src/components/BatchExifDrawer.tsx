/**
 * apps/admin/src/components/BatchExifDrawer.tsx
 *
 * 批量改 EXIF：把同一份 tag 补丁写进选中的每张照片文件（exifApi.updateBatch）。
 *
 * 【未填 / 填了要清 / 填了新值 —— 三态必须分开】
 * ExifPatch.fields 里 null = 清除该 tag，字符串 = 写入该值，**不出现** = 不动这个 tag。
 * 所以表单仅有输入框不足以区分：输入框空着到底是「不改」还是「清除」无法判断。
 * 这里给每个字段配一个「标记清除」开关：开关打开 → 提交 null；开关关闭且填了值 → 提交值；
 * 两者都没有 → 该 tag 完全不进补丁。
 * 【坐标系】GpsPicker 内部状态恒为 WGS-84，提交时按当前底图的坐标系换算成底图原始坐标，
 * 并把坐标系一并交给后端（默认高德 = GCJ-02）。
 */
import { useCallback, useEffect, useState } from 'react';
import { App, Button, Card, Checkbox, DatePicker, Divider, Drawer, Form, Input, Space, Tag } from 'antd';
import type { Dayjs } from 'dayjs';
import { exposureKindOfTag, fromWgs84 } from '@shaping-memory/core';
import type { GeoPoint } from '@shaping-memory/core';
import { exifApi } from '@shaping-memory/sdk';
import type { ExifPatch } from '@shaping-memory/sdk';

import { BASEMAPS, GpsPicker } from './GpsPicker';
import type { BasemapKey } from './GpsPicker';
import { ExposureDualInput } from './ExposureDualInput';
import { formatExifDatetime } from '../lib/exif-values';

/** 本抽屉支持批量统一的字段（exiftool 短名） */
const FIELD_KEYS = ['DateTimeOriginal', 'ExposureTime', 'FNumber', 'ISO', 'Model', 'LensModel'] as const;
type FieldKey = (typeof FIELD_KEYS)[number];

/** 曝光三要素：控件走「自由输入 + 档位下拉」，提交值也是数字而非文本 */
type ExposureFieldKey = 'ExposureTime' | 'FNumber' | 'ISO';

/** 类型收窄用：让后面的提交分支能把 key 判成「曝光字段」或「文本字段」；判定委托给 core，避免各写一份 tag 清单 */
function isExposureKey(key: FieldKey): key is ExposureFieldKey {
  return exposureKindOfTag(key) !== null;
}

const FIELD_LABEL: Record<FieldKey, string> = {
  DateTimeOriginal: '拍摄时间',
  ExposureTime: '快门速度',
  FNumber: '光圈',
  ISO: 'ISO',
  Model: '机身型号',
  LensModel: '镜头型号',
};

interface BatchExifFormValues {
  DateTimeOriginal?: Dayjs;
  ExposureTime?: number;
  FNumber?: number;
  ISO?: number;
  Model?: string;
  LensModel?: string;
}

/** 「标记为清除」开关的初始态：每个字段都要有一项，否则 Record 类型不成立 */
const NO_CLEARS: Record<FieldKey, boolean> = {
  DateTimeOriginal: false,
  ExposureTime: false,
  FNumber: false,
  ISO: false,
  Model: false,
  LensModel: false,
};

interface BatchExifDrawerProps {
  open: boolean;
  /** 本次要改的照片 id 列表 */
  ids: string[];
  onClose: () => void;
  /** 写入成功后的回调（父组件负责清空选中并重拉列表） */
  onDone: () => void;
}

export function BatchExifDrawer({ open, ids, onClose, onDone }: BatchExifDrawerProps) {
  const { message } = App.useApp();
  const [form] = Form.useForm<BatchExifFormValues>();
  const [saving, setSaving] = useState(false);
  /** 哪些字段本次要「清除」（提交 null） */
  const [clears, setClears] = useState<Record<FieldKey, boolean>>(NO_CLEARS);
  /** 地图选点（WGS-84）；null = 本次不选点 */
  const [point, setPoint] = useState<GeoPoint | null>(null);
  const [basemap, setBasemap] = useState<BasemapKey>('amap');
  /** 本次是否请求清除文件里的定位 */
  const [gpsCleared, setGpsCleared] = useState(false);

  // 每次打开都是一次全新的批量编辑，清除上一轮的残留状态
  useEffect(() => {
    if (!open) return;
    form.resetFields();
    setClears(NO_CLEARS);
    setPoint(null);
    setGpsCleared(false);
  }, [open, form]);

  const toggleClear = useCallback((key: FieldKey) => {
    setClears((prev) => ({ ...prev, [key]: !prev[key] }));
  }, []);

  const handleSave = async (): Promise<void> => {
    const values = form.getFieldsValue();
    const fields: Record<string, string | string[] | null> = {};

    for (const key of FIELD_KEYS) {
      if (clears[key]) {
        // 标记了清除：无条件提交 null，输入框中即使有值也以「清除」为准
        fields[key] = null;
        continue;
      }
      if (key === 'DateTimeOriginal') {
        const text = formatExifDatetime(values.DateTimeOriginal);
        if (text) fields[key] = text;
        continue;
      }
      if (isExposureKey(key)) {
        // 曝光三要素来自 InputNumber：值为数字（含档位下拉写回的 canonical），空则不进补丁
        const num = values[key];
        if (typeof num === 'number') fields[key] = String(num);
        continue;
      }
      const text = (values[key] ?? '').trim();
      if (text !== '') fields[key] = text;
    }

    const patch: ExifPatch = {};
    if (Object.keys(fields).length > 0) patch.fields = fields;
    if (gpsCleared) {
      patch.gps = null;
    } else if (point) {
      // 底图原始坐标 + 坐标系，换算交给后端
      const baseConfig = BASEMAPS[basemap];
      const basePoint = fromWgs84(point, baseConfig.crs);
      patch.gps = { lat: basePoint.lat, lon: basePoint.lon };
      patch.crs = baseConfig.crs;
    }

    if (!patch.fields && patch.gps === undefined) {
      message.info('尚未填写要修改的内容');
      return;
    }

    setSaving(true);
    try {
      const result = await exifApi.updateBatch(ids, patch);
      message.success(`已更新 ${result.updated} 张照片的 EXIF 记录`);
      onDone();
      onClose();
    } catch (error) {
      message.error(error instanceof Error ? error.message : '保存失败，请稍后重试');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Drawer
      open={open}
      width={720}
      title={`批量编辑拍摄参数（已选 ${ids.length} 张）`}
      onClose={onClose}
      extra={
        <Space>
          <Button onClick={onClose}>取消</Button>
          <Button type="primary" loading={saving} onClick={handleSave}>
            保存
          </Button>
        </Space>
      }
    >
      <div className="t-qua" style={{ fontSize: 11, marginBottom: 12 }}>
        只修改填写过或标记清除的项，其余内容保持原样。保存只更新数据库记录，照片文件保持原样。
      </div>

      <Form<BatchExifFormValues> form={form} layout="vertical" requiredMark={false} className="exif-form">
        {FIELD_KEYS.map((key) => (
          <Form.Item
            key={key}
            name={key}
            style={{ marginBottom: 16 }}
            label={
              <span className="exif-field-head">
                <span>{FIELD_LABEL[key]}</span>
                <Button
                  type="text"
                  size="small"
                  className={clears[key] ? 'exif-field-head__clear exif-field-head__clear--on' : 'exif-field-head__clear'}
                  onClick={() => toggleClear(key)}
                >
                  {clears[key] ? '已标记清除，点击取消' : '清除该项'}
                </Button>
              </span>
            }
          >
            {key === 'DateTimeOriginal' ? (
              <DatePicker
                showTime
                style={{ width: '100%' }}
                format="YYYY-MM-DD HH:mm:ss"
                placeholder="统一设置为这个拍摄时间"
                disabled={clears[key]}
              />
            ) : isExposureKey(key) ? (
              // 曝光三要素：自由输入 + 档位下拉，二者写同一个字段；标记清除时整行禁用
              <ExposureDualInput tag={key} disabled={clears[key]} />
            ) : (
              <Input placeholder={`统一设置为这个${FIELD_LABEL[key]}`} allowClear disabled={clears[key]} />
            )}
          </Form.Item>
        ))}
      </Form>

      <Divider style={{ margin: '8px 0 16px' }} />

      <Card size="small" title="地图选点（统一设置定位）">
        <Space size={12} style={{ marginBottom: 8 }}>
          <Tag color={point ? 'gold' : 'default'}>{point ? '已选点' : '未选点'}</Tag>
          <Checkbox
            checked={gpsCleared}
            onChange={(event) => {
              setGpsCleared(event.target.checked);
              if (event.target.checked) setPoint(null);
            }}
          >
            清除这批照片的定位
          </Checkbox>
        </Space>
        <div className="t-qua" style={{ fontSize: 11, marginBottom: 12 }}>
          不选点且未勾选清除时，这批照片的定位保持不变；选点后坐标会自动换算后保存。
        </div>
        <GpsPicker
          point={point}
          savedGps={null}
          basemap={basemap}
          onPointChange={(next) => {
            setPoint(next);
            setGpsCleared(false);
          }}
          onBasemapChange={setBasemap}
        />
      </Card>
    </Drawer>
  );
}