import { Alert, App, Button, Card, Col, Input, Popconfirm, Row, Select, Space, Statistic, Tabs, Tag } from 'antd';
import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { api, download, qs } from '../../api';
import { useAuth } from '../../auth';
import Table from '../../components/ResponsiveTable';
import { ConfirmationTag, SubmissionTag } from '../../components/StatusTag';
import type { SubStatus } from '../../types';
import StoredNumber, { useStoredNumber } from '../../components/EditableNumber';
import SubmissionAttachments from '../../components/SubmissionAttachments';

export interface RequirementRow {
  id: number;
  source_key: string;
  course_name: string;
  course_group: string;
  professional: string;
  teacher_names: string;
  writer_name: string;
  username: string;
  name: string;
  user_id: number | null;
  uploader_id: number | null;
  uploader_name: string;
  uploader_username: string;
  latest_id: number | null;
  status: SubStatus | null;
  verdict: 'passed' | 'failed' | null;
  confirmed_at: string | null;
  confirmed_by: string;
  created_at: string | null;
  can_confirm: boolean;
}
interface Data {
  source: { name: string; importedAt: string } | null;
  view: string;
  views: string[];
  groups: string[];
  programs: string[];
  rows: RequirementRow[];
  summary: { people: number; required: number; uploaded: number; passed: number; confirmed: number; unassigned: number };
}
interface PersonRow { key: string; name: string; username: string; unmatched: boolean; courses: RequirementRow[] }
const VIEW_NAMES: Record<string, string> = { college: '全院总览', group: '课程组总览', program: '专业总览' };
const isPassed = (r: RequirementRow) => r.status === 'done' && r.verdict === 'passed';
const isConfirmed = (r: RequirementRow) => r.status === 'done' && r.confirmed_at !== null;

