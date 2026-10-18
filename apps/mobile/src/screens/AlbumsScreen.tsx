/**
 * apps/mobile/src/screens/AlbumsScreen.tsx
 *
 * 影集模块：相册与分组都由后端动态提供（GET /albums、GET /album-groups），与 Web 端同源。
 *
 * 【布局】顶部一条分组导航（「全部」+ 各分组），下方按分组聚合出区块，每个区块标题是分组名、
 * 内容是该组相册卡片；点导航上的某个分组即只保留那一段。
 * 【分组顺序】完全按后端 sortOrder 铺，前台不提供排序切换 —— 后台怎么排、这里就怎么显示。
 * 【管理】管理员可在本页新建 / 重命名 / 删除分组，以及把相册移到别的分组：
 * 分组标题右侧给改名与删除，相册卡片在管理态下点按即选目标分组。接线走 SDK 的
 * albumGroupApi / albumApi.assignGroup，服务端按角色校验，前端只负责收集意图。
 * 【点开某一册】把画廊切到该相册（App 里的 filters.albumId），因此不额外造详情页。
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Alert, Pressable, ScrollView, Share, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Image } from 'expo-image';
import { albumApi, albumGroupApi, shareAlbumUrl } from '@shaping-memory/sdk';
import type { Album, AlbumGroup } from '@shaping-memory/sdk';
import { placeholderColors } from '@shaping-memory/core';

import { Chip, Icon, IconButton } from '../components/primitives';
import { OptionSheet } from '../components/OptionSheet';
import { PromptDialog } from '../components/PromptDialog';
import { useBreakpoint } from '../layout/useBreakpoint';
import { colors, radius, size, space, text } from '../theme';

/** 导航条上的「全部」伪分组：用固定 key 表示，与真实分组区分开（与 Web 同口径） */
const ALL = 'all';

/** 当前打开中的弹层：对话框与选项弹层共用一份状态，避免多个布尔量互相打架 */
type Pending =
  | null
  | { kind: 'create' }
  | { kind: 'rename'; group: AlbumGroup }
  | { kind: 'move'; album: Album }
  | { kind: 'deleteGroup'; group: AlbumGroup };

/**
 * 按列数切行。
 * 【为什么不用 flexWrap + 百分比宽】加 gap 之后百分比宽会算出小数误差，
 * 末行的卡片也会被撑宽；按行切块再让每张 flex:1，列宽与间距都恒等。
 */
function chunkRows<T>(items: readonly T[], size: number): T[][] {
  const rows: T[][] = [];
  for (let index = 0; index < items.length; index += size) rows.push(items.slice(index, index + size));
  return rows;
}

/** 影集卡片：封面（含底色保底）+ 张数角标 + 标题描述；管理态下改为「调整归属」入口 */
function AlbumCard({
  album,
  managing,
  onPress,
  onShare,
}: {
  album: Album;
  managing: boolean;
  onPress: (album: Album) => void;
  onShare: (album: Album) => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={managing ? `调整《${album.title}》所属分组` : `打开影集《${album.title}》，共 ${album.count} 张`}
      onPress={() => onPress(album)}
      style={({ pressed }) => [styles.card, pressed && styles.pressed]}
    >
      <View style={styles.cover}>
        {album.coverUrl ? (
          <>
            {/* 底片色保底：网络图较慢时卡片不会呈现为整块纯灰 */}
            <View style={[StyleSheet.absoluteFill, { backgroundColor: placeholderColors(album)[0] }]} />
            <Image
              source={{ uri: album.coverUrl }}
              style={StyleSheet.absoluteFill}
              contentFit="cover"
              transition={400}
              /* 相册封面是公开缩略图：落盘缓存，来回切页不重复下载 */
              cachePolicy="memory-disk"
            />
          </>
        ) : null}
        {/* 压暗层：让右下角计数在任何照片上都读得清 */}
        <View style={styles.shade} />
        <Text style={styles.count}>{album.count} 张</Text>
      </View>

      <View style={styles.body}>
        <View style={styles.bodyMain}>
          <Text style={styles.name} numberOfLines={1}>
            {album.title}
          </Text>
          <Text style={styles.desc} numberOfLines={1}>
            {album.description ?? '—'}
          </Text>
        </View>
        {/* 管理态下卡片整体已是「调整归属」入口，这里只留状态提示，不再叠分享 */}
        {managing ? (
          <Text style={styles.cardAction}>移到…</Text>
        ) : album.isPublic ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`分享《${album.title}》`}
            onPress={() => onShare(album)}
            hitSlop={8}
            style={({ pressed }) => [styles.share, pressed && styles.pressed]}
          >
            <Icon name="share" size={size.icon.compact} color={colors.text.secondary} />
            <Text style={styles.shareText}>分享</Text>
          </Pressable>
        ) : null}
      </View>
    </Pressable>
  );
}

