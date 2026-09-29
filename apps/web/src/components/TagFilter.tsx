/**
 * apps/web/src/components/TagFilter.tsx
 *
 * 标签筛选器：挂在搜索面板内、字段栅格**之上**（第一行），支持多选。
 *
 * 【为什么是 AND 而不是 OR】选「日落」+「海边」时用户想看的是「既是日落又是海边的那几张」；
 * OR 会把两个标签各自的全量都倒进来，越选越多反而不像在筛。口径与后端一致（见 core 的 searchPhotos）。
 *
 * 【为什么不自己做实时筛选】标签与其余九个字段同属「草稿」，由面板的「搜索」按钮统一提交。
 * 因此这里只改草稿，不发请求 —— 面板里不会出现「一半字段实时生效、一半要提交」的两种节奏。
 *
 * 【为什么过滤输入不做防抖】候选列表已经全量在内存（见 sdk 的 loadTagCatalog），
 * 逐字过滤只是一个数组 filter，毫秒级；再套一层防抖只会引入额外的输入延迟。
 * 真正的网络开销被 TTL 缓存挡在面板之外了。
 */
import { useEffect, useMemo, useState } from 'react';
import { loadTagCatalog } from '@shaping-memory/sdk';
import type { TagOption } from '@shaping-memory/sdk';

import { Icon } from './Icon';

/** 收起状态最多铺开几枚（选中项另有专门的展示区，因此这里省略几枚也不会导致找不到） */
const COLLAPSED_LIMIT = 12;

interface TagFilterProps {
  /** 已选标签名；空数组即「不按标签筛」 */
  value: string[];
  onChange: (names: string[]) => void;
}

export function TagFilter({ value, onChange }: TagFilterProps) {
  const [options, setOptions] = useState<readonly TagOption[]>([]);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const [keyword, setKeyword] = useState('');
  const [expanded, setExpanded] = useState(false);

  useEffect(() => {
    let cancelled = false;
    loadTagCatalog()
      .then((list) => {
        if (cancelled) return;
        setOptions(list);
        setFailed(false);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    // 面板可能被反复开合：卸载后的 setState 要拦掉
    return () => {
      cancelled = true;
    };
  }, []);

  /** 按关键词本地过滤候选（大小写不敏感） */
  const matched = useMemo(() => {
    const q = keyword.trim().toLowerCase();
    if (q === '') return options;
    return options.filter((tag) => tag.name.toLowerCase().includes(q));
  }, [options, keyword]);

  const visible = expanded ? matched : matched.slice(0, COLLAPSED_LIMIT);

  /** 点一枚标签 = 选中 / 取消；已选的那几枚在上方单独展示，所以这里只需按名字增删 */
  const toggle = (name: string) =>
    onChange(value.includes(name) ? value.filter((item) => item !== name) : [...value, name]);

  return (
    <div className="tag-filter">
      <span className="search-field__label">标签</span>

      {/* 已选区：选中的标签原样列在这里，× 就地取消，不必回列表里翻找 */}
      {value.length > 0 && (
        <div className="tag-filter__selected">
          {value.map((name) => (
            <span key={name} className="chip is-on chip--removable">
              {name}
              <button
                type="button"
                className="exif-tags__remove"
                aria-label={`取消标签 ${name}`}
                onClick={() => toggle(name)}
              >
                <Icon name="close" />
              </button>
            </span>
          ))}
        </div>
      )}

      <div className="tag-filter__head">
        <input
          className="search-input"
          aria-label="搜索标签"
          value={keyword}
          onChange={(event) => setKeyword(event.target.value)}
          placeholder={loading ? '标签加载中…' : '搜索标签'}
        />
        {/* 候选多于一行才给展开入口，避免固定占一个没用的按钮 */}
        {matched.length > COLLAPSED_LIMIT && (
          <button
            type="button"
            className="search-action"
            aria-expanded={expanded}
            onClick={() => setExpanded((prev) => !prev)}
          >
            <Icon name="chevron" />
            {expanded ? '收起' : `更多 ${matched.length}`}
          </button>
        )}
      </div>

      <div className={`tag-filter__options${expanded ? ' is-expanded' : ''}`}>
        {visible.map((tag) => {
          const on = value.includes(tag.name);
          return (
            <button
              key={tag.id}
              type="button"
              className={`chip tag-filter__option${on ? ' is-on' : ''}`}
              aria-pressed={on}
              onClick={() => toggle(tag.name)}
            >
              {on && <Icon name="check" />}
              {tag.name}
              <span className="tag-filter__count">{tag.count}</span>
            </button>
          );
        })}
        {!loading && matched.length === 0 && (
          <span className="tag-filter__empty">
            {failed ? '标签加载失败，稍后再试' : '没有匹配的标签'}
          </span>
        )}
      </div>
    </div>
  );
}