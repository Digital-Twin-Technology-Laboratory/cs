import { App, Button, Card, Descriptions, Form, Input, Space } from 'antd';
import { api } from '../../api';
import { useAuth } from '../../auth';
import type { User } from '../../types';

export default function Profile() {
  const { user, setUser } = useAuth();
  const { message } = App.useApp();
  const [pwForm] = Form.useForm();

  const saveInfo = async (v: { name: string; department: string }) => {
    try {
      const r = await api.put<{ user: User }>('/api/auth/profile', v);
      setUser(r.user);
      message.success('已保存');
    } catch (e) {
      message.error((e as Error).message);
    }
  };

  const savePw = async (v: { oldPassword: string; newPassword: string }) => {
    try {
      await api.put('/api/auth/password', v);
      message.success('密码已修改');
      pwForm.resetFields();
    } catch (e) {
      message.error((e as Error).message);
    }
  };

  return (
    <div className="page page-narrow">
      <div className="page-head">
        <h1>个人设置</h1>
      </div>
      <Space orientation="vertical" size={16} style={{ width: '100%' }}>
        <Card title="账号信息">
          <Descriptions size="small" column={1} style={{ marginBottom: 16 }}>
            <Descriptions.Item label="用户名">{user?.username}</Descriptions.Item>
            <Descriptions.Item label="角色">{user?.role === 'admin' ? '管理员' : '普通用户'}</Descriptions.Item>
            <Descriptions.Item label="注册时间">{user?.created_at}</Descriptions.Item>
          </Descriptions>
          <Form layout="vertical" initialValues={{ name: user?.name, department: user?.department }} onFinish={saveInfo}>
            <Form.Item label="姓名" name="name" rules={[{ required: true, message: '请输入姓名' }]}>
              <Input maxLength={50} />
            </Form.Item>
            <Form.Item label="所在部门 / 系部" name="department">
              <Input maxLength={100} />
            </Form.Item>
            <Button type="primary" htmlType="submit">
              保存
            </Button>
          </Form>
        </Card>
        <Card title="修改密码">
          <Form form={pwForm} layout="vertical" onFinish={savePw}>
            <Form.Item label="原密码" name="oldPassword" rules={[{ required: true, message: '请输入原密码' }]}>
              <Input.Password autoComplete="current-password" />
            </Form.Item>
            <Form.Item label="新密码" name="newPassword" rules={[{ required: true, message: '请输入新密码' }, { min: 8, message: '密码至少8位' }]}>
              <Input.Password autoComplete="new-password" />
            </Form.Item>
            <Form.Item
              label="确认新密码"
              name="confirm"
              dependencies={['newPassword']}
              rules={[
                { required: true, message: '请再次输入新密码' },
                ({ getFieldValue }) => ({
                  validator: (_, v) => (!v || v === getFieldValue('newPassword') ? Promise.resolve() : Promise.reject(new Error('两次输入的密码不一致'))),
                }),
              ]}
            >
              <Input.Password autoComplete="new-password" />
            </Form.Item>
            <Button type="primary" htmlType="submit">
              修改密码
            </Button>
          </Form>
        </Card>
      </Space>
    </div>
  );
}
