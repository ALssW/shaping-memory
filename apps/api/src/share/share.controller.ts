/**
 * apps/api/src/share/share.controller.ts
 *
 * 公开分享端点：无需鉴权，只读。返回 text/html，供社交爬虫解析 OpenGraph。
 */
import { Controller, Get, Header, Param } from '@nestjs/common';
import { ShareService } from './share.service';

@Controller('share')
export class ShareController {
  constructor(private readonly share: ShareService) {}

  @Get('album/:id')
  @Header('Content-Type', 'text/html; charset=utf-8')
  renderAlbum(@Param('id') id: string): Promise<string> {
    return this.share.renderAlbum(id);
  }
}