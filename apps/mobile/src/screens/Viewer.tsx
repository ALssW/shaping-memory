/**
 * apps/mobile/src/screens/Viewer.tsx
 *
 * 全屏查看器（模态面）。与 Web 端 apps/web/src/components/Viewer.tsx 同构：
 *   · 当前下标由父级持有，本组件只上报方向（onStep），因此回调引用恒稳；
 *   · EXIF 行来自 @shaping-memory/core 的 exifRows，两端同一份字段顺序；
 *   · 渐进显图：先给底片色，原片到达后淡入。
 *
 * 【移动端的必然差异】
 *   1) 翻页用横向滑动（PanResponder），没有物理键盘；
 *   2) 「下载」在移动端不现实，改为「用系统浏览器打开原图」；
 *   3) 窗口是模态而非 DOM 层，安全区要自己让开刘海与 home 指示条；
 *   4) 背板是纯材质色，没有 Web 的 `backdrop-filter: blur(sm)`（RN 模态另起一个
 *      window，dimezis 采样不到背后的 activity，加了也只是一块纯色）。
 *
 * 【形态】三档，判据只有宽度：
 *   · sm（< 769dp）：照片占主体，元数据进底部**半透明抽屉**（expo-blur 材质 +
 *     半透明底），默认收起为一行摘要（标题 + 拍摄时间），点击 / 上滑展开完整元数据；
 *   · md（769–899dp）：EXIF 退回照片下方的可折叠抽屉（沿用既有形态）；
 *   · lg（≥ 900dp，与 Web 的 WIDE_MIN 同数）：换成「左舞台 + 右 256dp EXIF 侧栏」。
 *   三档展示的是**同一份完整元数据**（metaRows），只是容器不同。
 *
 * 【全量 EXIF 的权限现实】`GET /photos/:id/exif` 需要 admin/editor：匿名访客拿不到，
 * 因此基础档位只渲染 photo 上与卡面同源的那些字段；登录 admin/editor 后、且元数据
 * 确实展开时才按需补拉一次全量 EXIF（见 useFullExif），失败就安静地退回基础档位。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Animated,
  Modal,
  PanResponder,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Image } from 'expo-image';
import {
  approvedTagNames,
  exifRawToText,
  exifRows,
  EXIF_FIELDS,
  formatDate,
  VIEWER_WIDE_MIN_WIDTH,
  VIEWPORT_BREAKPOINTS,
} from '@shaping-memory/core';
import type { Photo } from '@shaping-memory/core';
import { exifApi } from '@shaping-memory/sdk';
import type { PhotoExifResult } from '@shaping-memory/sdk';

import { Glass, Icon, IconButton } from '../components/primitives';
import { EditDialog } from '../components/EditDialog';
import { PhotoMiniMap } from '../components/PhotoMiniMap';
import { SaveToAlbumButton } from '../components/SaveToAlbumButton';
import { ZoomableImage } from '../components/ZoomableImage';
import { duration, easing, springs, VIEWER_ENTER_SCALE } from '../layout/motion';
import { colors, fontFamily, radius, size, space, tabularNums, text } from '../theme';

/** 判定为「翻页」而非「误触」的最小横向位移 */
const SWIPE_THRESHOLD = 40;
/** 认定用户是在横滑（而非竖滑页面）的最小位移 */
const SWIPE_SLOP = 12;
/** EXIF 展开后的最大高度（照片下方的抽屉形态）：超过就自己滚，避免顶掉照片 */
const EXIF_MAX_HEIGHT = 220;
/** 顶部缩略图条里的小图边长 */
const STRIP_SIZE = 44;

/**
 * 侧栏形态的栏宽：与 Web `.viewer__frame --exif-w` 同数（space.64 × 4 = 256dp）。
 * 侧栏高度不设限 —— Web 的 `.viewer__exif` 是 `height: 100%`（与照片等高），
 * 列表自己滚，这里靠「父级拉伸 + 列表 flex:1」得到同一结果。
 */
