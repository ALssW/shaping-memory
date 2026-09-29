/**
 * apps/web/src/components/Combobox.tsx
 *
 * 两个自建下拉：ComboBox（可输入 + 实时联想候选）与 SelectMenu（点选式）。
 *
 * 【为什么不用原生 <select> / <datalist>】原生下拉面板由浏览器绘制，
 * 颜色、边框、圆角、展开动画、选中态一概改不了 —— 而「与后台（antd）观感一致」
 * 正是本轮需求。自建一个小面板，两端共用同一套 --color-* / --radius-* / --motion-* token，
 * 观感才对得上。
 *
 * 【为什么两个组件放一个文件】它们共享：同一套面板结构、同一套键盘/外点关闭逻辑、
 * 同一套 CSS 类。拆成两个文件只会让这段共享逻辑要么重复、要么再抽一个文件。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { DictionaryKind } from '@shaping-memory/core';
import { searchApi } from '@shaping-memory/sdk';

import { Icon } from './Icon';

/** 联想防抖：输入停下来再发请求，敲字过程中不打后端 */
const SUGGEST_DEBOUNCE_MS = 250;
/** 一次拉回的候选条数：一屏够看，也不会把整份字典拖下来 */
const SUGGEST_LIMIT = 20;

/**
 * 外点 / Esc 关闭。
 * 【为什么监听 mousedown 而不是 click】click 在「按下 A 又拖到 B 抬起」时会落在 B 上，
 * 容易出现「点面板内选项却把面板关了」的竞态；mousedown 的时机与用户直觉一致。
 */
function useDismiss(open: boolean, close: () => void) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (event: MouseEvent) => {
      if (!ref.current?.contains(event.target as Node)) close();
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') close();
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open, close]);
  return ref;
}

/* -------------------------------------------------------------------------- */
/* 可输入 + 实时联想：字典字段（机身 / 镜头 / 光圈 / 快门 / 感光度）             */
/* -------------------------------------------------------------------------- */

interface ComboBoxProps {
  /** 字典类型：候选由 /search/suggest 按它拉取 */
  kind: DictionaryKind;
  value: string;
  placeholder?: string;
  ariaLabel: string;
  /** 选中或手输后的值（空串代表清空该维度） */
  onChange: (value: string) => void;
}

export function ComboBox({ kind, value, placeholder, ariaLabel, onChange }: ComboBoxProps) {
  const [open, setOpen] = useState(false);
  const [options, setOptions] = useState<readonly string[]>([]);
  const [active, setActive] = useState(0);
  const close = useCallback(() => setOpen(false), []);
  const ref = useDismiss(open, close);

  /* 输入变了就重新联想：防抖 + cancel 标记，丢弃「已经过时的关键词」的响应 */
  useEffect(() => {
    if (!open) return;
    let canceled = false;
    const timer = setTimeout(() => {
      searchApi
        .suggest(kind, value.trim(), SUGGEST_LIMIT)
        .then((list) => {
          if (canceled) return;
          setOptions(list.map((entry) => entry.value));
          setActive(0);
        })
        .catch(() => {
          if (!canceled) setOptions([]);
        });
    }, SUGGEST_DEBOUNCE_MS);
    return () => {
      canceled = true;
      clearTimeout(timer);
    };
  }, [open, kind, value]);

  /** 键盘操作：候选里的上下移动与回车确认，避免「只能用鼠标选」 */
  const onKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      setOpen(true);
      const delta = event.key === 'ArrowDown' ? 1 : -1;
      setActive((prev) => (options.length === 0 ? 0 : (prev + delta + options.length) % options.length));
      return;
    }
    if (event.key === 'Enter' && open && options[active]) {
      event.preventDefault();
      onChange(options[active]);
      setOpen(false);
    }
  };

  return (
    <div className="combo" ref={ref}>
      <input
        className="search-input"
        role="combobox"
        aria-label={ariaLabel}
        aria-expanded={open}
        aria-autocomplete="list"
        value={value}
        placeholder={placeholder}
        onFocus={() => setOpen(true)}
        onChange={(event) => {
          onChange(event.target.value);
          setOpen(true);
        }}
        onKeyDown={onKeyDown}
      />
      {value ? (
        <button
          type="button"
          className="combo__clear"
          aria-label={`清空${ariaLabel}`}
          // 按下时不抢走输入框焦点，清空后光标仍留在框里可以接着输
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => {
            onChange('');
            setOpen(true);
          }}
        >
          <Icon name="close" />
        </button>
      ) : (
        <span className="combo__caret" aria-hidden="true">
          <Icon name="chevron" />
        </span>
      )}

      {open ? (
        <div className="dropdown" role="listbox" aria-label={`${ariaLabel}候选`}>
          {options.length === 0 ? (
            <div className="dropdown__hint">没有匹配的候选</div>
          ) : (
            options.map((option, index) => (
              <button
                key={option}
                type="button"
                role="option"
                aria-selected={option === value}
                className={`dropdown__option${index === active ? ' is-active' : ''}${option === value ? ' is-on' : ''}`}
                // 不让输入框失焦，面板才不会在「按下」那一刻就关掉
                onMouseDown={(event) => event.preventDefault()}
                onMouseEnter={() => setActive(index)}
                onClick={() => {
                  onChange(option);
                  setOpen(false);
                }}
              >
                <span className="dropdown__text">{option}</span>
                {option === value ? <Icon name="check" className="dropdown__check" /> : null}
              </button>
            ))
          )}
        </div>
      ) : null}
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* 点选式下拉：定位状态（不限 / 有定位 / 无定位）、EXIF 的枚举型字段             */
/* -------------------------------------------------------------------------- */

