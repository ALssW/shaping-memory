/**
 * apps/admin/src/components/ExifDrawer.tsx
 *
 * EXIF 全量编辑器（Drawer）。
 *
 * 【只改数据库】保存只把 tag 写进 exif_metadata，照片文件（云端/本机）保持原样；
 *   用户在下载时才由后端把库里最新的 EXIF 动态注入下载副本，因此编辑永远可逆。
 * 【值一律原样进出】读写都带 exiftool 的 -n，不做任何「美化 / 还原」转换；
 *   唯一例外是 datetime 的 "YYYY:MM:DD HH:MM:SS" ↔ Dayjs，见 lib/exif-values.ts。
 * 【只提交改动】逐字段与库中原值做语义比较，没改的 tag 不提交，避免每次保存都重写全部元数据。
 * 【查看原片】右上角「查看原片 EXIF」只读解析原片本体，用于与库里记录对照。
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  App,
  Button,
  Card,
  Col,
  Collapse,
  Descriptions,
  Divider,
  Drawer,
  Empty,
  Form,
  InputNumber,
  Modal,
  Row,
  Space,
  Spin,
  Tag,
} from 'antd';
import {
  EXIF_EDITABLE_TAGS,
  EXIF_FIELDS,
  exifFieldOf,
  exifFieldsByGroup,
  fromWgs84,
  isValidLatLon,
} from '@shaping-memory/core';
import type { GeoPoint } from '@shaping-memory/core';
import { exifApi } from '@shaping-memory/sdk';
import type { ExifPatch, OriginalExifResult, PhotoExifResult } from '@shaping-memory/sdk';

import { ExifGroupFields } from './ExifGroupFields';
import { BASEMAPS, GpsPicker } from './GpsPicker';
import type { BasemapKey } from './GpsPicker';
import { CustomTagEditor } from './CustomTagEditor';
import { validateExifCustomTags } from '@shaping-memory/core';
import type { CustomTagRow } from '@shaping-memory/core';
import { formToSubmitValue, isSameFormValue, rawToFormValue } from '../lib/exif-values';

/** 表单初始值：按字段规格把文件原始字符串转成控件值 */
function initialFormValues(fields: Record<string, string>): Record<string, unknown> {
  const values: Record<string, unknown> = {};
  for (const spec of EXIF_FIELDS) values[spec.tag] = rawToFormValue(spec, fields[spec.tag]);
  return values;
}

interface ExifDrawerProps {
  /** 当前编辑的照片 id；null = 未打开 */
  photoId: string | null;
  open: boolean;
  onClose: () => void;
  /** 写入成功后回调（拍摄日期等可能被 EXIF 改写，列表需要同步） */
  onSaved: (result: PhotoExifResult) => void;
}

