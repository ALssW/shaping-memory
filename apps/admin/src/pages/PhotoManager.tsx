/**
 * apps/admin/src/pages/PhotoManager.tsx
 *
 * 照片管理列表：多维检索 / 批量上传 / 多选批量改元数据与 EXIF / 单张编辑 / 隐私标记行内切换。
 *
 * 【分类选项从数据来、器材与曝光选项从字典来】分类是轻量、随片变化的运营数据，仍从拉回的列表里去重累积；
 * 机身 / 镜头 / 光圈 / 快门 / ISO 则是字典里的「候选清单」，走 searchApi.suggest 远程联想（见 DictionarySelect），
 * 既不必把上千条候选一次性拉进页面，也能随输入即时缩小范围。
 *
 * 【为什么关键词要走「提交」而不是逐字请求】六维筛选全在服务端执行，
 * 每次按键都查询数据库既没有意义，也无法匹配输入速度；回车 / 点击搜索才真正触发。
 * （字典联想下拉是例外：它是「候选」而非「查询」，防抖后即时请求才能跟上输入。）
 *
 * 【隐私列的可写性】列里显示的是服务端判定的**有效策略**（inherit 只代表「没有单张标记」），
 * 点击标签弹出的下拉才是写入入口：选中项直接 PATCH 到 media 的单张标记上。
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import type { Key, PointerEvent as ReactPointerEvent, TdHTMLAttributes, ThHTMLAttributes } from 'react';
import {
  App,
  Button,
  DatePicker,
  Dropdown,
  Image,
  Input,
  Popconfirm,
  Select,
  Space,
  Spin,
  Table,
  Tag,
  Tooltip,
} from 'antd';
import type { ColumnsType } from 'antd/es/table';
import type { Dayjs } from 'dayjs';
import type { DictionaryKind, Photo, PhotoTag } from '@shaping-memory/core';
import { photoApi, searchApi } from '@shaping-memory/sdk';

import { PhotoMetaModal } from '../components/PhotoMetaModal';
import { ExifDrawer } from '../components/ExifDrawer';
import { PhotoUploadModal } from '../components/PhotoUploadModal';
import { FolderUploadModal } from '../components/FolderUploadModal';
import { BatchMetaModal } from '../components/BatchMetaModal';
import { BatchExifDrawer } from '../components/BatchExifDrawer';
import { PRIVACY_MARK_COLOR, PRIVACY_MARK_LABEL, PRIVACY_MARK_OPTIONS } from '../lib/privacy-modes';
import type { PrivacyMark } from '../lib/privacy-modes';

type SortOrder = 'asc' | 'desc';

/** 筛选下拉里的「不限」占位值 */
const ANY = '全部';

/** 字典联想的防抖时长：逐字敲打只发最后一次请求 */
const SUGGEST_DEBOUNCE_MS = 250;
/** 一次联想拉回的候选条数 */
const SUGGEST_LIMIT = 20;

/** 定位筛选：三态，'all' 时不传该条件 */
type GpsFilter = 'all' | 'yes' | 'no';

const GPS_OPTIONS: { value: GpsFilter; label: string }[] = [
  { value: 'all', label: '不限定位' },
  { value: 'yes', label: '仅有定位' },
  { value: 'no', label: '仅无定位' },
];

/** 把候选值并进已有选项：去空、去重、排序。累积策略见文件头注释 */
function mergeOptions(prev: string[], next: readonly string[]): string[] {
  const merged = new Set(prev);
  for (const value of next) {
    if (value) merged.add(value);
  }
  return Array.from(merged).sort((a, b) => a.localeCompare(b));
}

/** 空值统一显示为破折号：表格里「没有这个参数」与「参数是空串」应保持一致 */
function orDash(value: string | number | null | undefined) {
  return value === '' || value == null ? <span className="t-qua">—</span> : <>{value}</>;
}

/** 标签格：把这张照片上的标签名平铺出来（空则显示破折号） */
function TagCell({ tags }: { tags: PhotoTag[] }) {
  if (tags.length === 0) return <span className="t-qua">—</span>;
  return (
    <Space size={4} wrap>
      {tags.map((tag) => (
        <Tag key={tag.name}>{tag.name}</Tag>
      ))}
    </Space>
  );
}

/* ==========================================================================
 * 列宽 / 列顺序自定义
 *
 * 【为什么不用 react-resizable】本页只需要「拖表头右缘调宽 + 拖表头换位」两件事，
 * 用原生 pointer 事件在自定义表头单元格里就能做完，不必为此引入新依赖。
 * 宽度与顺序存 localStorage：这是纯展示偏好，不该占用服务端设置项。
 * ========================================================================== */

