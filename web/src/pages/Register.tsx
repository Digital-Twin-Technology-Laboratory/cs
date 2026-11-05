import { Alert, App, Button, Card, Form, Input, Result } from 'antd';
import { Link, useNavigate } from 'react-router-dom';
import { useState } from 'react';
import { api } from '../api';
import { useAuth } from '../auth';
import type { User } from '../types';
import { AuthTitle } from './Login';

export default function Register() {
  const { site, setUser, refresh } = useAuth();
  const nav = useNavigate();
  const { message } = App.useApp();
  const [loading, setLoading] = useState(false);
  const [pending, setPending] = useState(false);

  const first = !site?.hasUsers;
  const closed = !first && site?.registrationMode === 'closed';

  const onFinish = async (v: Record<string, string>) => {
    setLoading(true);
    try {
      const r = await api.post<{ user: User | null; pending?: boolean; message: string }>('/api/auth/register', v);
      if (r.user) {
        message.success(r.message);
        setUser(r.user);
        await refresh();
        nav(r.user.role === 'admin' && first ? '/admin/ai' : '/', { replace: true });
      } else {
        setPending(true);
      }
    } catch (e) {
      message.error((e as Error).message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="auth-wrap">
      <div className="auth-card">
        <AuthTitle sub="注册账号" />
        <Card>
          {pending ? (
            <Result status="success" title="注册成功" subTitle="请等待管理员审核，审核通过后即可登录。" extra={<Link to="/login">返回登录</Link>} />
          ) : closed ? (
            <Result status="info" title="当前未开放注册" subTitle="如需账号，请联系管理员开通。" extra={<Link to="/login">返回登录</Link>} />
          ) : (
            <>
              {first && <Alert type="info" showIcon style={{ marginBottom: 16 }} title="系统尚无账号，第一个注册的账号将自动成为管理员。" />}
              {!first && site?.registrationMode === 'approval' && (
                <Alert type="info" showIcon style={{ marginBottom: 16 }} title="注册后需要管理员审核通过才能登录。" />
              )}
              <Form layout="vertical" onFinish={onFinish} requiredMark={false}>
                <Form.Item
                  label="用户名"
                  name="username"
                  extra="用于登录，可使用工号；3–32位字母、数字或 _ . @ -"
                  rules={[
                    { required: true, message: '请输入用户名' },
                    { pattern: /^[A-Za-z0-9_.@-]{3,32}$/, message: '3–32位字母、数字或 _ . @ -' },
                  ]}
                >
                  <Input autoComplete="username" />
                </Form.Item>
                <Form.Item label="姓名" name="name" rules={[{ required: true, message: '请输入姓名' }]}>
                  <Input />
                </Form.Item>
                <Form.Item label="所在部门 / 系部" name="department">
                  <Input placeholder="选填" />
                </Form.Item>
                <Form.Item label="密码" name="password" rules={[{ required: true, message: '请输入密码' }, { min: 8, message: '密码至少8位' }]}>
                  <Input.Password autoComplete="new-password" />
                </Form.Item>
                <Form.Item
                  label="确认密码"
                  name="confirm"
                  dependencies={['password']}
                  rules={[
                    { required: true, message: '请再次输入密码' },
                    ({ getFieldValue }) => ({
                      validator: (_, v) => (!v || v === getFieldValue('password') ? Promise.resolve() : Promise.reject(new Error('两次输入的密码不一致'))),
                    }),
                  ]}
                >
                  <Input.Password autoComplete="new-password" />
                </Form.Item>
                <Button type="primary" htmlType="submit" block loading={loading}>
                  注册
                </Button>
              </Form>
              <div style={{ textAlign: 'center', marginTop: 16 }} className="muted small">
                已有账号？<Link to="/login">登录</Link>
              </div>
            </>
          )}
        </Card>
      </div>
    </div>
  );
}