interface AlbumsScreenProps {
  /** 点开某一册：带着 albumId 回到画廊，只展示该册照片 */
  onOpenAlbum: (albumId: string) => void;
  /** 是否具备分组管理权限（前台管理员）；无权限时管理入口只给提示，不发请求 */
  admin: boolean;
}

export function AlbumsScreen({ onOpenAlbum, admin }: AlbumsScreenProps) {
  const [albums, setAlbums] = useState<readonly Album[]>([]);
  const [groups, setGroups] = useState<readonly AlbumGroup[]>([]);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  /* 底部安全区（手势条）高度：内容延伸到手势柄之下（见 App.tsx），
     列表底 padding 补上手势区高度，滚到底时末行不被手势柄压住 */
  const insets = useSafeAreaInsets();
  /* 影集卡片与图墙同档：窄屏 2 列、宽屏随断点铺开 */
  const { wallColumns: columns } = useBreakpoint();

  /** 当前选中的分组：ALL = 全部 */
  const [active, setActive] = useState<string>(ALL);
  /** 管理态：为真时卡片点按改为调整归属，分组标题右侧出现改名与删除 */
  const [managing, setManaging] = useState(false);
  const [pending, setPending] = useState<Pending>(null);
  /** 写操作进行中：弹层的按钮与输入一并禁用 */
  const [busy, setBusy] = useState(false);
  /** 弹层内的失败原因（服务端文案优先，如「分组名已存在」） */
  const [error, setError] = useState<string | null>(null);
  /** 重拉计数：任何写操作成功后自增一次，相册与分组一起回到最新 */
  const [reloadTick, setReloadTick] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    // 相册与分组一起拉：缺了分组就没法把相册归位
    Promise.all([albumApi.list(), albumGroupApi.list()])
      .then(([albumList, groupList]) => {
        if (cancelled) return;
        setAlbums(albumList);
        setGroups(groupList);
        setFailed(false);
        setLoading(false);
      })
      .catch(() => {
        if (cancelled) return;
        setAlbums([]);
        setGroups([]);
        setFailed(true);
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [reloadTick]);

  /** 默认分组 id：历史数据里 groupId 为空的册都归到它名下，前台不会漏显示 */
  const defaultGroupId = useMemo(() => groups.find((group) => group.builtin)?.id ?? '', [groups]);

  /** 分组 → 该组相册；顺序即后端 sortOrder，不做二次排序 */
  const sections = useMemo(
    () =>
      groups.map((group) => ({
        ...group,
        albums: albums.filter((album) => (album.groupId ?? defaultGroupId) === group.id),
      })),
    [groups, albums, defaultGroupId],
  );

  /** 实际渲染的区块：「全部」时略去空分组（避免整页都是空标题），选中某组时只看那一组 */
  const visible = useMemo(
    () => (active === ALL ? sections.filter((section) => section.albums.length > 0) : sections.filter((section) => section.id === active)),
    [sections, active],
  );

  /** 写操作共用一条提交路径：统一记 busy / error，成功关层并重拉，失败保留弹层供用户修改 */
  const submit = useCallback(async (action: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await action();
      setPending(null);
      setReloadTick((tick) => tick + 1);
    } catch (err) {
      setError(err instanceof Error ? err.message : '操作失败，请稍后重试');
    } finally {
      setBusy(false);
    }
  }, []);

  const close = useCallback(() => {
    setPending(null);
    setError(null);
  }, []);

  const handleManageToggle = useCallback(() => {
    if (admin) {
      setManaging((prev) => !prev);
      return;
    }
    Alert.alert('需要管理员账号', '请先在右上角的账号入口登录管理员账号，再管理相册分组。');
  }, [admin]);

  /** 相册卡片的点按：常规态进相册，管理态改为选目标分组 */
  const handleAlbumPress = useCallback(
    (album: Album) => (managing ? setPending({ kind: 'move', album }) : onOpenAlbum(album.id)),
    [managing, onOpenAlbum],
  );

  /** 分享公开相册：交给系统分享面板，用户可直接发送或复制链接（与 Web 的公开相册链接同源） */
  const handleShare = useCallback((album: Album) => {
    void Share.share({ message: `${album.title} ${shareAlbumUrl(album.id)}` });
  }, []);

  /** 删除分组时的候选去处：除自身以外的所有分组（默认分组永远在列，保证一定有落点） */
  const deleteTargets = useMemo(() => {
    const group = pending?.kind === 'deleteGroup' ? pending.group : null;
    if (!group) return [];
    return sections.filter((section) => section.id !== group.id).map((section) => ({ key: section.id, label: section.name, meta: `${section.albums.length} 册` }));
  }, [pending, sections]);

  /** 移动相册的候选分组：把当前所在项排在最前并标注，便于确认「已经在哪」 */
  const moveTargets = useMemo(() => {
    const album = pending?.kind === 'move' ? pending.album : null;
    if (!album) return [];
    const current = album.groupId ?? defaultGroupId;
    return sections.map((section) => ({
      key: section.id,
      label: section.name,
      meta: section.id === current ? '当前所在' : `${section.albums.length} 册`,
    }));
  }, [pending, sections, defaultGroupId]);

  return (
    <View style={styles.screen}>
      <View style={styles.head}>
        <View style={styles.headMain}>
          <Text style={styles.title}>影集</Text>
          <Text style={styles.sub}>按分组归集的影集，点开即进入该册的照片</Text>
        </View>
        <IconButton
          name="edit"
          label={managing ? '退出分组管理' : '分组管理'}
          active={managing}
          onPress={handleManageToggle}
        />
      </View>

      {loading ? (
        <Text style={styles.empty}>加载中…</Text>
      ) : failed ? (
        <Text style={styles.empty}>影集加载失败，请稍后重试</Text>
      ) : albums.length === 0 && groups.length === 0 ? (
        <Text style={styles.empty}>暂无影集</Text>
      ) : (
        <>
          {/* 分组导航：窄屏可横向滑动，不换行挤压标题（与 Web 的 .album-nav 同构） */}
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.nav}>
            <Chip label={`全部 ${albums.length}`} active={active === ALL} onPress={() => setActive(ALL)} />
            {sections.map((section) => (
              <Chip key={section.id} label={`${section.name} ${section.albums.length}`} active={active === section.id} onPress={() => setActive(section.id)} />
            ))}
          </ScrollView>

          {managing ? (
            <View style={styles.manageBar}>
              <Text style={styles.manageHint}>分组管理中：点相册卡片可调整所属分组</Text>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="新建分组"
                onPress={() => setPending({ kind: 'create' })}
                style={({ pressed }) => [styles.newGroup, pressed && styles.pressed]}
              >
                <Icon name="plus" size={size.icon.compact} color={colors.background} />
                <Text style={styles.newGroupText}>新建分组</Text>
              </Pressable>
            </View>
          ) : null}

          <ScrollView contentContainerStyle={[styles.list, { paddingBottom: space.s40 + insets.bottom }]} showsVerticalScrollIndicator={false}>
            {visible.length === 0 ? (
              <Text style={styles.empty}>该分组下暂无影集</Text>
            ) : (
              visible.map((section) => (
                <View key={section.id} style={styles.section}>
                  <View style={styles.sectionHead}>
                    <Text style={styles.sectionTitle} numberOfLines={1}>
                      {section.name}
                      <Text style={styles.sectionCount}>　{section.albums.length} 册</Text>
                    </Text>
                    {/* 内置分组（默认分组）不可改名也不可删除，后端同样会拒绝 */}
                    {managing && !section.builtin ? (
                      <View style={styles.sectionActions}>
                        <IconButton name="edit" label={`重命名分组 ${section.name}`} size="compact" onPress={() => setPending({ kind: 'rename', group: section })} />
                        {/* 只剩一个分组时没有可接收的去处，直接不给删除入口 */}
                        {groups.length > 1 ? (
                          <IconButton
                            name="trash"
                            label={`删除分组 ${section.name}`}
                            size="compact"
                            onPress={() => setPending({ kind: 'deleteGroup', group: section })}
                          />
                        ) : null}
                      </View>
                    ) : null}
                  </View>

                  {/* 末行用等宽占位补齐，卡片宽度与间距才不会随张数变化 */}
                  {chunkRows(section.albums, columns).map((row, rowIndex) => (
                    <View key={rowIndex} style={styles.row}>
                      {row.map((album) => (
                        <AlbumCard key={album.id} album={album} managing={managing} onPress={handleAlbumPress} onShare={handleShare} />
                      ))}
                      {row.length < columns
                        ? Array.from({ length: columns - row.length }, (_, gapIndex) => <View key={`gap-${gapIndex}`} style={styles.gap} />)
                        : null}
                    </View>
                  ))}
                </View>
              ))
            )}
          </ScrollView>
        </>
      )}

      {/* 新建 / 重命名共用同一个输入弹窗：换对象靠 key 重挂载，初值因此在挂载时取一次即可 */}
      {pending && (pending.kind === 'create' || pending.kind === 'rename') ? (
        <PromptDialog
          key={pending.kind === 'rename' ? `rename-${pending.group.id}` : 'create'}
          title={pending.kind === 'create' ? '新建分组' : '重命名分组'}
          placeholder="分组名称"
          initialValue={pending.kind === 'rename' ? pending.group.name : ''}
          busy={busy}
          error={error}
          onCancel={close}
          onSubmit={(value) =>
            void submit(() => (pending.kind === 'create' ? albumGroupApi.create(value) : albumGroupApi.update(pending.group.id, { name: value })))
          }
        />
      ) : null}

      {pending?.kind === 'move' ? (
        <OptionSheet
          title={`移动《${pending.album.title}》`}
          hint="选择目标分组后，这本影集即刻改归该组"
          options={moveTargets}
          busy={busy}
          onCancel={close}
          onSelect={(groupId) => void submit(() => albumApi.assignGroup([pending.album.id], groupId))}
        />
      ) : null}

      {pending?.kind === 'deleteGroup' ? (
        <OptionSheet
          title={`删除分组「${pending.group.name}」`}
          hint={`组内 ${pending.group.count} 册影集将移动到所选分组，影集本身不会被删除`}
          options={deleteTargets}
          busy={busy}
          onCancel={close}
          onSelect={(moveTo) =>
            void submit(async () => {
              await albumGroupApi.remove(pending.group.id, moveTo);
              // 当前正看着被删掉的那一组时回到「全部」，否则会停在空区块上
              setActive((prev) => (prev === pending.group.id ? ALL : prev));
            })
          }
        />
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  head: { flexDirection: 'row', alignItems: 'flex-start', gap: space.s8, paddingHorizontal: space.s16, paddingBottom: space.s12 },
  headMain: { flex: 1, gap: space.s4 },
  title: { ...text.title },
  sub: { ...text.meta },
  empty: { ...text.body, color: colors.text.tertiary, textAlign: 'center', marginTop: space.s40 },

  nav: { gap: space.s8, paddingHorizontal: space.s16, paddingBottom: space.s8 },
  manageBar: { flexDirection: 'row', alignItems: 'center', gap: space.s12, paddingHorizontal: space.s16, paddingBottom: space.s8 },
  manageHint: { ...text.meta, flex: 1 },
  newGroup: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.s4,
    paddingHorizontal: space.s12,
    height: space.s32,
    borderRadius: radius.full,
    backgroundColor: colors.accent,
  },
  newGroupText: { ...text.caption, color: colors.background, fontWeight: '600' },

  list: { paddingHorizontal: space.s16, paddingBottom: space.s40 },
  section: { marginTop: space.s12 },
  sectionHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: space.s8 },
  sectionTitle: { ...text.label, fontWeight: '600', flexShrink: 1 },
  sectionCount: { ...text.meta, fontWeight: '400' },
  sectionActions: { flexDirection: 'row', gap: space.s4 },

  row: { flexDirection: 'row', gap: space.s12 },
  gap: { flex: 1 },
  card: { flex: 1, marginTop: space.s12, borderRadius: radius.xl, overflow: 'hidden' },
  pressed: { opacity: 0.78 },

  cover: { aspectRatio: 16 / 10, borderRadius: radius.xl, overflow: 'hidden' },
  shade: { ...StyleSheet.absoluteFillObject, backgroundColor: colors.material.thin },
  count: {
    ...text.meta,
    position: 'absolute',
    right: space.s8,
    bottom: space.s8,
    color: colors.text.base,
    fontWeight: '600',
  },

  body: { flexDirection: 'row', alignItems: 'center', gap: space.s8, paddingTop: space.s8 },
  bodyMain: { flex: 1, gap: space.s2 },
  name: { ...text.label, fontWeight: '600' },
  desc: { ...text.meta },
  cardAction: { ...text.meta, color: colors.accent },
  share: { flexDirection: 'row', alignItems: 'center', gap: space.s2, paddingVertical: space.s4 },
  shareText: { ...text.meta, color: colors.text.secondary },
});