export interface SelectOption {
  value: string;
  label: string;
}

interface SelectMenuProps {
  value: string;
  options: readonly SelectOption[];
  ariaLabel: string;
  onChange: (value: string) => void;
  /** 无值时的灰字提示 */
  placeholder?: string;
  /** 是否显示清除按钮（EXIF 字段用它表达「删除该 tag」） */
  clearable?: boolean;
  disabled?: boolean;
}

export function SelectMenu({
  value,
  options,
  ariaLabel,
  onChange,
  placeholder,
  clearable = false,
  disabled = false,
}: SelectMenuProps) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const close = useCallback(() => setOpen(false), []);
  const ref = useDismiss(open, close);

  /**
   * 【必须精确命中，不能回落到 options[0]】文件里没有该字段（value 为空）或值在枚举之外时，
   * 回落会让下拉显示成第一个选项（例如 Orientation 显示「1 · 正常」），
   * 用户会误以为文件里确有该值 —— 相当于把「未设置」冒充成「已设置」。
   */
  const current = options.find((option) => option.value === value);
  const triggerText = current ? current.label : value;
  const isPlaceholder = !current && value === '';

  const onKeyDown = (event: React.KeyboardEvent<HTMLButtonElement>): void => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      setOpen(true);
      const delta = event.key === 'ArrowDown' ? 1 : -1;
      setActive((prev) => (options.length === 0 ? 0 : (prev + delta + options.length) % options.length));
      return;
    }
    if (event.key === 'Enter' && open && options[active]) {
      event.preventDefault();
      onChange(options[active].value);
      setOpen(false);
    }
  };

  return (
    <div className="combo" ref={ref}>
      <button
        type="button"
        className="search-input combo__trigger"
        aria-label={ariaLabel}
        aria-haspopup="listbox"
        aria-expanded={open}
        disabled={disabled}
        onClick={() => setOpen((prev) => !prev)}
        onKeyDown={onKeyDown}
      >
        <span className={`dropdown__text${isPlaceholder ? ' is-placeholder' : ''}`}>
          {isPlaceholder ? (placeholder ?? '') : triggerText}
        </span>
        <span className={`combo__caret${open ? ' is-open' : ''}`} aria-hidden="true">
          <Icon name="chevron" />
        </span>
      </button>

      {clearable && value !== '' && !disabled ? (
        <button
          type="button"
          className="combo__clear"
          aria-label={`清空${ariaLabel}`}
          onClick={() => {
            onChange('');
            setOpen(false);
          }}
        >
          <Icon name="close" />
        </button>
      ) : null}

      {open ? (
        <div className="dropdown" role="listbox" aria-label={ariaLabel}>
          {options.length === 0 ? (
            <div className="dropdown__hint">没有可选项</div>
          ) : (
            options.map((option, index) => (
              <button
                key={option.value}
                type="button"
                role="option"
                aria-selected={option.value === value}
                className={`dropdown__option${index === active ? ' is-active' : ''}${option.value === value ? ' is-on' : ''}`}
                onMouseDown={(event) => event.preventDefault()}
                onMouseEnter={() => setActive(index)}
                onClick={() => {
                  onChange(option.value);
                  setOpen(false);
                }}
              >
                <span className="dropdown__text">{option.label}</span>
                {option.value === value ? <Icon name="check" className="dropdown__check" /> : null}
              </button>
            ))
          )}
        </div>
      ) : null}
    </div>
  );
}