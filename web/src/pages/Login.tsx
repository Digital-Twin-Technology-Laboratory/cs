import { App, Button, Card, Form, Input, Segmented } from 'antd';
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
  const { message, modal } = App.useApp();
  const [loading, setLoading] = useState(false);
  const [mode, setMode] = useState<'first' | 'password'>('password');
  const [redirectTo, setRedirectTo] = useState((loc.state as { from?: string } | null)?.from || '/');

  const onFinish = async (v: { username: string; password?: string; name?: string }) => {
    setLoading(true);
    try {
      const r = await api.post<{ user: User; initialPassword?: string }>('/api/auth/login', v);
      if (r.initialPassword) {
        setRedirectTo('/profile');
        modal.info({
          title: '首次登录成功',
          content: <div className="prose">您的初始密码是 <strong>{r.initialPassword}</strong>。<br />请在个人设置中修改密码。下次请使用工号或姓名，加上密码登录；同名时请使用工号。</div>,
          okText: '我知道了',
        });
      }
      setUser(r.user);
    } catch (e) {
      message.error((e as Error).message);
    } finally {
      setLoading(false);
    }
  };

  if (user) return <Navigate to={redirectTo} replace />;
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
            options={[{ label: '密码登录', value: 'password' }, { label: '教工首次登录', value: 'first' }]}
            style={{ marginBottom: 20 }}
          />
          <Form layout="vertical" onFinish={onFinish} requiredMark={false} size="large">
            <Form.Item name="username" rules={[{ required: true, message: mode === 'first' ? '请输入工号' : '请输入工号、姓名或用户名' }]}>
              <Input prefix={<UserOutlined />} placeholder={mode === 'first' ? '工号' : '工号 / 姓名 / 用户名'} autoComplete="username" autoFocus />
            </Form.Item>
            {mode === 'first' && (
              <Form.Item name="name" preserve={false} rules={[{ required: true, whitespace: true, message: '请输入姓名' }]}>
                <Input prefix={<UserOutlined />} placeholder="姓名（须与教工名单一致）" autoComplete="name" />
              </Form.Item>
            )}
            {mode === 'password' && (
              <Form.Item name="password" preserve={false} rules={[{ required: true, message: '请输入密码' }]}>
                <Input.Password prefix={<LockOutlined />} placeholder="密码" autoComplete="current-password" />
              </Form.Item>
            )}
            <Button type="primary" htmlType="submit" block loading={loading}>
              {mode === 'first' ? '首次登录并激活' : '登录'}
            </Button>
          </Form>
          <div className="muted small" style={{ marginTop: 12 }}>
            {mode === 'first' ? '仅限管理员导入且尚未激活的教工账号。首次须同时填写工号和姓名，登录后会告知初始密码。' : '已激活的教工使用工号或姓名加密码登录；同名请使用工号。忘记密码请联系管理员。'}
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
