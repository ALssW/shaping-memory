/**
 * apps/api/src/audit/audit.service.ts
 *
 * 操作审计：写入与查询。
 * 【为什么记在服务里而不是控制器上】记录动作的是拦截器（见 audit.interceptor.ts），
 * 控制器只负责「读」—— 两者共用一个 service，保证表结构与返回形状只有一份定义。
 */
import { Inject, Injectable } from '@nestjs/common';
import { desc } from 'drizzle-orm';
import { auditLogs } from '@shaping-memory/db';
import type { Db } from '@shaping-memory/db';
import { DB } from '../infra.module';

/** 一条审计记录（对外形状，与前端 SDK 的 AuditEntry 一一对应） */
export interface AuditEntry {
  id: number;
  actor: string | null;
  method: string;
  path: string;
  status: number;
  at: string;
}

/** 查询条数上限：后台日志页最多看 1000 条，避免一次把整表拉出来 */
const MAX_LIMIT = 1000;

@Injectable()
export class AuditService {
  constructor(@Inject(DB) private readonly db: Db) {}

  /**
   * 落一条记录。
   * 【必须吞掉自己的异常】审计是旁路功能，写失败不得影响业务请求 ——
   * 因此这里整体 try/catch，出错只在控制台留一句，不向上抛。
   */
  async record(entry: { actor: string | null; method: string; path: string; status: number }): Promise<void> {
    try {
      await this.db.insert(auditLogs).values(entry);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn('[audit] 写入失败：', (err as Error).message);
    }
  }

  /** 最近的操作记录，时间倒序 */
  async list(limit = 200): Promise<AuditEntry[]> {
    const size = Math.min(MAX_LIMIT, Math.max(1, Math.floor(limit)));
    const rows = await this.db.select().from(auditLogs).orderBy(desc(auditLogs.at)).limit(size);
    return rows.map((row) => ({
      id: row.id,
      actor: row.actor,
      method: row.method,
      path: row.path,
      status: row.status,
      at: row.at.toISOString(),
    }));
  }
}