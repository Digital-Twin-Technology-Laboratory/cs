import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowLeftOutlined,
  DownloadOutlined,
  SearchOutlined,
} from '@ant-design/icons';
import {
  Alert,
  App,
  AutoComplete,
  Button,
  Card,
  Checkbox,
  Col,
  Collapse,
  Empty,
  Form,
  Image,
  Input,
  InputNumber,
  Modal,
  Popconfirm,
  Row,
  Select,
  Space,
  Spin,
  Switch,
  Table,
  Tabs,
  Tag,
  Tooltip,
} from 'antd';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { api, download } from '../../api';
import { useAuth } from '../../auth';
import ResponsiveTable from '../../components/ResponsiveTable';
import { courseLabel, HistoryImport, HistorySearch, type HistoryCourse, type HistoryIssue } from './MaterialHistory';

const base = '/api/materials';
const planType = '人才培养方案及支撑矩阵';
const levels = { course: '课程检查', program: '专业复核', group: '教研室／课程组复核', college: '学院复核' };
const levelShort: Record<keyof typeof levels, string> = {
  course: '课程检查',
  program: '专业复核',
  group: '课程组复核',
  college: '学院复核',
};
const levelTagColors: Record<keyof typeof levels, string> = {
  course: 'blue',
  program: 'purple',
  group: 'cyan',
  college: 'geekblue',
};
const statusNames = { queued: '排队中', running: '检查中', done: '已完成', failed: '检查失败' };
const verdictNames = { passed: '通过', partial: '已检部分未发现问题（仍有待补／待核）', failed: '需整改' };
const colors: Record<string, string> = { 未发现问题: 'green', 需整改: 'red', 建议完善: 'blue', 待补: 'gold', 需核实: 'orange', 不适用: 'default' };
const choices = (items: Record<string, string>) => Object.entries(items).map(([value, label]) => ({ value, label }));
const options = (items: string[]) => items.map((value) => ({ value, label: value }));

type PersonRef = { id: number; username: string; name: string; department?: string };
type Scope = { level: keyof typeof levels; title: string; courseCode?: string; term: string; section: string; major: string; group: string; planGrade: number };
type Run = {
  id: number;
  status: keyof typeof statusNames;
  error: string | null;
  version: string;
  created_at: string;
  finished_at?: string | null;
  verdict: keyof typeof verdictNames | null;
  runner?: PersonRef;
};
type CaseRecord = {
  id: number;
  scope: Scope;
  createdAt?: string;
  owner?: PersonRef;
  editable: boolean;
  scopeLocked: boolean;
};
type CaseListItem = CaseRecord & {
  fileCount: number;
  runCount: number;
  latest: Run | null;
};
type Attached = { id: number; name: string; type: string; grade: boolean };
type Detail = CaseRecord & {
  version: string;
  expected: string[];
  optional: string[];
  plan: { name: string } | null;
  files: Attached[];
  runs: Run[];
};
type Picklists = {
  majors: string[];
  programs: readonly string[];
  groups: string[];
  college: boolean;
  courses: HistoryCourse[];
  teachingClasses: (HistoryCourse & { section: string })[];
};
type GradeRow = { location: string; line: number; cells: Record<string, string>; uncertain: string[]; ocr: boolean };
type GradeEdit = { location: string; line: number; column: string; value: string };
type GradeData = {
  rows: GradeRow[];
  edits: GradeEdit[];
  weights: Record<string, number>;
  weightEdits: Record<string, number> | null;
  scanned: boolean;
  weightsVerified: boolean;
};
type Check = { code: string; title: string };
type Rule = Check & { materials: string[]; status: string };
type MaterialIssue = { title: string; detail: string; action?: string; locations: string[]; materials: string[]; checks: Check[]; history?: string };
type IssueReport = {
  materials: { material: string; source?: string; sections: { label: string; issues: MaterialIssue[] }[] }[];
  missing: string[];
  toVerify: MaterialIssue[];
};
type ResultFile = { id: number; name: string; type: string; warnings: string[] };
type Result = {
  verdict: keyof typeof verdictNames;
  rules: Rule[];
  files: ResultFile[];
  issueReport: IssueReport;
  history?: { issue: HistoryIssue; status: string; detail: string; locations: { fileId: number; file: string; position: string }[] }[];
  stats: {
    id: number;
    file: string;
    weights: Record<string, number>;
    stats: { column: string; count: number; rows: number; excluded: number; unreadable: number; mean: number | null; bands: number[] }[];
  }[];
};

type CaseStateKey = 'failed' | 'partial' | 'passed' | 'running' | 'error' | 'unchecked';

function personDisplay(person?: PersonRef) {
  if (!person) return '未知';
  const name = person.name?.trim();
  const username = person.username?.trim();
  if (name && username && name !== username) return `${name}（${username}）`;
  return name || username || '未知';
}

function caseStateKey(run: Run | null | undefined): CaseStateKey {
  if (!run) return 'unchecked';
  if (run.status === 'queued' || run.status === 'running') return 'running';
  if (run.status === 'failed') return 'error';
  if (run.verdict === 'failed') return 'failed';
  if (run.verdict === 'partial') return 'partial';
  if (run.verdict === 'passed') return 'passed';
  return 'unchecked';
}

const statePriority: Record<CaseStateKey, number> = {
  failed: 0,
  error: 1,
  running: 2,
  partial: 3,
  unchecked: 4,
  passed: 5,
};

function RunStatusTag({ run }: { run: Run | null | undefined }) {
  if (!run) return <Tag style={{ marginInlineEnd: 0 }}>未检查</Tag>;
  if (run.status === 'queued') return <Tag color="processing" style={{ marginInlineEnd: 0 }}>排队中</Tag>;
  if (run.status === 'running') return <Tag color="processing" style={{ marginInlineEnd: 0 }}>检查中</Tag>;
  if (run.status === 'failed') {
    return (
      <Tooltip title={run.error || '检查运行失败'}>
        <Tag color="error" style={{ marginInlineEnd: 0 }}>检查失败</Tag>
      </Tooltip>
    );
  }
  if (run.verdict === 'failed') return <Tag color="red" style={{ marginInlineEnd: 0 }}>需整改</Tag>;
  if (run.verdict === 'passed') return <Tag color="green" style={{ marginInlineEnd: 0 }}>通过</Tag>;
  if (run.verdict === 'partial') {
    return (
      <Tooltip title={verdictNames.partial}>
        <Tag color="gold" style={{ marginInlineEnd: 0 }}>部分通过（待补/待核）</Tag>
      </Tooltip>
    );
  }
  return <Tag style={{ marginInlineEnd: 0 }}>{statusNames[run.status]}</Tag>;
}

export default function Materials() {
  const { id } = useParams();
  return id ? <CaseDetail key={id} id={id} /> : <MaterialsHome />;
}

