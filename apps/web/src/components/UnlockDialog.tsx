/**
 * apps/web/src/components/UnlockDialog.tsx
 *
 * 隐私照片的密码解锁面板（从查看器里唤起，属于「模态面派生的浮层」）。
 *
 * 【密码走哪条路】看这张照片自己有没有独立密码：
 *   - 有（hasOwnPassword）→ 走 POST /privacy/photos/:id/unlock，只解开这一张；
 *   - 没有 → 走全局的 POST /privacy/unlock，解开「按全局策略被打糊」的全部照片。
 * 两者成功都返回同一形态的票据，写进 SDK 后由调用方广播一次解锁事件。
 *
 * 【为什么自己拉一次策略】「有没有全局密码」只有后端知道，而后端返回的是布尔量
 * （policy.hasPassword），不是哈希 —— 前端无法、也不该自己推断。因此挂载时读一次公开策略。
 */
import { useEffect, useState } from 'react';
import type { FormEvent, MouseEvent } from 'react';
import { privacyApi } from '@shaping-memory/sdk';
import type { PrivacyPolicy } from '@shaping-memory/sdk';
import type { Photo } from '@shaping-memory/core';

import { Icon } from './Icon';
import { notifyPrivacyUnlocked } from '../lib/privacy';

interface UnlockDialogProps {
  photo: Photo;
  onClose: () => void;
}

export function UnlockDialog({ photo, onClose }: UnlockDialogProps) {
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  /** null = 还没读到策略：此时先不急着下「没有可用密码」的结论，避免闪一下误导文案 */
  const [policy, setPolicy] = useState<PrivacyPolicy | null>(null);

  useEffect(() => {
    let cancelled = false;
    privacyApi
      .policy()
      .then((value) => {
        if (!cancelled) setPolicy(value);
      })
      .catch(() => {
        if (!cancelled) setPolicy(null);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  /** 这张有独立密码时优先用它；否则回落到全局密码 */
  const own = photo.privacy?.hasOwnPassword ?? false;
  const usable = own || (policy?.hasPassword ?? false);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!password || busy || !usable) return;
    setBusy(true);
    setError(null);
    try {
      if (own) await privacyApi.unlockPhoto(photo.id, password);
      else await privacyApi.unlock(password);
      // 票据已进 SDK：广播出去，各处的照片列表会带着它重新拉一次
      notifyPrivacyUnlocked();
      onClose();
    } catch {
      setError('密码不正确，请重试');
      setBusy(false);
    }
  };

  /** 面板内的点击不冒泡到背板，否则点输入框就等于点「关闭」 */
  const stop = (event: MouseEvent) => event.stopPropagation();

  return (
    <div className="unlock" role="dialog" aria-modal="true" aria-label="解锁隐私照片" onClick={onClose}>
      <form className="unlock__panel" onClick={stop} onSubmit={submit}>
        <span className="unlock__icon">
          <Icon name="lock" />
        </span>
        <h2 className="unlock__title">这张照片需要授权</h2>
        <p className="unlock__hint">
          {own ? '请输入这张照片的独立查看密码' : '请输入查看密码'}
          {photo.title ? ` · ${photo.title}` : ''}
        </p>
        <input
          className="unlock__input"
          type="password"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          placeholder="查看密码"
          autoFocus
          disabled={!usable || busy}
        />
        {policy && !usable ? (
          <p className="unlock__error">尚未配置查看密码，请联系管理员开通授权</p>
        ) : error ? (
          <p className="unlock__error">{error}</p>
        ) : null}
        <div className="unlock__actions">
          <button type="button" className="unlock__btn" onClick={onClose}>
            取消
          </button>
          <button type="submit" className="unlock__btn is-primary" disabled={!usable || !password || busy}>
            {busy ? '验证中…' : '解锁'}
          </button>
        </div>
      </form>
    </div>
  );
}