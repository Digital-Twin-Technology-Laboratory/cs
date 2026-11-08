import { Alert, App, Button, Card, Checkbox, Form, Input, Modal, Select, Space, Tabs, Tag, Upload, type UploadFile } from 'antd';
import { useCallback, useEffect, useState } from 'react';
import { api } from '../../api';
import { useAuth } from '../../auth';
import Table from '../../components/ResponsiveTable';
import type { User } from '../../types';
import type { RequirementRow } from './Supervision';

interface ManagedUser extends User { program_scopes: string[]; supervision_manager: number }
interface Data {
  users: ManagedUser[];
  groups: string[];
  programs: string[];
  source: { url: string; name: string; importedAt: string } | null;
  requirements: RequirementRow[];
}
interface ImportResult { required: number; unassigned: number; warnings: string[] }
interface IdentityForm { college_role: User['college_role']; led_groups: string[]; program_scopes: string[]; supervision_manager?: boolean }
interface WriterForm { writer_user_id?: number; writer_name: string; professional: string }

export default function ViewManagement() {
  const { user, refresh } = useAuth();
  const { message } = App.useApp();
  const [data, setData] = useState<Data | null>(null);
  const [error, setError] = useState('');
  const [q, setQ] = useState('');
  const [courseQ, setCourseQ] = useState('');
  const [courseFilter, setCourseFilter] = useState('');
  const [editing, setEditing] = useState<ManagedUser | null>(null);
  const [writer, setWriter] = useState<RequirementRow | null>(null);
  const [busy, setBusy] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [files, setFiles] = useState<UploadFile[]>([]);
  const [url, setUrl] = useState('https://docs.qq.com/sheet/DVkVMc1RZS3NSTHpr?tab=000001');
  const [importResult, setImportResult] = useState<ImportResult | null>(null);
  const [identityForm] = Form.useForm<IdentityForm>();
  const [writerForm] = Form.useForm<WriterForm>();
  const collegeRole = Form.useWatch('college_role', identityForm);
  const load = useCallback(async () => {
    try { setData(await api.get<Data>('/api/supervision-management')); setError(''); }
    catch (e) { setData(null); setError((e as Error).message); }
  }, []);
  useEffect(() => { load(); }, [load]);

  const saveIdentity = async () => {
    const { supervision_manager, ...values } = await identityForm.validateFields();
    setBusy(true);
    try {
      await api.put(`/api/supervision-management/users/${editing!.id}`, {
        ...values, ...(user?.role === 'admin' ? { supervision_manager: supervision_manager ? 1 : 0 } : {}),
      });
      setEditing(null);
      message.success('身份及可见视图已更新');
      await load();
      await refresh();
    } catch (e) { message.error((e as Error).message); }
    finally { setBusy(false); }
  };
  const saveWriter = async () => {
    const values = await writerForm.validateFields();
    setBusy(true);
    try {
      await api.put(`/api/supervision-management/requirements/${writer!.id}`, {
        writer_user_id: values.writer_user_id ?? null, writer_name: values.writer_name.trim(), professional: values.professional || '',
      });
      setWriter(null);
      message.success('执笔人与审核专业已更新，个人及监督总览已同步');
      await load();
    } catch (e) { message.error((e as Error).message); }
    finally { setBusy(false); }
  };
  const importSource = async (mode: 'file' | 'cloud') => {
    if (mode === 'file' && !files[0]?.originFileObj) return message.warning('请选择云文档导出的 Excel 或 CSV 文件');
    setBusy(true);
    try {
      let result: ImportResult;
      if (mode === 'file') {
        const body = new FormData();
        body.append('file', files[0].originFileObj!);
        result = await api.post<ImportResult>('/api/supervision-management/import', body);
      } else result = await api.post<ImportResult>('/api/supervision-management/sync', { url: url.trim() });
      setImportResult(result);
      setImportOpen(false);
      setFiles([]);
      message.success(`清单已更新：${result.required} 份应交，${result.unassigned} 份待分配执笔人`);
      await load();
    } catch (e) { message.error((e as Error).message); }
    finally { setBusy(false); }
  };
  const users = data?.users.filter((u) => `${u.name} ${u.username}`.toLowerCase().includes(q.trim().toLowerCase())) ?? [];
  const requirements = data?.requirements.filter((r) => `${r.course_name} ${r.course_group} ${r.professional} ${r.writer_name} ${r.username} ${r.teacher_names}`.toLowerCase().includes(courseQ.trim().toLowerCase())
    && (courseFilter === 'unassigned' ? r.user_id === null && !r.writer_name && !r.username : courseFilter === 'unmatched' ? r.user_id === null && !!(r.writer_name || r.username) : true)) ?? [];
  const groupOptions = data?.groups.map((g) => ({ value: g, label: g })) ?? [];
  const programOptions = data?.programs.map((p) => ({ value: p, label: p })) ?? [];

  return <div className="page">
    <div className="page-head"><div><h1>视图与执笔人配置</h1><div className="sub">配置每个人可见的全院、专业、课程组视图，指定每份大纲的最终上传责任人。</div></div>
      <Space wrap><Button onClick={load}>刷新</Button><Button type="primary" onClick={() => setImportOpen(true)}>导入大纲清单</Button></Space></div>
    {error && <Alert type="error" showIcon title={error} style={{ marginBottom: 16 }} />}
    <Alert type="info" showIcon title="只管理监督身份，不授予系统管理员权限。"
      description="教学条线看全院；专业负责人看配置的审核专业；课程组长看负责的课程组并最终确认。课程组长可兼任其他监督身份。执笔人可随时调整，空执笔人仍计入应交总数。磨课表不参与大纲统计。" style={{ marginBottom: 16 }} />
    {data?.source && <div className="muted small" style={{ marginBottom: 16, overflowWrap: 'anywhere' }}>当前来源：{data.source.url ? <a href={data.source.url} target="_blank" rel="noreferrer">{data.source.name}</a> : data.source.name}；导入于 {data.source.importedAt}。云文档修改后请重新同步或导入。</div>}
    {importResult && <Alert type={importResult.warnings.length ? 'warning' : 'success'} showIcon
      title={`应交 ${importResult.required} 份，待分配执笔人 ${importResult.unassigned} 份`}
      description={importResult.warnings.length ? <ul>{importResult.warnings.map((warning, index) => <li key={index}>{warning}</li>)}</ul> : '清单导入成功，可在下方继续配置执笔人。'} style={{ marginBottom: 16 }} />}
    <Card loading={!data && !error}>
      <Tabs items={[
        { key: 'users', label: '身份与可见视图', children: <>
          <Input.Search placeholder="姓名 / 工号" allowClear onSearch={setQ} style={{ width: 260, marginBottom: 16 }} />
          <Table<ManagedUser> rowKey="id" dataSource={users} pagination={{ pageSize: 20, showSizeChanger: false, showTotal: (n) => `共 ${n} 个账号` }} columns={[
            { title: '人员', width: 180, render: (_, r) => <div><strong>{r.name}</strong><div className="muted small">{r.username}</div></div> },
            { title: '全院 / 专业身份', width: 160, render: (_, r) => <div>{r.role === 'admin' ? <Tag color="blue">系统管理员</Tag> : r.college_role === 'teaching' ? <Tag>教学条线</Tag> : r.college_role === 'program' || r.program_scopes.length ? <Tag>专业负责人</Tag> : r.led_groups.length ? <Tag>课程组长</Tag> : '普通教师'}{r.supervision_manager === 1 && <Tag>可配置监督视图</Tag>}</div> },
            { title: '负责课程组', width: 240, render: (_, r) => r.led_groups.length ? r.led_groups.map((g) => <div key={g}>{g}</div>) : '未配置' },
            { title: '负责审核专业', width: 200, render: (_, r) => r.program_scopes.length ? r.program_scopes.map((p) => <div key={p}>{p}</div>) : r.college_role === 'program' ? <Tag color="warning">待配置专业</Tag> : '未配置' },
            { title: '操作', width: 110, render: (_, r) => <Button type="link" onClick={() => { identityForm.setFieldsValue({ college_role: r.college_role, led_groups: r.led_groups, program_scopes: r.program_scopes, supervision_manager: r.supervision_manager === 1 }); setEditing(r); }}>配置视图</Button> },
          ]} />
        </> },
        { key: 'writers', label: '大纲清单与执笔人', children: <>
          <Space wrap style={{ marginBottom: 16 }}>
            <Input.Search placeholder="课程 / 执笔人 / 工号 / 任课教师" allowClear onSearch={setCourseQ} style={{ width: 290 }} />
            <Select value={courseFilter} onChange={setCourseFilter} style={{ width: 190 }} options={[{ value: '', label: '全部大纲' }, { value: 'unassigned', label: '待分配执笔人' }, { value: 'unmatched', label: '未匹配到账号' }]} />
          </Space>
          <Table<RequirementRow> rowKey="id" dataSource={requirements} pagination={{ pageSize: 20, showSizeChanger: false, showTotal: (n) => `共 ${n} 份大纲` }} columns={[
            { title: '课程', width: 240, render: (_, r) => <div><strong>{r.course_name}</strong><div className="muted small">{r.course_group || '未分组'}</div></div> },
            { title: '审核专业', width: 170, render: (_, r) => r.professional || <Tag>待配置专业</Tag> },
            { title: '任课教师', width: 180, dataIndex: 'teacher_names' },
            { title: '执笔人（最终上传者）', width: 190, render: (_, r) => <div>{r.name || r.writer_name || r.username || '待分配'}<div className="muted small">{r.username}</div>{r.user_id === null && <Tag>{r.writer_name || r.username ? '未匹配到账号' : '待分配'}</Tag>}</div> },
            { title: '操作', width: 120, render: (_, r) => <Button type="link" onClick={() => { writerForm.setFieldsValue({ writer_user_id: r.user_id ?? undefined, writer_name: r.writer_name, professional: r.professional }); setWriter(r); }}>配置执笔人</Button> },
          ]} />
        </> },
      ]} />
    </Card>
    <Modal title={`配置视图：${editing?.name ?? ''}（${editing?.username ?? ''}）`} open={!!editing} onOk={saveIdentity}
      onCancel={() => setEditing(null)} confirmLoading={busy} cancelButtonProps={{ disabled: busy }} closable={!busy} maskClosable={!busy} destroyOnHidden>
      <Form form={identityForm} layout="vertical">
        <Form.Item name="college_role" label="全院 / 专业监督身份" rules={[{ required: true }]}>
          <Select options={[{ value: 'none', label: '无全院或专业监督身份' }, { value: 'teaching', label: '教学条线（全院总览）' }, { value: 'program', label: '专业负责人（所选专业总览）' }]} />
        </Form.Item>
        <Form.Item name="led_groups" label="负责课程组（可兼任）"><Select mode="multiple" allowClear showSearch optionFilterProp="label" options={groupOptions} placeholder="选择可查看及最终确认的课程组" /></Form.Item>
        <Form.Item name="program_scopes" label="负责审核专业" extra={collegeRole === 'program' ? '不选专业时仍有专业总览入口，但不会显示任何专业的数据。' : '选择专业将开放对应的专业总览，可与教学条线或课程组长兼任。'}>
          <Select mode="multiple" allowClear showSearch optionFilterProp="label" options={programOptions} placeholder="选择负责的审核专业" />
        </Form.Item>
        {user?.role === 'admin' && <Form.Item name="supervision_manager" valuePropName="checked" extra="允许此人配置其他账号的监督身份、管辖范围和大纲执笔人，不授予系统管理员权限；不能转授配置权限。">
          <Checkbox>允许配置监督视图和执笔人</Checkbox>
        </Form.Item>}
        <Alert type="warning" showIcon title="每个课程组仅一位组长，选择已有组长的课程组会替换原负责人。" />
      </Form>
    </Modal>
    <Modal title={`配置执笔人：${writer?.course_name ?? ''}`} open={!!writer} onOk={saveWriter}
      onCancel={() => setWriter(null)} confirmLoading={busy} cancelButtonProps={{ disabled: busy }} closable={!busy} maskClosable={!busy} destroyOnHidden>
      <Form form={writerForm} layout="vertical">
        <Form.Item name="writer_user_id" label="绑定上传账号（姓名＋工号）" extra="未匹配账号可在此手动选择；不绑定账号且姓名为空时列为待分配。">
          <Select allowClear showSearch optionFilterProp="label" options={data?.users.map((u) => ({ value: u.id, label: `${u.name}（${u.username}）` }))}
            onChange={(id) => { if (id !== undefined) writerForm.setFieldValue('writer_name', data!.users.find((u) => u.id === id)!.name); }} />
        </Form.Item>
        <Form.Item name="writer_name" label="执笔人姓名（未匹配时保留原姓名）"><Input maxLength={50} /></Form.Item>
        <Form.Item name="professional" label="审核专业"><Select allowClear showSearch optionFilterProp="label" options={programOptions} /></Form.Item>
      </Form>
    </Modal>
    <Modal title="导入大纲云文档清单" open={importOpen} footer={null} onCancel={() => setImportOpen(false)} closable={!busy} maskClosable={!busy} destroyOnHidden>
      <Alert type="info" showIcon title="以课程云文档为准，不导入磨课安排。" description="同步保留已手工配置的执笔人，不改变任何账号或密码。空执笔人保留为待分配，仍计入应交总数；导入后可在清单中手动绑定账号及调整执笔人。" style={{ marginBottom: 16 }} />
      <Tabs items={[
        { key: 'cloud', label: '同步腾讯云文档', children: <Space orientation="vertical" style={{ width: '100%' }}>
          <Input aria-label="腾讯云文档地址" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://docs.qq.com/sheet/..." disabled={busy} />
          <Button type="primary" loading={busy} onClick={() => importSource('cloud')}>同步课程清单</Button>
          <div className="muted small">如云文档限制读取，请导出 Excel 或 CSV 后切换到文件导入。</div>
        </Space> },
        { key: 'file', label: '导入导出文件', children: <Space orientation="vertical" style={{ width: '100%' }}>
          <Upload accept=".xlsx,.csv" maxCount={1} fileList={files} beforeUpload={() => false} onChange={({ fileList }) => setFiles(fileList.slice(-1))} disabled={busy}><Button>选择云文档导出文件</Button></Upload>
          <Button type="primary" loading={busy} disabled={!files.length} onClick={() => importSource('file')}>导入课程清单</Button>
        </Space> },
      ]} />
    </Modal>
  </div>;
}
