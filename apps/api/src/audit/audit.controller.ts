/**
 * apps/api/src/audit/audit.controller.ts
 *
 * 操作审计的读接口：只有 admin 能看（日志里含所有账号的操作轨迹）。
 */
import { Controller, DefaultValuePipe, Get, ParseIntPipe, Query, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { Roles, RolesGuard } from '../auth/roles.guard';
import { AuditService } from './audit.service';
import type { AuditEntry } from './audit.service';

@Controller('audit')
export class AuditController {
  constructor(private readonly audit: AuditService) {}

  /** 最近的操作记录（需 admin），默认 200 条 */
  @Get()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('admin')
  list(@Query('limit', new DefaultValuePipe(200), ParseIntPipe) limit: number): Promise<AuditEntry[]> {
    return this.audit.list(limit);
  }
}