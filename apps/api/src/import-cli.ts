/**
 * apps/api/src/import-cli.ts
 *
 * 照片导入 CLI：`npm run import -w @shaping-memory/api`。
 * 扫描源目录、抽 EXIF、生成缩略图、幂等入库，最后打印汇总。
 */
import './env';
import { loadConfig } from '@shaping-memory/config';
import { importPhotos } from './import/pipeline';

async function main(): Promise<void> {
  const config = loadConfig();
  // eslint-disable-next-line no-console
  console.log(`[import] 源目录 ${config.PHOTO_SOURCE_DIR}（存储：${config.STORAGE_PROVIDER}）`);
  const report = await importPhotos(config);
  // eslint-disable-next-line no-console
  console.log(
    `[import] 完成：共 ${report.total} 张，导入 ${report.imported}，失败 ${report.failed}`,
  );
  // 上云结果单独报一行：本机模式下恒为 0，用户可据此确认「本次未涉及对象存储」
  if (report.uploaded > 0 || report.uploadFailed > 0) {
    // eslint-disable-next-line no-console
    console.log(`[import] 上云：成功 ${report.uploaded} 个对象，失败 ${report.uploadFailed} 个`);
  }
  for (const err of report.errors) {
    // eslint-disable-next-line no-console
    console.error(`  - ${err}`);
  }
  // 上传失败只影响云端副本，单独列出以免和「没导进来」混淆
  for (const err of report.uploadErrors) {
    // eslint-disable-next-line no-console
    console.error(`  - [未上云] ${err}`);
  }
}

void main();