export function ExifDrawer({ photoId, open, onClose, onSaved }: ExifDrawerProps) {
  const { message } = App.useApp();
  const [form] = Form.useForm();
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [exif, setExif] = useState<PhotoExifResult | null>(null);
  /** 经纬度手输框的值：允许只填一半（此时不构成有效坐标，不参与提交） */
  const [manual, setManual] = useState<{ lat: number | null; lon: number | null }>({ lat: null, lon: null });
  /** 是否请求「清除定位」（提交 gps: null） */
  const [gpsCleared, setGpsCleared] = useState(false);
  const [basemap, setBasemap] = useState<BasemapKey>('amap');
  const [customTags, setCustomTags] = useState<CustomTagRow[]>([]);
  /** 「查看原片 EXIF」只读弹窗：开关、加载态、结果 */
  const [originalOpen, setOriginalOpen] = useState(false);
  const [originalLoading, setOriginalLoading] = useState(false);
  const [original, setOriginal] = useState<OriginalExifResult | null>(null);

  const groups = useMemo(() => exifFieldsByGroup(), []);

  /** 原片 EXIF 弹窗的展示项：按 tag 名排序，value 原样展示（-n 口径） */
  const originalItems = useMemo(
    () =>
      Object.entries(original?.fields ?? {})
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([tag, value]) => ({ key: tag, label: tag, children: value })),
    [original],
  );

  /**
   * 把读回来的值铺进表单。
   * 必须放在 effect 里而不是拉取的回调里：加载中渲染的是占位内容，
   * Form 尚未挂载，此时调 setFieldsValue 会作用于「未连接」的表单实例而丢失。
   */
  useEffect(() => {
    if (!exif) return;
    form.setFieldsValue(initialFormValues(exif.fields));
  }, [exif, form]);

  useEffect(() => {
    if (!open || !photoId) return;
    let cancelled = false;
    setLoading(true);
    setExif(null);
    setCustomTags([]);
    setGpsCleared(false);
    exifApi
      .get(photoId)
      .then((result) => {
        if (cancelled) return;
        setExif(result);
        setManual(result.gps ? { lat: result.gps.lat, lon: result.gps.lon } : { lat: null, lon: null });
      })
      .catch((error: unknown) => {
        if (!cancelled) message.error(error instanceof Error ? error.message : '读取拍摄参数失败');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open, photoId, message]);

  /** 手动输入的经纬度视为 WGS-84；两半都填齐且合法才构成选点 */
  const gpsPoint: GeoPoint | null =
    manual.lat != null && manual.lon != null && isValidLatLon(manual.lat, manual.lon)
      ? { lat: manual.lat, lon: manual.lon }
      : null;

  const handleMapPick = useCallback((point: GeoPoint) => {
    setManual({ lat: point.lat, lon: point.lon });
    setGpsCleared(false);
  }, []);

  const handleClearGps = useCallback(() => {
    setManual({ lat: null, lon: null });
    setGpsCleared(true);
  }, []);

  const handleClearField = useCallback(
    (tag: string) => {
      // 置空即「清除」：提交时归一成 null，后端会删掉这个 tag
      form.setFieldValue(tag, null);
      message.info(`已清空「${exifFieldOf(tag)?.label ?? '该项'}」，保存后将从这张照片中移除`);
    },
    [form, message],
  );

  /**
   * 打开「查看原片 EXIF」弹窗：拉取原片本体的原始 EXIF（只读，不写库、不改文件）。
   * 每次都重新请求，避免用户连续对照多张照片时看到上一张的缓存结果。
   */
  const handleViewOriginal = useCallback(async () => {
    if (!photoId) return;
    setOriginalOpen(true);
    setOriginalLoading(true);
    setOriginal(null);
    try {
      setOriginal(await exifApi.getOriginal(photoId));
    } catch (error) {
      message.error(error instanceof Error ? error.message : '读取原片 EXIF 失败');
      setOriginalOpen(false);
    } finally {
      setOriginalLoading(false);
    }
  }, [photoId, message]);

  const handleSave = async (): Promise<void> => {
    if (!exif || !photoId) return;
    const tagError = validateExifCustomTags(customTags, EXIF_EDITABLE_TAGS);
    if (tagError) {
      message.error(tagError);
      return;
    }

    // 逐字段比对：只有真正改动的 tag 才提交
    const values = form.getFieldsValue(true) as Record<string, unknown>;
    const fieldPatch: Record<string, string | string[] | null> = {};
    for (const spec of EXIF_FIELDS) {
      const before = rawToFormValue(spec, exif.fields[spec.tag]);
      const after = values[spec.tag];
      if (isSameFormValue(spec, before, after)) continue;
      fieldPatch[spec.tag] = formToSubmitValue(spec, after);
    }
    for (const row of customTags) {
      if (row.tag === '') continue;
      fieldPatch[row.tag] = row.value === '' ? null : row.value;
    }

    const patch: ExifPatch = {};
    if (Object.keys(fieldPatch).length > 0) patch.fields = fieldPatch;
    if (gpsCleared) {
      patch.gps = null;
    } else if (gpsPoint) {
      // 提交「底图原始坐标 + 坐标系」，坐标系归一由后端统一完成
      const baseConfig = BASEMAPS[basemap];
      const basePoint = fromWgs84(gpsPoint, baseConfig.crs);
      patch.gps = { lat: basePoint.lat, lon: basePoint.lon };
      patch.crs = baseConfig.crs;
    }
    if (!patch.fields && patch.gps === undefined) {
      message.info('没有需要保存的改动');
      return;
    }

    setSaving(true);
    try {
      const result = await exifApi.update(photoId, patch);
      setExif(result);
      setManual(result.gps ? { lat: result.gps.lat, lon: result.gps.lon } : { lat: null, lon: null });
      setGpsCleared(false);
      setCustomTags([]);
      message.success('保存成功，已更新数据库记录');
      onSaved(result);
    } catch (error) {
      // 后端会返回 400（如非法参数名）；sdk 只抛状态码，这里把原文一并展示
      message.error(error instanceof Error ? error.message : '保存失败，请稍后重试');
    } finally {
      setSaving(false);
    }
  };

  const fileInfoItems = [
    { key: 'type', label: '文件类型', children: exif?.fields.FileType ?? '—' },
    {
      key: 'size',
      label: '像素尺寸',
      children: `${exif?.fields.ImageWidth ?? '?'} × ${exif?.fields.ImageHeight ?? '?'}`,
    },
    { key: 'mime', label: '图像格式', children: exif?.fields.MIMEType ?? '—' },
  ];

  return (
    <Drawer
      open={open}
      onClose={onClose}
      width={900}
      title={exif ? `编辑拍摄参数 · ${exif.photo.title || '未命名照片'}` : '编辑拍摄参数'}
      extra={
        <Space>
          {/* 只读对照：解析原片本体里的 EXIF，用来核对「库里记的」与「文件里真实的」 */}
          <Button onClick={handleViewOriginal} disabled={loading || !exif}>
            查看原片 EXIF
          </Button>
          <Button onClick={onClose}>取消</Button>
          <Button type="primary" loading={saving} disabled={loading || !exif} onClick={handleSave}>
            保存
          </Button>
        </Space>
      }
    >
      <Spin spinning={loading}>
        <Descriptions className="exif-fileinfo" size="small" column={3} items={fileInfoItems} />

        <Divider style={{ margin: '12px 0' }} />

        <Card size="small" title="定位（经纬度）" style={{ marginBottom: 16 }}>
          <Row gutter={16} align="middle" style={{ marginBottom: 8 }}>
            <Col span={8}>
              <InputNumber
                style={{ width: '100%' }}
                prefix="纬度"
                step={0.000001}
                precision={6}
                placeholder="如 39.9042"
                value={manual.lat}
                onChange={(value) => {
                  setManual((prev) => ({ ...prev, lat: value ?? null }));
                  setGpsCleared(false);
                }}
              />
            </Col>
            <Col span={8}>
              <InputNumber
                style={{ width: '100%' }}
                prefix="经度"
                step={0.000001}
                precision={6}
                placeholder="如 116.4074"
                value={manual.lon}
                onChange={(value) => {
                  setManual((prev) => ({ ...prev, lon: value ?? null }));
                  setGpsCleared(false);
                }}
              />
            </Col>
            <Col span={8}>
              <Space size={8}>
                <Tag color={exif?.gps ? 'gold' : 'default'}>
                  {exif?.gps ? '这张照片已有定位' : '这张照片暂无定位'}
                </Tag>
                <Button size="small" danger disabled={!exif?.gps && !gpsPoint} onClick={handleClearGps}>
                  清除定位
                </Button>
              </Space>
            </Col>
          </Row>
          <div className="t-qua" style={{ fontSize: 11, marginBottom: 12 }}>
            手动输入时请填标准 GPS 坐标；也可以直接在地图上选点，坐标会自动换算。
            {gpsCleared && ' 保存后将移除这张照片的定位。'}
          </div>
          <GpsPicker
            key={photoId ?? 'none'}
            point={gpsPoint}
            savedGps={exif?.gps ?? null}
            basemap={basemap}
            onPointChange={handleMapPick}
            onBasemapChange={setBasemap}
          />
        </Card>

        <Form form={form} layout="vertical" className="exif-form" requiredMark={false}>
          <Collapse
            defaultActiveKey={groups.map(([group]) => group)}
            items={groups.map(([group, fields]) => ({
              key: group,
              label: group,
              // 强制渲染：折叠面板收起时也保留表单字段，否则取不到值、也无法整体提交
              forceRender: true,
              children: <ExifGroupFields fields={fields} onClear={handleClearField} />,
            }))}
          />

          <div className="exif-group-title" style={{ marginTop: 20 }}>
            其他拍摄参数
          </div>
          <CustomTagEditor rows={customTags} onChange={setCustomTags} specTags={EXIF_EDITABLE_TAGS} />
        </Form>

        <Divider style={{ margin: '16px 0 8px' }} />
        <div className="t-qua" style={{ fontSize: 11 }}>
          保存只更新数据库中的 EXIF 记录，照片文件保持原样；用户下载时会把最新 EXIF 动态写入下载的图片。
          把某项内容留空再保存，即可移除该项的 EXIF 记录。
        </div>
      </Spin>

      {/* 原片 EXIF 只读弹窗：与编辑区（读库）分离，互不影响 */}
      <Modal
        open={originalOpen}
        onCancel={() => setOriginalOpen(false)}
        width={760}
        title={`原片 EXIF · ${exif?.photo.title || '未命名照片'}`}
        footer={<Button onClick={() => setOriginalOpen(false)}>关闭</Button>}
      >
        <Spin spinning={originalLoading}>
          <div className="t-qua" style={{ fontSize: 12, marginBottom: 12 }}>
            以下是原片文件里真实存在的原始信息（只读，不写库、不改文件），可与编辑区（来自数据库）对照。
            {original?.gps && ` 原片定位：${original.gps.lat}, ${original.gps.lon}`}
          </div>
          {originalItems.length > 0 ? (
            <div style={{ maxHeight: 520, overflow: 'auto' }}>
              <Descriptions size="small" column={1} bordered items={originalItems} />
            </div>
          ) : (
            !originalLoading && <Empty description="原片中无可读取的 EXIF" />
          )}
        </Spin>
      </Modal>
    </Drawer>
  );
}
