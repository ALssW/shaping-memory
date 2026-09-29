/**
 * apps/api/src/files/files.module.ts
 */
import { Module } from '@nestjs/common';
import { FilesController } from './files.controller';

@Module({
  controllers: [FilesController],
})
export class FilesModule {}