/**
 * apps/mobile/src/components/MapBottomSheet.tsx
 *
 * 地图画廊的信息面板 —— 触屏没有「标记旁边浮一块卡片」的空间（手指本身就盖住了标记），
 * 因此与 Web 的 L.popup 走相反的两条路：内容从底部升起来，地图仍在上面保持可见。
 *
 * 【为什么谷底是同一个 Sheet，而不是「单张 Sheet + 多张 Sheet」】
 * 点针脚得到单张、点计数点得到同机位的一组，两者展示的是同一件事的不同深度：
 * 「这处有什么」。共用一个容器，从簇里挑一张时只是内容换了一格，不会感觉打开了第二个界面。
 *
 * 【进出场为什么等 onLayout】抽屉的高度由内容决定（单张有 4~5 行、簇是一条缩略图带），
 * 写死一个高度值就等于写死一个上限。先量到真实高度再动画，滑动距离因此永远刚好。
 */
import { useEffect, useRef, useState } from 'react';
import { Animated, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Image } from 'expo-image';
import { formatLatLon } from '@shaping-memory/core';
import type { Photo, PhotoCluster } from '@shaping-memory/core';

import { Glass, IconButton } from './primitives';
import { duration, easing } from '../layout/motion';
import { colors, fontFamily, radius, space, tabularNums, text } from '../theme';

/** 横条里的小缩略图边长 */
const MINI_SIZE = 64;
/** 条里最多铺几张：再多只报数，横条过长会把抽屉顶得比屏幕还高 */
const MINI_MAX = 12;
/** 单张照片的主图高度 */
const HERO_HEIGHT = 168;

/** 一行「标签 + 值」；值为空时整行不落，免得被一串「—」撑大 */
function Row({ label, value }: { label: string; value?: string }) {
  if (!value) return null;
  return (
    <View style={styles.row}>
      <Text style={styles.rowKey}>{label}</Text>
      <Text style={styles.rowValue} numberOfLines={2}>
        {value}
      </Text>
    </View>
  );
}

/**
 * 单张照片：主图 + 基本拍摄信息（与 Web 的 .map-card 同一份字段与顺序）。
 * **主图是整张卡片的主入口** —— 点它进本端的放大器（与 Web「点卡片里的缩略图才进放大器」同一套：
 * 标记只负责把卡片叫出来，卡片是那段停顿，主图是那段停顿的出口）。
 */
function PhotoDetail({ photo, onOpen }: { photo: Photo; onOpen: (photo: Photo) => void }) {
  const isoText = photo.iso ? `ISO ${photo.iso}` : '';
  const gear = [photo.cam, photo.lens].filter(Boolean).join(' · ');
  const exposure = [photo.focal, photo.aperture, photo.speed, isoText].filter(Boolean).join(' · ');
  return (
    <>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`查看 ${photo.title} 大图`}
        onPress={() => onOpen(photo)}
        /* 左右内缩挂在按钮上而不是图片上：命中区因此与看得见的图完全重合，
           手指点在图旁边的留白上不会误开放大器 */
        style={({ pressed }) => [styles.heroBtn, pressed && styles.pressed]}
      >
        <Image
          style={styles.hero}
          source={{ uri: photo.cardUrl ?? photo.url }}
          contentFit="cover"
          transition={duration.base}
          /* 卡面档缩略图是公开资源，落盘缓存：下次点开同一处不再走网络 */
          cachePolicy="memory-disk"
        />
      </Pressable>
      {/* 触屏没有 hover，靠这一行明确说明「图可点击」（与 Web 的 .map-card__hint 同一句） */}
      <Text style={styles.hint}>点击图片查看大图</Text>
      <View style={styles.rows}>
        <Row label="器材" value={gear} />
        <Row label="曝光" value={exposure} />
        <Row label="拍摄" value={photo.date} />
        <Row label="地点" value={photo.place} />
        <Row label="坐标" value={photo.gps ? formatLatLon(photo.gps.lat, photo.gps.lon, 5) : ''} />
      </View>
    </>
  );
}

/** 同一机位多张：横向缩略图条，点某张就把它提到上面来 */
function ClusterDetail({
  cluster,
  onPick,
}: {
  cluster: PhotoCluster;
  onPick: (photo: Photo) => void;
}) {
  const shown = cluster.photos.slice(0, MINI_MAX);
  return (
    <>
      <View style={styles.rows}>
        <Row label="坐标" value={formatLatLon(cluster.lat, cluster.lon, 5)} />
      </View>
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.strip}
        /* 横条自己滚，不把抽屉外的手势抢走 */
        nestedScrollEnabled
      >
        {shown.map((photo) => (
          <Pressable
            key={photo.id}
            accessibilityRole="button"
            accessibilityLabel={photo.title}
            onPress={() => onPick(photo)}
            style={({ pressed }) => [pressed && styles.pressed]}
          >
            <Image
              style={styles.mini}
              source={{ uri: photo.cardUrl ?? photo.url }}
              contentFit="cover"
              transition={duration.fast}
              cachePolicy="memory-disk"
            />
          </Pressable>
        ))}
      </ScrollView>
      {cluster.photos.length > shown.length ? (
        <Text style={styles.more}>还有 {cluster.photos.length - shown.length} 张</Text>
      ) : null}
    </>
  );
}