/** 各列默认宽度：对象键序同时定义了表头的默认先后顺序（操作列固定在最后，不在此表内） */
const DEFAULT_COLUMN_WIDTHS: Record<string, number> = {
  url: 76,
  title: 220,
  cat: 90,
  date: 110,
  cam: 150,
  lens: 190,
  focal: 80,
  aperture: 80,
  speed: 90,
  iso: 70,
  gps: 170,
  tags: 140,
  likes: 70,
  privacy: 130,
};

/** 可拖拽列的白名单：只认已知列，避免旧存档中的未知键使表头多出多余的列 */
const COLUMN_KEYS = new Set(Object.keys(DEFAULT_COLUMN_WIDTHS));

/** 列宽上下限：过窄时表头难以点击，过宽时表格会超出视口 */
const MIN_COLUMN_WIDTH = 60;
const MAX_COLUMN_WIDTH = 480;

/** 列设置（宽度 + 顺序）的本地持久化键 */
const COLUMN_STORAGE_KEY = 'shaping-memory-admin.photo-columns';

/** 操作列宽度：固定列，不参与拖拽、也不持久化，保证破坏性操作永远在同一处 */
const ACTION_COLUMN_WIDTH = 210;

interface ColumnPrefs {
  order: string[];
  widths: Record<string, number>;
}

/** 将宽度限制在合法区间内：拖拽与读档都经过它，任何来源的数值都安全 */
function clampColumnWidth(width: number): number {
  return Math.min(MAX_COLUMN_WIDTH, Math.max(MIN_COLUMN_WIDTH, Math.round(width)));
}

/**
 * 读本地列设置。
 * 【为什么要过滤未知键】列定义会随版本增减，旧存档里的键可能已不存在，
 * 直接采用会渲染出未定义的列；顺序只保留白名单内的键，缺失的列按定义顺序补齐。
 * 存档损坏时静默回落默认值，不因一份损坏的 JSON 导致整页崩溃。
 */
function loadColumnPrefs(): ColumnPrefs {
  const fallback: ColumnPrefs = { order: [...COLUMN_KEYS], widths: { ...DEFAULT_COLUMN_WIDTHS } };
  try {
    const raw = localStorage.getItem(COLUMN_STORAGE_KEY);
    if (!raw) return fallback;
    const parsed = JSON.parse(raw) as Partial<ColumnPrefs>;
    const order = (parsed.order ?? []).filter((key) => COLUMN_KEYS.has(key));
    const widths: Record<string, number> = {};
    for (const key of COLUMN_KEYS) {
      const width = parsed.widths?.[key];
      if (typeof width === 'number' && Number.isFinite(width)) widths[key] = clampColumnWidth(width);
    }
    return { order: order.length > 0 ? order : fallback.order, widths: { ...fallback.widths, ...widths } };
  } catch {
    return fallback;
  }
}

/** 把 key 移到 target 的位置（拖拽换位用）；任一方不存在时原样返回 */
function moveColumn(order: string[], key: string, target: string): string[] {
  const from = order.indexOf(key);
  const to = order.indexOf(target);
  if (from < 0 || to < 0 || from === to) return order;
  const next = [...order];
  next.splice(from, 1);
  next.splice(to, 0, key);
  return next;
}

/** 表头单元格 props：在 antd 透传的基础上带两个 data-* 标记，供拖拽读写列 key / 宽度 */
interface HeaderCellProps extends TdHTMLAttributes<HTMLTableCellElement>, ThHTMLAttributes<HTMLTableCellElement> {
  'data-col-key'?: string;
  'data-col-width'?: number;
}

/** 列拖拽上下文：把父组件的拖拽回调透给自定义表头单元格，避免每个表头各自注册监听 */
interface ColumnDragApi {
  /** 该列是否允许拖拽（操作列 / 勾选列不在白名单内） */
  draggable: (key: string) => boolean;
  /** 正在拖拽的列 key，用于高亮 */
  activeKey: string | null;
  onResizeStart: (event: ReactPointerEvent, key: string, width: number) => void;
  onReorderStart: (event: ReactPointerEvent, key: string) => void;
}

const ColumnDragContext = createContext<ColumnDragApi | null>(null);

/** 自定义表头单元格：右缘一条把手负责调宽，其余区域按住可换位 */
function DraggableHeaderCell(props: HeaderCellProps) {
  const api = useContext(ColumnDragContext);
  const { children, ...rest } = props;
  const colKey = rest['data-col-key'] ?? '';
  const colWidth = Number(rest['data-col-width']) || 0;
  // 非白名单列（操作列 / 勾选列）原样渲染，不挂任何拖拽交互
  if (!api || !api.draggable(colKey)) return <th {...rest}>{children}</th>;

  return (
    <th
      {...rest}
      className={`${rest.className ?? ''} col-drag-cell`.trim()}
      data-dragging={api.activeKey === colKey}
    >
      <div className="col-drag-cell__label" onPointerDown={(event) => api.onReorderStart(event, colKey)}>
        {children}
      </div>
      <span
        className="col-drag-cell__handle"
        onPointerDown={(event) => {
          event.stopPropagation(); // 避免将「调宽」误判为「换位」
          api.onResizeStart(event, colKey, colWidth);
        }}
      />
    </th>
  );
}