function MaterialsHome() {
  const { user } = useAuth();
  const [params, setParams] = useSearchParams();
  const canImport = user?.role === 'admin' || user?.college_role === 'teaching';
  const tab = params.get('tab');
  return <div className="page">
    <div className="page-head"><div><h1>全套材料检查</h1>
      <div className="sub">上传教学材料按清单检查，也可以单独导入或查询往期问题。</div>
    </div></div>
    <Tabs activeKey={tab === 'history' || (tab === 'import' && canImport) ? tab : 'check'}
      onChange={(key) => setParams(key === 'check' ? {} : { tab: key })}
      items={[
        { key: 'check', label: '上传材料并检查', children: <CaseList /> },
        ...(canImport ? [{ key: 'import', label: '整表导入往期问题', children: <HistoryImport /> }] : []),
        { key: 'history', label: '查询历史问题', children: <HistorySearch /> },
      ]} />
  </div>;
}

function CaseList() {
  const { user } = useAuth();
  const [data, setData] = useState<CaseListItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [editor, setEditor] = useState<CaseRecord | 'new'>();
  const [q, setQ] = useState('');
  const [statusFilter, setStatusFilter] = useState<'all' | CaseStateKey>('all');
  const [levelFilter, setLevelFilter] = useState<'all' | keyof typeof levels>('all');
  const [termFilter, setTermFilter] = useState<string>('');
  const [scopeGroupFilter, setScopeGroupFilter] = useState<string>('');
  const [uploaderFilter, setUploaderFilter] = useState<number | undefined>();
  const [onlyMine, setOnlyMine] = useState(false);
  const [sortBy, setSortBy] = useState<'recent' | 'failed_first' | 'created'>('recent');
  const nav = useNavigate();
  const { message } = App.useApp();

  const load = useCallback(async () => {
    setLoading(true);
    try { setData(await api.get<CaseListItem[]>(base)); }
    catch (e) { message.error((e as Error).message); }
    finally { setLoading(false); }
  }, [message]);
  useEffect(() => { void load(); }, [load]);

  const summary = useMemo(() => {
    let failed = 0;
    let passed = 0;
    let partial = 0;
    let running = 0;
    let unchecked = 0;
    for (const item of data) {
      const state = caseStateKey(item.latest);
      if (state === 'failed' || state === 'error') failed++;
      else if (state === 'passed') passed++;
      else if (state === 'partial') partial++;
      else if (state === 'running') running++;
      else unchecked++;
    }
    return { total: data.length, failed, passed, partial, running, unchecked };
  }, [data]);

  const filterMeta = useMemo(() => {
    const levelSet = new Set<keyof typeof levels>();
    const termSet = new Set<string>();
    const groupSet = new Set<string>();
    const uploaderMap = new Map<number, { value: number; label: string }>();
    let hasOthers = false;
    for (const item of data) {
      levelSet.add(item.scope.level);
      if (item.scope.term) termSet.add(item.scope.term);
      if (item.scope.major) groupSet.add(item.scope.major);
      if (item.scope.group) groupSet.add(item.scope.group);
      if (item.owner) {
        uploaderMap.set(item.owner.id, { value: item.owner.id, label: personDisplay(item.owner) });
        if (user && item.owner.id !== user.id) hasOthers = true;
      }
    }
    return {
      levels: [...levelSet],
      terms: [...termSet].sort((a, b) => b.localeCompare(a, 'zh-CN', { numeric: true })),
      groups: [...groupSet].sort((a, b) => a.localeCompare(b, 'zh-CN')),
      uploaders: [...uploaderMap.values()].sort((a, b) => a.label.localeCompare(b.label, 'zh-CN')),
      hasOthers,
    };
  }, [data, user]);

  const isBroadViewer = !!(
    user &&
    (user.role === 'admin' || user.college_role !== 'none' || user.led_groups.length > 0 || user.program_scopes.length > 0)
  );

  const hasActiveFilter = !!(
    q.trim() ||
    statusFilter !== 'all' ||
    levelFilter !== 'all' ||
    termFilter ||
    scopeGroupFilter ||
    uploaderFilter !== undefined ||
    onlyMine
  );

  const resetFilters = () => {
    setQ('');
    setStatusFilter('all');
    setLevelFilter('all');
    setTermFilter('');
    setScopeGroupFilter('');
    setUploaderFilter(undefined);
    setOnlyMine(false);
  };

  const filtered = useMemo(() => {
    const keyword = q.trim().toLowerCase();
    const list = data.filter((item) => {
      if (onlyMine && user && item.owner?.id !== user.id) return false;
      if (statusFilter !== 'all' && caseStateKey(item.latest) !== statusFilter) return false;
      if (levelFilter !== 'all' && item.scope.level !== levelFilter) return false;
      if (termFilter && item.scope.term !== termFilter) return false;
      if (scopeGroupFilter && item.scope.major !== scopeGroupFilter && item.scope.group !== scopeGroupFilter) return false;
      if (uploaderFilter !== undefined && item.owner?.id !== uploaderFilter) return false;
      if (keyword) {
        const haystack = [
          item.scope.title,
          item.scope.courseCode,
          item.scope.term,
          item.scope.section,
          item.scope.major,
          item.scope.group,
          levels[item.scope.level],
          item.owner?.name,
          item.owner?.username,
        ].filter(Boolean).join(' ').toLowerCase();
        if (!haystack.includes(keyword)) return false;
      }
      return true;
    });
    const activityTime = (item: CaseListItem) => item.latest?.finished_at || item.latest?.created_at || item.createdAt || '';
    return [...list].sort((a, b) => {
      if (sortBy === 'created') return b.id - a.id;
      if (sortBy === 'failed_first') {
        const diff = statePriority[caseStateKey(a.latest)] - statePriority[caseStateKey(b.latest)];
        if (diff !== 0) return diff;
      }
      const timeDiff = activityTime(b).localeCompare(activityTime(a));
      return timeDiff !== 0 ? timeDiff : b.id - a.id;
    });
  }, [data, onlyMine, user, statusFilter, levelFilter, termFilter, scopeGroupFilter, uploaderFilter, q, sortBy]);

  return <>
    <div className="page-head">
      <div>
        <div className="sub">为课程选择学期后，可送检全套或部分材料，也可进行专业、课程组或学院复核。</div>
        {summary.total > 0 && (
          <div className="archive-inline-summary">
            <span>共 <strong>{summary.total}</strong> 份档案</span>
            {summary.failed > 0 && (
              <button
                type="button"
                className={`material-stat-link is-danger${statusFilter === 'failed' ? ' is-active' : ''}`}
                onClick={() => setStatusFilter((cur) => cur === 'failed' ? 'all' : 'failed')}
              >
                需整改 <strong>{summary.failed}</strong>
              </button>
            )}
            {summary.partial > 0 && (
              <button
                type="button"
                className={`material-stat-link is-warn${statusFilter === 'partial' ? ' is-active' : ''}`}
                onClick={() => setStatusFilter((cur) => cur === 'partial' ? 'all' : 'partial')}
              >
                部分通过 <strong>{summary.partial}</strong>
              </button>
            )}
            {summary.passed > 0 && (
              <button
                type="button"
                className={`material-stat-link is-ok${statusFilter === 'passed' ? ' is-active' : ''}`}
                onClick={() => setStatusFilter((cur) => cur === 'passed' ? 'all' : 'passed')}
              >
                已通过 <strong>{summary.passed}</strong>
              </button>
            )}
            {summary.running > 0 && (
              <button
                type="button"
                className={`material-stat-link${statusFilter === 'running' ? ' is-active' : ''}`}
                onClick={() => setStatusFilter((cur) => cur === 'running' ? 'all' : 'running')}
              >
                检查中 <strong>{summary.running}</strong>
              </button>
            )}
            {summary.unchecked > 0 && (
              <button
                type="button"
                className={`material-stat-link${statusFilter === 'unchecked' ? ' is-active' : ''}`}
                onClick={() => setStatusFilter((cur) => cur === 'unchecked' ? 'all' : 'unchecked')}
              >
                未检查 <strong>{summary.unchecked}</strong>
              </button>
            )}
          </div>
        )}
      </div>
      <Button type="primary" onClick={() => setEditor('new')}>新建送检档案</Button>
    </div>

    <Card className="archive-toolbar-card" styles={{ body: { padding: '10px 14px' } }}>
      <div className="material-filter-row">
        <Input
          allowClear
          prefix={<SearchOutlined style={{ color: '#94a3b8' }} />}
          placeholder="搜索课程、教学班、专业或上传人"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          style={{ width: 'min(220px, 100%)' }}
        />
        <Select
          aria-label="按检查状态筛选"
          value={statusFilter}
          onChange={setStatusFilter}
          style={{ width: 124 }}
          options={[
            { value: 'all', label: '全部状态' },
            { value: 'failed', label: '需整改' },
            { value: 'partial', label: '部分通过' },
            { value: 'passed', label: '通过' },
            { value: 'running', label: '检查中' },
            { value: 'error', label: '检查失败' },
            { value: 'unchecked', label: '未检查' },
          ]}
        />
        {(filterMeta.uploaders.length > 1 || isBroadViewer) && (
          <Select
            aria-label="按上传人筛选"
            allowClear
            showSearch
            optionFilterProp="label"
            placeholder="上传人"
            value={uploaderFilter}
            onChange={(val) => setUploaderFilter(val)}
            style={{ width: 132 }}
            options={filterMeta.uploaders}
          />
        )}
        {filterMeta.terms.length > 0 && (
          <Select
            aria-label="按学期筛选"
            allowClear
            showSearch
            optionFilterProp="label"
            placeholder="学期"
            value={termFilter || undefined}
            onChange={(val) => setTermFilter(val ?? '')}
            style={{ width: 148 }}
            options={options(filterMeta.terms)}
          />
        )}
        {filterMeta.groups.length > 1 && (
          <Select
            aria-label="按专业或课程组筛选"
            allowClear
            showSearch
            optionFilterProp="label"
            placeholder="专业/课程组"
            value={scopeGroupFilter || undefined}
            onChange={(val) => setScopeGroupFilter(val ?? '')}
            style={{ width: 140 }}
            options={options(filterMeta.groups)}
          />
        )}
        {filterMeta.levels.length > 1 && (
          <Select
            aria-label="按检查范围筛选"
            value={levelFilter}
            onChange={setLevelFilter}
            style={{ width: 112 }}
            options={[{ value: 'all', label: '全部范围' }, ...choices(levels)]}
          />
        )}
        <Select
          aria-label="排序方式"
          value={sortBy}
          onChange={setSortBy}
          style={{ width: 120 }}
          options={[
            { value: 'recent', label: '最近动态' },
            { value: 'failed_first', label: '需整改优先' },
            { value: 'created', label: '建档时间' },
          ]}
        />
        {filterMeta.hasOthers && (
          <label className="dossier-switch-label" style={{ marginInlineStart: 'auto' }}>
            <Switch size="small" checked={onlyMine} onChange={setOnlyMine} />
            <span>仅看我的</span>
          </label>
        )}
        {hasActiveFilter && (
          <Button type="link" size="small" style={{ paddingInline: 4 }} onClick={resetFilters}>
            重置（{filtered.length}/{data.length}）
          </Button>
        )}
      </div>
    </Card>

    <Card styles={{ body: { padding: 0 } }}>
      <ResponsiveTable<CaseListItem>
        rowKey="id"
        dataSource={filtered}
        loading={loading}
        pagination={{
          pageSize: 12,
          showSizeChanger: true,
          pageSizeOptions: ['12', '20', '50'],
          showTotal: (total) => `共 ${total} 份档案`,
        }}
        locale={{ emptyText: hasActiveFilter ? '没有符合筛选条件的送检档案' : '暂无送检档案，点击右上角「新建送检档案」开始' }}
        columns={[
          {
            title: '送检档案',
            width: 260,
            render: (_, r) => {
              const meta = [r.scope.courseCode, r.scope.major, r.scope.group].filter(Boolean).join(' · ');
              return (
                <div className="material-case-cell">
                  <Link to={`/materials/${r.id}`} className="material-case-title">{r.scope.title}</Link>
                  <div className="material-case-meta">
                    <Tag color={levelTagColors[r.scope.level]} bordered={false} style={{ marginInlineEnd: 0, fontSize: 11.5, lineHeight: '18px' }}>
                      {levelShort[r.scope.level]}
                    </Tag>
                    {meta && <span className="muted small">{meta}</span>}
                  </div>
                </div>
              );
            },
          },
          {
            title: '上传人',
            width: 145,
            render: (_, r) => (
              <div className="material-person-cell">
                <div className="material-person-name">{r.owner?.name || r.owner?.username || '未知'}</div>
                {r.owner?.username && r.owner.username !== r.owner.name && (
                  <div className="muted small">{r.owner.username}</div>
                )}
              </div>
            ),
          },
          {
            title: '学期 / 教学班',
            width: 155,
            render: (_, r) => (
              <div>
                <div>{r.scope.term || <span className="muted">未填学期</span>}</div>
                {r.scope.section && <div className="muted small">{r.scope.section}</div>}
              </div>
            ),
          },
          {
            title: '材料 / 次数',
            width: 105,
            render: (_, r) => (
              <div>
                <div>{r.fileCount} 份材料</div>
                <div className="muted small">{r.runCount ? `已检 ${r.runCount} 次` : '尚未检查'}</div>
              </div>
            ),
          },
          {
            title: '最近检查',
            width: 165,
            render: (_, r) => (
              <div className="material-status-cell">
                <div><RunStatusTag run={r.latest} /></div>
                <div className="muted small">
                  {r.latest ? (r.latest.finished_at || r.latest.created_at) : (r.createdAt ? `建档 ${r.createdAt}` : '')}
                </div>
              </div>
            ),
          },
          {
            title: '操作',
            width: 135,
            render: (_, r) => {
              const active = r.latest?.status === 'queued' || r.latest?.status === 'running';
              return (
                <Space size={4} wrap>
                  <Button type="link" size="small" style={{ paddingInline: 4 }} onClick={() => nav(`/materials/${r.id}`)}>查看</Button>
                  {r.editable && <>
                    <Button type="link" size="small" style={{ paddingInline: 4 }} disabled={active} onClick={() => setEditor(r)}>编辑</Button>
                    <CaseDelete entry={r} link size="small" disabled={active} onDeleted={load} />
                  </>}
                </Space>
              );
            },
          },
        ]}
      />
    </Card>
    {editor && <CaseEditor entry={editor === 'new' ? undefined : editor} onClose={() => setEditor(undefined)}
      onSaved={(id) => {
        setEditor(undefined);
        if (editor === 'new') nav(`/materials/${id}`);
        else void load();
      }} />}
  </>;
}

