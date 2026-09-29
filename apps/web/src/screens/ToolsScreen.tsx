/**
 * apps/web/src/screens/ToolsScreen.tsx
 *
 * 工具模块：先渲染 core `PANEL_TOOL_REGISTRY` 的面板型工具卡片（点开进各自的工作台），
 * 再遍历 `TOOL_REGISTRY`，按每个工具的字段 schema 动态渲染表单，把数值交给纯函数 compute 得到结果。
 *
 * 【为什么这里不多写一个工具】每个工具自描述（fields + compute），
 * 新增工具只需在 core 注册一条 ToolDef，这里自动出现一张可交互的计算卡。
 *
 * 【面板型工具为什么同页切换】工作台与计算器同属「工具」模块，hash 路由只有 #tools 一个入口，
 * 用局部 state 切换视图就不必给路由加分支，返回时也天然回到工具列表。
 */
import { useMemo, useState } from 'react';
import { PANEL_TOOL_REGISTRY, TOOL_REGISTRY } from '@shaping-memory/core';
import type { PanelToolDef, ToolDef, ToolField } from '@shaping-memory/core';
import type { IconName } from '../components/Icon';
import { Icon } from '../components/Icon';
import { LocalExifWorkbench } from '../components/LocalExifWorkbench';

/** 工具图标映射：清单是数据，图标是表现，两边不互相污染 */
const TOOL_ICONS: Record<string, IconName> = {
  nd: 'aperture',
  ev: 'wrench',
  dof: 'camera',
  fov: 'grid',
  color_temp: 'aperture',
};

/** 面板型工具的图标：注册表给的是名字，映射成前台 Icon 里的同名图形 */
const PANEL_ICONS: Record<string, IconName> = {
  'exif-edit': 'sliders',
};

/** 由字段默认值搭出初始 state（全部字段默认都是 number） */
function defaultsOf(tool: ToolDef): Record<string, number> {
  const values: Record<string, number> = {};
  for (const field of tool.fields) values[field.key] = field.default;
  return values;
}

/** 单输入控件：number 渲染数值框，select 渲染 chip 按钮组 */
function ToolFieldControl({ field, value, onChange }: { field: ToolField; value: number; onChange: (next: number) => void }) {
  if (field.type === 'select') {
    return (
      <div>
        <span className="field__label">{field.label}</span>
        <div className="preset-row" role="group" aria-label={field.label}>
          {(field.options ?? []).map((option) => {
            const isOn = option.value === value;
            return (
              <button
                key={option.value}
                type="button"
                className={`preset${isOn ? ' is-on' : ''}`}
                aria-pressed={isOn}
                onClick={() => onChange(option.value)}
              >
                {option.label}
              </button>
            );
          })}
        </div>
      </div>
    );
  }

  return (
    <label>
      <span className="field__label">
        {field.label}
        {field.label && field.unit ? <span className="field__unit">{field.unit}</span> : null}
      </span>
      <input
        className="field__input"
        type="number"
        min={field.min}
        max={field.max}
        step={field.step ?? 1}
        inputMode="decimal"
        value={Number.isFinite(value) ? value : ''}
        onChange={(event) => onChange(Number(event.target.value))}
      />
    </label>
  );
}

/** 一张可交互的计算卡：头部 + 字段网格 + 结果 */
function ToolCard({ tool }: { tool: ToolDef }) {
  const [values, setValues] = useState(() => defaultsOf(tool));

  const setField = (key: string, next: number): void => {
    setValues((prev) => ({ ...prev, [key]: next }));
  };

  // 字段少（≤4）且函数纯，但结果带 toFixed 分支，切字段时才算即可
  const result = useMemo(() => tool.compute(values), [tool, values]);

  return (
    <article className="tool-card tool-card--filled" aria-label={tool.name}>
      <header className="ndcalc__head">
        <span className="tool-card__icon">
          <Icon name={TOOL_ICONS[tool.key] ?? 'wrench'} />
        </span>
        <div>
          <div className="ndcalc__title">{tool.name}</div>
          <div className="ndcalc__hint">{tool.desc}</div>
        </div>
      </header>

      <div className="ndcalc__grid">
        {tool.fields.map((field) => (
          <ToolFieldControl key={field.key} field={field} value={values[field.key]} onChange={(next) => setField(field.key, next)} />
        ))}
      </div>

      <div className="ndcalc__result">
        <span className="ndcalc__result-label">{result.primarySub ?? tool.name}</span>
        <div>
          <div className="ndcalc__value">{result.primary}</div>
          {result.rows.length > 0 ? (
            <div className="tool-result__rows">
              {result.rows.map((row) => (
                <div key={row.label} className="tool-result__row">
                  <span className="tool-result__row-label">{row.label}</span>
                  <span className="tool-result__row-value">{row.value}</span>
                </div>
              ))}
            </div>
          ) : null}
        </div>
      </div>
    </article>
  );
}

export function ToolsScreen() {
  // 当前打开的面板型工具：非空即切换到工作台视图，返回时清空
  const [panel, setPanel] = useState<PanelToolDef | null>(null);

  if (panel?.key === 'exif-edit') {
    return <LocalExifWorkbench onBack={() => setPanel(null)} />;
  }

  return (
    <section className="module">
      <div className="shell">
        <h1 className="page-title">工具</h1>
        <p className="page-sub">拍摄现场用得上的换算，全在本地即时计算</p>

        <div className="tool-grid">
          {PANEL_TOOL_REGISTRY.map((tool) => (
            <button key={tool.key} type="button" className="tool-card tool-card--panel" onClick={() => setPanel(tool)}>
              <span className="tool-card__icon">
                <Icon name={PANEL_ICONS[tool.key] ?? 'sliders'} />
              </span>
              <span className="tool-card__name">{tool.name}</span>
              <span className="tool-card__desc">{tool.desc}</span>
              {tool.local ? <span className="tool-card__badge">免登录 · 断网可用</span> : null}
            </button>
          ))}
          {TOOL_REGISTRY.map((tool) => (
            <ToolCard key={tool.key} tool={tool} />
          ))}
        </div>
      </div>
    </section>
  );
}