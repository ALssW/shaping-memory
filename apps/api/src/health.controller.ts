/**
 * apps/api/src/health.controller.ts
 */
import { Controller, Get } from '@nestjs/common';
import { toChinaIso } from '@shaping-memory/core';

@Controller('health')
export class HealthController {
  @Get()
  ok(): { status: string; now: string } {
    // 服务器当前时刻同样按中国标准时间出口，与其余时间字段同一口径
    return { status: 'ok', now: toChinaIso(new Date()) };
  }
}