function CaseEditor({ entry, onClose, onSaved }: { entry?: CaseRecord; onClose: () => void; onSaved: (id: number) => void }) {
  const [settings, setSettings] = useState<Picklists>();
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [manualSection, setManualSection] = useState(!entry?.scope.section);
  const [form] = Form.useForm<Scope>();
  const level = Form.useWatch('level', form) ?? entry?.scope.level ?? 'course';
  const courseCode = Form.useWatch('courseCode', form);
  const title = Form.useWatch('title', form);
  const section = Form.useWatch('section', form);
  const { message } = App.useApp();
  useEffect(() => {
    api.get<Picklists>(`${base}/options`).then(setSettings).catch((e) => setError(e.message));
  }, []);
  const levelOptions = choices(levels).filter(({ value }) => value === entry?.scope.level || value === 'course' || (value === 'program' ? settings?.programs.length
    : value === 'group' ? settings?.groups.length : settings?.college));
  const available = (course: HistoryCourse) => !entry?.scopeLocked || !course.major || course.major === entry.scope.major;
  const courseOptions = [
    ...(settings?.teachingClasses ?? []).filter(available).map((course) => ({
      value: course.key, label: `${course.section} · ${courseLabel(course)}`, course, section: course.section,
    })),
    ...(settings?.courses ?? []).filter(available).map((course) => ({
      value: course.key, label: `${courseLabel(course)} · 手动填班`, course, section: '',
    })),
  ];
  return <Modal title={entry ? '编辑档案' : '新建送检档案'} width={720} open onCancel={onClose}
    okText={entry ? '保存修改' : '建档并上传'} confirmLoading={busy} okButtonProps={{ disabled: !settings }} onOk={() => form.submit()}>
      {error && <Alert type="error" message={error} />}
      <Spin spinning={!settings && !error}>
      <Form form={form} layout="vertical" initialValues={entry?.scope ?? { level: 'course', planGrade: 2025 }}
        onFinish={async (values) => {
          setBusy(true);
          try {
            if (entry) {
              await api.put(`${base}/${entry.id}`, { ...entry.scope, ...values });
              message.success('档案已保存，已有检查报告不变');
              onSaved(entry.id);
            } else {
              const { id } = await api.post<{ id: number }>(base, values);
              onSaved(id);
            }
          } catch (e) { message.error((e as Error).message); }
          finally { setBusy(false); }
        }}>
        <Form.Item name="level" label="检查范围" rules={[{ required: true }]}><Select disabled={!!entry} options={levelOptions} /></Form.Item>
        <Form.Item name="courseCode" hidden><Input /></Form.Item>
        <Form.Item name="title" label={level === 'course' ? '课程／教学班' : '复核名称'}
          extra={level === 'course' && <Space size={8} wrap>
            {section && !manualSection && <span>教学班：{section}
              {' '}<Button type="link" size="small" onClick={() => setManualSection(true)}>改填教学班</Button></span>}
            {courseCode && <span>课程代码：{courseCode}</span>}
            {!title && <span>优先选已登记的教学班，也可手动补录。</span>}
          </Space>} rules={[{ required: true, whitespace: true }]}>
          {level === 'course' ? <AutoComplete options={courseOptions} placeholder="按教学班、课程名称或代码搜索"
            filterOption={(value, option) => !!option?.label.toLowerCase().includes(value.toLowerCase())}
            onChange={() => { form.setFieldsValue({ courseCode: '', section: '' }); setManualSection(true); }}
            onSelect={(_, { course, section }) => {
              setManualSection(!section);
              form.setFieldsValue({ title: course.name, courseCode: course.code, section,
                ...(settings?.majors.includes(course.major) && !entry?.scopeLocked ? { major: course.major } : {}) });
            }}>
            <Input maxLength={120} />
          </AutoComplete> : <Input maxLength={120} />}
        </Form.Item>
        {level === 'course' && <Form.Item name="section" label="教学班" hidden={!manualSection || !title?.trim()}>
          <Input maxLength={120} placeholder="填写实际教学班或合班名称" />
        </Form.Item>}
        {(level === 'course' || level === 'program') && <Row gutter={16}>
          <Col xs={24} sm={12}><Form.Item name="major" label="专业" rules={[{ required: true }]}>
            <Select disabled={entry?.scopeLocked} options={options([...(level === 'course' ? settings?.majors ?? [] : settings?.programs ?? [])])} />
          </Form.Item></Col>
          <Col xs={24} sm={12}><Form.Item name="planGrade" label="对照培养方案年级"><InputNumber min={2000} max={2100} style={{ width: '100%' }} /></Form.Item></Col>
        </Row>}
        {level === 'group' && <Form.Item name="group" label="课程组" rules={[{ required: true }]}><Select disabled={entry?.scopeLocked} options={options(settings?.groups ?? [])} /></Form.Item>}
        {entry?.scopeLocked && (level === 'course' || level === 'program' || level === 'group') &&
          <div className="muted" style={{ marginTop: 12 }}>已有附件或检查记录，不能更改所属专业或课程组；其他修改在下次检查时生效。</div>}
      </Form>
      </Spin>
  </Modal>;
}