export default function Supervision({ embedded = false }: { embedded?: boolean }) {
  const { user } = useAuth();
  const stored = useStoredNumber();
  const { message } = App.useApp();
  const [params, setParams] = useSearchParams();
  const view = params.get('view') ?? '';
  const [data, setData] = useState<Data | null>(null);
  const [error, setError] = useState('');
  const [refresh, setRefresh] = useState(0);
  const [q, setQ] = useState('');
  const [group, setGroup] = useState('');
  const [program, setProgram] = useState('');
  const [status, setStatus] = useState('');
  const [page, setPage] = useState(1);
  const [confirming, setConfirming] = useState<number | null>(null);
  const [selected, setSelected] = useState<React.Key[]>([]);
  useEffect(() => { setSelected([]); }, [view, group, program, q, status]);
  useEffect(() => {
    let active = true;
    const load = async () => {
      try {
        const result = await api.get<Data>(`/api/supervision/progress?${qs({ view })}`);
        if (active) { setData(result); setError(''); }
      } catch (e) {
        if (active) { setData(null); setError((e as Error).message); }
      }
    };
    setData(null);
    setError('');
    load();
    const timer = setInterval(load, 10000);
    return () => { active = false; clearInterval(timer); };
  }, [view, refresh]);
  const confirm = async (id: number) => {
    setConfirming(id);
    try {
      await api.post(`/api/submissions/${id}/confirm`);
      message.success('已最终确认，个人与监督总览已同步');
      setRefresh((n) => n + 1);
    } catch (e) { message.error((e as Error).message); }
    finally { setConfirming(null); }
  };
  const statisticScope = data?.view === 'college' ? 'college' : `${data?.view}:${user!.id}`;
  const numberName = (field: string) => JSON.stringify([group, program, q.trim().toLowerCase(), 'summary', field]);
  const scopedPeople = data?.view !== 'college' || group || program || q;
  const personStat = (r: PersonRow, field: string, value: number) => ({
    scope: scopedPeople ? statisticScope : r.key.startsWith('user:') ? `personal:${r.key.slice(5)}` : `person:${r.key}`,
    name: scopedPeople ? JSON.stringify([group, program, q.trim().toLowerCase(), 'person', r.key, field]) : field,
    value,
  });
  const scoped = data?.rows.filter((r) => (!group || r.course_group === group) && (!program || r.professional === program)
    && `${r.name} ${r.writer_name} ${r.username} ${r.course_name} ${r.teacher_names} ${r.uploader_name} ${r.uploader_username}`.toLowerCase().includes(q.trim().toLowerCase())) ?? [];
  const people = new Map<string, PersonRow>();
  for (const course of scoped) {
    if (course.user_id === null && !course.writer_name && !course.username) continue;
    const key = course.user_id !== null ? `user:${course.user_id}` : JSON.stringify([course.username, course.writer_name]);
    if (!people.has(key)) people.set(key, { key, name: course.name || course.writer_name || course.username, username: course.username,
      unmatched: course.user_id === null && !!(course.writer_name || course.username), courses: [] });
    people.get(key)!.courses.push(course);
  }
  const peopleRows = [...people.values()];
  const uploaded = scoped.filter((r) => r.latest_id !== null).length;
  const passed = scoped.filter(isPassed).length;
  const confirmed = scoped.filter(isConfirmed).length;
  const unassigned = scoped.filter((r) => r.user_id === null && !r.writer_name && !r.username).length;
  const courseRows = scoped.filter((r) => status === 'missing' ? r.latest_id === null : status === 'uploaded' ? r.latest_id !== null
    : status === 'pending' ? !isConfirmed(r) : status === 'confirmed' ? isConfirmed(r) : status === 'passed' ? isPassed(r)
    : status === 'not-passed' ? r.status === 'done' && r.verdict === 'failed' : true);
  const courseTable = (rows: RequirementRow[], paginated = false) => <Table<RequirementRow> rowKey="id" size="small" dataSource={rows}
    rowSelection={paginated ? { selectedRowKeys: selected, preserveSelectedRowKeys: true, onChange: setSelected, getCheckboxProps: (r) => ({ disabled: r.latest_id === null }) } : undefined}
    pagination={paginated ? { current: page, pageSize: 20, showSizeChanger: false, total: rows.length, onChange: setPage, showTotal: (n) => `共 ${n} 门课程（平行班已合并）` } : false}
    columns={[
      { title: '应交课程', width: 280, render: (_, r) => <div>{r.course_name}<div className="muted small">课程组：{r.course_group || '未分组'}</div><div className="muted small">审核专业：{r.professional || '未配置'}</div></div> },
      { title: '执笔人', width: 150, render: (_, r) => <div>{r.name || r.writer_name || r.username || '待指定'}<div className="muted small">{r.username}</div>{r.user_id === null && (r.writer_name || r.username) && <Tag>未匹配到账号</Tag>}</div> },
      { title: '实际上传人', width: 150, render: (_, r) => <div>{r.uploader_name || r.uploader_username || '尚未上传'}{r.uploader_username && <div className="muted small">{r.uploader_username}</div>}</div> },
      { title: '最新检查', width: 120, render: (_, r) => r.latest_id === null ? '未上传' : <SubmissionTag status={r.status} verdict={r.verdict} /> },
      { title: '最终确认', width: 170, render: (_, r) => <div><ConfirmationTag status={r.status} confirmedAt={r.confirmed_at} />{r.confirmed_by && <div className="muted small">{r.confirmed_by}</div>}</div> },
      { title: '操作', width: 150, render: (_, r) => <Space orientation="vertical" size={6}>
        {r.latest_id !== null && <Link to={`/submissions/${r.latest_id}`}>在线查看大纲与结果</Link>}
        {r.latest_id !== null && <Button size="small" onClick={() => download(`/api/submissions/${r.latest_id}/file`)}>下载原文件</Button>}
        {r.latest_id !== null && r.status === 'done' && <Button size="small" onClick={() => download(`/api/submissions/${r.latest_id}/report.docx`)}>下载检查结果</Button>}
        {r.can_confirm && r.latest_id !== null && r.status === 'done' && !r.confirmed_at && <Popconfirm title="组长最终确认此份大纲？" description="确认后直接视为最终确认，无需教师再次确认。" onConfirm={() => confirm(r.latest_id!)}><Button size="small" type="primary" loading={confirming === r.latest_id}>组长最终确认</Button></Popconfirm>}
      </Space> },
    ]} />;
  const actions = <Space wrap>
    <Button onClick={() => setRefresh((n) => n + 1)}>刷新进度</Button>
    {user && (user.role === 'admin' || user.college_role === 'teaching') && <Link to="/submissions?scope=college"><Button>全院检查记录</Button></Link>}
    {user && (user.role === 'admin' || user.supervision_manager === 1) && <Link to="/view-management"><Button>视图与执笔人配置</Button></Link>}
  </Space>;
  return <div className={embedded ? undefined : 'page'}>
    {!embedded && <div className="page-head"><div><h1>{data ? VIEW_NAMES[data.view] : '监督总览'}</h1>
      <div className="sub">{user?.name}：按已授权范围查看课程进度，平行班合并；执笔人待定不影响课程上传与确认。</div></div>
      {actions}</div>}
    {error && <Alert type="error" showIcon title={error} style={{ marginBottom: 16 }} />}
    {data && !data.source && <Alert type="warning" showIcon title="尚未导入大纲云文档清单"
      description="请由 root 或汤家华在“视图与执笔人配置”中同步云表，或上传云表导出的 Excel / CSV。原课表和磨课表不再用作大纲应交范围。" style={{ marginBottom: 16 }} />}
    {data?.view === 'program' && !data.programs.length && <Alert type="warning" showIcon title="尚未配置负责专业"
      description="专业总览已开放，请联系 root 或汤家华在“视图与执笔人配置”中指定负责专业；配置后即可查看该专业进度。" style={{ marginBottom: 16 }} />}
    <Card loading={!data && !error} title={embedded ? '大纲进度总览' : undefined} extra={embedded ? actions : undefined}>
      <Space wrap style={{ marginBottom: 20 }}>
        {data && <Select value={data.view} aria-label="监督视图" style={{ width: 170 }} options={data.views.map((v) => ({ value: v, label: VIEW_NAMES[v] }))}
          onChange={(next) => { setParams({ view: next }); setGroup(''); setProgram(''); setPage(1); }} />}
        <Select value={group} aria-label="监督课程组筛选" onChange={(v) => { setGroup(v); setPage(1); }} style={{ width: 280 }} options={[{ value: '', label: '全部授权课程组' }, ...(data?.groups ?? []).filter(Boolean).map((g) => ({ value: g, label: g }))]} />
        <Select value={program} aria-label="监督专业筛选" onChange={(v) => { setProgram(v); setPage(1); }} style={{ width: 220 }} options={[{ value: '', label: '全部授权专业' }, ...(data?.programs ?? []).filter(Boolean).map((p) => ({ value: p, label: p }))]} />
        <Input placeholder="课程 / 执笔人 / 实际上传人 / 工号" value={q} allowClear onChange={(e) => { setQ(e.target.value); setPage(1); }} style={{ width: 270 }} />
      </Space>
      <Row gutter={[16, 16]}>
        {([['required', '课程总数', scoped.length], ['uploaded', '已上传 / 应交', uploaded], ['passed', '已通过 / 应交', passed], ['confirmed', '最终确认 / 应交', confirmed], ['missing', '尚未上传', scoped.length - uploaded], ['unassigned', '执笔人待定', unassigned]] as const).map(([key, title, count], i) =>
          <Col xs={12} md={4} key={key}><Statistic title={title} value={count} formatter={() => <StoredNumber scope={statisticScope} name={numberName(key)} value={count} />}
            suffix={i >= 1 && i <= 3 ? <>/ <StoredNumber scope={statisticScope} name={numberName('required')} value={scoped.length} /> 门</> : i === 5 ? '门课程' : '门'} /></Col>)}
      </Row>
      <Alert type="info" showIcon style={{ margin: '20px 0' }} title="按云文档课程清单统计，平行班合并，与磨课安排无关。"
        description="课程进度取对应课程的最新上传、检查和确认，不要求预先指定执笔人。执笔人待定也可上传，系统记录实际上传人；组长可查看本组课程并最终确认，新上传需确认新结果。上方统计随课程组、审核专业和搜索变化，不受课程状态筛选影响。" />
      <Tabs defaultActiveKey="courses" onChange={() => setPage(1)} items={[
        { key: 'courses', label: '逐门课程', children: <>
          <Select value={status} aria-label="监督上传状态筛选" onChange={(v) => { setStatus(v); setPage(1); }} style={{ width: 180, marginBottom: 16 }} options={[{ value: '', label: '全部状态' }, { value: 'missing', label: '未上传' }, { value: 'uploaded', label: '已上传' }, { value: 'pending', label: '未最终确认' }, { value: 'confirmed', label: '已最终确认' }, { value: 'passed', label: '检查已通过' }, { value: 'not-passed', label: '检查未通过' }]} />
          <SubmissionAttachments selected={courseRows.filter((r) => selected.includes(r.id) && r.latest_id !== null).map((r) => ({ id: r.latest_id!, status: r.status }))} onClear={() => setSelected([])} />
          {courseTable(courseRows, true)}
        </> },
        { key: 'people', label: '人员进度', children: <>
          {unassigned > 0 && <Alert type="info" showIcon title={`${unassigned} 门课程尚未确定执笔人，已计入课程总数及课程上传进度，不计为一位人员。`} description="请在“逐门课程”查看这些课程的进度与实际上传人。下方仅汇总已指定或有明确姓名的执笔人。" style={{ marginBottom: 16 }} />}
          <Table<PersonRow> rowKey="key" dataSource={peopleRows}
          expandable={{ expandedRowRender: (r) => courseTable(r.courses) }}
          pagination={{ current: page, pageSize: 20, showSizeChanger: false, total: peopleRows.length, onChange: setPage, showTotal: (n) => `共 ${n} 位执笔人` }}
          columns={[
            { title: '执笔人', width: 190, render: (_, r) => <div><strong>{r.name}</strong><div className="muted small">{r.username}</div>{r.unmatched && <Tag>未匹配到账号</Tag>}</div> },
            { title: '需要上传', width: 100, render: (_, r) => <><StoredNumber {...personStat(r, 'required', r.courses.length)} /> 份</> },
            { title: '已上传 / 应交', width: 130, render: (_, r) => <><StoredNumber {...personStat(r, 'uploaded', r.courses.filter((c) => c.latest_id !== null).length)} /> / <StoredNumber {...personStat(r, 'required', r.courses.length)} /></> },
            { title: '已通过 / 应交', width: 160, render: (_, r) => {
              const passedStat = personStat(r, 'passed', r.courses.filter(isPassed).length);
              const requiredStat = personStat(r, 'required', r.courses.length);
              const allPassed = stored(passedStat.scope, passedStat.name, passedStat.value) === stored(requiredStat.scope, requiredStat.name, requiredStat.value);
              return <div><StoredNumber {...passedStat} /> / <StoredNumber {...requiredStat} /><div><Tag color={allPassed ? 'success' : undefined}>{allPassed ? '全部已通过' : '尚未全部通过'}</Tag></div></div>;
            } },
            { title: '最终确认 / 应交', width: 140, render: (_, r) => <><StoredNumber {...personStat(r, 'confirmed', r.courses.filter(isConfirmed).length)} /> / <StoredNumber {...personStat(r, 'required', r.courses.length)} /></> },
          ]} />
        </> },
      ]} />
    </Card>
  </div>;
}
