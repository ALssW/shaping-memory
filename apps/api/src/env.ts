/**
 * apps/api/src/env.ts
 *
 * 在模块被首次 import 时加载仓库根目录的 .env。
 * main.ts 与 import-cli.ts 都在最顶部 import 本模块，确保 loadConfig() 生效前 env 就绪。
 * 本脚本由 npm 脚本运行（CWD = apps/api），仓库根 = 再上两级。
 */
import { config as loadEnv } from 'dotenv';
import path from 'node:path';

loadEnv({ path: path.resolve(__dirname, '../../..', '.env') });