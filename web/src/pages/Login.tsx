import { App, Button, Card, Form, Input, Segmented } from 'antd';
import { LockOutlined, UserOutlined } from '@ant-design/icons';
import { Link, useLocation, useNavigate } from 'react-router-dom';
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
  const { setUser, site } = useAuth();
  const nav = useNavigate();
  const loc = useLocation();
  const { message } = App.useApp();
  const [loading, setLoading] = useState(false);
  const [mode, setMode] = useState<'staff' | 'password'>('staff');

  const onFinish = async (v: { username: string; password?: string }) => {
    setLoading(true);
    try {
      const r = await api.post<{ user: User }>('/api/auth/login', mode === 'staff' ? { username: v.username } : v);
      setUser(r.user);
      nav((loc.state as { from?: string } | null)?.from || '/', { replace: true });
    } catch (e) {
      message.error((e as Error).message);
    } finally {
      setLoading(false);
    }
  };

  const canRegister = !site?.hasUsers || site.registrationMode !== 'closed';

  return (
    <div className="auth-wrap">
      <div className="auth-card">
        <AuthTitle sub="教学大纲按检查清单进行 AI 检查，生成修改清单" />
        <Card>
          <Segmented
            block
            size="large"
            value={mode}
            onChange={setMode}
            options={[{ label: '教工登录', value: 'staff' }, { label: '账号密码登录', value: 'password' }]}
            style={{ marginBottom: 20 }}
          />
          <Form layout="vertical" onFinish={onFinish} requiredMark={false} size="large">
            <Form.Item name="username" rules={[{ required: true, message: mode === 'staff' ? '请输入工号或姓名' : '请输入用户名' }]}>
              <Input prefix={<UserOutlined />} placeholder={mode === 'staff' ? '工号或姓名' : '用户名'} autoComplete="username" autoFocus />
            </Form.Item>
            {mode === 'password' && (
              <Form.Item name="password" preserve={false} rules={[{ required: true, message: '请输入密码' }]}>
                <Input.Password prefix={<LockOutlined />} placeholder="密码" autoComplete="current-password" />
              </Form.Item>
            )}
            <Button type="primary" htmlType="submit" block loading={loading}>
              登录
            </Button>
          </Form>
          {mode === 'staff' && <div className="muted small" style={{ marginTop: 12 }}>名单内教工无需密码，输入工号或姓名即可登录；同名请使用工号。</div>}
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
