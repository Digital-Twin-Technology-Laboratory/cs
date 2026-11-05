import { App, Button, Card, Form, Input, Modal, Popconfirm, Select, Space, Table, Tag } from 'antd';
import { PlusOutlined } from '@ant-design/icons';
import { useCallback, useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { api, qs } from '../../api';
import { useAuth } from '../../auth';
import { UserStatusTag } from '../../components/StatusTag';
import type { User } from '../../types';

type Row = User & { course_count: number; submission_count: number };

export default function Users() {
  const { user: me } = useAuth();
  const nav = useNavigate();
  const { message } = App.useApp();
  const [params] = useSearchParams();
  const [filter, setFilter] = useState({ q: '', status: params.get('status') ?? '', role: '' });
  const [page, setPage] = useState(1);
  const [data, setData] = useState<{ total: number; rows: Row[] }>({ total: 0, rows: [] });
  const [loading, setLoading] = useState(false);
  const [creating, setCreating] = useState(false);
  const [resetting, setResetting] = useState<Row | null>(null);
  const [createForm] = Form.useForm();
  const [pwForm] = Form.useForm();

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setData(await api.get(`/api/admin/users?${qs({ ...filter, page, pageSize: 20 })}`));
    } finally {
      setLoading(false);
    }
  }, [filter, page]);
  useEffect(() => {
    load();
  }, [load]);

  const act = async (fn: () => Promise<unknown>, ok: string) => {
    try {
      await fn();
      message.success(ok);
      load();
    } catch (e) {
      message.error((e as Error).message);
    }
  };
  const update = (u: Row, patch: Partial<User>, ok: string) => act(() => api.put(`/api/admin/users/${u.id}`, patch), ok);

  const create = async () => {
    const v = await createForm.validateFields();
    await act(() => api.post('/api/admin/users', v), '账号已创建');
    setCreating(false);
    createForm.resetFields();
  };

  const resetPw = async () => {
    const v = await pwForm.validateFields();
    await act(() => api.post(`/api/admin/users/${resetting!.id}/reset-password`, v), '密码已重置');
    setResetting(null);
    pwForm.resetFields();
  };

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>用户管理</h1>
          <div className="sub">审核注册、启用/停用账号、设置管理员、重置密码，查看各账号的课程与文件</div>
        </div>
        <Button type="primary" icon={<PlusOutlined />} onClick={() => setCreating(true)}>
          新建账号
        </Button>
      </div>
      <Card styles={{ body: { padding: 0 } }}>
        <Space wrap style={{ padding: 16 }}>
          <Input.Search placeholder="用户名 / 姓名 / 部门" allowClear onSearch={(q) => (setPage(1), setFilter((f) => ({ ...f, q })))} style={{ width: 240 }} />
          <Select
            value={filter.status}
            onChange={(status) => (setPage(1), setFilter((f) => ({ ...f, status })))}
            style={{ width: 130 }}
            options={[
              { value: '', label: '全部状态' },
              { value: 'pending', label: '待审核' },
              { value: 'active', label: '正常' },
              { value: 'disabled', label: '已停用' },
            ]}
          />
          <Select
            value={filter.role}
            onChange={(role) => (setPage(1), setFilter((f) => ({ ...f, role })))}
            style={{ width: 130 }}
            options={[
              { value: '', label: '全部角色' },
              { value: 'admin', label: '管理员' },
              { value: 'user', label: '普通用户' },
            ]}
          />
        </Space>
        <Table
          rowKey="id"
          loading={loading}
          dataSource={data.rows}
          scroll={{ x: 1100 }}
          pagination={{ current: page, pageSize: 20, total: data.total, onChange: setPage, showTotal: (t) => `共 ${t} 个账号` }}
          columns={[
            { title: '用户名', dataIndex: 'username', render: (v, r) => <>{v} {r.id === me?.id && <Tag>我</Tag>}</> },
            { title: '姓名', dataIndex: 'name' },
            { title: '部门', dataIndex: 'department' },
            { title: '角色', dataIndex: 'role', width: 90, render: (v) => (v === 'admin' ? <Tag color="blue">管理员</Tag> : '普通用户') },
            { title: '状态', dataIndex: 'status', width: 90, render: (v) => <UserStatusTag status={v} /> },
            {
              title: '课程 / 检查',
              width: 110,
              render: (_, r) => (
                <Button type="link" size="small" style={{ padding: 0 }} onClick={() => nav(`/admin/records?userId=${r.id}&tab=submissions`)}>
                  {r.course_count} / {r.submission_count}
                </Button>
              ),
            },
            { title: '注册时间', dataIndex: 'created_at', width: 165 },
            { title: '最近登录', dataIndex: 'last_login_at', width: 165, render: (v) => v || '—' },
            {
              title: '操作',
              width: 300,
              fixed: 'right',
              render: (_, r) => {
                const self = r.id === me?.id;
                return (
                  <Space size={0} wrap>
                    {r.status === 'pending' && (
                      <Button type="link" size="small" onClick={() => update(r, { status: 'active' }, '已审核通过')}>
                        审核通过
                      </Button>
                    )}
                    {r.status === 'active' && !self && (
                      <Popconfirm title="停用后该账号将无法登录，确定停用？" onConfirm={() => update(r, { status: 'disabled' }, '已停用')}>
                        <Button type="link" size="small">
                          停用
                        </Button>
                      </Popconfirm>
                    )}
                    {r.status === 'disabled' && (
                      <Button type="link" size="small" onClick={() => update(r, { status: 'active' }, '已启用')}>
                        启用
                      </Button>
                    )}
                    {!self &&
                      (r.role === 'admin' ? (
                        <Popconfirm title="取消该账号的管理员权限？" onConfirm={() => update(r, { role: 'user' }, '已取消管理员')}>
                          <Button type="link" size="small">
                            取消管理员
                          </Button>
                        </Popconfirm>
                      ) : (
                        <Popconfirm title="设为管理员后可管理整个网站，确定？" onConfirm={() => update(r, { role: 'admin' }, '已设为管理员')}>
                          <Button type="link" size="small">
                            设为管理员
                          </Button>
                        </Popconfirm>
                      ))}
                    <Button type="link" size="small" onClick={() => setResetting(r)}>
                      重置密码
                    </Button>
                    {!self && (
                      <Popconfirm
                        title="删除账号"
                        description={`将同时删除该账号的 ${r.course_count} 门课程、${r.submission_count} 次检查记录及全部上传文件，且无法恢复。`}
                        okText="确认删除"
                        okButtonProps={{ danger: true }}
                        onConfirm={() => act(() => api.del(`/api/admin/users/${r.id}`), '账号已删除')}
                      >
                        <Button type="link" size="small" danger>
                          删除
                        </Button>
                      </Popconfirm>
                    )}
                  </Space>
                );
              },
            },
          ]}
        />
      </Card>

      <Modal title="新建账号" open={creating} onOk={create} onCancel={() => setCreating(false)} okText="创建" destroyOnHidden>
        <Form form={createForm} layout="vertical" initialValues={{ role: 'user' }} preserve={false}>
          <Form.Item label="用户名" name="username" rules={[{ required: true, pattern: /^[A-Za-z0-9_.@-]{3,32}$/, message: '3–32位字母、数字或 _ . @ -' }]}>
            <Input />
          </Form.Item>
          <Form.Item label="姓名" name="name" rules={[{ required: true, message: '请输入姓名' }]}>
            <Input />
          </Form.Item>
          <Form.Item label="部门" name="department">
            <Input />
          </Form.Item>
          <Form.Item label="初始密码" name="password" rules={[{ required: true, min: 8, message: '密码至少8位' }]}>
            <Input.Password autoComplete="new-password" />
          </Form.Item>
          <Form.Item label="角色" name="role">
            <Select options={[{ value: 'user', label: '普通用户' }, { value: 'admin', label: '管理员' }]} />
          </Form.Item>
        </Form>
      </Modal>

      <Modal title={`重置密码：${resetting?.name ?? ''}（${resetting?.username ?? ''}）`} open={!!resetting} onOk={resetPw} onCancel={() => setResetting(null)} okText="重置" destroyOnHidden>
        <Form form={pwForm} layout="vertical" preserve={false}>
          <Form.Item label="新密码" name="password" rules={[{ required: true, min: 8, message: '密码至少8位' }]}>
            <Input.Password autoComplete="new-password" />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  );
}
