/**
 * apps/admin/src/pages/AuditPage.tsx
 *
 * 操作日志：后端只保留最近 N 条写操作记录（登录后的 POST / PATCH / PUT / DELETE）。
 *
 * 【为什么没有时间范围筛选】/audit 是「最近 N 条」的定长视图，不是可检索的历史表；
 * 前端只提供条数选择，避免提供后端并不支持的虚假筛选。
 */
import { useCallback, useEffect, useState } from 'react';
import { App, Button, Empty, Select, Table, Tag } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { auditApi } from '@shaping-memory/sdk';
import type { AuditEntry } from '@shaping-memory/sdk';

import { formatDateTime } from '../lib/format';

/** 状态码上色：<400 成功（绿），<500 客户端错（橙），其余服务端错（红） */
function statusColor(status: number): string {
  if (status < 400) return 'green';
  if (status < 500) return 'orange';
  return 'red';
}

const LIMIT_OPTIONS = [100, 200, 500].map((value) => ({ value, label: `最近 ${value} 条` }));

export function AuditPage() {
  const { message } = App.useApp();
  const [entries, setEntries] = useState<AuditEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [limit, setLimit] = useState(200);

  const load = useCallback(async (): Promise<void> => {
    setLoading(true);
    try {
      setEntries(await auditApi.list(limit));
    } catch (error) {
      message.error(error instanceof Error ? error.message : '操作日志加载失败');
    } finally {
      setLoading(false);
    }
  }, [limit, message]);

  useEffect(() => {
    void load();
  }, [load]);

  const columns: ColumnsType<AuditEntry> = [
    {
      title: '时间',
      dataIndex: 'at',
      width: 180,
      render: (at: string) => formatDateTime(at, true),
    },
    {
      title: '操作者',
      dataIndex: 'actor',
      width: 140,
      render: (actor: string | null) => actor ?? <span className="t-qua">匿名</span>,
    },
    {
      title: '方法',
      dataIndex: 'method',
      width: 100,
      render: (method: string) => <Tag>{method}</Tag>,
    },
    {
      title: '路径',
      dataIndex: 'path',
      render: (path: string) => (
        <span style={{ fontFamily: 'var(--font-family-mono)', fontSize: 11 }}>{path}</span>
      ),
    },
    {
      title: '状态码',
      dataIndex: 'status',
      width: 100,
      render: (status: number) => <Tag color={statusColor(status)}>{status}</Tag>,
    },
  ];

  return (
    <div>
      <div className="admin-toolbar">
        <span className="admin-page-title">操作日志</span>
        <div className="admin-toolbar__spacer" />
        <Select<number> value={limit} onChange={setLimit} options={LIMIT_OPTIONS} style={{ width: 140 }} />
        <Button onClick={() => void load()} loading={loading}>
          刷新
        </Button>
      </div>

      <Table<AuditEntry>
        rowKey="id"
        size="small"
        loading={loading}
        columns={columns}
        dataSource={entries}
        locale={{ emptyText: <Empty description="暂无写操作记录" /> }}
        pagination={{ pageSize: 50, showSizeChanger: true, showTotal: (total) => `共 ${total} 条` }}
      />
    </div>
  );
}