/**
 * apps/web/src/components/LocalExifExportPanel.tsx
 *
 * 导出设置面板：文件名规则 + 保存位置（导出设置的界面落点）。
 *
 * 【为什么单独成组件】工作台已经承担导入 / 勾选 / 草稿 / 应用四项职责，导出设置是第五项、
 * 且与前几项没有耦合（只读 naming 与目录名），拆出来后工作台的 JSX 不至于失控。
 *
 * 【为什么把「预览名」摆在面板里】命名规则的问题只有看到真实结果才会暴露
 * （比如模板里忘写 {ext}、后缀写成 `` 导致覆盖同名文件）。摆一行「首个文件将导出为 xxx」，
 * 用户在点导出之前就能自查。
 */
import type { ExportNaming } from '../lib/exifExport';

interface LocalExifExportPanelProps {
  naming: ExportNaming;
  onNamingChange: (next: ExportNaming) => void;
  /** 按当前规则算出的首个导出文件名（空字符串 = 暂无可导出的照片） */
  previewName: string;
  /** 已选目录名；null = 走浏览器下载 */
  directoryName: string | null;
  /** 浏览器是否支持目录选择器（Firefox / Safari 为 false） */
  directorySupported: boolean;
  busy: boolean;
  onChooseDirectory: () => void;
  onUseDownload: () => void;
}

const MODES: ReadonlyArray<{ value: ExportNaming['mode']; label: string }> = [
  { value: 'suffix', label: '原名 + 后缀' },
  { value: 'prefix', label: '前缀 + 原名' },
  { value: 'template', label: '模板' },
];

const CONFLICTS: ReadonlyArray<{ value: ExportNaming['conflict']; label: string }> = [
  { value: 'rename', label: '同名自动加序号' },
  { value: 'overwrite', label: '同名直接覆盖' },
];

export function LocalExifExportPanel({
  naming,
  onNamingChange,
  previewName,
  directoryName,
  directorySupported,
  busy,
  onChooseDirectory,
  onUseDownload,
}: LocalExifExportPanelProps) {
  /** 当前模式对应的那段可编辑文本 */
  const activeText = naming.mode === 'prefix' ? naming.prefix : naming.mode === 'template' ? naming.template : naming.suffix;

  const updateText = (text: string): void => {
    if (naming.mode === 'prefix') onNamingChange({ ...naming, prefix: text });
    else if (naming.mode === 'template') onNamingChange({ ...naming, template: text });
    else onNamingChange({ ...naming, suffix: text });
  };

  return (
    <div className="localexif-export">
      <div className="localexif-export__row">
        <span className="localexif-export__label">文件名规则</span>
        <select
          className="search-input localexif-export__select"
          value={naming.mode}
          onChange={(event) => onNamingChange({ ...naming, mode: event.target.value as ExportNaming['mode'] })}
        >
          {MODES.map((mode) => (
            <option key={mode.value} value={mode.value}>
              {mode.label}
            </option>
          ))}
        </select>
        <input
          className="search-input localexif-export__input"
          value={activeText}
          placeholder={naming.mode === 'template' ? '{name}-{date}' : '如 -edited'}
          onChange={(event) => updateText(event.target.value)}
        />
        <select
          className="search-input localexif-export__select"
          value={naming.conflict}
          onChange={(event) => onNamingChange({ ...naming, conflict: event.target.value as ExportNaming['conflict'] })}
        >
          {CONFLICTS.map((conflict) => (
            <option key={conflict.value} value={conflict.value}>
              {conflict.label}
            </option>
          ))}
        </select>
      </div>

      <div className="localexif-export__row">
        <span className="localexif-export__label">保存位置</span>
        <button type="button" className="search-action" disabled={busy || !directorySupported} onClick={onChooseDirectory}>
          {directoryName ? '更换目录…' : '选择导出目录…'}
        </button>
        {directoryName ? (
          <button type="button" className="search-action" disabled={busy} onClick={onUseDownload}>
            改用浏览器下载
          </button>
        ) : null}
        <span className="localexif-export__hint">
          {directoryName
            ? `已选目录：${directoryName}`
            : directorySupported
              ? '未选目录，将逐个走浏览器下载'
              : '当前浏览器不支持目录选择，将逐个走浏览器下载（Firefox / Safari 常见）'}
        </span>
      </div>

      {previewName ? (
        <p className="localexif-export__preview">
          首个文件将导出为 <code>{previewName}</code>
        </p>
      ) : null}
    </div>
  );
}