const EXIF_SIDE_WIDTH = space.s64 * 4;
/** sm 档抽屉展开后的高度上限：照片必须仍占主体，因此最多给到半屏 */
const SHEET_MAX_HEIGHT_RATIO = 0.5;
/** 抽屉的上滑 / 下滑判定：竖向位移超过它才算一次「展开 / 收起」的意图 */
const SHEET_SWIPE = 24;

/* -------------------------------------------------------------------------- */
/* 原片层                                                                      */
/* -------------------------------------------------------------------------- */
/* 照片本体与三种手势（双击缩放 / 捏合 / 放大后平移）都在 ZoomableImage 里，
   它在舞台内自适应占位（contain），查看器只负责给它一个舞台。 */

/* -------------------------------------------------------------------------- */
/* 完整元数据：一份口径，三个容器共用                                            */
/* -------------------------------------------------------------------------- */

/** 元数据的一行：标签 + 值。值是数值/文本混排，标签固定宽 —— 两栏不会与内容对齐冲突 */
type MetaRow = readonly [string, string];

/** 全量 EXIF（admin/editor 专属）→ 展示行：按 EXIF_FIELDS 的登记顺序与 label 走，只留文件里真有值的 tag */
function fullExifRows(result: PhotoExifResult): MetaRow[] {
  const rows: MetaRow[] = [];
  for (const field of EXIF_FIELDS) {
    const raw = result.fields[field.tag];
    if (raw === undefined || raw === '') continue;
    /* 原始值先过 core 的规范化（与编辑表单同一份口径），再按单位拼上后缀 */
    const value = exifRawToText(field.type, raw);
    if (value !== '') rows.push([field.label, field.unit ? `${value} ${field.unit}` : value]);
  }
  if (result.gps) rows.push(['定位', `${result.gps.lat}, ${result.gps.lon}`]);
  return rows;
}

/**
 * 查看页的完整元数据行 = `exifRows(photo)` 的全部行 + 卡面上的标题 / 分类 / 标签，
 * 登录 admin/editor 后补拉的全量 EXIF 再追加在后面。
 *
 * 【同名字段去重】先出现的那一条胜出：卡面同源的那份是「展示值」，全量 EXIF 是
 * 「文件里的原始值」，两者同名时展示值优先（否则同一个字段会出现两行、值还不一样）。
 * 【基础档位为什么只有 photo 上的字段】全量 EXIF 接口要 admin/editor，
 * 匿名访客拿不到 —— 不臆造匿名可见的字段，界面自然也不会出现空壳行。
 */
function metaRows(photo: Photo, full: PhotoExifResult | null): MetaRow[] {
  const rows: MetaRow[] = [['标题', photo.title], ...exifRows(photo)];
  /* 标签是本组件额外补充的一行（不在 exifRows 的固定表里），没有标签就不落这一行 ——
     固定表里那些空值行是「字段存在但没读到」，与「这份档案不含该维度」不是一回事。
     只取「已生效」的标签：待审的是低置信度猜测，未经人工确认不该出现在访客眼前。
     注：描述不进这张表 —— 它是一段正文，落成「标签 + 值」的行会被 numberOfLines 截掉，
     因此单独由 PhotoDescription 整段渲染（见 ExifBody）。 */
  const tags = approvedTagNames(photo.tags);
  if (tags.length > 0) rows.push(['标签', tags.map((tag) => `#${tag}`).join(' ')]);
  if (full) rows.push(...fullExifRows(full));
  const seen = new Set<string>();
  return rows.filter(([key]) => (seen.has(key) ? false : (seen.add(key), true)));
}

/**
 * 照片描述：整段正文（换行与空行原样保留 —— RN 的 Text 本来就不吞 \n）。
 * 排在拍摄信息之前：它是「关于这张照片的一段话」，比器材参数更该先被看到。
 * 没写描述就不落这一块（与迷你地图同一条口径：空块不如不出现）。
 */
function PhotoDescription({ text }: { text: string }) {
  if (!text.trim()) return null;
  return (
    <View style={styles.descBlock}>
      <Text style={styles.descLabel}>描述</Text>
      <Text style={styles.descText}>{text}</Text>
    </View>
  );
}

