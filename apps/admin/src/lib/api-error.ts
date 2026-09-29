/**
 * apps/admin/src/lib/api-error.ts
 *
 * sdk 的通用 request 把所有非 2xx 压成 `new Error('API 状态码: 路径')`，
 * 消息体（如后端 409 的具体原因）无法获取。业务上只需要区分「是哪一类失败」，
 * 因此这里从错误消息中提取状态码，页面据此给出不同的提示文案。
 */

/** 取错误里的 HTTP 状态码；不是 API 错误（如 fetch 网络失败）时返回 null */
export function apiStatus(error: unknown): number | null {
  if (!(error instanceof Error)) return null;
  const matched = error.message.match(/^API (\d{3})/);
  return matched ? Number(matched[1]) : null;
}