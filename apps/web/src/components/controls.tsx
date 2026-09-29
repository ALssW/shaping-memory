/**
 * apps/web/src/components/controls.tsx
 *
 * 交互基元：圆形图标按钮 / 胶囊分段控件 / 分类 chip。
 * 三个都很小且总是一起出现，故聚合成一个文件，避免碎片化的单组件文件。
 */
import type { IconName } from './Icon';
import { Icon } from './Icon';

/* -------------------------------------------------------------------------- */
/* 圆形图标按钮                                                                */
/* -------------------------------------------------------------------------- */

interface IconButtonProps {
  /** 图标名 */
  name: IconName;
  /** 无障碍名称（图标本身对读屏器隐藏） */
  label: string;
  /** 只有两档，对应 size.icon-button.* */
  size?: 'default' | 'compact';
  /** 激活态：accent 文字 + 淡洗底 */
  active?: boolean;
  /** 压在照片上时加材质底与发丝边 */
  glass?: boolean;
  className?: string;
  onClick?: () => void;
}

export function IconButton({ name, label, size = 'default', active = false, glass = false, className, onClick }: IconButtonProps) {
  const classes = [
    'icon-btn',
    size === 'compact' ? 'icon-btn--compact' : '',
    glass ? 'icon-btn--glass' : '',
    active ? 'is-on' : '',
    className ?? '',
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <button type="button" className={classes} aria-label={label} aria-pressed={active} onClick={onClick}>
      <Icon name={name} />
    </button>
  );
}

/* -------------------------------------------------------------------------- */
/* 胶囊分段控件（导航项组 / 墙面-列表 / 倒序-正序 共用）                        */
/* -------------------------------------------------------------------------- */

export interface PillOption<T extends string> {
  value: T;
  label: string;
  icon?: IconName;
}

interface PillBarProps<T extends string> {
  options: readonly PillOption<T>[];
  value: T;
  onChange: (value: T) => void;
  /** 中性描边版（不带 accent 倾向），用于页内次级切换 */
  neutral?: boolean;
  /** 只渲染图标、隐藏文字：文字转为 hover 提示（title）与 aria-label。用于顶栏导航 / 视图 / 排序等 */
  iconOnly?: boolean;
  ariaLabel: string;
  className?: string;
}

export function PillBar<T extends string>({ options, value, onChange, neutral = false, iconOnly = false, ariaLabel, className }: PillBarProps<T>) {
  return (
    <div className={`pillbar${neutral ? ' pillbar--neutral' : ''}${iconOnly ? ' pillbar--icon' : ''}${className ? ` ${className}` : ''}`} role="group" aria-label={ariaLabel}>
      {options.map((option) => {
        const isOn = option.value === value;
        return (
          <button
            key={option.value}
            type="button"
            className={`pillbar__item${isOn ? ' is-on' : ''}`}
            aria-pressed={isOn}
            aria-label={iconOnly ? option.label : undefined}
            title={iconOnly ? option.label : undefined}
            onClick={() => onChange(option.value)}
          >
            {option.icon ? <Icon name={option.icon} className="pillbar__icon" /> : null}
            {iconOnly ? null : option.label}
          </button>
        );
      })}
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* 分类 chip                                                                   */
/* -------------------------------------------------------------------------- */

interface ChipProps {
  label: string;
  active: boolean;
  onClick: () => void;
}

export function Chip({ label, active, onClick }: ChipProps) {
  return (
    <button type="button" className={`chip${active ? ' is-on' : ''}`} aria-pressed={active} onClick={onClick}>
      {label}
    </button>
  );
}