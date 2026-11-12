import { Alert, App, Button, Card, Descriptions, Form, Input, InputNumber, Modal, Popconfirm, Select, Space, Tag, Upload } from 'antd';
import Table from '../../components/ResponsiveTable';
import { InboxOutlined, PlusOutlined, UploadOutlined } from '@ant-design/icons';
import type { UploadFile } from 'antd';
import { useCallback, useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { api, qs } from '../../api';
import { useAuth } from '../../auth';
import { UserStatusTag } from '../../components/StatusTag';
import type { CheckQuota, User } from '../../types';
import SupervisionRoles from './SupervisionRoles';

type Row = User & { course_count: number; submission_count: number; checkQuota: CheckQuota };

export default function Users() {
  const { user: me, refresh } = useAuth();
  const nav = useNavigate();
  const { message } = App.useApp();
  const [params] = useSearchParams();
  const [filter, setFilter] = useState({ q: '', status: params.get('status') ?? '', role: '' });
  const [page, setPage] = useState(1);
  const [data, setData] = useState<{ total: number; rows: Row[] }>({ total: 0, rows: [] });
  const [loading, setLoading] = useState(false);
  const [creating, setCreating] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [files, setFiles] = useState<UploadFile[]>([]);
  const [importing, setImporting] = useState(false);
  const [resetting, setResetting] = useState<Row | null>(null);
  const [granting, setGranting] = useState<Row | null>(null);
  const [grantingBusy, setGrantingBusy] = useState(false);
  const [leader, setLeader] = useState<Row | null>(null);
  const [leaderGroups, setLeaderGroups] = useState<string[]>([]);
  const [groupOptions, setGroupOptions] = useState<{ value: string; label: string }[]>([]);
  const [leaderBusy, setLeaderBusy] = useState(false);
  const [quotaForm] = Form.useForm();
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

  const editLeader = async (u: Row) => {
    try {
      const roles = await api.get<{
        groups: { group: string; userId: number | null }[];
        users: Pick<User, 'id' | 'name' | 'username'>[];
      }>('/api/admin/supervision-roles');
      setGroupOptions(roles.groups.map((g) => {
        const current = roles.users.find((person) => person.id === g.userId);
        return { value: g.group, label: `${g.group}${current && current.id !== u.id ? `（现任：${current.name} / ${current.username}）` : ''}` };
      }));
      setLeaderGroups(roles.groups.filter((g) => g.userId === u.id).map((g) => g.group));
      setLeader(u);
    } catch (e) {
      message.error((e as Error).message);
    }
  };

  const saveLeader = async () => {
    setLeaderBusy(true);
    try {
      await api.put(`/api/admin/users/${leader!.id}`, { led_groups: leaderGroups });
      message.success('课程组长权限已保存');
      setLeader(null);
      await load();
      await refresh();
    } catch (e) {
      message.error((e as Error).message);
    } finally {
      setLeaderBusy(false);
    }
  };

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

  const importRoster = async () => {
    const file = files[0]?.originFileObj;
    if (!file) return message.warning('请选择教工名单文件');
    const fd = new FormData();
    fd.append('file', file);
    setImporting(true);
    try {
      const result = await api.post<{ imported: number; skipped: number }>('/api/admin/users/import', fd);
      message.success(`已导入 ${result.imported} 个教工账号，跳过 ${result.skipped} 个已有工号`);
      setImportOpen(false);
      setFiles([]);
      load();
    } catch (e) {
      message.error((e as Error).message);
    } finally {
      setImporting(false);
    }
  };

  const grantQuota = async (values: { amount: number }) => {
    setGrantingBusy(true);
    try {
      await api.post(`/api/admin/users/${granting!.id}/check-quota`, values);
      message.success(`已为 ${granting!.name} 增加 ${values.amount} 次今日检查次数`);
      setGranting(null);
      await load();
      await refresh();
    } catch (e) {
      message.error((e as Error).message);
    } finally {
      setGrantingBusy(false);
    }
  };

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>用户管理</h1>
          <div className="sub">管理账号、导入教工名单和增加今日检查次数。展开用户可查看注册及登录信息。</div>
        </div>
        <Space wrap>
          <SupervisionRoles onChange={load} />
          <Button icon={<UploadOutlined />} onClick={() => setImportOpen(true)}>导入教工名单</Button>
          <Button type="primary" icon={<PlusOutlined />} onClick={() => setCreating(true)}>
            新建账号
          </Button>
        </Space>
      </div>
      <Card styles={{ body: { padding: 0 } }}>
        <Space wrap style={{ padding: 16 }}>
          <Input.Search placeholder="工号 / 用户名 / 姓名 / 部门" allowClear onSearch={(q) => (setPage(1), setFilter((f) => ({ ...f, q })))} style={{ width: 260 }} />
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
            style={{ width: 180 }}
            options={[
              { value: '', label: '全部角色' },
              { value: 'admin', label: '管理员' },
              { value: 'teaching', label: '教学条线（全院）' },
              { value: 'program', label: '专业负责人（全院）' },
              { value: 'group_leader', label: '课程组长' },
              { value: 'user', label: '普通教师' },
            ]}
          />
        </Space>
        <Table
          rowKey="id"
          loading={loading}
          dataSource={data.rows}
          expandable={{ expandedRowRender: (r) => <Descriptions size="small" column={{ xs: 1, sm: 3 }} items={[
            { key: 'login', label: '登录方式', children: r.role === 'admin' ? '用户名 + 密码' : '工号 / 姓名 + 密码' },
            { key: 'created', label: '注册时间', children: r.created_at },
            { key: 'last', label: '最近登录', children: r.last_login_at || '尚未登录' },
          ]} /> }}
          pagination={{ current: page, pageSize: 20, total: data.total, onChange: setPage, showTotal: (t) => `共 ${t} 个账号` }}
          columns={[
            { title: '用户', width: 210, render: (_, r) => <div><strong className="user-name" title={r.name}>{r.name}{r.id === me?.id && <Tag style={{ marginLeft: 8 }}>我</Tag>}</strong><div className="muted small">{r.username}</div></div> },
            { title: '部门', dataIndex: 'department', width: 120, render: (v) => v || '—' },
            { title: '账号状态', width: 140, render: (_, r) => <Space size={4} wrap>{r.role === 'admin' && <Tag color="blue">管理员</Tag>}<UserStatusTag status={r.status} /></Space> },
            {
              title: '监督身份', width: 200, render: (_, r) => <div>
                <Select<User['college_role'] | 'group_leader'>
                  value={r.college_role !== 'none' ? r.college_role : r.program_scopes.length ? 'program' : r.led_groups.length ? 'group_leader' : 'none'}
                  style={{ width: '100%' }}
                  aria-label={`${r.name}的监督身份`}
                  onSelect={(identity) => identity === 'group_leader'
                    ? editLeader(r)
                    : update(r, identity === 'none' ? { college_role: identity, led_groups: [] } : { college_role: identity }, '监督身份已更新')}
                  options={[
                    { value: 'none', label: '普通教师' },
                    { value: 'teaching', label: '教学条线（全院）' },
                    { value: 'program', label: '专业负责人（全院）' },
                    { value: 'group_leader', label: '课程组长' },
                  ]}
                />
                {r.led_groups.map((group) => <div key={group} className="muted small">课程组长：{group}</div>)}
                {r.program_scopes.map((professional) => <div key={professional} className="muted small">负责专业：{professional}</div>)}
                {r.led_groups.length > 0 && <Button type="link" size="small" style={{ padding: 0 }} onClick={() => editLeader(r)}>设置课程组</Button>}
                {(r.college_role === 'program' || r.program_scopes.length > 0) && <Button type="link" size="small" style={{ padding: 0 }} onClick={() => nav('/view-management')}>配置专业范围</Button>}
              </div>,
            },
            {
              title: '课程 / 检查',
              width: 110,
              render: (_, r) => (
                <Button type="link" size="small" style={{ padding: 0 }} onClick={() => nav(`/admin/records?userId=${r.id}&tab=submissions`)}>
                  {r.course_count} / {r.submission_count}
                </Button>
              ),
            },
            { title: '今日检查次数', width: 170, render: (_, r) => <div className="quota-cell"><b>剩余 {r.checkQuota.remaining} / {r.checkQuota.limit} 次</b><div className="muted small">已完成 {r.checkQuota.used} · 占用 {r.checkQuota.pending}</div><Button size="small" icon={<PlusOutlined />} onClick={() => { quotaForm.resetFields(); setGranting(r); }}>增加次数</Button></div> },
            {
              title: '操作',
              width: 200,
              render: (_, r) => {
                const self = r.id === me?.id;
                return (
                  <div className="user-actions">
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
                  </div>
                );
              },
            },
          ]}
        />
      </Card>

      <Modal
        title={`设置课程组长：${leader?.name ?? ''}（${leader?.username ?? ''}）`}
        open={!!leader}
        onOk={saveLeader}
        onCancel={() => setLeader(null)}
        okText="保存课程组长"
        confirmLoading={leaderBusy}
        cancelButtonProps={{ disabled: leaderBusy }}
        closable={!leaderBusy}
        maskClosable={!leaderBusy}
        destroyOnHidden
      >
        <Alert type="info" showIcon title="课程组长可与教学条线、专业负责人兼任"
          description="保存仅修改负责课程组，不改变全院监督身份。每组仅一位组长，选择已有组长的组将替换原负责人。清空后保存可取消课程组长身份。" style={{ marginBottom: 16 }} />
        <Select mode="multiple" allowClear showSearch optionFilterProp="label" style={{ width: '100%' }}
          aria-label="负责课程组" placeholder="请选择负责的课程组" options={groupOptions}
          value={leaderGroups} onChange={setLeaderGroups} disabled={leaderBusy} />
      </Modal>

      <Modal
        title={`增加今日检查次数：${granting?.name ?? ''}`}
        open={!!granting}
        onOk={() => quotaForm.submit()}
        onCancel={() => { if (!grantingBusy) setGranting(null); }}
        okText="确认增加"
        confirmLoading={grantingBusy}
        cancelButtonProps={{ disabled: grantingBusy }}
        destroyOnHidden
      >
        <Alert type="info" showIcon title="追加次数仅当天有效" description="次日恢复基础 5 次。检查失败不计次，排队和检查中的任务暂占名额。" style={{ marginBottom: 20 }} />
        <Form form={quotaForm} layout="vertical" initialValues={{ amount: 5 }} preserve={false} onFinish={grantQuota}>
          <Form.Item label="增加次数" name="amount" rules={[{ required: true, type: 'integer', min: 1, max: 1000, message: '请输入 1–1000 的整数' }]}>
            <InputNumber min={1} max={1000} precision={0} addonAfter="次" style={{ width: '100%' }} />
          </Form.Item>
        </Form>
      </Modal>

      <Modal
        title="导入教工名单"
        open={importOpen}
        onOk={importRoster}
        onCancel={() => { if (!importing) { setImportOpen(false); setFiles([]); } }}
        okText="导入名单"
        confirmLoading={importing}
        cancelButtonProps={{ disabled: importing }}
        destroyOnHidden
      >
        <Alert
          type="info"
          showIcon
          title="使用工号或姓名和初始密码登录"
          description="新导入账号的初始密码为 12345678，登录后可直接使用系统。已有工号会跳过，不修改原账号、密码或权限。"
          style={{ marginBottom: 16 }}
        />
        <p>支持 Excel（.xlsx，第一个工作表）或 UTF-8 编码的 CSV。第一行包含“姓名”和“工号”两列，列顺序不限；工号列请设为文本，保留前导零。</p>
        <Upload.Dragger
          accept=".xlsx,.csv"
          maxCount={1}
          fileList={files}
          beforeUpload={() => false}
          onChange={({ fileList }) => setFiles(fileList.slice(-1))}
          disabled={importing}
        >
          <p className="ant-upload-drag-icon"><InboxOutlined /></p>
          <p className="ant-upload-text">点击或拖拽教工名单到此处</p>
        </Upload.Dragger>
      </Modal>

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