/** 表头单元格的稳定引用：antd 用它判断是否要重挂表头，每次渲染新建会打断进行中的拖拽 */
const TABLE_COMPONENTS = { header: { cell: DraggableHeaderCell } };

/* ==========================================================================
 * 字典联想下拉
 *
 * 【为什么不用「从结果里累积候选」】机身/镜头/光圈/快门/ISO 都是运营数据，量级可能上千，
 * 一次性全量拉进页面既拖慢首屏，也无法获得「随输入缩小范围」的能力；
 * 因此改为按需向后端字典联想接口取候选（searchApi.suggest）。
 * 【为什么必须防抖 + 请求序号】防抖让逐字输入只发最后一次请求；
 * 序号则防止乱序 —— 较慢的旧响应返回时不得覆盖新输入的结果。
 * ========================================================================== */

/** 字典下拉的一枚选项：value 是落进查询条件的原值，label 是展示文案 */
interface DictionaryOption {
  value: string;
  label: string;
}

interface DictionarySelectProps {
  kind: DictionaryKind;
  value: string;
  onChange: (value: string) => void;
  /** 「不限」选项的文案，如「全部机身」 */
  allLabel: string;
  width: number;
}

/** 字典联想下拉：候选来自后端字典，首次展开即有内容，输入时防抖远程检索 */
function DictionarySelect({ kind, value, onChange, allLabel, width }: DictionarySelectProps) {
  const [options, setOptions] = useState<DictionaryOption[]>([]);
  const [searching, setSearching] = useState(false);
  const timerRef = useRef<number | null>(null);
  /** 请求序号：较慢的旧请求返回时不得覆盖新结果 */
  const seqRef = useRef(0);

  const runSuggest = useCallback(
    async (q: string): Promise<void> => {
      const seq = ++seqRef.current;
      setSearching(true);
      try {
        const list = await searchApi.suggest(kind, q, SUGGEST_LIMIT);
        if (seq !== seqRef.current) return; // 已有更新的请求发出，本次结果作废
        setOptions(list.map((entry) => ({ value: entry.value, label: entry.label ?? entry.value })));
      } catch {
        // 联想仅为辅助功能：失败时保留现有候选即可，不打断用户操作
      } finally {
        // 只有仍是最新请求时才收掉加载态，否则会提前关闭新请求的加载状态
        if (seq === seqRef.current) setSearching(false);
      }
    },
    [kind],
  );

  // 挂载（或 kind 变化）即预取一批候选：下拉首次展开时不为空
  useEffect(() => {
    void runSuggest('');
    return () => {
      if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    };
  }, [runSuggest]);

  /** 输入变化：防抖 250ms 后再发起请求 */
  const handleSearch = useCallback(
    (q: string): void => {
      if (timerRef.current !== null) window.clearTimeout(timerRef.current);
      timerRef.current = window.setTimeout(() => {
        timerRef.current = null;
        void runSuggest(q);
      }, SUGGEST_DEBOUNCE_MS);
    },
    [runSuggest],
  );

  return (
    <Select
      value={value}
      onChange={onChange}
      style={{ width }}
      showSearch
      filterOption={false} // 候选已由服务端按 q 过滤，前端不再二次过滤
      loading={searching}
      onSearch={handleSearch}
      options={[{ value: ANY, label: allLabel }, ...options]}
      // loading 时用转圈占位，避免「无数据」短暂闪现造成误解
      notFoundContent={searching ? <Spin size="small" /> : undefined}
    />
  );
}

