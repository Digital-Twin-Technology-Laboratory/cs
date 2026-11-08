import { Alert, App, Button, Card, Col, Input, Popconfirm, Row, Select, Space, Statistic } from 'antd';
import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../../api';
import { useAuth } from '../../auth';
import Table from '../../components/ResponsiveTable';
import { ConfirmationTag, SubmissionTag } from '../../components/StatusTag';
import type { RequiredCourseProgress } from '../../types';

type RowData = RequiredCourseProgress & { username: string; name: string; can_confirm: boolean };
interface Data { college: boolean; groups: string[]; rows: RowData[] }

export default function Supervision() {
  const { user } = useAuth();
  const { message } = App.useApp();
  const [data, setData] = useState<Data | null>(null);
  const [error, setError] = useState('');
  const [q, setQ] = useState('');
  const [group, setGroup] = useState('');
  const [status, setStatus] = useState('');
  const [page, setPage] = useState(1);
  const [confirming, setConfirming] = useState<number | null>(null);
  const load = useCallback(async () => {
    try { setData(await api.get<Data>('/api/supervision/progress')); setError(''); }
    catch (e) { setError((e as Error).message); }
  }, []);
  useEffect(() => { load(); const timer = setInterval(load, 10000); return () => clearInterval(timer); }, [load]);
  const confirm = async (id: number) => {
    setConfirming(id);
    try { await api.post(`/api/submissions/${id}/confirm`); message.success('已最终确认，管理员与教师个人总览已同步'); await load(); }
    catch (e) { message.error((e as Error).message); }
    finally { setConfirming(null); }
  };
  const scoped = data?.rows.filter((r) => (!group || r.course_group === group) && `${r.name} ${r.username} ${r.course_name}`.toLowerCase().includes(q.trim().toLowerCase())) ?? [];
  const uploaded = scoped.filter((r) => r.latest_id !== null).length;
  const passed = scoped.filter((r) => r.status === 'done' && r.verdict === 'passed').length;
  const confirmed = scoped.filter((r) => r.status === 'done' && r.confirmed_at !== null).length;
  const rows = scoped.filter((r) => status === 'missing' ? r.latest_id === null : status === 'uploaded' ? r.latest_id !== null : status === 'pending' ? r.confirmed_at === null : status === 'confirmed' ? r.confirmed_at !== null : true);
  return <div className="page">
    <div className="page-head"><div><h1>{data?.college ? '全院总览' : '课程组总览'}</h1>
      <div className="sub">{user?.college_role === 'teaching' ? '教学条线' : user?.college_role === 'program' ? '专业负责人' : user?.role === 'admin' ? '管理员' : '课程组长'}：{user?.name}。{data?.college ? '可查看全院整周应交进度。' : '仅显示本人负责课程组的磨课清单课程（周一至周三），不含其他课程组数据。'}</div></div>
      <Button onClick={load}>刷新进度</Button></div>
    {error && <Alert type="error" showIcon title={error} style={{ marginBottom: 16 }} />}
    <Card loading={!data && !error}>
      <Space wrap style={{ marginBottom: 20 }}>
        <Select value={group} aria-label="监督课程组筛选" onChange={(v) => { setGroup(v); setPage(1); }} style={{ width: 280 }} options={[{ value: '', label: '全部授权课程组' }, ...(data?.groups ?? []).filter(Boolean).map((g) => ({ value: g, label: g }))]} />
        <Input placeholder="教师 / 工号 / 课程" value={q} allowClear onChange={(e) => { setQ(e.target.value); setPage(1); }} style={{ width: 220 }} />
      </Space>
      <Row gutter={[16, 16]}>
        {([['任课教师', new Set(scoped.map((r) => r.username)).size, '人'], ['应交大纲', scoped.length, '份'], ['已上传', uploaded, '份'], ['未上传', scoped.length - uploaded, '份'], ['最新检查通过', passed, '份'], ['最终已确认', confirmed, '份']] as const).map(([title, value, suffix]) => <Col xs={12} md={4} key={title}><Statistic title={title} value={value} suffix={suffix} /></Col>)}
      </Row>
      <Alert type="info" showIcon style={{ margin: '20px 0' }} title="按教师工号＋课程合并平行班，每项只计一份。"
        description="取最新检查及最终确认状态。课程组长可查看本组磨课清单内的上传文件和检查结果，组长确认直接视为最终确认，无需教师再次确认；只具有全院查看身份的人员不能代组长确认。重新上传后需确认新结果。上方数字随课程组和搜索变化，不受下方状态筛选影响。" />
      <Select value={status} aria-label="监督上传状态筛选" onChange={(v) => { setStatus(v); setPage(1); }} style={{ width: 180, marginBottom: 16 }} options={[{ value: '', label: '全部状态' }, { value: 'missing', label: '未上传' }, { value: 'uploaded', label: '已上传' }, { value: 'pending', label: '未最终确认' }, { value: 'confirmed', label: '已最终确认' }]} />
      <Table<RowData> rowKey={(r) => JSON.stringify([r.username, r.course_name])} dataSource={rows}
        pagination={{ current: page, pageSize: 20, showSizeChanger: false, total: rows.length, onChange: setPage, showTotal: (n) => `共 ${n} 份应交大纲` }}
        columns={[
          { title: '任课教师', width: 160, render: (_, r) => <div>{r.name}<div className="muted small">{r.username}</div></div> },
          { title: '应交课程', width: 240, render: (_, r) => <div>{r.course_name}<div className="muted small">{r.course_group || '未分组'}</div></div> },
          { title: '最新检查', width: 120, render: (_, r) => r.latest_id === null ? '未上传' : <SubmissionTag status={r.status} verdict={r.verdict} /> },
          { title: '最终确认', width: 170, render: (_, r) => <div><ConfirmationTag status={r.status} confirmedAt={r.confirmed_at} />{r.confirmed_by && <div className="muted small">{r.confirmed_by}</div>}{r.confirmed_at && <div className="muted small">{r.confirmed_at}</div>}</div> },
          { title: '操作', width: 150, render: (_, r) => <Space orientation="vertical" size={6}>
            {r.latest_id !== null && <Link to={`/submissions/${r.latest_id}`}>在线查看大纲与结果</Link>}
            {r.can_confirm && r.latest_id !== null && r.status === 'done' && !r.confirmed_at && <Popconfirm title="组长最终确认此份大纲？" description="确认后同步到管理员和个人端，无需教师再确认。" onConfirm={() => confirm(r.latest_id!)}><Button size="small" type="primary" loading={confirming === r.latest_id}>组长最终确认</Button></Popconfirm>}
          </Space> },
        ]} />
    </Card>
  </div>;
}