interface MapBottomSheetProps {
  /** 当前展示的单张照片；与 cluster 二者必有其一 */
  photo: Photo | null;
  /** 同一机位的一组；点针脚时为 null */
  cluster: PhotoCluster | null;
  /** 从横条里挑了一张 */
  onPick: (photo: Photo) => void;
  /** 点主图 → 进放大器（列表由宿主决定：恒为这个点位的照片） */
  onOpen: (photo: Photo) => void;
  onClose: () => void;
}

export function MapBottomSheet({ photo, cluster, onPick, onOpen, onClose }: MapBottomSheetProps) {
  const insets = useSafeAreaInsets();
  /** 量到的抽屉高度：升起动画的起点，未量到之前整体透明，不会闪一帧 */
  const [sheetHeight, setSheetHeight] = useState(0);
  const progress = useRef(new Animated.Value(0)).current;

  /* 内容的身份：从簇里挑一张、或在两个标记之间切换，都算换了一份内容，重跑一次升起 */
  const identity = photo?.id ?? cluster?.key ?? '';

  useEffect(() => {
    if (sheetHeight === 0) return;
    progress.setValue(0);
    Animated.timing(progress, {
      toValue: 1,
      duration: duration.base,
      easing: easing.smooth,
      useNativeDriver: true,
    }).start();
  }, [identity, sheetHeight, progress]);

  if (!photo && !cluster) return null;

  const translateY = progress.interpolate({ inputRange: [0, 1], outputRange: [sheetHeight, 0] });

  return (
    <Animated.View
      style={[
        styles.sheet,
        { paddingBottom: insets.bottom + space.s12, transform: [{ translateY }], opacity: progress },
      ]}
      onLayout={(event) => setSheetHeight(Math.round(event.nativeEvent.layout.height))}
    >
      <Glass corner="xl">
        <View style={styles.head}>
          <Text style={styles.title} numberOfLines={1}>
            {photo ? photo.title : `该点 ${cluster?.photos.length ?? 0} 张`}
          </Text>
          <IconButton name="close" label="关闭信息面板" size="compact" onPress={onClose} />
        </View>
        {photo ? <PhotoDetail photo={photo} onOpen={onOpen} /> : null}
        {!photo && cluster ? <ClusterDetail cluster={cluster} onPick={onPick} /> : null}
      </Glass>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  /* 绝对定位钉在模块下缘：地图因此始终占满整块，抽屉浮在它上面。
     左右各留一格，让玻璃面与屏幕边缘之间有呼吸，不至于看成贴边的黑条。 */
  sheet: { position: 'absolute', left: space.s8, right: space.s8, bottom: space.s8 },
  pressed: { opacity: 0.72 },

  head: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: space.s8,
    paddingHorizontal: space.s16,
    paddingTop: space.s12,
    paddingBottom: space.s8,
  },
  title: { ...text.label, fontWeight: '600', flexShrink: 1 },

  heroBtn: { marginHorizontal: space.s16 },
  hero: { height: HERO_HEIGHT, borderRadius: radius.lg, backgroundColor: colors.material.thin },
  hint: { ...text.caption, color: colors.text.quaternary, paddingHorizontal: space.s16, paddingTop: space.s6 },

  rows: { paddingHorizontal: space.s16, paddingTop: space.s8, paddingBottom: space.s4 },
  row: { flexDirection: 'row', alignItems: 'center', paddingVertical: space.s6 },
  rowKey: { ...text.meta, width: 64 },
  /* EXIF 值是数值类信息：走等宽族 + 等宽数字，与查看器的 .exifValue 同一处口径 */
  rowValue: { ...text.caption, flex: 1, textAlign: 'right', fontFamily: fontFamily.mono, ...tabularNums },

  strip: { gap: space.s8, paddingHorizontal: space.s16, paddingTop: space.s4 },
  mini: {
    width: MINI_SIZE,
    height: MINI_SIZE,
    borderRadius: radius.md,
    backgroundColor: colors.material.thin,
  },
  more: { ...text.meta, color: colors.text.quaternary, paddingHorizontal: space.s16, paddingTop: space.s8 },
});