/**
 * EXIF 卡片的正文 = **描述**（有就落）+ **拍摄位置小地图**（有 GPS 才落）+ 元数据行。
 * 三个容器（手机档抽屉 / 底部抽屉 / 侧栏）共用它，因此三档的正文永远一致；
 * 与 Web 端「拍摄信息卡片里先描述、再小地图、最后参数表」是同一处口径。
 */
function ExifBody({ photo, rows }: { photo: Photo; rows: readonly MetaRow[] }) {
  return (
    <>
      <PhotoDescription text={photo.description} />
      {photo.gps ? <PhotoMiniMap gps={photo.gps} title={photo.title} /> : null}
      <MetaRows rows={rows} />
    </>
  );
}

/** 元数据行表：底部抽屉 / 侧栏 / 手机档抽屉三处都用它，内容因此不可能出现不一致 */
function MetaRows({ rows }: { rows: readonly MetaRow[] }) {
  return (
    <>
      {rows.map(([key, value]) => (
        <View style={styles.exifRow} key={key}>
          <Text style={styles.exifKey}>{key}</Text>
          {/* 完整元数据里有长文本（镜头型号 / 版权），允许折到第二行再截断 */}
          <Text style={styles.exifValue} numberOfLines={2}>
            {value}
          </Text>
        </View>
      ))}
    </>
  );
}

/**
 * admin/editor 才拿得到的全量 EXIF：**按需补拉** —— 只有元数据展开时才请求，
 * 同一张只拉一次（收起再展开不重复发请求）。匿名访客不会触发它。
 * 拉失败就安静地退回基础档位：查看器不该因为一个可选增强而报错。
 */
