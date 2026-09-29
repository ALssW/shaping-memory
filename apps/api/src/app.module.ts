/**
 * apps/api/src/app.module.ts
 */
import { Module } from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { AdminModule } from './admin/admin.module';
import { AuditInterceptor } from './audit/audit.interceptor';
import { AuditModule } from './audit/audit.module';
import { AuthModule } from './auth/auth.module';
import { CatalogModule } from './catalog/catalog.module';
import { DictionaryModule } from './dictionary/dictionary.module';
import { GeoModule } from './geo/geo.module';
import { InfraModule } from './infra.module';
import { FilesModule } from './files/files.module';
import { HealthController } from './health.controller';
import { PhotosModule } from './photos/photos.module';
import { PrivacyModule } from './privacy/privacy.module';
import { SearchModule } from './search/search.module';
import { SettingsModule } from './settings/settings.module';
import { ShareModule } from './share/share.module';
import { TagsModule } from './tags/tags.module';
import { ThemeModule } from './theme/theme.module';

@Module({
  imports: [
    InfraModule,
    AuthModule,
    PhotosModule,
    FilesModule,
    CatalogModule,
    ShareModule,
    PrivacyModule,
    SettingsModule,
    AuditModule,
    AdminModule,
    DictionaryModule,
    SearchModule,
    GeoModule,
    ThemeModule,
    TagsModule,
  ],
  controllers: [HealthController],
  providers: [
    // 全局审计拦截器：所有写操作（POST/PUT/PATCH/DELETE）留一条记录，
    // 未登录请求由它记 actor=null，因此不需要额外的中间件
    { provide: APP_INTERCEPTOR, useClass: AuditInterceptor },
  ],
})
export class AppModule {}