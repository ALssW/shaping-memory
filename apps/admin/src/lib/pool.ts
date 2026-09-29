/**
 * apps/admin/src/lib/pool.ts
 *
 * 通用并发池：固定 limit 个 worker 从同一队列里取任务，队列为空时即结束。
 * 分片上传（chunkUpload）与多文件并发上传（FolderUploadModal）共用这一份调度。
 *
 * 【任务为什么不往外抛异常】worker 自身把失败转成返回值（如「该分片未传输成功」），
 * 并发池只负责任务调度 —— 否则任一任务抛出异常会使 Promise.all 提前结束，队列中剩余任务无人处理，
 * 表现形式即为「仅一张失败，其余全部未上传」。
 *
 * 【为什么用共享游标而不是数组切片】任务数可能有数千，切片会不断复制数组；
 * 自增游标是 O(1)，且在取号时即固定「哪个任务由谁领取」。
 */
export async function runPool<T>(
  items: readonly T[],
  limit: number,
  worker: (item: T) => Promise<void>,
): Promise<void> {
  let cursor = 0;
  // items 为空时也要留一个 worker 立即结束，避免调用方为「空批次」编写特判
  const workerCount = Math.max(1, Math.min(limit, items.length));
  const workers = Array.from({ length: workerCount }, async () => {
    for (;;) {
      const index = cursor;
      cursor += 1;
      if (index >= items.length) return;
      await worker(items[index]!);
    }
  });
  await Promise.all(workers);
}