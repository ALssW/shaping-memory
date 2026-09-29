/**
 * apps/api/src/health.controller.ts
 */
import { Controller, Get } from '@nestjs/common';

@Controller('health')
export class HealthController {
  @Get()
  ok(): { status: string; now: string } {
    return { status: 'ok', now: new Date().toISOString() };
  }
}