import { useCallback, useEffect, useState } from 'react';
import { ArrowLeftOutlined } from '@ant-design/icons';
import { Alert, App, AutoComplete, Button, Card, Checkbox, Col, Collapse, Empty, Form, Image, Input, InputNumber, Modal, Popconfirm, Row, Select, Space, Spin, Table, Tabs, Tag } from 'antd';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { api, download } from '../../api';
import { useAuth } from '../../auth';
import { courseLabel, HistoryImport, HistorySearch, type HistoryCourse, type HistoryIssue } from './MaterialHistory';

const base = '/api/materials';
const planType = '人才培养方案及支撑矩阵';
const levels = { course: '课程检查', program: '专业复核', group: '教研室／课程组复核', college: '学院复核' };
const statusNames = { queued: '排队中', running: '检查中', done: '已完成', failed: '检查失败' };
const verdictNames = { passed: '通过', partial: '已检部分未发现问题（仍有待补／待核）', failed: '需整改' };
const colors: Record<string, string> = { 未发现问题: 'green', 需整改: 'red', 建议完善: 'blue', 待补: 'gold', 需核实: 'orange', 不适用: 'default' };
const choices = (items: Record<string, string>) => Object.entries(items).map(([value, label]) => ({ value, label }));
const options = (items: string[]) => items.map((value) => ({ value, label: value }));

type Scope = { level: keyof typeof levels; title: string; courseCode?: string; term: string; section: string; major: string; group: string; planGrade: number };
type Run = { id: number; status: keyof typeof statusNames; error: string | null; version: string;
  created_at: string; verdict: keyof typeof verdictNames | null };
type CaseRecord = { id: number; scope: Scope; editable: boolean; scopeLocked: boolean };
type Attached = { id: number; name: string; type: string; grade: boolean };
type Detail = CaseRecord & { version: string; expected: string[]; optional: string[];
  plan: { name: string } | null; files: Attached[]; runs: Run[] };
type Picklists = { majors: string[]; programs: readonly string[]; groups: string[]; college: boolean; courses: HistoryCourse[] };
type GradeRow = { location: string; line: number; cells: Record<string, string>; uncertain: string[]; ocr: boolean };
type GradeEdit = { location: string; line: number; column: string; value: string };
type GradeData = { rows: GradeRow[]; edits: GradeEdit[]; weights: Record<string, number>; weightEdits: Record<string, number> | null;
  scanned: boolean; weightsVerified: boolean };
type Finding = { status: string; location: string; detail: string };
type Rule = { code: string; title: string; materials: string[]; status: string; findings: Finding[] };
type Result = { verdict: keyof typeof verdictNames; rules: Rule[]; files: { id: number; name: string; type: string; warnings: string[] }[];
  history?: { issue: HistoryIssue; status: string; detail: string; locations: { fileId: number; file: string; position: string }[] }[];
  stats: { id: number; file: string; weights: Record<string, number>; stats: { column: string; count: number; rows: number; excluded: number; unreadable: number; mean: number | null; bands: number[] }[] }[] };

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
  const [data, setData] = useState<(CaseRecord & { latest: Run | null })[]>([]);
  const [loading, setLoading] = useState(true);
  const [editor, setEditor] = useState<CaseRecord | 'new'>();
  const nav = useNavigate();
  const { message } = App.useApp();
  const load = useCallback(async () => {
    setLoading(true);
    try { setData(await api.get<typeof data>(base)); }
    catch (e) { message.error((e as Error).message); }
    finally { setLoading(false); }
  }, [message]);
  useEffect(() => { void load(); }, [load]);
  return <>
    <div className="page-head">
      <div className="sub">为课程选择学期后，可送检全套或部分材料，也可进行专业、课程组或学院复核。</div>
      <Button type="primary" onClick={() => setEditor('new')}>新建送检档案</Button>
    </div>
    <Card>
      <Table rowKey="id" dataSource={data} loading={loading} scroll={{ x: 860 }} pagination={{ pageSize: 12 }} columns={[
        { title: '送检档案', render: (_, r) => <Link to={`/materials/${r.id}`}>{r.scope.title}</Link> },
        { title: '范围', render: (_, r) => levels[r.scope.level] },
        { title: '学期／教学班', render: (_, r) => [r.scope.term, r.scope.section].filter(Boolean).join(' · ') },
        { title: '最近检查', render: (_, r) => r.latest ? r.latest.verdict ? verdictNames[r.latest.verdict] : statusNames[r.latest.status] : '未检查' },
        { title: '操作', width: 180, fixed: 'right', render: (_, r) => {
          const active = r.latest?.status === 'queued' || r.latest?.status === 'running';
          return <Space size={0}>
            <Button type="link" onClick={() => nav(`/materials/${r.id}`)}>查看</Button>
            {r.editable && <>
              <Button type="link" disabled={active} onClick={() => setEditor(r)}>编辑</Button>
              <CaseDelete entry={r} link disabled={active} onDeleted={load} />
            </>}
          </Space>;
        } },
      ]} />
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
  const [form] = Form.useForm<Scope>();
  const level = Form.useWatch('level', form) ?? entry?.scope.level ?? 'course';
  const courseCode = Form.useWatch('courseCode', form);
  const { message } = App.useApp();
  useEffect(() => {
    api.get<Picklists>(`${base}/options`).then(setSettings).catch((e) => setError(e.message));
  }, []);
  const levelOptions = choices(levels).filter(({ value }) => value === entry?.scope.level || value === 'course' || (value === 'program' ? settings?.programs.length
    : value === 'group' ? settings?.groups.length : settings?.college));
  const courseOptions = settings?.courses.map((course) => ({ value: course.key, label: courseLabel(course), course }));
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
        <Form.Item name="title" label={level === 'course' ? '课程' : '复核名称'}
          extra={level === 'course' && courseCode ? `课程代码：${courseCode}` : undefined} rules={[{ required: true, whitespace: true }]}>
          {level === 'course' ? <AutoComplete options={courseOptions} placeholder="按课程名称或代码选择，也可填写新课程名称"
            filterOption={(value, option) => !!option?.label.toLowerCase().includes(value.toLowerCase())}
            onChange={() => form.setFieldValue('courseCode', '')}
            onSelect={(_, { course }) => form.setFieldsValue({ title: course.name, courseCode: course.code,
              ...(settings?.majors.includes(course.major) && !entry?.scopeLocked ? { major: course.major } : {}) })}>
            <Input maxLength={120} />
          </AutoComplete> : <Input maxLength={120} />}
        </Form.Item>
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

