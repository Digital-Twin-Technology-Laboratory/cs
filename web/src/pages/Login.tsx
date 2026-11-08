import { App, Button, Card, Form, Input } from 'antd';
import { LockOutlined, UserOutlined } from '@ant-design/icons';
import { Link, Navigate, useLocation } from 'react-router-dom';
import { useState } from 'react';
import { api } from '../api';
import { useAuth } from '../auth';
import type { User } from '../types';

export function AuthTitle({ sub }: { sub: string }) {
  const { site } = useAuth();
  return (
    <div className="auth-title">
      <span className="brand-mark" style={{ width: 40, height: 40, fontSize: 20, borderRadius: 8 }}>
        纲
      </span>
      <h1>{site?.siteName}</h1>
      <p>{sub}</p>
    </div>
  );
}

export default function Login() {
  const { user, setUser, site } = useAuth();
  const loc = useLocation();
  const { message } = App.useApp();
  const [loading, setLoading] = useState(false);
  const redirectTo = (loc.state as { from?: string } | null)?.from || '/';

  const onFinish = async (v: { username: string; password: string }) => {
    setLoading(true);
    try {
      const r = await api.post<{ user: User }>('/api/auth/login', v);
      setUser(r.user);
    } catch (e) {
      message.error((e as Error).message);
    } finally {
      setLoading(false);
    }
  };

  if (user) return <Navigate to={user.must_change_password ? '/change-password' : redirectTo} replace />;
  const canRegister = !site?.hasUsers || site.registrationMode !== 'closed';

  return (
    <div className="auth-wrap">
      <div className="auth-card">
        <AuthTitle sub="教学大纲按检查清单进行 AI 检查，生成可下载的检查结果" />
        <Card>
          <Form layout="vertical" onFinish={onFinish} requiredMark={false} size="large">
            <Form.Item name="username" rules={[{ required: true, message: '请输入工号、姓名或用户名' }]}>
              <Input prefix={<UserOutlined />} placeholder="工号 / 姓名 / 用户名" autoComplete="username" autoFocus />
            </Form.Item>
            <Form.Item name="password" rules={[{ required: true, message: '请输入密码' }]}>
              <Input.Password prefix={<LockOutlined />} placeholder="密码" autoComplete="current-password" />
            </Form.Item>
            <Button type="primary" htmlType="submit" block loading={loading}>
              登录
            </Button>
          </Form>
          <div className="muted small" style={{ marginTop: 12 }}>
            使用工号或姓名加密码登录；同名请使用工号。初始密码由管理员提供，首次登录后须修改密码。忘记密码请联系管理员。
          </div>
          <div style={{ textAlign: 'center', marginTop: 16 }} className="muted small">
            {canRegister ? (
              <>
                还没有账号？<Link to="/register">注册</Link>
              </>
            ) : (
              '当前未开放注册，如需账号请联系管理员'
            )}
          </div>
        </Card>
      </div>
    </div>
  );
}
