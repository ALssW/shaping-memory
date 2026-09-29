/**
 * apps/web/src/components/SearchPanel.tsx
 *
 * 前台 EXIF 搜索面板：从顶栏的搜索图标唤出，压在页面顶部。
 *
 * 【为什么只认关闭按钮】搜索条件往往要反复调整，面板如果「点一下别处就收」
 * 会让刚调好的筛选丢光。因此这里不响应 Esc、不响应点外部：要么收起要么一直开着。
 *
 * 【为什么点「搜索」后也不关】搜索是**可迭代**的动作：看过结果常常还要回来改一个条件再搜。
 * 面板留在原地，改完直接再点一次即可；关闭交给右上角的 ×。
 *
 * 【检索在哪发生】条件由上层交 /search/photos 在服务端筛（百余张虽是前端也扛得住，
 * 但口径必须与后台一致，所以收口到同一个检索入口）。面板自己只负责「收集条件」。
 *
 * 【下拉为什么是自建的】机身/镜头/光圈/快门/感光度五项的候选来自字典（/search/suggest，
 * 输入即联想），定位状态是固定三态。原生 <select>/<datalist> 的面板样式改不动，
 * 与后台不一致，故统一用 Combobox.tsx 里的两个自建下拉。
 */
import { useState } from 'react';
import { DICTIONARY_KINDS } from '@shaping-memory/core';
import type { DictionaryKind, SearchQuery } from '@shaping-memory/core';

import { ComboBox, SelectMenu } from './Combobox';
import { Icon } from './Icon';
import { TagFilter } from './TagFilter';

interface FieldProps {
  label: string;
  children: React.ReactNode;
}

/**
 * 一个筛选项 = 说明文案 + 输入控件，减少逐项手写 label 的重复。
 * 【为什么用 div 而不是 label】有一半字段的控件是「可输入 + 下拉」的组合框，
 * 里面有多个可交互元素；label 的隐式关联会把点击转发给第一个控件，
 * 容易出现「点清空按钮反而把面板关掉」这类怪行为。语义改由控件自己的 aria-label 承担。
 */
function Field({ label, children }: FieldProps) {
  return (
    <div className="search-field">
      <span className="search-field__label">{label}</span>
      {children}
    </div>
  );
}

/** 字典类型 → 检索条件字段名。只有相机是特例（kind 为 camera，条件名沿用后端的 cam） */
const QUERY_KEY_OF_KIND: Record<DictionaryKind, keyof SearchQuery> = {
  camera: 'cam',
  lens: 'lens',
  aperture: 'aperture',
  shutter: 'speed',
  iso: 'iso',
};

/** 条件值 → 输入框文本（数值型 iso 也要转成字符串才放得进 input） */
function textOf(query: SearchQuery, kind: DictionaryKind): string {
  const raw = query[QUERY_KEY_OF_KIND[kind]];
  return raw === undefined ? '' : String(raw);
}

/**
 * 点整块输入框就唤出日期面板，与后台的日期选择交互一致。
 * 原生 <input type="date"> 只在点右侧小日历图标时才展开，点文字区毫无反应 ——
 * 显式调 showPicker 补齐这一半；不支持的浏览器（部分 Safari/Firefox）静默退回默认行为。
 */
function openPicker(input: HTMLInputElement): void {
  const picker = input as HTMLInputElement & { showPicker?: () => void };
  try {
    picker.showPicker?.();
  } catch {
    /* 非用户手势触发时浏览器会抛 NotAllowedError，忽略即可 */
  }
}

/** 空搜索条件：清空草稿用 */
const EMPTY: SearchQuery = {};

/** 定位状态三态：值与后端 hasGps 的 '1' / '0' 口径一致 */
const GPS_OPTIONS = [
  { value: '', label: '不限' },
  { value: '1', label: '有定位' },
  { value: '0', label: '无定位' },
] as const;

interface SearchPanelProps {
  /** 提交（点「搜索」）：把草稿作为最终搜索条件交给上层 */
  onApply: (query: SearchQuery) => void;
  /** 关闭：唯一能让面板消失的通道 */
  onClose: () => void;
}