function CaseDelete({ entry, disabled, link, size, onDeleted }: { entry: CaseRecord; disabled: boolean; link?: boolean; size?: 'small' | 'middle'; onDeleted: () => void }) {
  const { message } = App.useApp();
  return <Popconfirm title={`删除「${entry.scope.title}」？`}
    description="档案、全部附件和历史检查报告都会删除，无法恢复。已用检查次数不退回。"
    okText="确认删除" cancelText="取消" okButtonProps={{ danger: true }} disabled={disabled}
    onConfirm={async () => {
      try {
        await api.del(`${base}/${entry.id}`);
        message.success('已删除送检档案');
        onDeleted();
      } catch (e) { message.error((e as Error).message); }
    }}>
    <Button danger type={link ? 'link' : 'default'} size={size} style={link && size === 'small' ? { paddingInline: 4 } : undefined} disabled={disabled}>删除</Button>
  </Popconfirm>;
}

function CaseDetail({ id }: { id: string }) {
  const url = `${base}/${id}`;
  const { message } = App.useApp();
  const nav = useNavigate();
  const back = () => nav('/materials');
  const [entry, setEntry] = useState<Detail>();
  const [term, setTerm] = useState<string>();
  const [reviewHistory, setReviewHistory] = useState(true);
  const [error, setError] = useState('');
  const [runId, setRunId] = useState<number>();
  const [result, setResult] = useState<Result | null>(null);
  const [resultLoading, setResultLoading] = useState(false);
  const [pending, setPending] = useState(false);
  const [editing, setEditing] = useState(false);
  const [type, setType] = useState<string>();
  const [upload, setUpload] = useState<File[]>([]);
  const [picker, setPicker] = useState(0);
  const [editGrade, setEditGrade] = useState<Attached>();
  const [verify, setVerify] = useState<Rule>();
  const [verifyForm] = Form.useForm<{ finding: string; note: string }>();
  const [activeTab, setActiveTab] = useState<'issues' | 'material' | 'history' | 'files'>('files');
  const tabInitialized = useRef(false);

  const fetchCase = useCallback(async () => {
    const detail = await api.get<Detail>(url);
    setEntry(detail);
    setTerm((old) => old ?? detail.scope.term);
    setType((old) => old && (detail.expected.includes(old) || detail.optional.includes(old)) ? old : undefined);
    setRunId((old) => old ?? detail.runs[0]?.id);
    if (!tabInitialized.current) {
      tabInitialized.current = true;
      setActiveTab(detail.runs.length > 0 ? 'issues' : 'files');
    }
  }, [url]);
  useEffect(() => { fetchCase().catch((e) => setError(e.message)); }, [fetchCase]);
  const latest = entry?.runs[0];
  const active = latest?.status === 'queued' || latest?.status === 'running';
  const selected = entry?.runs.find((r) => r.id === runId);
  const currentState = selected?.status;
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => fetchCase().catch((e) => message.error(e.message)), 1800);
    return () => clearInterval(timer);
  }, [active, fetchCase, message]);
  useEffect(() => {
    setResult(null);
    if (!runId || currentState !== 'done') {
      setResultLoading(false);
      return;
    }
    let cancelled = false;
    setResultLoading(true);
    api.get<{ result: Result }>(`${url}/runs/${runId}`).then((r) => {
      if (!cancelled) setResult(r.result);
    }).catch((e) => { if (!cancelled) message.error(e.message); })
      .finally(() => { if (!cancelled) setResultLoading(false); });
    return () => { cancelled = true; };
  }, [runId, currentState, url, message]);

  async function perform(action: () => Promise<void>) {
    setPending(true);
    try { await action(); await fetchCase(); }
    catch (e) { message.error((e as Error).message); }
    finally { setPending(false); }
  }

  if (error) {
    return (
      <div className="page">
        <Button icon={<ArrowLeftOutlined />} onClick={back} style={{ marginBottom: 14 }}>返回档案列表</Button>
        <Alert type="error" message={error} />
      </div>
    );
  }
  if (!entry) return <div className="page"><Spin /></div>;

  const { scope } = entry;
  const readonly = !entry.editable || active;
  const isCourse = scope.level === 'course';
  const year = new Date().getFullYear();
  const termOptions = options([year, year - 1, year - 2].flatMap((start) =>
    [1, 2].map((semester) => `${start}-${start + 1} 第${semester}学期`)));
  const startDisabledReason = !entry.files.length
    ? '请先在「送检材料管理」上传至少一份材料'
    : !term?.trim()
      ? `请先在「送检材料管理」填写${isCourse ? '送检学期' : '复核时段'}`
      : '';
  const types = result ? [...new Set(result.files.map((f) => f.type))] : [];

  const renderRunPlaceholder = () => {
    if (!entry.runs.length) {
      return (
        <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="还没有检查结果，请先在「送检材料管理」上传材料并开始检查">
          <Button type="primary" onClick={() => setActiveTab('files')}>去上传材料</Button>
        </Empty>
      );
    }
    if (selected?.status === 'failed') {
      return <Alert type="error" showIcon message={selected.error || '检查运行失败，请重试'} />;
    }
    if (selected?.status === 'queued' || selected?.status === 'running') {
      return <Alert type="info" showIcon message="正在等待或读取材料并检查；结果会自动刷新。" />;
    }
    if (resultLoading || !result) {
      return <div style={{ padding: '36px 0', textAlign: 'center' }}><Spin tip="正在加载检查报告…" /></div>;
    }
    return null;
  };

  const tabItems = [
    {
      key: 'issues',
      label: '整改报告',
      children: result
        ? <IssueSummary result={result} onVerify={!readonly && latest?.id === runId
          ? (rule) => { verifyForm.resetFields(); setVerify(rule); } : undefined} />
        : renderRunPlaceholder(),
    },
    {
      key: 'material',
      label: `材料与成绩统计${result ? `（${result.files.length}）` : ''}`,
      children: result ? (
        <Collapse items={types.map((t) => {
          const files = result.files.filter((f) => f.type === t);
          const stats = result.stats.filter((s) => files.some((f) => f.id === s.id));
          const warningCount = files.reduce((n, f) => n + f.warnings.length, 0);
          return {
            key: t,
            label: <Space wrap>
              <span>{t}</span>
              <Tag color="blue">{files.length} 份</Tag>
              {warningCount > 0 && <Tag color="warning">{warningCount} 条提醒</Tag>}
              {stats.length > 0 && <Tag color="cyan">含成绩复算</Tag>}
            </Space>,
            children: <Space direction="vertical" style={{ width: '100%' }}>
              {files.map((f) => <div key={f.id || f.name}>{f.id
                ? <Button type="link" style={{ paddingInline: 0 }} icon={<DownloadOutlined />} onClick={() => download(`${url}/files/${f.id}/original`)}>{f.name}</Button>
                : <Tag>已引用：{f.name}</Tag>}
                {f.warnings.map((w, i) => <Alert key={i} type="warning" message={w} style={{ marginTop: 6 }} />)}
              </div>)}
              {!!stats.length && <div className="muted small">复算仅用于核对，不修改正式成绩。</div>}
              {stats.map((s) => <div key={s.id} className="material-grade-stat-box">
                <div style={{ marginBottom: 6 }}><strong>识别到的权重：</strong>{Object.entries(s.weights).map(([key, value]) => `${key} ${value}%`).join('、') || '待核实'}</div>
                {s.stats.map((item) => <div key={item.column} className="small" style={{ lineHeight: 1.8 }}>
                  <strong>{item.column}：</strong>{item.count}/{item.rows} 行可计算，{item.excluded} 行特殊状态，{item.unreadable} 行待核；
                  均分 <strong>{item.mean?.toFixed(2) ?? '—'}</strong>；各分段人数（&lt;60／60–69／70–79／80–89／≥90）{item.bands.join('／')}
                </div>)}
              </div>)}
            </Space>,
          };
        })} />
      ) : renderRunPlaceholder(),
    },
    ...(result?.history ? [{
      key: 'history',
      label: `历史问题复查（${result.history.length}）`,
      children: (
        <ResponsiveTable
          rowKey={(r) => r.issue.id}
          dataSource={result.history}
          size="small"
          pagination={{ pageSize: 12 }}
          locale={{ emptyText: '没有匹配到可复查的历史问题。常规清单检查已照常完成。' }}
          columns={[
            {
              title: '历史反馈原文',
              width: 340,
              render: (_, r) => <>
                <div style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{r.issue.text}</div>
                <div className="muted small">{[r.issue.term || r.issue.date, r.issue.source, r.issue.position].filter(Boolean).join(' · ')}</div>
              </>,
            },
            {
              title: '本次复查结论',
              width: 260,
              render: (_, r) => <><Tag color={colors[r.status]}>{r.status}</Tag>{r.detail}</>,
            },
            {
              title: '本次文件与位置',
              width: 240,
              render: (_, r) => r.locations.length ? r.locations.map((loc, index) =>
                <div key={index}>{loc.fileId
                  ? <Button type="link" size="small" style={{ paddingInline: 0 }} onClick={() => download(`${url}/files/${loc.fileId}/original`)}>{loc.file}</Button>
                  : loc.file} · {loc.position}</div>) : '暂无核验依据',
            },
          ]}
        />
      ),
    }] : []),
    {
      key: 'files',
      label: `送检材料管理（${entry.files.length}份）`,
      children: (
        <div>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 12, marginBottom: 12 }}>
            {entry.editable ? (
              <Space wrap align="center">
                <span style={{ fontWeight: 500 }}>{isCourse ? '送检学期：' : '复核时段：'}</span>
                <AutoComplete id="material-term" value={term ?? ''} disabled={readonly || pending}
                  style={{ width: 260 }} options={isCourse ? termOptions : []} onChange={setTerm}
                  filterOption={(value, option) => !!option?.value.includes(value)} placeholder={isCourse ? '选择或填写学期' : '填写本次复核时段'}>
                  <Input maxLength={120} />
                </AutoComplete>
              </Space>
            ) : <span />}
            <Tag style={{ marginInlineEnd: 0 }}>规则 {entry.version}</Tag>
          </div>
          <Alert type="info" showIcon message="可以先检查已上传的材料。应交未上传记为待补，不适用不记缺失。"
            description="开始检查时，普通 JPG、PNG 会自动发送给当前 AI 接口识别文字。请先脱敏；成绩单和学生答卷仅在本地处理。" />
          {entry.editable && <Space wrap style={{ margin: '14px 0' }}>
            <Select aria-label="材料类型" placeholder="选择材料类型" disabled={readonly} showSearch value={type} onChange={setType}
              style={{ minWidth: 260 }} options={options([...entry.expected, ...entry.optional])} />
            <input key={picker} aria-label="选择原始材料" type="file" accept=".docx,.xls,.xlsx,.pptx,.pdf,.jpg,.jpeg,.png" multiple disabled={readonly}
              onChange={(e) => setUpload([...e.currentTarget.files ?? []])} />
            <Button aria-label="上传材料" disabled={readonly || !type || !upload.length} loading={pending} onClick={() => perform(async () => {
              let sent = 0;
              try {
                for (const file of upload) {
                  const body = new FormData(); body.set('file', file); body.set('type', type!);
                  await api.post(`${url}/files`, body); sent++;
                }
                message.success(`已添加 ${sent} 份材料`);
              } finally {
                setUpload(upload.slice(sent)); setPicker((i) => i + 1);
                if (sent !== upload.length) await fetchCase();
              }
            })}>上传</Button>
            {!!upload.length && <span className="muted">待上传 {upload.length} 个文件</span>}
          </Space>}
          <ResponsiveTable
            rowKey="type"
            size="small"
            pagination={false}
            dataSource={[...new Set([...entry.expected, ...entry.files.map((f) => f.type)])].map((t) =>
              ({ type: t, files: entry.files.filter((f) => f.type === t) }))}
            columns={[
              { title: '材料类型', dataIndex: 'type', width: 260 },
              {
                title: '已提供',
                width: 540,
                render: (_, row) => row.files.length ? row.files.map((file) => (
                  <Space key={file.id} size={4} wrap style={{ display: 'flex' }}>
                    <Button type="link" size="small" style={{ paddingInline: 4 }} onClick={() => download(`${url}/files/${file.id}/original`)}>{file.name}</Button>
                    {file.grade && <Button type="link" size="small" style={{ paddingInline: 4 }} onClick={() => setEditGrade(file)}>查看／校对成绩</Button>}
                    {entry.editable && <Popconfirm title="从当前送检材料移除？历史报告引用的原文件仍会保留。"
                      onConfirm={() => perform(async () => { await api.del(`${url}/files/${file.id}`); })}>
                      <Button type="link" size="small" style={{ paddingInline: 4 }} danger disabled={readonly || pending}>移除</Button>
                    </Popconfirm>}
                  </Space>
                )) : row.type === planType && entry.plan ? <Tag color="blue">已引用：{entry.plan.name}</Tag> : <Tag color="gold">待补</Tag>,
              },
            ]}
          />
        </div>
      ),
    },
  ];

  const tabBarExtra = entry.runs.length > 0 ? (
    <Space size={8} wrap>
      <Select
        aria-label="检查版本"
        size="small"
        value={runId}
        onChange={setRunId}
        style={{ width: 'min(300px, 55vw)' }}
        options={entry.runs.map((r) => ({
          value: r.id,
          label: [
            `#${r.id}`,
            r.finished_at || r.created_at,
            r.verdict ? (r.verdict === 'partial' ? '部分通过' : verdictNames[r.verdict]) : statusNames[r.status],
          ].filter(Boolean).join(' · '),
        }))}
      />
      {selected?.status === 'done' && (
        <Button size="small" type="primary" icon={<DownloadOutlined />} onClick={() => download(`${url}/runs/${runId}/report.docx`)}>
          下载 Word
        </Button>
      )}
    </Space>
  ) : undefined;

  return <div className="page material-detail-page">
    <div className="material-detail-header">
      <div className="material-detail-header-left">
        <div className="material-detail-title-row">
          <Button type="text" size="small" icon={<ArrowLeftOutlined />} onClick={back} style={{ paddingInline: 4 }}>返回</Button>
          <h1>{scope.title}</h1>
          <RunStatusTag run={latest} />
        </div>
        <div className="material-detail-sub">
          <span>{[levels[scope.level], scope.courseCode, scope.term, scope.section, scope.major, scope.group].filter(Boolean).join(' · ')}</span>
          <span className="material-detail-sep">|</span>
          <span>上传人：<strong>{personDisplay(entry.owner)}</strong></span>
        </div>
      </div>
      {entry.editable && (
        <Space size={8} wrap className="material-detail-actions">
          {isCourse && <Checkbox checked={reviewHistory} disabled={readonly || pending}
            onChange={(e) => setReviewHistory(e.target.checked)}>复查历史问题</Checkbox>}
          <Button size="small" disabled={active || pending} onClick={() => setEditing(true)}>编辑档案</Button>
          <CaseDelete entry={entry} size="small" disabled={active || pending} onDeleted={back} />
          <Tooltip title={startDisabledReason}>
            <Button size="small" type="primary" disabled={active || !entry.files.length || !term?.trim()} loading={pending}
              onClick={() => perform(async () => {
                const r = await api.post<{ id: number }>(`${url}/runs`, { term, reviewHistory });
                setRunId(r.id);
                setActiveTab('issues');
              })}>
              {latest ? '重新检查' : '开始检查'}
            </Button>
          </Tooltip>
        </Space>
      )}
    </div>

    <Card className="material-detail-card" styles={{ body: { padding: '6px 20px 20px' } }}>
      <Tabs
        activeKey={activeTab}
        onChange={(k) => setActiveTab(k as typeof activeTab)}
        tabBarExtraContent={tabBarExtra}
        items={tabItems}
      />
    </Card>

    {editing && <CaseEditor entry={entry} onClose={() => setEditing(false)} onSaved={() => {
      setEditing(false);
      void fetchCase().catch((e) => message.error(e.message));
    }} />}
    {editGrade && <GradeDialog url={`${url}/files/${editGrade.id}`} file={editGrade} readonly={readonly} onClose={() => setEditGrade(undefined)} />}
    <Modal open={!!verify} title={verify ? `人工核实 · ${verify.title}` : ''} onCancel={() => setVerify(undefined)}
      onOk={() => verifyForm.submit()} okText="保存核实意见" confirmLoading={pending}>
      <Form layout="vertical" form={verifyForm} initialValues={{ finding: '未发现问题' }}
        onFinish={(value) => perform(async () => {
          await api.put(`${url}/verification/${verify!.code}`, value);
          setVerify(undefined); message.success('已保存；重新检查后写入新报告。');
        })}>
        <Form.Item name="finding" label="核实结论"><Select options={options(['未发现问题', '需整改'])} /></Form.Item>
        <Form.Item name="note" label="依据位置与结论" rules={[{ required: true, min: 3 }]}><Input.TextArea rows={3} maxLength={800} /></Form.Item>
      </Form>
    </Modal>
  </div>;
}

