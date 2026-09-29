/**
 * apps/admin/src/lib/privacy-modes.ts
 *
 * 隐私标记的显示口径（表格 Tag / 批量编辑下拉共用一份，避免两处各写一遍导致文案不一致）。
 *
 * 【两种取值不是一回事】照片上可能「没有任何单张标记」（标记值 inherit = 跟随全局默认），
 * 也可能显式标了 visible / blur / hidden。而 sdk 返回的 photo.privacy.mode 是**服务端判定后的有效策略**，
 * 只会是 visible / blur / hidden 三者之一；inherit 只作为后台编辑时的「取消单张标记」选项出现。
 */

/** 后台可选的单张隐私标记（含「跟随默认」） */
export type PrivacyMark = 'inherit' | 'visible' | 'blur' | 'hidden';

export const PRIVACY_MARK_LABEL: Record<PrivacyMark, string> = {
  inherit: '跟随默认',
  visible: '公开',
  blur: '模糊',
  hidden: '隐藏',
};

/**
 * Tag 颜色：inherit 灰（无单张标记）、visible 绿（可直接看）、blur 橙（模糊）、hidden 红（前台不出现）。
 * 颜色只表达「可见程度」，不做装饰。
 */
export const PRIVACY_MARK_COLOR: Record<PrivacyMark, string> = {
  inherit: 'default',
  visible: 'green',
  blur: 'orange',
  hidden: 'red',
};

/** 下拉选项（顺序 = 从最开放到最封闭） */
export const PRIVACY_MARK_OPTIONS: { value: PrivacyMark; label: string }[] = (
  ['inherit', 'visible', 'blur', 'hidden'] as PrivacyMark[]
).map((value) => ({ value, label: PRIVACY_MARK_LABEL[value] }));