export function SearchPanel({ onApply, onClose }: SearchPanelProps) {
  const [draft, setDraft] = useState<SearchQuery>(EMPTY);

  const patch = (key: keyof SearchQuery, value: string | number | boolean | undefined) =>
    setDraft((prev) => {
      const next = { ...prev };
      if (value === '' || value === undefined) delete next[key];
      else next[key] = value as never;
      return next;
    });

  /** 字典字段回填：iso 落成数值，其余是文本；清空则删除该维度 */
  const patchDictionary = (kind: DictionaryKind, raw: string) => {
    if (kind !== 'iso') {
      patch(QUERY_KEY_OF_KIND[kind], raw);
      return;
    }
    const iso = Number(raw);
    patch('iso', raw.trim() !== '' && Number.isFinite(iso) ? iso : undefined);
  };

  /**
   * 标签是唯一的**数组**维度，不能走 patch —— patch 按标量 key 逐个赋值，
   * 塞数组进去会破坏其余九个字段的类型约束。空数组即删除该维度，与别处「空即不限」一致。
   */
  const setTags = (names: string[]) =>
    setDraft((prev) => {
      const next = { ...prev };
      if (names.length === 0) delete next.tags;
      else next.tags = names;
      return next;
    });

  const gpsValue = draft.hasGps === undefined ? '' : draft.hasGps ? '1' : '0';

  return (
    <section className="search-panel" role="dialog" aria-label="照片搜索">
      {/* 标签在第一行：它是「先圈大范围、再用 EXIF 抠细节」里的第一步 */}
      <TagFilter value={draft.tags ?? []} onChange={setTags} />

      <div className="search-panel__grid">
        <Field label="关键词">
          <input
            className="search-input"
            aria-label="关键词"
            value={draft.q ?? ''}
            onChange={(event) => patch('q', event.target.value)}
            placeholder="标题 / 分类 / 相机 / 镜头"
          />
        </Field>
        <Field label="拍摄日期起">
          <input
            className="search-input"
            aria-label="拍摄日期起"
            type="date"
            value={draft.from ?? ''}
            onChange={(event) => patch('from', event.target.value)}
            onClick={(event) => openPicker(event.currentTarget)}
          />
        </Field>
        <Field label="拍摄日期止">
          <input
            className="search-input"
            aria-label="拍摄日期止"
            type="date"
            value={draft.to ?? ''}
            onChange={(event) => patch('to', event.target.value)}
            onClick={(event) => openPicker(event.currentTarget)}
          />
        </Field>
        {/* 五项字典字段：标题与占位符取自 core 的类型元数据，保证与后端口径一致 */}
        {DICTIONARY_KINDS.map((meta) => (
          <Field key={meta.kind} label={meta.fieldLabel}>
            <ComboBox
              kind={meta.kind}
              ariaLabel={meta.fieldLabel}
              placeholder={meta.placeholder}
              value={textOf(draft, meta.kind)}
              onChange={(raw) => patchDictionary(meta.kind, raw)}
            />
          </Field>
        ))}
        <Field label="定位状态">
          <SelectMenu
            ariaLabel="定位状态"
            options={GPS_OPTIONS}
            value={gpsValue}
            onChange={(raw) => patch('hasGps', raw === '' ? undefined : raw === '1')}
          />
        </Field>
      </div>

      <div className="search-panel__actions">
        <button type="button" className="search-action" onClick={() => setDraft(EMPTY)}>
          <Icon name="close" />
          清空
        </button>
        <button type="button" className="search-action is-primary" onClick={() => onApply(draft)}>
          <Icon name="search" />
          搜索
        </button>
      </div>

      {/* 关闭按钮固定在面板右上角：唯一且显眼的收口 */}
      <button type="button" className="search-panel__close" aria-label="关闭搜索" onClick={onClose}>
        <Icon name="close" />
      </button>
    </section>
  );
}