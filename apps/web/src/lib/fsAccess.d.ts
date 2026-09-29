/**
 * apps/web/src/lib/fsAccess.d.ts
 *
 * 补上 `window.showDirectoryPicker` 的类型声明。
 *
 * 【为什么必须自己声明】TypeScript 5.6 的 lib.dom 里已经有 FileSystemDirectoryHandle /
 * getFileHandle / createWritable，唯独 `showDirectoryPicker` 还没进 DOM 类型 —— 而这个方法
 * 正是「导出到自选目录」的唯一入口。与其把 window 整体断言成 any（会连带丢掉所有类型检查），
 * 不如在这里精确补齐一处。
 *
 * 【运行时不保证存在】Firefox / Safari 至今未实现该 API，因此调用前一律先
 * `isDirectorySupported()`，不支持就走逐个下载回落。
 */

interface Window {
  showDirectoryPicker?(options?: {
    mode?: 'read' | 'readwrite';
    /** 记住上次选过的目录，用户第二次导出少点两下 */
    id?: string;
  }): Promise<FileSystemDirectoryHandle>;
}