function useFullExif(photoId: string | undefined, enabled: boolean): PhotoExifResult | null {
  const [fetched, setFetched] = useState<{ id: string; result: PhotoExifResult } | null>(null);

  useEffect(() => {
    if (!photoId || !enabled || fetched?.id === photoId) return;
    let cancelled = false;
    exifApi
      .get(photoId)
      .then((result) => {
        if (!cancelled) setFetched({ id: photoId, result });
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [photoId, enabled, fetched]);

  return fetched && fetched.id === photoId ? fetched.result : null;
}

/* -------------------------------------------------------------------------- */
/* 可折叠元数据面板（md / lg 档沿用：底部抽屉 / 右侧栏）                          */
/* -------------------------------------------------------------------------- */

interface InspectorProps {
  /** 当前照片：EXIF 正文里的小地图要读它的坐标 */
  photo: Photo;
  /** 完整元数据行（与 sm 抽屉同一份渲染） */
  rows: readonly MetaRow[];
  /** 展开态由查看器持有：三个容器共用同一个「元数据看没看」的意图 */
  open: boolean;
  onToggle: () => void;
  /** 侧栏形态（宽屏）：元数据挪到照片右侧的固定宽度栏里，与 Web 的 `--exif-w` 分支同构 */
  side?: boolean;
}

function Inspector({ photo, rows, open, onToggle, side = false }: InspectorProps) {
  return (
    <Glass corner="xl" style={[styles.inspector, side && styles.inspectorSide]}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="拍摄信息"
        accessibilityState={{ expanded: open }}
        onPress={onToggle}
        style={styles.inspectorHead}
      >
        <View style={styles.inspectorTitle}>
          <Icon name="info" size={size.icon.compact} color={colors.text.secondary} />
          <Text style={styles.inspectorHeadText}>拍摄信息</Text>
        </View>
        {/* 未展开是下箭头，展开后转 180° 指向上面 */}
        <View style={open ? styles.chevUp : undefined}>
          <Icon name="chevron" size={size.icon.compact} color={colors.text.tertiary} />
        </View>
      </Pressable>

      {open ? (
        <ScrollView
          /* 侧栏档吃满整栏（对齐 Web 的 height:100%）；
             抽屉档限高 220dp，免得长列表把照片挤出可视区 */
          style={side ? styles.exifScrollSide : styles.exifScroll}
          contentContainerStyle={styles.exifBody}
          nestedScrollEnabled
        >
          <ExifBody photo={photo} rows={rows} />
        </ScrollView>
      ) : null}
    </Glass>
  );
}

/* -------------------------------------------------------------------------- */
/* sm 档的底部半透明抽屉                                                         */
/* -------------------------------------------------------------------------- */

interface MetaSheetProps {
  photo: Photo;
  rows: readonly MetaRow[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/**
 * sm 档（<769dp）的元数据抽屉：照片仍是主体，元数据压在底部的半透明玻璃面上
 * （`Glass` = expo-blur 材质 + 半透明底，两件都在，缺一个就退化成半透明色块）。
 * 收起时只有一行摘要（标题 + 拍摄时间），点击或上滑展开完整元数据，再点或下滑收起。
 *
 * 【抽屉里的滚动为什么不会带着照片走】照片层完全没有滚动容器，抽屉里只有自己的
 * ScrollView（nestedScrollEnabled）—— 等价于 Web 的 `overscroll-behavior: contain`。
 */
function MetaSheet({ photo, rows, open, onOpenChange }: MetaSheetProps) {
  const { height } = useWindowDimensions();

  /* 上滑展开 / 下滑收起：只在明显竖向滑动时接管手势（与横滑翻页的判定同一条思路） */
  const panResponder = useMemo(
    () =>
      PanResponder.create({
        onMoveShouldSetPanResponder: (_event, gesture) =>
          Math.abs(gesture.dy) > SWIPE_SLOP && Math.abs(gesture.dy) > Math.abs(gesture.dx),
        onPanResponderRelease: (_event, gesture) => {
          if (gesture.dy <= -SHEET_SWIPE) onOpenChange(true);
          else if (gesture.dy >= SHEET_SWIPE) onOpenChange(false);
        },
      }),
    [onOpenChange],
  );

  return (
    <Glass
      corner="xl"
      style={[styles.sheet, { maxHeight: Math.round(height * SHEET_MAX_HEIGHT_RATIO) }]}
    >
      {/* 摘要行整行可点、也可上下滑：两种手势都通向同一个展开 / 收起 */}
      <View {...panResponder.panHandlers}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="照片元数据"
          accessibilityState={{ expanded: open }}
          onPress={() => onOpenChange(!open)}
          style={styles.sheetHead}
        >
          <Text style={styles.sheetTitle} numberOfLines={1}>
            {photo.title}
          </Text>
          <View style={styles.sheetRight}>
            <Text style={styles.sheetMeta} numberOfLines={1}>
              {formatDate(photo.date)}
            </Text>
            <View style={open ? styles.chevUp : undefined}>
              <Icon name="chevron" size={size.icon.compact} color={colors.text.tertiary} />
            </View>
          </View>
        </Pressable>
      </View>

      {open ? (
        <ScrollView style={styles.sheetScroll} contentContainerStyle={styles.exifBody} nestedScrollEnabled>
          <ExifBody photo={photo} rows={rows} />
        </ScrollView>
      ) : null}
    </Glass>
  );
}

/* -------------------------------------------------------------------------- */

interface ViewerProps {
  list: readonly Photo[];
  index: number;
  /** 只上报方向（-1 上一张 / +1 下一张），循环与边界交给父级 */
  onStep: (delta: number) => void;
  onClose: () => void;
  /** 是否具备前台编辑能力（admin）：显示「编辑」入口 */
  admin: boolean;
  /** 编辑保存成功后回调（触发重拉列表） */
  onPhotosChanged: () => void;
  liked: ReadonlySet<string>;
  onToggleLike: (id: string) => void;
  /**
   * 顶部横向缩略图条：**只有从地图画廊进来时才给**。
   * 那一路的 list 是「这个机位的照片」（见 MapScreen），翻页是「在该机位的若干张之间挑」，
   * 一条缩略图带能让这一点直观可见；从图墙进来的 list 是整份档案，翻页手势已经够用，
   * 再挂一条几十张的带子只会挤掉照片。长度 ≤ 1 时自动不渲染。
   */
  strip?: readonly Photo[];
  /** 点缩略图条里的某一张：跳到此下标（与 onStep 一样，状态仍由父级持有） */
  onSeek?: (index: number) => void;
}

export function Viewer({
  list,
  index,
  onStep,
  onClose,
  admin,
  onPhotosChanged,
  liked,
  onToggleLike,
  strip,
  onSeek,
}: ViewerProps) {
  const insets = useSafeAreaInsets();
  const { width } = useWindowDimensions();
  const photo = list[index];
  /** 编辑对话框是否展开（仅 admin） */
  const [editing, setEditing] = useState(false);

  /* 形态只由宽度决定：≥900 时 EXIF 挪到照片右侧的固定栏里 —— 与 Web 的 WIDE_MIN
     是同一个数（core/layout.ts 的 VIEWER_WIDE_MIN_WIDTH）。高度不参与判断，
     横屏矮出来的空间交给「列表自己滚」吸收，不必为矮屏另开一套布局。 */
  const wide = width >= VIEWER_WIDE_MIN_WIDTH;
  /** 手机档（< 769dp，与图墙的档位线同一个数）：元数据换成底部半透明抽屉 */
  const sm = width < VIEWPORT_BREAKPOINTS.md;

  /* 元数据的展开态由查看器持有：三个容器（手机抽屉 / 底部抽屉 / 侧栏）共用同一个意图。
     宽屏沿用既有默认「展开」（与 Web 一致），手机档默认收起成一行摘要 —— 照片要保持主体。 */
  const [metaOpen, setMetaOpen] = useState(wide);
  /** 全量 EXIF 只在「已登录 admin/editor」且「元数据已展开」时才补拉（见 useFullExif） */
  const fullExif = useFullExif(photo?.id, admin && metaOpen);
  /** 三档共用的一份完整元数据（同名字段已去重） */
  const rows = useMemo(() => (photo ? metaRows(photo, fullExif) : []), [photo, fullExif]);

  /* 进出场：Modal 自带的 fade 用的是平台时值（既不能从 token 派生，也没法只淡背板），
     所以关掉它自己驱动。两套模型各归各的（规范 §3.9）：空间运动（缩放）走 smooth 弹簧，
     非空间（透明度）走 base 时长 + smooth 缓动 —— 与 Web「画框 springs.smooth、
     背板 fade()」的分工同构。 */
  const enterFade = useRef(new Animated.Value(0)).current;
  const enterScale = useRef(new Animated.Value(VIEWER_ENTER_SCALE)).current;
  const [leaving, setLeaving] = useState(false);
  /** 退场只跑一次：动画期间连点关闭不能重复触发 onClose */
  const closing = useRef(false);

  useEffect(() => {
    Animated.parallel([
      Animated.timing(enterFade, {
        toValue: 1,
        duration: duration.base,
        easing: easing.smooth,
        useNativeDriver: true,
      }),
      Animated.spring(enterScale, { ...springs.smooth, toValue: 1 }),
    ]).start();
  }, [enterFade, enterScale]);

  /** 关闭走查：先把进出场倒放一遍，跑完才真的卸载 Modal（直接 onClose 是硬切） */
  const requestClose = useCallback(() => {
    if (closing.current) return;
    closing.current = true;
    setLeaving(true);
    Animated.parallel([
      Animated.timing(enterFade, {
        toValue: 0,
        duration: duration.fast,
        easing: easing.smooth,
        useNativeDriver: true,
      }),
      Animated.timing(enterScale, {
        toValue: VIEWER_ENTER_SCALE,
        duration: duration.fast,
        easing: easing.smooth,
        useNativeDriver: true,
      }),
    ]).start(() => onClose());
  }, [enterFade, enterScale, onClose]);

  /* 横滑翻页。onStep 由父级 useCallback 保证引用恒定，故这里只建一次响应器 */
  const panResponder = useMemo(
    () =>
      PanResponder.create({
        // 只在「明显横滑」时接管手势，否则把竖向滑动还给底层列表
        onMoveShouldSetPanResponder: (_event, gesture) =>
          Math.abs(gesture.dx) > SWIPE_SLOP && Math.abs(gesture.dx) > Math.abs(gesture.dy),
        onPanResponderRelease: (_event, gesture) => {
          if (gesture.dx <= -SWIPE_THRESHOLD) onStep(1);
          else if (gesture.dx >= SWIPE_THRESHOLD) onStep(-1);
        },
      }),
    [onStep],
  );

  /**
   * 画的是原图还是缩略图。
   * 【为什么不再交给系统浏览器】原先是 Linking.openURL 跳出去看，用户一旦离开应用
   * 就无法回到原来的位置；改成就地换一份字节 —— 与 Web 的「加载原片」同一个语义。
   * 缓存交给 expo-image：公开可见的原片走 memory-disk（这正是需求里的「本地缓存原图」，
   * 第二次点开直接从本地取）；获准后拿到的隐私原片服务端是 no-store，只进内存不落盘。
   */
  const [original, setOriginal] = useState(false);
  useEffect(() => {
    // 换页即回到缩略图：下一张还没看，不该默认把十几 MB 的原片拉下来
    setOriginal(false);
  }, [photo?.id]);

  const openOriginal = useCallback(() => {
    if (photo) setOriginal((prev) => !prev);
  }, [photo]);

  const toggleLike = useCallback(() => {
    if (photo) onToggleLike(photo.id);
  }, [photo, onToggleLike]);

  // 列表在查看期间被筛空时的保底处理，避免读到 undefined
  if (!photo) return null;

  const isLiked = liked.has(photo.id);

  return (
    <Modal visible transparent animationType="none" statusBarTranslucent onRequestClose={requestClose}>
      {/* 背板只做透明度：材质色本身不动，与 Web「scrim 淡出、材质不变」同一手法 */}
      <Animated.View
        style={[
          styles.backdrop,
          { paddingTop: insets.top + space.s8, paddingBottom: insets.bottom + space.s8, opacity: enterFade },
        ]}
        pointerEvents={leaving ? 'none' : 'auto'}
      >
        {/* key 跟着形态换：宽窄切换时 EXIF 的父级方向从纵变横，留着旧节点会带着
            上一形态的锚点残留一帧 */}
        <Animated.View key={wide ? 'wide' : 'narrow'} style={[styles.shell, { transform: [{ scale: enterScale }] }]}>
          <View style={styles.topBar}>
            <IconButton name="close" label="关闭查看器" onPress={requestClose} />
            <View style={styles.topActions}>
              {/* 前台编辑入口（仅 admin） */}
              {admin ? <IconButton name="edit" label="编辑照片" active={editing} onPress={() => setEditing(true)} /> : null}
              {/* 保存到相册：字节来自服务端写回后的原片，private 不可导出时按钮自身不渲染 */}
              <SaveToAlbumButton photo={photo} variant="icon" />
              {/* 查看原图：就地换一份字节，不跳出应用；再点一次回到缩略图。
                  锁住时后端不下发原片地址，画出来仍是模糊图（按钮因此不额外判一次） */}
              <IconButton
                name="download"
                label={original ? '显示缩略图' : '查看原图'}
                active={original}
                onPress={openOriginal}
              />
              <IconButton
                name={isLiked ? 'heartFilled' : 'heart'}
                label={isLiked ? '取消喜爱' : '标记喜爱'}
                active={isLiked}
                onPress={toggleLike}
              />
            </View>
          </View>

          {/* 点位缩略图条（仅从地图画廊进来时）：点某张直接跳过去，省去逐张滑动的手势。
              横滑自带，不参与查看器的左右翻页 —— 两者的方向冲突由 nestedScroll 解开。 */}
          {strip && strip.length > 1 && onSeek ? (
            <View style={styles.stripWrap}>
              <ScrollView
                horizontal
                showsHorizontalScrollIndicator={false}
                contentContainerStyle={styles.strip}
                nestedScrollEnabled
              >
                {strip.map((item, at) => (
                  <Pressable
                    key={item.id}
                    accessibilityRole="button"
                    accessibilityLabel={item.title}
                    accessibilityState={{ selected: at === index }}
                    onPress={() => onSeek(at)}
                    style={({ pressed }) => [pressed && styles.stripPressed]}
                  >
                    <Image
                      style={[styles.stripThumb, at === index && styles.stripThumbOn]}
                      source={{ uri: item.cardUrl ?? item.url }}
                      contentFit="cover"
                      transition={duration.fast}
                      /* 条里的缩略图会随翻页反复出现，落盘缓存省下重复请求 */
                      cachePolicy="memory-disk"
                    />
                  </Pressable>
                ))}
              </ScrollView>
            </View>
          ) : null}

          <View style={[styles.body, wide && styles.bodyWide]}>
            <View style={styles.mainCol}>
              {/* sm 档底部要给抽屉留出落脚的净空，否则收起的摘要行会一直盖住照片下缘 */}
              <View style={[styles.stageWrap, sm && styles.stageWrapSheet]} {...panResponder.panHandlers}>
                <View style={styles.stage}>
                  {/* key 挂在照片 id + 原图态上：换片或切换原图都重挂 ZoomableImage，
                      缩放与位移自然复位（看原图时不该沿用缩略图上的放大位置） */}
                  <ZoomableImage key={`${photo.id}:${original ? 'o' : 't'}`} photo={photo} original={original} />
                </View>
                {/* 左右箭头贴在照片区两侧中线：滑动之外再给一个明确的可点入口。
                    触屏没有 hover，Web「默认 opacity:0、悬停才显形」的分支在这里不成立，
                    因此窄屏与宽屏均常驻显示 */}
                <View style={styles.arrows} pointerEvents="box-none">
                  <IconButton name="arrowLeft" label="上一张" glass onPress={() => onStep(-1)} />
                  <IconButton name="arrowRight" label="下一张" glass onPress={() => onStep(1)} />
                </View>
              </View>

              {/* 说明条只在非 sm 档保留：手机档的标题与拍摄时间已经挪进底部抽屉的摘要行，
                  再挂一条就与抽屉重复了（且它会跟抽屉抢底部空间） */}
              {sm ? null : (
                <View style={styles.caption}>
                  <Glass corner="full" style={styles.captionBox}>
                    <Text style={styles.captionTitle} numberOfLines={1}>
                      {photo.title}
                    </Text>
                    <Text style={styles.captionMeta} numberOfLines={1}>
                      {photo.cat} · {formatDate(photo.date)}
                    </Text>
                  </Glass>
                </View>
              )}
            </View>

            {sm ? (
              <MetaSheet photo={photo} rows={rows} open={metaOpen} onOpenChange={setMetaOpen} />
            ) : (
              <Inspector
                photo={photo}
                rows={rows}
                open={metaOpen}
                onToggle={() => setMetaOpen((prev) => !prev)}
                side={wide}
              />
            )}
          </View>
        </Animated.View>

        {/* 单张编辑对话框（仅 admin）。
            挂在缩放层之外：它是独立的 Modal，写入被缩放的子树里没有意义 */}
        {editing ? (
          <EditDialog photo={photo} onClose={() => setEditing(false)} onChanged={onPhotosChanged} />
        ) : null}
      </Animated.View>
    </Modal>
  );
}

/* -------------------------------------------------------------------------- */

const styles = StyleSheet.create({
  /** 模态背板：接近不透明的材质色，压住底下的内容 */
  backdrop: {
    flex: 1,
    backgroundColor: colors.material.opaque,
    paddingHorizontal: space.s16,
  },

  topBar: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  topActions: { flexDirection: 'row', alignItems: 'center', gap: space.s4 },

  /* 点位缩略图条：一颗胶囊里横向排开，不抢照片的纵向空间（高度 = 小图 + 一行间距） */
  stripWrap: { paddingTop: space.s8 },
  strip: { gap: space.s6, paddingHorizontal: space.s16, alignItems: 'center' },
  stripPressed: { opacity: 0.72 },
  stripThumb: {
    width: STRIP_SIZE,
    height: STRIP_SIZE,
    borderRadius: radius.sm,
    backgroundColor: colors.material.thin,
  },
  /** 当前这张：accent 一圈描边（与缩略图条其余项区分），不换尺寸以免整条跳动 */
  stripThumbOn: { borderWidth: 1, borderColor: colors.accent },

  /** 被缩放的内容壳：顶栏 + 主体一起长出来 */
  shell: { flex: 1 },
  /** 主体：窄屏是「舞台 + 说明 + EXIF 抽屉」的竖排，宽屏换成「左舞台 / 右 EXIF 栏」 */
  body: { flex: 1 },
  bodyWide: { flexDirection: 'row' },
  mainCol: { flex: 1 },

  stageWrap: { flex: 1, justifyContent: 'center', marginVertical: space.s12 },
  /** sm 档：底部让出收起态摘要行的高度，照片下缘不会被抽屉长期压住 */
  stageWrapSheet: { marginBottom: space.s40 },
  /** 舞台：照片直角显示（无圆角），并裁掉放大后溢出的部分，免得压到顶栏与 EXIF 栏 */
  stage: { flex: 1, overflow: 'hidden', justifyContent: 'center' },
  arrows: {
    ...StyleSheet.absoluteFillObject,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },

  caption: { alignItems: 'center', marginBottom: space.s8 },
  captionBox: { paddingHorizontal: space.s16, paddingVertical: space.s8, alignItems: 'center' },
  captionTitle: { ...text.label, fontWeight: '600' },
  captionMeta: { ...text.meta, marginTop: space.s2, ...tabularNums },

  inspector: { paddingBottom: space.s4 },
  /* 侧栏形态：定宽 + 吃满高度（父级 row 的 alignItems 默认 stretch）。
     左侧留一格间隙，让玻璃栏与照片之间有呼吸，不至于看成同一块面 */
  inspectorSide: { width: EXIF_SIDE_WIDTH, marginLeft: space.s12 },
  inspectorHead: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: space.s16,
    paddingVertical: space.s12,
  },
  inspectorTitle: { flexDirection: 'row', alignItems: 'center', gap: space.s8 },
  inspectorHeadText: { ...text.label, color: colors.text.secondary },
  chevUp: { transform: [{ rotate: '180deg' }] },

  exifScroll: { maxHeight: EXIF_MAX_HEIGHT },
  /** 侧栏档：吃满整栏剩余高度，超出自己滚 */
  exifScrollSide: { flex: 1 },
  exifBody: {
    paddingHorizontal: space.s16,
    paddingBottom: space.s12,
    borderTopWidth: 1,
    borderTopColor: colors.border.base,
    paddingTop: space.s8,
  },
  /* 描述块：与下面的 EXIF 行共用同一条左边距，整段排版（换行原样保留）。
     它自己不再限高 —— 长文由外层容器滚动吸收（抽屉 220dp / 侧栏整栏 / 手机档半屏），
     因此描述再长也不会把照片挤出可视区。 */
  descBlock: { paddingTop: space.s4, paddingBottom: space.s8 },
  descLabel: { ...text.meta, color: colors.text.tertiary, marginBottom: space.s4 },
  descText: { ...text.caption, color: colors.text.secondary },
  exifRow: { flexDirection: 'row', alignItems: 'center', paddingVertical: space.s6 },
  exifKey: { ...text.meta, width: 76 },
  /* EXIF 值是数值类信息，与标签不是一类：走等宽族 + 等宽数字，
     与 Web 的 .exif-row__v 同一处口径，逐位比对时不会因字宽跳动而错行 */
  exifValue: { ...text.caption, flex: 1, textAlign: 'right', fontFamily: fontFamily.mono, ...tabularNums },

  /* sm 档的底部抽屉：绝对定位钉在主体下缘，因此照片占满整块、抽屉浮在它上面；
     `bottom: 0` 只吃掉收起态一行的高度，展开时才向上长到半屏（限高由 SHEET_MAX_HEIGHT_RATIO 给） */
  sheet: { position: 'absolute', left: 0, right: 0, bottom: 0 },
  sheetHead: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: space.s12,
    paddingHorizontal: space.s16,
    paddingVertical: space.s12,
  },
  /** 摘要行的标题占主位、拍摄时间靠右收尾（两段都可能被截断，故都允许省略） */
  sheetTitle: { ...text.label, fontWeight: '600', flexShrink: 1 },
  sheetRight: { flexDirection: 'row', alignItems: 'center', gap: space.s8, flexShrink: 1 },
  sheetMeta: { ...text.meta, ...tabularNums, color: colors.text.secondary },
  /* 展开后的元数据自己滚：这里不给 maxHeight，高度上限已由外层 Glass 的 maxHeight 限制 */
  sheetScroll: { flexGrow: 0 },
});