function CaseDelete({ entry, disabled, link, onDeleted }: { entry: CaseRecord; disabled: boolean; link?: boolean; onDeleted: () => void }) {
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
    <Button danger type={link ? 'link' : 'default'} disabled={disabled}>删除</Button>
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
  const [pending, setPending] = useState(false);
  const [editing, setEditing] = useState(false);
  const [type, setType] = useState<string>();
  const [upload, setUpload] = useState<File[]>([]);
  const [picker, setPicker] = useState(0);
  const [editGrade, setEditGrade] = useState<Attached>();
  const [verify, setVerify] = useState<Rule>();
  const [verifyForm] = Form.useForm<{ finding: string; note: string }>();
  const fetchCase = useCallback(async () => {
    const detail = await api.get<Detail>(url);
    setEntry(detail);
    setTerm((old) => old ?? detail.scope.term);
    setType((old) => old && (detail.expected.includes(old) || detail.optional.includes(old)) ? old : undefined);
    setRunId((old) => old ?? detail.runs[0]?.id);
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
    if (!runId || currentState !== 'done') return;
    let cancelled = false;
    api.get<{ result: Result }>(`${url}/runs/${runId}`).then((r) => {
      if (!cancelled) setResult(r.result);
    }).catch((e) => { if (!cancelled) message.error(e.message); });
    return () => { cancelled = true; };
  }, [runId, currentState, url, message]);

  async function perform(action: () => Promise<void>) {
    setPending(true);
    try { await action(); await fetchCase(); }
    catch (e) { message.error((e as Error).message); }
    finally { setPending(false); }
  }
  const backButton = <Button icon={<ArrowLeftOutlined />} onClick={back} style={{ marginBottom: 16 }}>返回档案列表</Button>;
  if (error) return <div className="page">{backButton}<Alert type="error" message={error} /></div>;
  if (!entry) return <div className="page"><Spin /></div>;
  const { scope } = entry;
  const readonly = !entry.editable || active;
  const isCourse = scope.level === 'course';
  const year = new Date().getFullYear();
  const termOptions = options([year, year - 1, year - 2].flatMap((start) =>
    [1, 2].map((semester) => `${start}-${start + 1} 第${semester}学期`)));
  return <div className="page">
    {backButton}
    <div className="page-head">
      <div><h1>{scope.title}</h1>
        <div className="sub">{[levels[scope.level], scope.courseCode, scope.term, scope.section, scope.major, scope.group].filter(Boolean).join(' · ')}</div>
      </div>
      {entry.editable && <Space wrap>
        <Button disabled={active || pending} onClick={() => setEditing(true)}>编辑档案</Button>
        <CaseDelete entry={entry} disabled={active || pending} onDeleted={back} />
        {isCourse && <Checkbox checked={reviewHistory} disabled={readonly || pending}
          onChange={(e) => setReviewHistory(e.target.checked)}>同时复查本课程的历史问题</Checkbox>}
        <Button type="primary" disabled={active || !entry.files.length || !term?.trim()} loading={pending}
          onClick={() => perform(async () => {
            const r = await api.post<{ id: number }>(`${url}/runs`, { term, reviewHistory });
            setRunId(r.id);
          })}>
          {latest ? '重新检查当前材料' : '开始检查'}
        </Button>
      </Space>}
    </div>
    <Space direction="vertical" size="middle" style={{ width: '100%' }}>
      <Card title="本次送检材料" extra={<Tag>规则 {entry.version}</Tag>}>
        {entry.editable && <Form layout="vertical">
          <Form.Item label={isCourse ? '送检学期' : '复核时段'} required htmlFor="material-term">
            <AutoComplete id="material-term" value={term ?? ''} disabled={readonly || pending}
              style={{ width: '100%', maxWidth: 320 }} options={isCourse ? termOptions : []} onChange={setTerm}
              filterOption={(value, option) => !!option?.value.includes(value)} placeholder={isCourse ? '选择或填写学期' : '填写本次复核时段'}>
              <Input maxLength={120} />
            </AutoComplete>
          </Form.Item>
        </Form>}
        <Alert type="info" showIcon message="可以先检查已上传的材料。应交未上传记为待补，不适用不记缺失。" />
        {entry.editable && <Space wrap style={{ margin: '14px 0' }}>
          <Select aria-label="材料类型" placeholder="选择材料类型" disabled={readonly} showSearch value={type} onChange={setType}
            style={{ minWidth: 260 }} options={options([...entry.expected, ...entry.optional])} />
          <input key={picker} aria-label="选择原始材料" type="file" accept=".docx,.xlsx,.pptx,.pdf,.jpg,.jpeg,.png" multiple disabled={readonly}
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
        <Table rowKey="type" size="small" scroll={{ x: 700 }} pagination={false}
          dataSource={[...new Set([...entry.expected, ...entry.files.map((f) => f.type)])].map((type) =>
            ({ type, files: entry.files.filter((f) => f.type === type) }))} columns={[
            { title: '材料类型', dataIndex: 'type' },
            { title: '已提供', render: (_, row) => row.files.length ? row.files.map((file) =>
              <Space key={file.id} size={4} wrap style={{ display: 'flex' }}>
                <Button type="link" onClick={() => download(`${url}/files/${file.id}/original`)}>{file.name}</Button>
                {file.grade && <Button type="link" onClick={() => setEditGrade(file)}>查看／校对成绩</Button>}
                {entry.editable && <Popconfirm title="从当前送检材料移除？历史报告引用的原文件仍会保留。"
                  onConfirm={() => perform(async () => { await api.del(`${url}/files/${file.id}`); })}>
                  <Button type="link" danger disabled={readonly || pending}>移除</Button>
                </Popconfirm>}
              </Space>) : row.type === planType && entry.plan ? <Tag color="blue">已引用：{entry.plan.name}</Tag> : <Tag color="gold">待补</Tag> },
          ]} />
      </Card>
      <Card title="检查结果" extra={selected?.status === 'done' && <Button onClick={() => download(`${url}/runs/${runId}/report.docx`)}>下载 Word 报告</Button>}>
        {entry.runs.length ? <>
          <Select aria-label="检查版本" value={runId} onChange={setRunId} style={{ width: 'min(100%, 410px)', marginBottom: 16 }} options={entry.runs.map((r) =>
            ({ value: r.id, label: `#${r.id} · ${r.created_at} · ${statusNames[r.status]}` }))} />
          {selected?.status === 'failed' && <Alert type="error" showIcon message={selected.error || '检查运行失败，请重试'} />}
          {['queued', 'running'].includes(selected?.status ?? '') && <Alert type="info" showIcon message="正在等待或读取材料并检查；结果会自动刷新。" />}
          {result && <ResultView url={url} result={result} onVerify={!readonly && latest?.id === runId
            ? (rule) => { verifyForm.resetFields(); setVerify(rule); } : undefined} />}
        </> : <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="还没有检查结果" />}
      </Card>
    </Space>
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

function ResultView({ url, result, onVerify }: { url: string; result: Result; onVerify?: (rule: Rule) => void }) {
  const [filter, setFilter] = useState('applicable');
  const types = [...new Set([...result.files.map((f) => f.type), ...result.rules.filter((r) => r.status !== '不适用').flatMap((r) => r.materials)])];
  return <Space direction="vertical" style={{ width: '100%' }} size="middle">
    <Alert showIcon type={result.verdict === 'passed' ? 'success' : result.verdict === 'partial' ? 'warning' : 'error'}
      message={verdictNames[result.verdict]} description="结论仅针对这次检查的材料。需核实的内容请对照原件，复算不修改正式成绩。" />
    <Tabs items={[
      { key: 'material', label: '按材料查', children: <Collapse items={types.map((type) => {
        const files = result.files.filter((f) => f.type === type);
        const relevant = result.rules.filter((r) => r.status !== '不适用' && r.materials.includes(type));
        const stats = result.stats.filter((s) => files.some((f) => f.id === s.id));
        return { key: type, label: <Space wrap>{type}<Tag color={files.length ? 'blue' : 'gold'}>{files.length ? `${files.length} 份` : '待补'}</Tag></Space>,
          children: <Space direction="vertical">
            {files.map((f) => <div key={f.id}>{f.id
              ? <Button type="link" onClick={() => download(`${url}/files/${f.id}/original`)}>{f.name}</Button>
              : <Tag>已引用：{f.name}</Tag>}
              {f.warnings.map((w, i) => <Alert key={i} type="warning" message={w} />)}
            </div>)}
            {stats.map((s) => <div key={s.id}>
              <div>识别到的权重：{Object.entries(s.weights).map(([key, value]) => `${key} ${value}%`).join('、') || '待核实'}</div>
              {s.stats.map((item) => <div key={item.column}>
                {item.column}：{item.count}/{item.rows} 行可计算，{item.excluded} 行特殊状态，{item.unreadable} 行待核；
                均分 {item.mean?.toFixed(2) ?? '—'}；各分段人数（&lt;60／60–69／70–79／80–89／≥90）{item.bands.join('／')}
              </div>)}
            </div>)}
            {relevant.map((r) => <div key={r.code}><Tag color={colors[r.status]}>{r.status}</Tag>{r.code} {r.title}
              {r.findings.filter((f) => f.status !== '未发现问题' && f.status !== '待补').map((f, i) =>
                <div key={i} className="muted">{f.detail}{f.location && <div style={{ whiteSpace: 'pre-wrap' }}>{f.location}</div>}</div>)}
            </div>)}
          </Space> };
      })} /> },
      { key: 'rules', label: '按问题查', children: <Space direction="vertical" style={{ width: '100%' }}>
        <Select aria-label="筛选检查项" value={filter} onChange={setFilter} style={{ width: 210 }}
          options={[{ label: '全部适用项', value: 'applicable' }, { label: '全部条款（含不适用）', value: 'all' }, ...options(Object.keys(colors))]} />
        <Collapse items={result.rules.filter((r) => filter === 'all' || (filter === 'applicable' ? r.status !== '不适用' : r.status === filter)).map((r) => ({
          key: r.code, label: <Space wrap><Tag color={colors[r.status]}>{r.status}</Tag>{r.code} {r.title}</Space>,
          children: <Space direction="vertical">
            {!!r.materials.length && <div className="muted">涉及材料：{r.materials.join('、')}</div>}
            {r.findings.map((f, i) => <div key={i}>
              <Tag color={colors[f.status]}>{f.status}</Tag>{f.detail}
              {f.location && <div className="muted" style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', marginTop: 4 }}>{f.location}</div>}
            </div>)}
            {r.status === '需核实' && !!r.materials.length && onVerify && <Button onClick={() => onVerify(r)}>记录人工核实</Button>}
          </Space>,
        }))} />
      </Space> },
      ...(result.history ? [{ key: 'history', label: `历史问题复查（${result.history.length}）`,
        children: <Table rowKey={(r) => r.issue.id} dataSource={result.history} size="small" scroll={{ x: 800 }}
          pagination={{ pageSize: 12 }} locale={{ emptyText: '没有匹配到可复查的历史问题。常规清单检查已照常完成。' }}
          columns={[
            { title: '历史反馈原文', width: '40%', render: (_, r) => <>
              <div style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{r.issue.text}</div>
              <div className="muted">{[r.issue.term || r.issue.date, r.issue.source, r.issue.position].filter(Boolean).join(' · ')}</div>
            </> },
            { title: '本次复查结论', width: '30%', render: (_, r) => <><Tag color={colors[r.status]}>{r.status}</Tag>{r.detail}</> },
            { title: '本次文件与位置', render: (_, r) => r.locations.length ? r.locations.map((loc, index) =>
              <div key={index}>{loc.fileId
                ? <Button type="link" size="small" onClick={() => download(`${url}/files/${loc.fileId}/original`)}>{loc.file}</Button>
                : loc.file} · {loc.position}</div>) : '暂无核验依据' },
          ]} />,
      }] : []),
    ]} />
  </Space>;
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
