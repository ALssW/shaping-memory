/**
 * apps/admin/src/pages/OverviewPage.tsx
 *
 * 数据概览：一次 /stats 拿齐全部计数，铺成卡片网格。
 *
 * 【为什么不做图表】这些数字属于「是否需要清理 / 是否存在异常」的巡检指标，
 * 单值卡片比折线图更便于快速阅读；趋势类图需要历史快照，后端目前未存储。
 */
import { useCallback, useEffect, useState } from 'react';
import { App, Button, Card, Col, Empty, Row, Spin, Statistic } from 'antd';
import { statsApi } from '@shaping-memory/sdk';
import type { AdminStats } from '@shaping-memory/sdk';

/** 卡片项：值与单位分开写，避免在渲染里做字符串拼接 */
interface StatItem {
  key: string;
  label: string;
  value: number | string;
  suffix?: string;
}

function toItems(stats: AdminStats): StatItem[] {
  return [
    { key: 'photos', label: '照片总数', value: stats.photos, suffix: '张' },
    { key: 'live', label: '实况照片', value: stats.livePhotos, suffix: '张' },
    { key: 'marked', label: '隐私标记', value: stats.markedPhotos, suffix: '张' },
    { key: 'deleted', label: '已删除', value: stats.deletedPhotos, suffix: '张' },
    { key: 'albums', label: '相册', value: stats.albums, suffix: '个' },
    { key: 'categories', label: '分类', value: stats.categories, suffix: '个' },
    { key: 'users', label: '账号', value: stats.users, suffix: '个' },
    { key: 'shares', label: '分享链接', value: stats.shares, suffix: '条' },
    { key: 'activeShares', label: '有效分享', value: stats.activeShares, suffix: '条' },
    { key: 'latestCapture', label: '最新拍摄日期', value: stats.latestCapture ?? '—' },
  ];
}

export function OverviewPage() {
  const { message } = App.useApp();
  const [stats, setStats] = useState<AdminStats | null>(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async (): Promise<void> => {
    setLoading(true);
    try {
      setStats(await statsApi.get());
    } catch (error) {
      message.error(error instanceof Error ? error.message : '概览数据加载失败');
    } finally {
      setLoading(false);
    }
  }, [message]);

  useEffect(() => {
    void load();
  }, [load]);

  const items = stats ? toItems(stats) : [];

  return (
    <div>
      <div className="admin-toolbar">
        <span className="admin-page-title">数据概览</span>
        <div className="admin-toolbar__spacer" />
        <Button onClick={() => void load()} loading={loading}>
          刷新
        </Button>
      </div>

      <Spin spinning={loading}>
        {items.length === 0 && !loading ? (
          <Empty description="暂无统计数据" />
        ) : (
          <Row gutter={[16, 16]}>
            {items.map((item) => (
              <Col key={item.key} xs={24} sm={12} md={8} lg={6} xl={4}>
                <Card size="small" className="admin-stat-card">
                  <Statistic title={item.label} value={item.value} suffix={item.suffix} />
                </Card>
              </Col>
            ))}
          </Row>
        )}
      </Spin>
    </div>
  );
}