function IssueSummary({ result, onVerify }: { result: Result; onVerify?: (rule: Rule) => void }) {
  const { materials, missing, toVerify } = result.issueReport;
  const [activeId, setActiveId] = useState('');
  const [verifyOpen, setVerifyOpen] = useState<string[]>([]);
  const sectionRefs = useRef<Record<string, HTMLElement | null>>({});

  const verifiable = useMemo(
    () => new Map(result.rules.filter((rule) => rule.status === '需核实' && rule.materials.length).map((rule) => [rule.code, rule])),
    [result.rules],
  );

  const navItems = useMemo(() => {
    const items: { id: string; label: string; count: number }[] = materials.map((m, idx) => ({
      id: `report-mat-${idx}`,
      label: m.material,
      count: m.sections.reduce((sum, s) => sum + s.issues.length, 0),
    }));
    if (missing.length) items.push({ id: 'report-missing', label: '附 待补材料', count: missing.length });
    if (toVerify.length) items.push({ id: 'report-verify', label: '附 需核实事项', count: toVerify.length });
    return items;
  }, [materials, missing.length, toVerify.length]);

  useEffect(() => {
    setActiveId(navItems[0]?.id ?? '');
    setVerifyOpen([]);
  }, [result, navItems]);

  useEffect(() => {
    if (navItems.length <= 1) return;
    const onScroll = () => {
      let current = navItems[0].id;
      for (const item of navItems) {
        const el = sectionRefs.current[item.id];
        if (el && el.getBoundingClientRect().top <= 120) current = item.id;
      }
      setActiveId(current);
    };
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, [navItems]);

  const jumpTo = (id: string) => {
    setActiveId(id);
    if (id === 'report-verify') setVerifyOpen(['verify']);
    requestAnimationFrame(() => {
      sectionRefs.current[id]?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
  };

  const renderIssue = (issue: MaterialIssue, i: number, material?: string) => (
    <div className="issue" key={i}>
      <h5 className="issue-title">{i + 1}. {issue.title}</h5>
      {!!issue.materials.length && (issue.materials.length !== 1 || issue.materials[0] !== material) && (
        <p className="issue-location"><b>涉及材料：</b>{issue.materials.join(' / ')}</p>
      )}
      {!!issue.locations.length && <p className="issue-location"><b>位置：</b>{issue.locations.join('；')}</p>}
      {issue.detail !== issue.title && <p><b>{material ? '问题：' : '核实内容：'}</b>{issue.detail}</p>}
      {issue.action && <p><b>整改意见：</b>{issue.action}</p>}
      {issue.history && <p className="issue-location"><b>往期反馈：</b>{issue.history}</p>}
      {!material && onVerify && issue.checks.map(({ code, title }) => {
        const rule = verifiable.get(code);
        return rule && <Button type="link" size="small" className="material-report-verify" key={code} onClick={() => onVerify(rule)}>核实 {code} {title}</Button>;
      })}
    </div>
  );

  return (
    <div className="material-report-with-toc">
      <div className="report-paper material-report material-report-main">
        {!materials.length && <p className="muted">本次未发现明确问题或建议修改项。</p>}
        {materials.map(({ material, source, sections }, idx) => {
          const secId = `report-mat-${idx}`;
          return (
            <section key={material} ref={(el) => { sectionRefs.current[secId] = el; }} className="material-toc-target">
              <h3 className="report-section">{material}</h3>
              {source && <p className="report-meta muted">{source}</p>}
              {sections.map(({ label, issues }) => (
                <div key={label}>
                  <h4 className="material-report-category">{label} <span className="muted">{issues.length} 项</span></h4>
                  {issues.map((issue, i) => renderIssue(issue, i, material))}
                </div>
              ))}
            </section>
          );
        })}
        {!!missing.length && (
          <section ref={(el) => { sectionRefs.current['report-missing'] = el; }} className="material-toc-target">
            <h3 className="report-section">附 待补材料</h3>
            <p>{missing.join('；')}</p>
          </section>
        )}
        {!!toVerify.length && (
          <section ref={(el) => { sectionRefs.current['report-verify'] = el; }} className="material-toc-target">
            <Collapse
              className="material-report-appendix"
              size="small"
              activeKey={verifyOpen}
              onChange={(keys) => setVerifyOpen(Array.isArray(keys) ? keys.map(String) : [String(keys)])}
              items={[{
                key: 'verify',
                label: `附 需核实事项（${toVerify.length} 项，尚未确认）`,
                children: toVerify.map((issue, i) => renderIssue(issue, i)),
              }]}
            />
          </section>
        )}
      </div>

      {navItems.length > 1 && (
        <aside className="material-report-toc" aria-label="材料快捷导航">
          <div className="material-toc-title">快捷导航</div>
          <nav className="material-toc-list">
            {navItems.map((item) => (
              <button
                type="button"
                key={item.id}
                className={`material-toc-item${activeId === item.id ? ' is-active' : ''}`}
                onClick={() => jumpTo(item.id)}
              >
                <span className="material-toc-label" title={item.label}>{item.label}</span>
                <span className="material-toc-count">{item.count}</span>
              </button>
            ))}
          </nav>
        </aside>
      )}
    </div>
  );
}

function GradeDialog({ url, file, readonly, onClose }: { url: string; file: Attached; readonly: boolean; onClose: () => void }) {
  const { message } = App.useApp();
  const [data, setData] = useState<GradeData>();
  const [edits, setEdits] = useState<GradeEdit[]>([]);
  const [weightEdits, setWeightEdits] = useState<Record<string, number> | null>(null);
  const [verified, setVerified] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const original = `${url}/original`;
  useEffect(() => {
    api.get<GradeData>(`${url}/grades`).then((next) => {
      setData(next); setEdits(next.edits); setWeightEdits(next.weightEdits); setVerified(next.weightsVerified);
    })
      .catch((e) => setError(e.message));
  }, [url]);
  const columns = [...new Set(data?.rows.flatMap((r) => Object.keys(r.cells)) ?? [])].filter((key) => key !== '序号');
  const position = (row: GradeRow, column: string) => (edit: GradeEdit) =>
    edit.location === row.location && edit.line === row.line && edit.column === column;
  const edit = (row: GradeRow, column: string, value: string) => setEdits((old) => [
    ...old.filter((e) => !position(row, column)(e)), { location: row.location, line: row.line, column, value },
  ]);
  return <Modal open title={`成绩单识别 · ${file.name}`} width={1150} onCancel={onClose}
    footer={readonly || !data ? <Button onClick={onClose}>关闭</Button> : [
      <Button key="close" onClick={onClose}>取消</Button>,
      <Button key="save" type="primary" loading={busy} onClick={async () => {
        setBusy(true);
        try {
          await api.put(`${url}/grades`, { edits, weights: weightEdits, weightsVerified: verified });
          message.success('已保存识别校正，原件未改动；重新检查后生效。'); onClose();
        } catch (e) { message.error((e as Error).message); } finally { setBusy(false); }
      }}>保存识别校正</Button>,
    ]}>
    {error ? <Alert type="error" message={error} /> : !data ? <Spin /> : <Space direction="vertical" style={{ width: '100%' }} size="middle">
      <Alert type="info" message="空白、短横线和 0 不等同。请只按原件校正识别值，备注不会用于改分。" />
      <Space wrap>
        {/\.(png|jpe?g)$/i.test(file.name) && <Image src={`${original}?preview=1`} width={140} alt="成绩单原图，点开可旋转和放大" />}
        {/\.pdf$/i.test(file.name) && <a href={`${original}?preview=1`} target="_blank" rel="noreferrer">打开 PDF 原件</a>}
        <Button onClick={() => download(original)}>下载原件</Button>
      </Space>
      <div>识别到的成绩比例：{Object.entries(data.weights).map(([key, value]) => `${key} ${value}%`).join('、') || '未识别到'}</div>
      {data.scanned && <>
        <Space wrap>
          {['平时', '期中', '实验', '期末'].map((key) => <label key={key}>
            {key} <InputNumber aria-label={`${key}成绩比例`} min={0} max={100} size="small" disabled={readonly}
              addonAfter="%" value={(weightEdits ?? data.weights)[key] ?? null} onChange={(value) => {
                if (value === null) {
                  const next = { ...(weightEdits ?? data.weights) }; delete next[key]; setWeightEdits(next);
                } else setWeightEdits({ ...(weightEdits ?? data.weights), [key]: value });
                setVerified(false);
              }} />
          </label>)}
          {!readonly && weightEdits && <Button size="small" onClick={() => { setWeightEdits(null); setVerified(false); }}>恢复识别值</Button>}
        </Space>
        <Checkbox disabled={readonly} checked={verified}
          onChange={(e) => setVerified(e.target.checked)}>以上比例已与原件逐项核对</Checkbox>
      </>}
      <Table<GradeRow> rowKey={(r) => `${r.location}:${r.line}`} dataSource={data.rows} size="small" scroll={{ x: 'max-content' }}
        pagination={{ pageSize: 12 }} locale={{ emptyText: '未识别到可对齐的表格行。请查看原文件，或补传清晰原图／电子表格。' }}
        columns={[{ title: '位置', render: (_, row) => `${row.location} · ${row.line}` },
          ...columns.map((column) => ({
            title: column, width: column === '学号' || column === '备注' ? 150 : 96,
            render: (_: unknown, row: GradeRow) => {
              if (!(column in row.cells)) return '—';
              const correction = edits.find(position(row, column));
              const value = correction?.value ?? row.cells[column];
              const uncertain = !correction && row.uncertain.includes(column);
              return readonly ? <>{value || '空白'}{uncertain && <Tag color="orange">待核</Tag>}</>
                : <Input size="small" aria-label={`${row.location} 行 ${row.line} ${column}`} maxLength={120}
                  status={uncertain ? 'warning' : undefined} value={value} placeholder={uncertain ? '待核' : '空白'}
                  onChange={(e) => edit(row, column, e.target.value)} />;
            },
          })),
          ...(!readonly && data.scanned ? [{ title: '复核操作', render: (_: unknown, row: GradeRow) => row.ocr && <Button size="small"
            onClick={() => setEdits((old) => [...old, ...columns.filter((key) =>
              row.cells[key] && !old.some(position(row, key))).map((column) => ({ location: row.location, line: row.line, column, value: row.cells[column] }))])}>
            确认本行非空识别值
          </Button> }] : []),
        ]} />
    </Space>}
  </Modal>;
}