export function PhotoManager() {
  const { message, modal } = App.useApp();
  const [photos, setPhotos] = useState<Photo[]>([]);
  const [loading, setLoading] = useState(false);
  const [categories, setCategories] = useState<string[]>([]);
  const [category, setCategory] = useState<string>(ANY);
  const [sort, setSort] = useState<SortOrder>('desc');
  const [selectedKeys, setSelectedKeys] = useState<Key[]>([]);
  const [editing, setEditing] = useState<Photo | null>(null);
  const [exifPhotoId, setExifPhotoId] = useState<string | null>(null);
  /** 批量弹层开关：上传 / 改元数据 / 改 EXIF */
  const [uploading, setUploading] = useState(false);
  /** 文件夹上传弹窗（与逐张上传分开：它自带分片与断点续传） */
  const [folderUpload, setFolderUpload] = useState(false);
  const [batchMeta, setBatchMeta] = useState(false);
  const [batchExif, setBatchExif] = useState(false);

  /* --- 列设置：宽度与顺序持久化到本地；操作列固定在最后，不参与 --- */
  /** 初始偏好只在挂载时读一次：之后以 state 为准，避免拖拽中被本地存档覆盖 */
  const initialPrefs = useMemo(loadColumnPrefs, []);
  const [columnOrder, setColumnOrder] = useState<string[]>(initialPrefs.order);
  const [columnWidths, setColumnWidths] = useState<Record<string, number>>(initialPrefs.widths);
  const [draggingKey, setDraggingKey] = useState<string | null>(null);
  /** 拖拽落点信息；用 ref 存，避免指针每移动一像素就触发一次渲染 */
  const dragRef = useRef<{ mode: 'resize' | 'reorder'; key: string; startX: number; startWidth: number } | null>(null);
  /** 只有用户真正改过列设置才写 localStorage，避免挂载时即将默认值写入本地 */
  const prefsDirtyRef = useRef(false);

  /* --- 分页：photos 一次性全量拉回，分页纯前端；但每页条数必须受控，否则切换后仍固定为 20 条 --- */
  const [pageSize, setPageSize] = useState(20);
  const [currentPage, setCurrentPage] = useState(1);

  /* --- 检索条件：草稿与生效值分开，只有提交时才把草稿同步过去并触发查询 --- */
  const [keywordDraft, setKeywordDraft] = useState('');
  const [keyword, setKeyword] = useState('');
  const [range, setRange] = useState<[Dayjs | null, Dayjs | null] | null>(null);
  const [cam, setCam] = useState<string>(ANY);
  const [lens, setLens] = useState<string>(ANY);
  /** 曝光三要素维度：候选来自字典联想下拉（不是从结果里累积） */
  const [aperture, setAperture] = useState<string>(ANY);
  const [shutter, setShutter] = useState<string>(ANY);
  const [iso, setIso] = useState<string>(ANY);
  const [gps, setGps] = useState<GpsFilter>('all');

  const load = useCallback(async (): Promise<void> => {
    setLoading(true);
    try {
      // ISO 的选中值是字符串（下拉里存的是字典原值），查询要求 number：先排除「全部」，再转数字
      const isoNumber = iso === ANY ? undefined : Number(iso);
      // 走检索通道（searchApi.photos），参数与 /photos 完全一致
      const list = await searchApi.photos({
        category,
        sort,
        q: keyword || undefined,
        from: range?.[0]?.format('YYYY-MM-DD'),
        to: range?.[1]?.format('YYYY-MM-DD'),
        cam: cam === ANY ? undefined : cam,
        lens: lens === ANY ? undefined : lens,
        aperture: aperture === ANY ? undefined : aperture,
        speed: shutter === ANY ? undefined : shutter,
        // 非数字（理论上不会出现，字典值都来自后端）一律按「不限」处理，避免 NaN 进入查询
        iso: isoNumber !== undefined && Number.isFinite(isoNumber) ? isoNumber : undefined,
        hasGps: gps === 'all' ? undefined : gps === 'yes',
      });
      setPhotos(list);
      // 分类候选仍只增不减地累积，保证筛选后下拉框里仍有全部选项
      setCategories((prev) => mergeOptions(prev, list.map((photo) => photo.cat)));
      // 已被删掉的行不该继续留在选中集里
      const ids = new Set(list.map((photo) => photo.id));
      setSelectedKeys((prev) => prev.filter((key) => ids.has(String(key))));
    } catch (error) {
      message.error(error instanceof Error ? error.message : '照片列表加载失败');
    } finally {
      setLoading(false);
    }
  }, [category, sort, keyword, range, cam, lens, aperture, shutter, iso, gps, message]);

  useEffect(() => {
    void load();
  }, [load]);

  /** 重置全部检索条件。条件分散在多个 state 里，逐个清空比由用户逐项还原更实用 */
  const resetFilters = useCallback((): void => {
    setCategory(ANY);
    setSort('desc');
    setKeywordDraft('');
    setKeyword('');
    setRange(null);
    setCam(ANY);
    setLens(ANY);
    setAperture(ANY);
    setShutter(ANY);
    setIso(ANY);
    setGps('all');
  }, []);

  /** 单张更新后原地替换，避免整表重拉 */
  const replacePhoto = useCallback((updated: Photo) => {
    setPhotos((prev) => prev.map((photo) => (photo.id === updated.id ? updated : photo)));
  }, []);

  const handleRemove = useCallback(
    async (photo: Photo): Promise<void> => {
      try {
        await photoApi.remove(photo.id);
        message.success(`已删除「${photo.title || photo.id}」`);
        await load();
      } catch (error) {
        message.error(error instanceof Error ? error.message : '删除失败');
      }
    },
    [load, message],
  );

  const handleBatchRemove = useCallback((): void => {
    const ids = selectedKeys.map(String);
    if (ids.length === 0) return;
    modal.confirm({
      title: `确认删除选中的 ${ids.length} 张照片？`,
      content: '照片会从相册中移除，原文件仍会保留，需要时可由管理员恢复。',
      okText: '确认删除',
      okButtonProps: { danger: true },
      cancelText: '取消',
      onOk: async () => {
        try {
          const result = await photoApi.removeBatch(ids);
          message.success(`已删除 ${result.removed} 张照片`);
          setSelectedKeys([]);
          await load();
        } catch (error) {
          message.error(error instanceof Error ? error.message : '批量删除失败');
        }
      },
    });
  }, [selectedKeys, modal, message, load]);

  /** 批量写操作完成后的统一收尾：清空选中并重拉列表（页面上各处结果都变了） */
  const refreshAfterBatch = useCallback((): void => {
    setSelectedKeys([]);
    void load();
  }, [load]);

  /** 行内切换隐私标记：直接 PATCH 单张标记，成功后原地替换该行 */
  const handlePrivacyChange = useCallback(
    async (photo: Photo, privacy: PrivacyMark): Promise<void> => {
      if ((photo.privacy?.mode ?? 'inherit') === privacy) return;
      try {
        const updated = await photoApi.update(photo.id, { privacy });
        replacePhoto(updated);
        message.success(`「${photo.title || photo.id}」的隐私标记已改为${PRIVACY_MARK_LABEL[privacy]}`);
      } catch (error) {
        message.error(error instanceof Error ? error.message : '隐私标记修改失败');
      }
    },
    [message, replacePhoto],
  );

  const selectedIds = useMemo(() => selectedKeys.map(String), [selectedKeys]);

  /** 切换单行选中态：供「缩略图」列整格点击使用（图片本身除外，见该列 render） */
  const toggleRowSelected = useCallback((id: string): void => {
    setSelectedKeys((prev) =>
      prev.some((key) => String(key) === id) ? prev.filter((key) => String(key) !== id) : [...prev, id],
    );
  }, []);

  /** 数据列定义（不含固定在最后的操作列）；宽度由 columnWidths 注入，这里只写业务默认之外的东西 */
  const dataColumns = useMemo<ColumnsType<Photo>>(
    () => [
      {
        key: 'url',
        dataIndex: 'url',
        title: '缩略图',
        render: (_url: string, record) => (
          /* 整格可点选行：点击空白处切换选中；点击图片本身仍查看大图，故在内层阻止冒泡 */
          <div className="thumb-cell" onClick={() => toggleRowSelected(record.id)}>
            <span onClick={(event) => event.stopPropagation()}>
              <Image
                className="admin-thumb"
                src={record.cardUrl ?? record.url}
                alt={record.title}
                preview={{ src: record.originalUrl ?? record.url }}
              />
            </span>
          </div>
        ),
      },
      {
        key: 'title',
        dataIndex: 'title',
        title: '标题',
        render: (title: string, record) => (
          <div>
            <div>{title || '（无标题）'}</div>
            <div className="t-qua" style={{ fontSize: 11, fontFamily: 'var(--font-family-mono)' }}>
              {record.id}
            </div>
          </div>
        ),
      },
      {
        key: 'cat',
        dataIndex: 'cat',
        title: '分类',
        render: (cat: string) => <Tag color="gold">{cat}</Tag>,
      },
      {
        key: 'date',
        dataIndex: 'date',
        title: '拍摄日期',
        render: (date: string) => orDash(date),
      },
      /* 器材三列：找片时最常用到的线索，紧跟在时间之后 */
      {
        key: 'cam',
        dataIndex: 'cam',
        title: '机身',
        render: (cam: string) => orDash(cam),
      },
      {
        key: 'lens',
        dataIndex: 'lens',
        title: '镜头',
        render: (lens: string) => orDash(lens),
      },
      {
        key: 'focal',
        dataIndex: 'focal',
        title: '焦距',
        render: (focal: string) => orDash(focal),
      },
      /* 曝光三要素：拆分为三列而非挤在一格，便于逐列扫读与逐列核对 */
      {
        key: 'aperture',
        dataIndex: 'aperture',
        title: '光圈',
        render: (aperture: string) => orDash(aperture),
      },
      {
        key: 'speed',
        dataIndex: 'speed',
        title: '快门',
        render: (speed: string) => orDash(speed),
      },
      {
        key: 'iso',
        dataIndex: 'iso',
        title: 'ISO',
        align: 'right',
        render: (iso: number | null) => orDash(iso),
      },
      {
        key: 'gps',
        dataIndex: 'gps',
        title: '坐标',
        render: (gps: Photo['gps']) =>
          gps ? (
            /* 等宽 + 五位小数：坐标用于核对与复制，而非直接阅读 */
            <span className="t-qua" style={{ fontSize: 11, fontFamily: 'var(--font-family-mono)' }}>
              {gps.lat.toFixed(5)}, {gps.lon.toFixed(5)}
            </span>
          ) : (
            <span className="t-qua">—</span>
          ),
      },
      {
        key: 'tags',
        dataIndex: 'tags',
        title: '标签',
        render: (tags: PhotoTag[]) => <TagCell tags={tags} />,
      },
      {
        key: 'likes',
        dataIndex: 'likes',
        title: '点赞',
        align: 'right',
      },
      /* 隐私列：标签显示有效策略，点标签弹下拉改单张标记 */
      {
        key: 'privacy',
        title: '隐私',
        render: (_, record) => {
          const mode = (record.privacy?.mode ?? 'inherit') as PrivacyMark;
          // 用原生 title 而不是 Tooltip：Tooltip 需包裹 Dropdown 才能挂到锚点上，链路更脆弱
          return (
            <Dropdown
              trigger={['click']}
              menu={{
                items: PRIVACY_MARK_OPTIONS.map((option) => ({ key: option.value, label: option.label })),
                selectedKeys: [mode],
                onClick: ({ key }) => void handlePrivacyChange(record, key as PrivacyMark),
              }}
            >
              <span className="privacy-cell" title="点击切换隐私标记">
                <Tag color={PRIVACY_MARK_COLOR[mode]}>{PRIVACY_MARK_LABEL[mode]}</Tag>
              </span>
            </Dropdown>
          );
        },
      },
    ],
    [handlePrivacyChange, toggleRowSelected],
  );

  /** 操作列：固定在最右，不参与拖拽换位、宽度也不持久化 */
  const actionColumn = useMemo<ColumnsType<Photo>[number]>(
    () => ({
      key: 'action',
      title: '操作',
      width: ACTION_COLUMN_WIDTH,
      fixed: 'right',
      render: (_, record) => (
        <Space size={2}>
          <Button type="link" size="small" onClick={() => setEditing(record)}>
            编辑信息
          </Button>
          <Button type="link" size="small" onClick={() => setExifPhotoId(record.id)}>
            编辑拍摄参数
          </Button>
          <Popconfirm
            title="确认删除这张照片？"
            description="照片会从相册中移除，原文件仍会保留。"
            okText="删除"
            cancelText="取消"
            okButtonProps={{ danger: true }}
            onConfirm={() => handleRemove(record)}
          >
            <Button type="link" size="small" danger>
              删除
            </Button>
          </Popconfirm>
        </Space>
      ),
    }),
    [handleRemove],
  );

  /**
   * 最终列：按持久化顺序排布，并注入持久化宽度与拖拽用的 data-* 标记。
   * 存档里的顺序可能缺列（版本新增），用定义顺序补齐，避免新增列不显示。
   */
  const columns = useMemo<ColumnsType<Photo>>(() => {
    const byKey = new Map(dataColumns.map((column) => [String(column.key), column]));
    const orderedKeys = [...columnOrder, ...COLUMN_KEYS].filter((key, index, all) => all.indexOf(key) === index);
    const ordered = orderedKeys
      .map((key) => byKey.get(key))
      .filter((column): column is ColumnsType<Photo>[number] => Boolean(column))
      .map((column): ColumnsType<Photo>[number] => {
        const key = String(column.key);
        const width = columnWidths[key] ?? DEFAULT_COLUMN_WIDTHS[key] ?? MIN_COLUMN_WIDTH;
        return {
          ...column,
          width,
          onHeaderCell: (): HeaderCellProps => ({ 'data-col-key': key, 'data-col-width': width }),
        };
      });
    return [...ordered, actionColumn];
  }, [dataColumns, actionColumn, columnOrder, columnWidths]);

  /** 横向滚动宽度随列宽变化：固定数字会使加宽后的列被挤压 */
  const scrollX = useMemo(
    () => columns.reduce((sum, column) => sum + (typeof column.width === 'number' ? column.width : 0), 0) + 40,
    [columns],
  );

  /** 拖拽入口：透给表头单元格（经 Context），起手即记下起点，后续交给 window 监听 */
  const dragApi = useMemo<ColumnDragApi>(
    () => ({
      draggable: (key) => COLUMN_KEYS.has(key),
      activeKey: draggingKey,
      onResizeStart: (event, key, width) => {
        event.preventDefault();
        dragRef.current = { mode: 'resize', key, startX: event.clientX, startWidth: width };
        setDraggingKey(key);
      },
      onReorderStart: (event, key) => {
        event.preventDefault();
        dragRef.current = { mode: 'reorder', key, startX: event.clientX, startWidth: 0 };
        setDraggingKey(key);
      },
    }),
    [draggingKey],
  );

  /* 监听挂在 window 上：指针移出表头也能继续调宽 / 换位，松开后才结束 */
  useEffect(() => {
    if (!draggingKey) return;

    const handleMove = (event: PointerEvent): void => {
      const drag = dragRef.current;
      if (!drag) return;
      // 真正改动了才算「用户定制过」：仅点击表头不应写入一份默认值
      prefsDirtyRef.current = true;
      if (drag.mode === 'resize') {
        const width = clampColumnWidth(drag.startWidth + (event.clientX - drag.startX));
        setColumnWidths((prev) => ({ ...prev, [drag.key]: width }));
        return;
      }
      // 换位：判断指针当前落在哪个表头上；操作列 / 勾选列没有 data-col-key，自然被排除
      const target = (document.elementFromPoint(event.clientX, event.clientY) as HTMLElement | null)?.closest<HTMLElement>(
        '[data-col-key]',
      );
      const targetKey = target?.dataset.colKey;
      if (!targetKey || targetKey === drag.key) return;
      setColumnOrder((prev) => moveColumn(prev, drag.key, targetKey));
    };

    const handleUp = (): void => {
      dragRef.current = null;
      setDraggingKey(null);
    };

    window.addEventListener('pointermove', handleMove);
    window.addEventListener('pointerup', handleUp);
    document.body.classList.add('col-dragging');
    return () => {
      window.removeEventListener('pointermove', handleMove);
      window.removeEventListener('pointerup', handleUp);
      document.body.classList.remove('col-dragging');
    };
  }, [draggingKey]);

  /* 列设置变化后落盘；只在用户改过之后才写（见 prefsDirtyRef），避免写入多余记录 */
  useEffect(() => {
    if (!prefsDirtyRef.current) return;
    localStorage.setItem(COLUMN_STORAGE_KEY, JSON.stringify({ order: columnOrder, widths: columnWidths }));
  }, [columnOrder, columnWidths]);

  /** 重置列宽与列顺序：清掉本地存档并回到默认定义 */
  const resetColumnPrefs = useCallback((): void => {
    prefsDirtyRef.current = false;
    localStorage.removeItem(COLUMN_STORAGE_KEY);
    setColumnOrder([...COLUMN_KEYS]);
    setColumnWidths({ ...DEFAULT_COLUMN_WIDTHS });
    message.success('列设置已重置');
  }, [message]);

  return (
    <>
      {/* 检索区：六个维度平铺，改任一项即重新查询（关键词走回车 / 点搜索提交） */}
      <div className="admin-toolbar">
        <Input.Search
          value={keywordDraft}
          onChange={(event) => setKeywordDraft(event.target.value)}
          onSearch={(value) => setKeyword(value.trim())}
          placeholder="标题 / 编号 / 相机 / 镜头 / 分类"
          allowClear
          style={{ width: 260 }}
        />
        <DatePicker.RangePicker
          value={range}
          onChange={(dates) => setRange(dates)}
          placeholder={['拍摄日期起', '止']}
        />
        <Select
          value={category}
          onChange={setCategory}
          style={{ width: 140 }}
          options={[{ value: ANY, label: '全部分类' }, ...categories.map((name) => ({ value: name, label: name }))]}
        />
        {/* 器材与曝光五维：候选来自字典联想（防抖 250ms 远程检索），值清空即回到「全部」 */}
        <DictionarySelect kind="camera" value={cam} onChange={setCam} allLabel="全部机身" width={170} />
        <DictionarySelect kind="lens" value={lens} onChange={setLens} allLabel="全部镜头" width={190} />
        <DictionarySelect kind="aperture" value={aperture} onChange={setAperture} allLabel="全部光圈" width={120} />
        <DictionarySelect kind="shutter" value={shutter} onChange={setShutter} allLabel="全部快门" width={130} />
        <DictionarySelect kind="iso" value={iso} onChange={setIso} allLabel="全部 ISO" width={120} />
        <Select<GpsFilter>
          value={gps}
          onChange={setGps}
          style={{ width: 120 }}
          options={GPS_OPTIONS}
        />
        <Select<SortOrder>
          value={sort}
          onChange={setSort}
          style={{ width: 120 }}
          options={[
            { value: 'desc', label: '最新在前' },
            { value: 'asc', label: '最早在前' },
          ]}
        />
        <Button onClick={() => void load()} loading={loading}>
          刷新
        </Button>
        <Button onClick={resetFilters}>重置</Button>
        <Tooltip title="把列宽与列顺序恢复为默认，并清除本机保存的列设置">
          <Button onClick={resetColumnPrefs}>重置列设置</Button>
        </Tooltip>
      </div>

      {/* 结果区：命中张数 + 上传入口 + 当前选中 + 批量操作 */}
      <div className="admin-toolbar">
        <Tooltip title="修改拍摄参数只更新数据库记录，照片文件保持原样">
          <span className="t-qua" style={{ fontSize: 11 }}>
            共 {photos.length} 张
          </span>
        </Tooltip>
        <Button type="primary" onClick={() => setUploading(true)}>
          上传照片
        </Button>
        <Tooltip title="选一个本地文件夹：自动以文件夹名建相册，大文件自动分片、支持断点续传">
          <Button onClick={() => setFolderUpload(true)}>文件夹上传</Button>
        </Tooltip>
        <div className="admin-toolbar__spacer" />
        <span className="t-sec" style={{ fontSize: 12 }}>
          已选 {selectedKeys.length} 项
        </span>
        <Button
          disabled={selectedKeys.length === 0}
          onClick={() => setBatchMeta(true)}
        >
          批量编辑信息
        </Button>
        <Tooltip title="把同一组拍摄参数写入选中的照片">
          <Button disabled={selectedKeys.length === 0} onClick={() => setBatchExif(true)}>
            批量编辑拍摄参数
          </Button>
        </Tooltip>
        <Button danger disabled={selectedKeys.length === 0} onClick={handleBatchRemove}>
          批量删除
        </Button>
      </div>

      <ColumnDragContext.Provider value={dragApi}>
        <Table<Photo>
          rowKey="id"
          size="small"
          loading={loading}
          columns={columns}
          dataSource={photos}
          components={TABLE_COMPONENTS}
          scroll={{ x: scrollX }}
          /* 表头冻结 + 便于用 CSS 定位到本表：
             开启 sticky 后 AntD 会把表头拆成一块独立的吸顶容器，
             页面纵向滚动时它吸在页头下缘（具体位置与层级见 admin.css 的 .photo-table）。 */
          className="photo-table"
          sticky
          onRow={(record) => ({
            // 整行点击选中：点任意行区域（交互控件除外）即切换该行选中，
            // 与复选框 rowSelection 共享同一 selectedKeys 状态，视觉与行为完全一致。
            onClick: (event) => {
              const el = event.target as HTMLElement;
              // 交互控件/已有独立点击行为的区域不触发行选中，避免误触：
              // —— 按钮、链接、输入类、下拉、开关（AntD 用 role=switch）
              // —— 复选框/单选（rowSelection 自带点按）
              // —— 缩略图单元格：点空白由其自身切换选中，点图片放大图（内部已 stopPropagation）
              if (el.closest('button, a, input, textarea, select, [role="switch"], .ant-dropdown-trigger, .ant-checkbox-wrapper, .ant-radio-wrapper, .thumb-cell')) {
                return;
              }
              toggleRowSelected(record.id);
            },
          })}
          rowSelection={{
            selectedRowKeys: selectedKeys,
            onChange: setSelectedKeys,
            preserveSelectedRowKeys: false,
          }}
          pagination={{
            current: currentPage,
            pageSize,
            showSizeChanger: true,
            pageSizeOptions: [20, 50, 100, 200],
            showTotal: (total) => `共 ${total} 张`,
            // 每页条数变了就回到第一页，否则页码可能落在不存在的页上
            onChange: (page, size) => {
              if (size !== pageSize) {
                setPageSize(size);
                setCurrentPage(1);
                return;
              }
              setCurrentPage(page);
            },
          }}
        />
      </ColumnDragContext.Provider>

      <PhotoMetaModal
        photo={editing}
        categoryOptions={categories}
        onClose={() => setEditing(null)}
        onSaved={replacePhoto}
      />

      <ExifDrawer
        photoId={exifPhotoId}
        open={exifPhotoId !== null}
        onClose={() => setExifPhotoId(null)}
        onSaved={(result) => replacePhoto(result.photo)}
      />

      <PhotoUploadModal
        open={uploading}
        onClose={() => setUploading(false)}
        onUploaded={() => void load()}
      />

      <FolderUploadModal
        open={folderUpload}
        onClose={() => setFolderUpload(false)}
        onUploaded={() => void load()}
      />

      <BatchMetaModal
        open={batchMeta}
        ids={selectedIds}
        categoryOptions={categories}
        onClose={() => setBatchMeta(false)}
        onDone={refreshAfterBatch}
      />

      <BatchExifDrawer
        open={batchExif}
        ids={selectedIds}
        onClose={() => setBatchExif(false)}
        onDone={refreshAfterBatch}
      />
    </>
  );
}
