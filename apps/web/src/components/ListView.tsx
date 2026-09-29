/**
 * apps/web/src/components/ListView.tsx
 *
 * 列表视图：按「年月」分组、组内横竖混排的等高行 + 左侧进度轨。
 *
 * 【为什么按年月分组】列表是逐张读时间的地方：日期有序的流水如果一路排到底，
 * 读者会失去「现在是哪一段」的锚点。分组标题（2026 · 8月）承担这个锚点，
 * 分割线负责切段，组内不再插任何间断。
 *
 * 【分组为什么跟着「月 / 日」变】分组标题就是「这一段是什么时候」的答案，而段的长度
 * 由工具栏的刻度粒度决定：月尺度按月切段、日尺度逐日切段。切段逻辑与图墙共用
 * core 的 timeGroups（键取 scaleKeyOf、文案取 scaleLabelOf），
 * 切尺度时两视图同时换口径，读者不会在轨上看到「8月6日」、在标题里看到「8月」。
 *
 * 【日尺度为什么要把组间距收紧】日尺度下分组从「月」变成「日」，组数会翻好几倍，
 * 40px 的组间距会让一屏里几乎全是空白 —— 见 app.css 的 .list--fine。
 *
 * 【等高行怎么排】不写死列数、也不量 DOM：把每张卡的 flex 基准设成
 * 「目标行高 × 自身纵横比」、伸缩权设成「自身纵横比」，同一行里
 * 横片与竖片就自动等高，且整行刚好铺满容器宽度 —— 横竖混排不会出现空洞。
 * 基准只认照片自身的比例（见 photoAspect），因此照片本身不变形。
 * 行末再由一个 flex-grow 极大的填充元素吸走剩余宽度，
 * 保证每组的最后一行是「按基准高度收尾」而不是被拉成一条大图。
 *
 * 【为什么不给列表做邻位聚拢】聚拢的前提是「有横向邻位」：一行里邻居多达七八张，
 * 朝被悬浮的那张收拢只会把整行挤成麻花、把下面的卡片推走，滚动位置跟着跳。
 * 因此列表用最轻的静态反馈（整张材质加厚一档），把这个视图的动效预算全部留给滚动本身。
 *
 * 【元信息为什么复用 PhotoMask】它是照片信息的唯一一份排版（标题 → 器材 → 时间 → 曝光/标签），
 * 墙面卡片与列表卡片必须一致，所以这里不另写一套。区别只在外壳：墙面上它是压在照片上的
 * 渐变蒙版（绝对定位），列表里它是照片下方的普通文本块 —— 这层差异由 CSS 覆盖，不是结构差异。
 *
 * 【读数与刻度】与墙面共用 useGalleryRail：进度 0 = 最新一张、1 = 最旧一张，
 * 轨上的月份刻度画出整份档案的时间分布，月份/年份标签跟着滚动点换边。
 */
import { useCallback, useMemo } from 'react';
import type { CSSProperties } from 'react';
import { motion } from 'motion/react';
import { buildTimeGroups, photoAspect, placeholderColors, sortByDate } from '@shaping-memory/core';
import type { Photo, SortOrder } from '@shaping-memory/core';

import { Icon } from './Icon';
import { PhotoMask } from './PhotoMask';
import { ProgressRail } from './ProgressRail';
import { ProgressiveImage } from './ProgressiveImage';
import { useGalleryRail } from '../hooks/useGalleryRail';
import { reorder } from '../lib/motion';
import type { RailScale } from '../hooks/useProgressRail';
import type { OpenHandler } from '../types';

interface ListViewProps {
  photos: readonly Photo[];
  sort: SortOrder;
  /** 时间刻度粒度：月（整份档案的分布）/ 日（逐日精读） */
  scale: RailScale;
  onOpen: OpenHandler;
  /** 选择模式（admin 批量编辑）：为 true 时点卡片切换选中、不打开查看器 */
  selecting?: boolean;
  selected?: ReadonlySet<string>;
  onToggleSelect?: (id: string) => void;
}

/**
 * 卡片尺寸只由照片自身纵横比决定：
 * CSS 侧用同一个 --card-aspect 既当伸缩权、又当基准宽度的系数，也当缩略图的比例。
 */
function aspectStyle(photo: Photo): CSSProperties {
  const [width, height] = photoAspect(photo);
  return { '--card-aspect': width / height } as CSSProperties;
}

