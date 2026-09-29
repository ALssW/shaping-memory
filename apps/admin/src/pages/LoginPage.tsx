/**
 * apps/admin/src/pages/LoginPage.tsx
 *
 * 登录页：账号密码 → authApi.login。成功后 sdk 内部已 setAuthToken，
 * 这里只负责把结果交给上层持久化。
 */
import { useState } from 'react';
import { App, Button, Card, Form, Input, Typography } from 'antd';
import { authApi } from '@shaping-memory/sdk';
import type { Session } from '../lib/session';

interface LoginFormValues {
  username: string;
  password: string;
}

interface LoginPageProps {
  onLoggedIn: (session: Session) => void;
}

export function LoginPage({ onLoggedIn }: LoginPageProps) {
  const { message } = App.useApp();
  const [submitting, setSubmitting] = useState(false);

  const handleSubmit = async (values: LoginFormValues): Promise<void> => {
    setSubmitting(true);
    try {
      const result = await authApi.login(values.username.trim(), values.password);
      message.success(`登录成功，${result.username}`);
      onLoggedIn({ token: result.token, username: result.username, role: result.role });
    } catch (error) {
      // sdk 对登录失败只抛「账号或密码错误」，不区分「用户不存在」以免泄露账号是否存在
      message.error(error instanceof Error ? error.message : '登录失败');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="admin-login">
      <Card className="admin-login__card">
        <Typography.Title level={4} style={{ marginBottom: 4 }}>
          塑忆 · 后台管理
        </Typography.Title>
        <Typography.Paragraph className="t-ter" style={{ fontSize: 12, marginBottom: 20 }}>
          仅管理员 / 编辑可登录；修改拍摄参数只更新数据库记录，照片文件保持原样
        </Typography.Paragraph>
        <Form<LoginFormValues>
          layout="vertical"
          requiredMark={false}
          initialValues={{ username: '', password: '' }}
          onFinish={handleSubmit}
        >
          <Form.Item
            name="username"
            label="账号"
            rules={[{ required: true, message: '请输入账号' }]}
          >
            <Input autoComplete="username" placeholder="admin" allowClear />
          </Form.Item>
          <Form.Item
            name="password"
            label="密码"
            rules={[{ required: true, message: '请输入密码' }]}
          >
            <Input.Password autoComplete="current-password" placeholder="请输入密码" />
          </Form.Item>
          <Button type="primary" htmlType="submit" block loading={submitting}>
            登录
          </Button>
        </Form>
      </Card>
    </div>
  );
}
