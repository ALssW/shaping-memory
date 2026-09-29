/**
 * apps/admin/src/pages/ThemePage.tsx
 *
 * 主题配置页：颜色 + 字号倍率 + 逐档微调。
 *
 * 【预览是怎么实现的】页面里没有第二块「预览区」—— 草稿一变就通过 theme-store
 * 调用 setActiveTheme 写进 <style>，整站（含左侧菜单、表格、弹窗）立即套用。
 * 用户此刻看到的后台本身就是预览，因此「保存」只决定是否落库、是否让
 * 其他人也看到。撤销 = 把已保存值再套一遍，界面即回到原样。
 */
import { useState } from 'react';
import { App, Button, Card, ColorPicker, InputNumber, Popconfirm, Slider, Tag, Tooltip } from 'antd';
import { tokens } from '@shaping-memory/design-tokens';
import {
  FONT_TIERS,
  FONT_TIER_LABELS,
  THEME_COLOR_KEYS,
  THEME_COLOR_LABELS,
  THEME_LIMITS,
} from '@shaping-memory/core';
import type { FontTier, ThemeColorKey } from '@shaping-memory/core';

import { useThemeStore } from '../lib/theme-store';

/** 倍率滑杆的一档：标签 + 滑杆 + 数字输入（两个倍率共用同一个排布） */
interface ScaleRowProps {
  label: string;
  hint: string;
  value: number;
  limits: { min: number; max: number; step: number };
  onChange: (value: number) => void;
}

function ScaleRow({ label, hint, value, limits, onChange }: ScaleRowProps) {
  return (
    <div className="theme-row">
      <div className="theme-row__label">
        <span className="theme-row__name">{label}</span>
        <span className="t-ter">{hint}</span>
      </div>
      <Slider
        className="theme-row__slider"
        min={limits.min}
        max={limits.max}
        step={limits.step}
        value={value}
        onChange={onChange}
      />
      <InputNumber
        className="theme-row__number"
        min={limits.min}
        max={limits.max}
        step={limits.step}
        value={value}
        onChange={(next) => next !== null && onChange(next)}
      />
    </div>
  );
}

/** 逐档微调的一行：留空即「跟随上面那个倍率」 */
interface TierRowProps {
  tier: FontTier;
  /** 该档在当前配置下实际生效的 px（未覆盖时即 基准 × 倍率） */
  autoPx: number;
  override: number | undefined;
  onChange: (value: number | null) => void;
}

function TierRow({ tier, autoPx, override, onChange }: TierRowProps) {
  return (
    <div className="theme-row">
      <div className="theme-row__label">
        <span className="theme-row__name">{FONT_TIER_LABELS[tier]}</span>
        <span className="t-ter">跟随倍率时为 {autoPx}px</span>
      </div>
      <InputNumber
        className="theme-row__number"
        min={THEME_LIMITS.overrideFontPx.min}
        max={THEME_LIMITS.overrideFontPx.max}
        step={0.5}
        placeholder={`自动 ${autoPx}`}
        value={override ?? null}
        onChange={onChange}
      />
      <Tooltip title="清空即回到跟随倍率">
        <Button size="small" type="text" disabled={override === undefined} onClick={() => onChange(null)}>
          重置这档
        </Button>
      </Tooltip>
    </div>
  );
}

