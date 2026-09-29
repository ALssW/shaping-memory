/**
 * apps/mobile/src/screens/AlbumsScreen.tsx
 *
 * 影集模块：相册已由后端动态提供（albumApi.list），与 Web 端同源。
 * 点开某一册 = 把画廊切到该相册（App 里的 filters.albumId），因此不额外造详情页。
 */
import { useEffect, useState } from 'react';
import { FlatList, Pressable, StyleSheet, Text, View } from 'react-native';
import { Image } from 'expo-image';
import { albumApi } from '@shaping-memory/sdk';
import type { Album } from '@shaping-memory/sdk';
import { placeholderColors } from '@shaping-memory/core';

import { useBreakpoint } from '../layout/useBreakpoint';
import { colors, radius, space, text } from '../theme';

/** 影集卡片：封面（含底色保底）+ 张数角标 + 标题描述 */
function AlbumCard({ album, onOpen }: { album: Album; onOpen: (id: string) => void }) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`打开影集《${album.title}》，共 ${album.count} 张`}
      onPress={() => onOpen(album.id)}
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
        <Text style={styles.name} numberOfLines={1}>
          {album.title}
        </Text>
        <Text style={styles.desc} numberOfLines={1}>
          {album.description ?? '—'}
        </Text>
      </View>
    </Pressable>
  );
}

interface AlbumsScreenProps {
  /** 点开某一册：带着 albumId 回到画廊，只展示该册照片 */
  onOpenAlbum: (albumId: string) => void;
}

export function AlbumsScreen({ onOpenAlbum }: AlbumsScreenProps) {
  const [albums, setAlbums] = useState<readonly Album[]>([]);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  /* 影集卡片与图墙同档：窄屏 2 列、宽屏随断点铺开 */
  const { wallColumns: columns } = useBreakpoint();

  useEffect(() => {
    let cancelled = false;
    albumApi
      .list()
      .then((list) => {
        if (cancelled) return;
        setAlbums(list);
        setLoading(false);
      })
      .catch(() => {
        if (cancelled) return;
        setAlbums([]);
        setFailed(true);
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <View style={styles.screen}>
      <View style={styles.head}>
        <Text style={styles.title}>影集</Text>
        <Text style={styles.sub}>按题材归集的影集，点开即进入该册的照片</Text>
      </View>

      {loading ? (
        <Text style={styles.empty}>加载中…</Text>
      ) : failed ? (
        <Text style={styles.empty}>影集加载失败，请稍后重试</Text>
      ) : albums.length === 0 ? (
        <Text style={styles.empty}>暂无影集</Text>
      ) : (
        <FlatList
          /* numColumns 变化必须换 key 强制重挂载（FlatList 不支持运行时改列数，
             key 不变会直接报错或沿用旧布局）。影集卡片数量少，重建的代价可以忽略。 */
          key={`albums-${columns}`}
          data={albums}
          keyExtractor={(album) => album.id}
          numColumns={columns}
          // 多列时左右各一个间距；columnWrapperStyle 必须给，否则 numColumns 不生效
          columnWrapperStyle={styles.row}
          contentContainerStyle={styles.list}
          showsVerticalScrollIndicator={false}
          renderItem={({ item }) => <AlbumCard album={item} onOpen={onOpenAlbum} />}
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  head: { paddingHorizontal: space.s16, paddingBottom: space.s12, gap: space.s4 },
  title: { ...text.title },
  sub: { ...text.meta },
  empty: { ...text.body, color: colors.text.tertiary, textAlign: 'center', marginTop: space.s40 },

  list: { paddingHorizontal: space.s16, paddingBottom: space.s40 },
  row: { gap: space.s12 },
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

  body: { paddingTop: space.s8, gap: space.s2 },
  name: { ...text.label, fontWeight: '600' },
  desc: { ...text.meta },
});