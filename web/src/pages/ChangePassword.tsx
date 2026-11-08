import { Alert, App, Button, Card, Form, Input } from 'antd';
import { useState } from 'react';
import { api } from '../api';
import { useAuth } from '../auth';
import { AuthTitle } from './Login';
import type { User } from '../types';

export default function ChangePassword() {
  const { user, setUser, logout } = useAuth();
  const { message } = App.useApp();
  const [loading, setLoading] = useState(false);

  const save = async (values: { oldPassword: string; newPassword: string }) => {
    setLoading(true);
    try {
      const result = await api.put<{ user: User }>('/api/auth/password', values);
      setUser(result.user);
      message.success('密码已修改');
    } catch (e) {
      message.error((e as Error).message);
    } finally {
      setLoading(false);
    }
  };

  return <div className="auth-wrap"><div className="auth-card">
    <AuthTitle sub="修改初始密码" />
    <Card>
      <Alert type="info" showIcon title={`${user?.name}，请先修改初始密码`}
        description="修改完成后才能进入系统。新密码不能与原密码相同。" style={{ marginBottom: 20 }} />
      <Form layout="vertical" onFinish={save} requiredMark={false} size="large">
        <Form.Item label="原密码" name="oldPassword" rules={[{ required: true, message: '请输入原密码' }]}>
          <Input.Password autoComplete="current-password" />
        </Form.Item>
        <Form.Item label="新密码" name="newPassword" rules={[{ required: true, message: '请输入新密码' }, { min: 8, max: 64, message: '密码须为8–64位' }]}>
          <Input.Password autoComplete="new-password" />
        </Form.Item>
        <Form.Item label="确认新密码" name="confirm" dependencies={['newPassword']} rules={[
          { required: true, message: '请再次输入新密码' },
          ({ getFieldValue }) => ({ validator: (_, value) => !value || value === getFieldValue('newPassword') ? Promise.resolve() : Promise.reject(new Error('两次输入的密码不一致')) }),
        ]}>
          <Input.Password autoComplete="new-password" />
        </Form.Item>
        <Button type="primary" htmlType="submit" block loading={loading}>修改密码并进入系统</Button>
        <Button block style={{ marginTop: 12 }} disabled={loading} onClick={logout}>退出登录</Button>
      </Form>
    </Card>
  </div></div>;
}