export function ListView({ photos, sort, scale, onOpen, selecting = false, selected, onToggleSelect }: ListViewProps) {
  /* 日期有序副本：列表是逐张读时间的地方，顺序必须与轨道读数一致。
     比较口径来自 core（与墙面、查看器翻页共用同一份，见 sortByDate 的注释） */
  const ordered = useMemo(() => sortByDate(photos, sort), [photos, sort]);

  const groups = useMemo(() => buildTimeGroups(ordered, scale), [ordered, scale]);

  /* 刻度粒度由工具栏决定，分组标题与轨上刻度同源 —— 切到日尺度时
     分组标题会写「2026 · 8月6日」，轨上那枚刻度也写「8/6」，读的是同一段时间 */
  const rail = useGalleryRail(ordered, '列表位置', scale);

  /** 卡片只上报「我被点了」，下标由列表位置决定 —— 与墙面同一套契约 */
  const open = useCallback(
    (index: number, card: HTMLElement) => {
      // 起点矩形取图片本体：查看器的放大动画从缩略图起飞
      const box = card.querySelector('.progressive');
      onOpen(index, ordered, (box ?? card).getBoundingClientRect());
    },
    [onOpen, ordered],
  );

  if (ordered.length === 0) return <div className="empty-state">该分类暂无照片</div>;

  return (
    /* list--fine：日尺度下分组变多，组间距与组头留白同步收紧（见 app.css） */
    <div className={`list rail-layout${scale === 'day' ? ' list--fine' : ''}`} ref={rail.containerRef}>
      {/* 轨道槽：sticky 与网格栏位都归这一层（见 app.css 的 .rail-slot），
          槽内的 ProgressRail 因此可以是纯粹的展示层 */}
      <div className="rail-slot">
        <ProgressRail
          progress={rail.progress}
          label={rail.label}
          dragging={rail.dragging}
          marks={rail.marks}
          activeKey={rail.activeKey}
          labelEvery={rail.labelEvery}
          spanPx={rail.spanPx}
          orientation="vertical"
          jumpTo={rail.jumpTo}
          hitProps={rail.hitProps}
          sliderProps={rail.sliderProps}
          trackRef={rail.trackRef}
        />
      </div>

      <div className="list__groups">
        {groups.map((group) => (
          <section className="list__group" key={group.key}>
            {/* 分组头：上方一条发丝分割线切段，标题（年月）取主色调 */}
            <header className="list__group-head">
              <h3 className="list__group-title">{group.label}</h3>
              {/* 张数落在时间右侧、压小一号：与墙面 .masonry__time-sep 同款同序 */}
              <span className="list__group-count">{group.items.length} 张</span>
            </header>

            <ul className="list__row">
              {group.items.map(({ photo, index }) => (
                /* 切刻度时分组会整体重切，这张会搬到另一个 <ul> 里（父节点都换了）——
                   layoutId 让 Motion 认出「这还是同一张」，用旧矩形补间到新位置，
                   于是重排过程看得见。列表项本身的尺寸不随刻度变，位置才变。 */
                <motion.li
                  className="list__cell"
                  key={photo.id}
                  layoutId={photo.id}
                  transition={reorder}
                  style={aspectStyle(photo)}
                  /* 列表项与卡片都不可拖：缩略图是 <img>，浏览器默认让它可拖，
                     拖起来会拽出一个照片幽灵；卡片本身补一份，拖到标题 / EXIF 区也不起拖。 */
                  draggable={false}
                >
                  <article
                    className={`list-card${selecting ? (selected?.has(photo.id) ? ' is-selected' : ' is-selectable') : ''}`}
                    data-photo={photo.id}
                    role="button"
                    tabIndex={0}
                    aria-label={
                      selecting
                        ? selected?.has(photo.id)
                          ? `取消选中《${photo.title}》`
                          : `选中《${photo.title}》`
                        : `查看《${photo.title}》`
                    }
                    aria-pressed={selecting ? selected?.has(photo.id) : undefined}
                    draggable={false}
                    onClick={(event) => {
                      if (selecting) onToggleSelect?.(photo.id);
                      else open(index, event.currentTarget);
                    }}
                    onKeyDown={(event) => {
                      // 自定义按钮需自己补齐键盘的两种激活方式
                      if (event.key === 'Enter' || event.key === ' ') {
                        event.preventDefault();
                        if (selecting) onToggleSelect?.(photo.id);
                        else open(index, event.currentTarget);
                      }
                    }}
                  >
                    <div className="list-card__thumb">
                      <ProgressiveImage
                        src={photo.cardUrl ?? photo.url}
                        alt={photo.title}
                        aspect={photoAspect(photo)}
                        colors={placeholderColors(photo)}
                      />
                      {/* 选择模式下的勾选角标 */}
                      {selecting ? (
                        <span className="photo-card__check" aria-hidden="true">
                          {selected?.has(photo.id) ? <Icon name="check" /> : null}
                        </span>
                      ) : null}
                      {/* 实况角标与墙面同款同位置（照片右上角），保证两种视图的语义一致 */}
                      {photo.isLive ? (
                        <span className="photo-card__live" title="实况照片">
                          <Icon name="live" />
                          <span className="photo-card__live-text">实况</span>
                        </span>
                      ) : null}
                      {/* 隐私角标：与墙面同款、同放左上角（实况占着右上角） */}
                      {photo.privacy && photo.privacy.mode !== 'visible' ? (
                        <span className="photo-card__lock" title="隐私照片，需要授权查看">
                          <Icon name="lock" />
                        </span>
                      ) : null}
                    </div>

                    <div className="list-card__meta">
                      {/* 地点不另起一行：它就在蒙版的 daterow 里（时间左侧，
                          列表形态下 CSS 把它复位成 static）。同一份信息在卡片里重复两次只是噪声
                          （与墙面 PhotoTile 的处理一致 —— 只是墙面把它钉在了照片右上角）。 */}
                      <PhotoMask photo={photo} />
                    </div>
                  </article>
                </motion.li>
              ))}
              {/* 行末填充：只吸收末行剩余宽度，自身不占高度（详见文件头注释） */}
              <li className="list__row-filler" aria-hidden="true" />
            </ul>
          </section>
        ))}
      </div>
    </div>
  );
}