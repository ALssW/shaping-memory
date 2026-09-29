/**
 * apps/api/src/audit/audit.module.ts
 *
 * 操作审计模块。导出 AuditInterceptor 供 AppModule 注册成全局拦截器，
 * 同时导出 AuditService 供其它模块（如账号服务）需要时手动补一条记录。
 */
import { Module } from '@nestjs/common';
import { AuditController } from './audit.controller';
import { AuditInterceptor } from './audit.interceptor';
import { AuditService } from './audit.service';

@Module({
  controllers: [AuditController],
  providers: [AuditService, AuditInterceptor],
  exports: [AuditService, AuditInterceptor],
})
export class AuditModule {}