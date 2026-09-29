/**
 * apps/web/src/components/WallView.tsx
 *
 * 墙面视图：**按时间分段**的多列瀑布流 + 浮在页面正下方的横向时间轨。
 *
 * 【为什么要先按日期排序】墙面的读数是「档案时间刻度」，它必须落在一个有序列表上；
 * 后端返回的顺序只是默认（最新在前），并不等于用户此刻选的「正序/倒序」，
 * 因此这里先按 sort 排出有序副本，再分段、分列，每一条纵列与每一行都成为一段连续时间，
 * 轨道读数与刻度才单调推进。
 *
 * 【为什么先分段、再在段内分列】分隔线是「这里换了一段」的答案，它与列表那条分组头
 * 回答的是同一个问题，因此必须是**一根横贯整行的线**，而不是每列各拉一条短线。
 * 若先分列、再在每列里各自判断跨刻度点，各列的边界位置天生不同步（第 i 张进第 i % N 列），
 * 横贯线必然在某几列的两段之间硬切一刀 —— 所以在结构上就必须先分段：
 * 一段 = 一条整行分隔线 + 一个 N 列子网格。线由组持有，列只负责在段内排照片。
 *
 * 【段内为什么还是轮转分列】multi-column 是**列优先**填充：它把最新的一整段写入第一列，
 * 于是同一行里从左往右读，时间反而是跳着走的（实测第 1 列 2026-08、第 5 列 2023-01）。
 * 段内按轮转分配（第 i 张进第 i % N 列），横向读过去就是「下一张」——
 * 整段先从左往右、再往下，与读数方向一致。代价是段高不再自动均衡（各列按自身内容收尾），
 * 这是「按时间从左往右」必然要付的那部分。
 *
 * 【轨为什么横躺、为什么在正下方】墙面是一整片铺满视口的照片，左侧那条竖轨会切掉
 * 最左一列的画面；横轨放在正下方居中，既让出整幅画面，又和「先从左往右、再往下」
 * 的阅读方向同构。**时间从左到右 = 最新到最旧**，与纵向版「顶端最新」一一对应
 * （progress 0 恒为最新，两种朝向共用同一份刻度）。
 *
 * 【分隔线为什么随「月 / 日」一起变】分隔线的位置就是「时间段的边界」，而段的长度
 * 由工具栏的刻度粒度决定：月尺度按年月切、日尺度按日切。切段与列表共用 core 的 timeGroups，
 * 键取 core 的 scaleKeyOf —— 两视图不可能对同一条边界给出不同答案。
 *
 * 每张照片的动效全在 PhotoTile 里，这里只负责判定被悬停的照片以及由此算出的邻位聚拢。
 */
import { useCallback, useMemo } from 'react';
import type { CSSProperties } from 'react';
import { motion } from 'motion/react';
import { buildTimeGroups, sortByDate, splitIntoColumns, wallColumnCount } from '@shaping-memory/core';
import type { GroupItem, Photo, SortOrder } from '@shaping-memory/core';

import { PhotoTile } from './PhotoTile';
import { ProgressRail } from './ProgressRail';
import { useGalleryRail } from '../hooks/useGalleryRail';
import { useRipple, ZERO_PUSH } from '../hooks/useRipple';
import { useViewport } from '../hooks/useViewport';
import { reorder } from '../lib/motion';
import type { RailScale } from '../hooks/useProgressRail';
import type { OpenHandler } from '../types';

interface WallViewProps {
  photos: readonly Photo[];
  sort: SortOrder;
  /** 时间刻度粒度：月（整份档案的分布）/ 日（逐日精读） */
  scale: RailScale;
  onOpen: OpenHandler;
  /** 选择模式（admin 批量编辑）：为 true 时点照片切换选中，不再打开查看器 */
  selecting?: boolean;
  selected?: ReadonlySet<string>;
  onToggleSelect?: (id: string) => void;
}

/** 一个时间分段连同它内部已分好的列 —— 渲染期直接铺开，不再逐帧分配 */
interface WallGroup {
  key: string;
  label: string;
  /** 本段照片总数：分段头的读数。分列是段内的二次切分，张数必须在切之前取 */
  count: number;
  columns: GroupItem[][];
}

/*
 * 列数与「段内分列」都取自 core/layout：那套断点（769/1024/1440）与 % N 轮转
 * 是 Web 与移动端共用的行为口径，放在组件里就会变成两份实现。
 * 断点走视口宽度而不是容器宽度，是为了与那几条媒体查询逐字对齐。
 */

