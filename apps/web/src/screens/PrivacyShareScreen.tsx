/**
 * apps/web/src/screens/PrivacyShareScreen.tsx
 *
 * 隐私照片的「时效链接 + 提取码」查看页（需求 4c：链接分享授权 & 提取码双重校验）。
 *
 * 【两条腿各自管什么】
 *   - 链接本身：带 token，决定「这批照片可以被看」以及「到什么时候为止」；
 *   - 提取码：链接被人转发出去后，仍需要知道那 4~6 位数字才拿得到照片。
 * 因此打开链接先只做「验链接」这一步：要么直接拿到照片，要么被告知要提取码。
 *
 * 【拿到的照片为什么已经是清晰图】地址由后端拼好（见 PhotosService.toApi），
 * 票据（pt）就嵌在里面 —— 这个页面从不自己拼图片地址，也就没有拼漏的可能。
 */
import { useCallback, useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import { photoAspect, placeholderColors } from '@shaping-memory/core';
import type { Photo } from '@shaping-memory/core';
import { privacyApi } from '@shaping-memory/sdk';

import { Icon } from '../components/Icon';
import { ProgressiveImage } from '../components/ProgressiveImage';

/** 打开链接的四种结果；loading 与 invalid 之外的两种都要给出明确的下一步 */
type Phase = 'loading' | 'needCode' | 'invalid' | 'ready';

interface PrivacyShareScreenProps {
  /** 链接里的 token；缺失（如手输 #privacy-share）直接判为无效 */
  token: string;
}

export function PrivacyShareScreen({ token }: PrivacyShareScreenProps) {
  const [phase, setPhase] = useState<Phase>(token ? 'loading' : 'invalid');
  const [photos, setPhotos] = useState<readonly Photo[]>([]);
  const [expiresAt, setExpiresAt] = useState<string | null>(null);
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  /** 取照片：不带 code 时若后端要提取码，会回 needCode；带 code 则是校验那一次 */
  const load = useCallback(
    async (withCode?: string) => {
      if (!token) return;
      setBusy(true);
      try {
        const result = await privacyApi.openShare(token, withCode);
        if (result.status === 'ok') {
          setPhotos(result.photos);
          setExpiresAt(result.expiresAt);
          setError(null);
          setPhase('ready');
          return;
        }
        if (result.status === 'needCode') {
          // 提取码不对时后端同样回 needCode，因此这里要靠「是否这次带过 code」区分文案
          setError(withCode ? '提取码不正确，请重试' : null);
          setPhase('needCode');
          return;
        }
        // 非 2xx 且非 401：标题本身就是「链接无效或已过期」，不必再叠一句
        setError(null);
        setPhase('invalid');
      } catch {
        // 请求本身失败（断网 / 被中断）：必须在 finally 里复位 busy，
        // 否则按钮会永远停在「验证中…」，用户既看不到原因也无法重试
        setError(withCode ? '验证失败，请重试' : '网络异常，请稍后重试');
        setPhase(withCode ? 'needCode' : 'invalid');
      } finally {
        setBusy(false);
      }
    },
    [token],
  );

  useEffect(() => {
    void load();
  }, [load]);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!code || busy) return;
    void load(code);
  };

  return (
    <section className="module share">
      {phase === 'loading' ? <div className="empty-state">正在打开分享…</div> : null}

      {phase === 'invalid' ? (
        <div className="share__notice">
          <span className="share__notice-icon is-bad">
            <Icon name="lock" />
          </span>
          <h1 className="share__notice-title">链接无效或已过期</h1>
          <p className="share__hint">请向分享者索取新的链接。</p>
          {/* 网络层面的失败也落到这里：把具体原因说清楚，避免将网络失败误判为「无效」 */}
          {error ? <p className="unlock__error">{error}</p> : null}
        </div>
      ) : null}

      {phase === 'needCode' ? (
        <form className="share__notice" onSubmit={submit}>
          <span className="share__notice-icon">
            <Icon name="lock" />
          </span>
          <h1 className="share__notice-title">需要提取码</h1>
          <p className="share__hint">请输入分享者提供的 4~6 位提取码</p>
          <input
            className="unlock__input share__code"
            value={code}
            onChange={(event) => setCode(event.target.value.replace(/\D/g, '').slice(0, 6))}
            inputMode="numeric"
            autoComplete="one-time-code"
            placeholder="提取码"
            aria-label="提取码"
            autoFocus
          />
          {error ? <p className="unlock__error">{error}</p> : null}
          <button type="submit" className="unlock__btn is-primary share__submit" disabled={!code || busy}>
            {busy ? '验证中…' : '查看照片'}
          </button>
        </form>
      ) : null}

      {phase === 'ready' ? (
        <>
          <header className="share__head">
            <h1 className="share__notice-title">隐私照片分享</h1>
            <p className="share__hint">
              共 {photos.length} 张
              {expiresAt ? ` · 有效期至 ${formatExpiry(expiresAt)}` : ''}
            </p>
          </header>
          <div className="share__grid">
            {photos.map((photo) => (
              <figure className="share__item" key={photo.id} draggable={false}>
                <ProgressiveImage
                  src={photo.cardUrl ?? photo.url}
                  alt={photo.title}
                  aspect={photoAspect(photo)}
                  colors={placeholderColors(photo)}
                />
                <figcaption className="share__caption">{photo.title}</figcaption>
              </figure>
            ))}
          </div>
        </>
      ) : null}
    </section>
  );
}

/** 到期时间显示成「YYYY-MM-DD HH:mm」：分享页只需快速看出剩余时长，不必精确到秒 */
function formatExpiry(iso: string): string {
  const date = new Date(iso);
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}