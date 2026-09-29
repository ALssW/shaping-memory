/**
 * apps/web/src/components/AccountPanel.tsx
 *
 * 前台账号面板：未登录是登录表单，登录后是当前账号 + 退出。
 * 从顶栏的账号图标唤出，只认右上角关闭按钮收口（与搜索面板同一套交互语义）。
 *
 * 【登录为什么放前台】需求 4：admin 在前台登录后获得照片编辑能力。
 * 登录态落 lib/session（localStorage 持久化），编辑入口据此显隐。
 */
import { useState } from 'react';
import { authApi } from '@shaping-memory/sdk';

import type { FrontSession } from '../lib/session';
import { saveSession } from '../lib/session';
import { Icon } from './Icon';

interface AccountPanelProps {
  session: FrontSession | null;
  /** 登录成功后把会话交给上层（上层据此决定编辑入口显隐） */
  onLogin: (session: FrontSession) => void;
  /** 退出后回调（上层清空会话） */
  onLogout: () => void;
  /** 关闭：唯一收口 */
  onClose: () => void;
}

export function AccountPanel({ session, onLogin, onLogout, onClose }: AccountPanelProps) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const canSubmit = username.trim().length > 0 && password.length > 0 && !submitting;

  const handleSubmit = async (): Promise<void> => {
    if (!canSubmit) return;
    setSubmitting(true);
    setError(null);
    try {
      const result = await authApi.login(username.trim(), password);
      // sdk 已把 token 写入内存，这里再落到的前端会话（含角色/用户名）里
      const next = { token: result.token, username: result.username, role: result.role };
      saveSession(next);
      onLogin(next);
      setUsername('');
      setPassword('');
    } catch (err) {
      // 不区分「用户不存在」与「密码错误」，避免向试探者泄露账号是否存在
      setError(err instanceof Error ? err.message : '登录失败');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <section className="account-panel" role="dialog" aria-label="账号">
      {session ? (
        <div className="account-panel__signed">
          <div className="account-panel__who">
            <span className="account-panel__icon">
              <Icon name="user" />
            </span>
            <div className="account-panel__meta">
              <b className="account-panel__name">{session.username}</b>
              <span className="account-panel__role">
                {session.role === 'admin' ? '管理员 · 已开放前台编辑' : session.role}
              </span>
            </div>
          </div>
          <button type="button" className="account-panel__logout" onClick={onLogout}>
            <Icon name="logout" />
            退出登录
          </button>
        </div>
      ) : (
        <form
          className="account-panel__form"
          onSubmit={(event) => {
            event.preventDefault();
            void handleSubmit();
          }}
        >
          <label className="search-field">
            <span className="search-field__label">账号</span>
            <input
              className="search-input"
              value={username}
              onChange={(event) => setUsername(event.target.value)}
              autoComplete="username"
              placeholder="admin"
            />
          </label>
          <label className="search-field">
            <span className="search-field__label">密码</span>
            <input
              className="search-input"
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              autoComplete="current-password"
              placeholder="请输入密码"
            />
          </label>
          {error ? <p className="account-panel__error">{error}</p> : null}
          <button type="submit" className="search-action is-primary" disabled={!canSubmit}>
            {submitting ? '登录中…' : '登录'}
          </button>
        </form>
      )}

      <button type="button" className="search-panel__close" aria-label="关闭账号面板" onClick={onClose}>
        <Icon name="close" />
      </button>
    </section>
  );
}