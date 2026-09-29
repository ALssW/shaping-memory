/**
 * apps/api/src/catalog/ids.ts
 *
 * 分类 / 相册的 id 生成器。
 * 单独成文件是为了让「种子脚本」也能复用同一套 id 规则，而不必 import 整个 Nest 服务。
 */
import { createHash } from 'node:crypto';

/**
 * 分类 id：取分类名的稳定哈希（sha1 前 16 位）。
 * 【为什么不用中文当 id】主键一旦是中文，URL、日志、跨端传参都要处理编码；
 * 稳定哈希保证「同名 → 同 id」，重复执行种子脚本天然幂等。
 */
export function categoryIdOf(name: string): string {
  return 'cat_' + createHash('sha1').update(name).digest('hex').slice(0, 16);
}

/** 相册 id：同样取标题的稳定哈希，种子脚本可反复执行而不新增重复册 */
export function albumIdOf(title: string): string {
  return 'alb_' + createHash('sha1').update(title).digest('hex').slice(0, 16);
}

/** 相册分组 id：同样取分组名的稳定哈希，重复执行种子脚本天然幂等 */
export function albumGroupIdOf(name: string): string {
  return 'grp_' + createHash('sha1').update(name).digest('hex').slice(0, 16);
}

/**
 * 内置的「默认分组」名。
 * 【为什么需要它】删除分组时册不能悬空，必须落到一个永远存在的分组里，
 * 这个分组就是「默认分组」；后台新建相册未选分组时也归入它。
 */
export const DEFAULT_GROUP_NAME = '默认分组';

/** 默认分组的固定 id（由名字派生，因此种子脚本与运行时服务算出的必是同一个） */
export const DEFAULT_GROUP_ID = albumGroupIdOf(DEFAULT_GROUP_NAME);