export function ThemePage() {
  const { message } = App.useApp();
  const { saved, draft, dirty, updateDraft, commit, discard, resetFactory } = useThemeStore();
  const [saving, setSaving] = useState(false);

  /** 改一个颜色：只换这一项，其余照旧 */
  const patchColor = (key: ThemeColorKey, value: string): void => {
    updateDraft({ ...draft, colors: { ...draft.colors, [key]: value } });
  };

  /** 改逐档覆盖：传 null 即删掉这一档，回到跟随倍率 */
  const patchOverride = (tier: FontTier, value: number | null): void => {
    const next = { ...draft.fontOverrides };
    if (value === null) delete next[tier];
    else next[tier] = value;
    updateDraft({ ...draft, fontOverrides: next });
  };

  const handleSave = async (): Promise<void> => {
    if (!dirty) {
      message.info('没有需要保存的改动');
      return;
    }
    setSaving(true);
    try {
      await commit();
      message.success('主题已保存，刷新页面后对所有用户生效');
    } catch (error) {
      message.error(error instanceof Error ? error.message : '主题保存失败');
    } finally {
      setSaving(false);
    }
  };

  const handleReset = async (): Promise<void> => {
    setSaving(true);
    try {
      await resetFactory();
      message.success('已恢复出厂设置');
    } catch (error) {
      message.error(error instanceof Error ? error.message : '恢复出厂失败');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div>
      <div className="admin-toolbar">
        <span className="admin-page-title">主题配置</span>
        {dirty && <Tag color="gold">预览中 · 未保存</Tag>}
        <div className="admin-toolbar__spacer" />
        <Button onClick={discard} disabled={!dirty || saving}>
          撤销改动
        </Button>
        <Popconfirm
          title="恢复出厂设置"
          description="颜色与字号将全部回到默认值，并立即保存。"
          okText="恢复"
          cancelText="取消"
          onConfirm={() => void handleReset()}
        >
          <Button disabled={saving}>恢复出厂</Button>
        </Popconfirm>
        <Button type="primary" loading={saving} onClick={() => void handleSave()}>
          保存修改
        </Button>
      </div>

      <Card size="small" title="颜色" className="admin-form-card">
        <div className="theme-grid">
          {THEME_COLOR_KEYS.map((key) => (
            <div key={key} className="theme-color">
              <span className="theme-color__name">{THEME_COLOR_LABELS[key]}</span>
              <ColorPicker
                value={draft.colors[key]}
                disabledAlpha={false}
                onChangeComplete={(color) => patchColor(key, color.toHexString())}
              />
              <span className="theme-color__value t-ter">{draft.colors[key]}</span>
            </div>
          ))}
        </div>
        <p className="theme-note">
          只需调这几个核心色：次要文字、悬浮态、玻璃质感等层级会按它们自动推导，改一处全站跟随。
        </p>
      </Card>

      <Card size="small" title="字号倍率" className="admin-form-card">
        <ScaleRow
          label="全局字号倍率"
          hint="电脑端（宽 ≥ 1024px）生效，字号、间距、控件高度一起放大；手机与平板保持原样"
          value={draft.fontScale}
          limits={THEME_LIMITS.fontScale}
          onChange={(fontScale) => updateDraft({ ...draft, fontScale })}
        />
        <ScaleRow
          label="照片信息区倍率"
          hint="照片详情里的拍摄参数、悬浮信息、编辑面板单独放大；它是独立倍率，不与全局叠加"
          value={draft.exifScale}
          limits={THEME_LIMITS.exifScale}
          onChange={(exifScale) => updateDraft({ ...draft, exifScale })}
        />
      </Card>

      <Card
        size="small"
        title="逐档微调"
        className="admin-form-card"
        extra={<span className="t-ter">留空即跟随倍率</span>}
      >
        {FONT_TIERS.map((tier) => (
          <TierRow
            key={tier}
            tier={tier}
            autoPx={Math.round(Number.parseFloat(tokens.font.size[tier]) * draft.fontScale * 10) / 10}
            override={draft.fontOverrides[tier]}
            onChange={(value) => patchOverride(tier, value)}
          />
        ))}
      </Card>

      <p className="theme-note theme-note--foot">
        正在编辑的即当前生效值：修改后可直接从后台界面查看效果。点击「保存修改」后才会写入服务器，
        其他用户刷新页面即可看到相同的样式。已保存的版本：
        <span className="t-ter"> 全局 ×{saved.fontScale} · 信息区 ×{saved.exifScale}</span>
      </p>
    </div>
  );
}