export function WallView({ photos, sort, scale, onOpen, selecting = false, selected, onToggleSelect }: WallViewProps) {
  const { containerRef, hovered, onHover, pushes } = useRipple<HTMLDivElement>('.photo-card');
  const { width } = useViewport();

  /* 日期有序副本：倒序 = 最新在前。不原地 sort，避免改动上层的数组。
     比较口径来自 core（与列表视图、查看器翻页共用同一份，见 sortByDate 的注释）。 */
  const ordered = useMemo(() => sortByDate(photos, sort), [photos, sort]);

  const columnCount = wallColumnCount(width);

  /* 分段 + 段内分列一次算完：两者都由 scale 与列数决定，
     拆成两次 useMemo 只会让「切刻度时的计算顺序」变得不可见。 */
  const groups = useMemo<WallGroup[]>(
    () =>
      buildTimeGroups(ordered, scale).map((group) => ({
        key: group.key,
        label: group.label,
        count: group.items.length,
        columns: splitIntoColumns(group.items, columnCount),
      })),
    [ordered, scale, columnCount],
  );

  /* 横向轨：与列表那条竖轨共用同一份刻度与读数，只有朝向不同 */
  const rail = useGalleryRail(ordered, '墙面位置', scale, 'horizontal');

  /** 缩略图只上报「我这张被点了」，下标由列表位置决定 */
  const activate = useCallback(
    (index: number, origin: DOMRect) => onOpen(index, ordered, origin),
    [onOpen, ordered],
  );

  if (ordered.length === 0) return <div className="empty-state">该分类暂无照片</div>;

  return (
    /* rail-layout--float：轨道不占栏，照片真的从屏幕最左列铺到最右列。
       横轨是 fixed 定位（脱离栅格流），因此不会把照片顶走。 */
    <div className="wall rail-layout rail-layout--float" ref={rail.containerRef}>
      {/* 正下方居中的横轨：位置交给 .rail-dock（fixed + translateX(-50%)），
          因此它在任何屏宽下都居中，且与页面上其它浮层同处一个层级。
          mat-thick + glass-neutral 是它压在照片上仍然可读的原因 —— 材质与阴影
          都取自 token 的 .mat-* / .glass-* 工具类，不在 app.css 里另造一套。 */}
      <div className="rail-dock mat-thick glass-neutral">
        <ProgressRail
          progress={rail.progress}
          label={rail.label}
          dragging={rail.dragging}
          marks={rail.marks}
          activeKey={rail.activeKey}
          labelEvery={rail.labelEvery}
          spanPx={rail.spanPx}
          orientation="horizontal"
          jumpTo={rail.jumpTo}
          hitProps={rail.hitProps}
          sliderProps={rail.sliderProps}
          trackRef={rail.trackRef}
        />
      </div>

      {/* 瀑布流：浮层变体下它就是唯一的一栏（照片铺满整页），
          列数交给 CSS 变量 —— JS 决定了「每张进入哪一列」，列数就必须与它同源。
          masonry--fine：日尺度下段数翻好几倍，段间距与线头留白同步收紧（见 app.css）。 */}
      <div
        className={`masonry${scale === 'day' ? ' masonry--fine' : ''}`}
        ref={containerRef}
        style={{ '--masonry-cols': columnCount } as CSSProperties}
      >
        {groups.map((group) => (
          <section className="masonry__group" key={group.key}>
            {/* 分段头：上方一条发丝线横贯整行切段，标题（年月 / 年月日）取主色调。
                与列表 .list__group-head 一字不差 —— 两视图回答的是同一个问题。 */}
            <header className="masonry__time-sep">
              <h3 className="masonry__time-sep-label">{group.label}</h3>
              {/* 张数落在时间右侧、压小一号：先读「哪一段」再读「有几张」，
                  层级上它是标题的注解而非并列信息（见 app.css 的 -count 规则）。 */}
              <span className="masonry__time-sep-count">{group.count} 张</span>
            </header>

            <div className="masonry__grid">
              {group.columns.map((column, columnIndex) => (
                <div className="masonry__col" key={columnIndex}>
                  {column.map(({ photo, index }) => (
                    /* 外壳只为一件事而存在：切刻度时给照片的重排位移一个补间落点
                       （分段重切会把这张连同后面所有照片整体推开）。
                       它挂在 layoutId 而不是 layout：切刻度后这张往往搬进了另一个
                       分段的子网格（父节点都换了），layout="position" 只在同一父级内
                       认得出位移，跨父级必须靠共享 id 让 Motion 接管。 */
                    <motion.div
                      className="masonry__item"
                      key={photo.id}
                      layoutId={photo.id}
                      transition={reorder}
                    >
                      <PhotoTile
                        photo={photo}
                        /* 卡片自带全局下标：段内是列优先的 DOM 顺序，
                           与时间顺序不再一致，邻位聚拢要靠它把「第几张」对回去（见 useRipple）。 */
                        index={index}
                        active={hovered === index}
                        push={pushes?.[index] ?? ZERO_PUSH}
                        onHover={(hovering) => onHover(hovering ? index : null)}
                        onActivate={(origin) => activate(index, origin)}
                        selecting={selecting}
                        selected={selected?.has(photo.id) ?? false}
                        onToggleSelect={onToggleSelect}
                      />
                    </motion.div>
                  ))}
                </div>
              ))}
            </div>
          </section>
        ))}
      </div>
    </div>
  );
}