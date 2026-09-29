/**
 * apps/web/src/components/PhotoMask.tsx
 *
 * 照片悬浮蒙版：标题 / 器材行（相机型号 + 格式）/ 拍摄时间 + 分辨率 / 底行（曝光参数 + 标签）。
 * 拍摄地点另挂在照片右上角（见下）。
 *
 * 【信息分层】视觉上分四段，从「是什么」到「什么时候拍的」再到「怎么拍的、怎么归类」：
 *   1) 标题          —— 唯一的实体名，字号最大
 *   2) 器材行        —— 相机型号在格式左侧（机身 → 容器），构成固定顺序
 *   3) 地点 + 时间   —— 地点在墙面上被钉到照片右上角（绝对定位 + 玻璃底，见 app.css），
 *                       时间与分辨率留在这一行并**统一左对齐**：位置固定、
 *                       不跟着右侧标签的疏密忽左忽右
 *   4) 曝光 + 标签   —— 同处底行：曝光在左（读的是数值，靠 mono 字体区分），
 *                       标签在右（读的是归类），两者各占一端
 *
 * 【地点为什么不从 DOM 里挪出去】列表卡片没有「照片角落」可钉，地点仍要留在
 * 时间左侧那一行里。于是 DOM 只写一份，靠各自的 CSS 决定它是角标还是行内项 ——
 * 墙面绝对定位、列表复位成 static（见 app.css 的 .list-card__meta .photo-card__place）。
 *
 * 墙面卡片与列表卡片是同一张照片的两种排布，信息内容与顺序必须一致，
 * 所以抽成一份 —— 两处各写一遍迟早会不一致。两者的外壳差异（压在照片上的渐变蒙版 /
 * 照片下方的文本块）由各自的 CSS 覆盖，这里只输出结构。
 * 显隐由各自的 :hover 规则控制，淡入淡出由父级（Motion）驱动，因此这里不带任何动画。
 */
import { approvedTagNames, formatDate, resolutionOf } from '@shaping-memory/core';
import type { Photo } from '@shaping-memory/core';

import { Icon } from './Icon';

export function PhotoMask({ photo }: { photo: Photo }) {
  // 曝光参数：真实照片个别字段（如 ISO）可能缺失，过滤空项再拼，避免出现「··ISO」这种空段
  const exposure = [photo.focal, photo.aperture, photo.speed, photo.iso != null ? `ISO ${photo.iso}` : '']
    .filter(Boolean)
    .join(' · ');
  // 像素分辨率：缺失时为空串，那一栏就不渲染
  const resolution = resolutionOf(photo);
  // 前台只展示「已生效」的标签：待审的是低置信度猜测，没经人工确认前不该出现在公开页面上
  const tags = approvedTagNames(photo.tags);

  return (
    <div className="photo-card__mask">
      <div className="photo-card__title">{photo.title}</div>

      {(photo.cam || photo.format) && (
        <div className="photo-card__gear">
          <span className="photo-card__cam">{photo.cam}</span>
          <span className="photo-card__format">{photo.format}</span>
        </div>
      )}

      {/* 拍摄时间 / 分辨率共处一行且**统一居左**：时间（什么时候拍的，检索主线索）
          → 分辨率（mono，与曝光参数同属「数值类」）。两项都缺失时才整行不渲染。
          地点也在这行里 —— 但墙面形态下它被 CSS 钉到照片右上角，只有列表卡片才看得见它排在时间左侧，
          因此这一行的渲染条件仍然把 place 算进去（它缺席时不会凭空多出一条空行）。 */}
      {photo.place || photo.date || resolution ? (
        <div className="photo-card__daterow">
          {/* 拍摄地点：墙面是照片右上角的玻璃胶囊（绝对定位，见 app.css），
              列表卡片里则是时间左侧的一枚定位图标 + 地名，两者共用这一份 DOM。 */}
          {photo.place ? (
            <span className="photo-card__place">
              <Icon name="pin" />
              <span className="photo-card__place-text">{photo.place}</span>
            </span>
          ) : null}
          {photo.date ? (
            <time className="photo-card__date" dateTime={photo.date}>
              {formatDate(photo.date)}
            </time>
          ) : null}
          {resolution ? <span className="photo-card__resolution">{resolution}</span> : null}
        </div>
      ) : null}

      {/* 底行：曝光参数在左、标签在右 —— 数值与归类各占一端，互不干扰 */}
      {(exposure || tags.length > 0) && (
        <div className="photo-card__foot">
          {exposure && <span className="photo-card__exposure">{exposure}</span>}
          {tags.length > 0 && (
            <ul className="photo-card__tags">
              {tags.map((tag) => (
                <li key={tag} className="photo-card__tag">
                  #{tag}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}