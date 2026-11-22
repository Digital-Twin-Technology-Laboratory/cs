import { useCallback, useEffect, useState } from 'react';
import { Alert, App, Button, Card, Checkbox, Col, Collapse, Empty, Form, Image, Input, InputNumber, Modal, Popconfirm, Row, Select, Space, Spin, Table, Tabs, Tag } from 'antd';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api, download } from '../../api';

const base = '/api/materials';
const planType = '人才培养方案及支撑矩阵';
const levels = { course: '课程检查', program: '专业复核', group: '教研室／课程组复核', college: '学院复核' };
const teaching = { theory: '纯理论', mixed: '理论＋实验', practice: '独立实践' };
const assessments = { written: '笔试', computer: '机考', project: '项目', report: '报告／课程论文', other: '其他' };
const roundings = { unknown: '未确认', integer: '四舍五入到整数', oneDecimal: '四舍五入到一位小数', exact: '不取整' };
const statusNames = { queued: '排队中', running: '检查中', done: '已完成', failed: '检查失败' };
const verdictNames = { passed: '通过', partial: '已检部分未发现问题（仍有待补／待核）', failed: '需整改' };
const colors: Record<string, string> = { 未发现问题: 'green', 需整改: 'red', 建议完善: 'blue', 待补: 'gold', 需核实: 'orange', 不适用: 'default' };
const choices = (items: Record<string, string>) => Object.entries(items).map(([value, label]) => ({ value, label }));
const options = (items: string[]) => items.map((value) => ({ value, label: value }));

type Scope = { level: keyof typeof levels; title: string; term: string; section: string; major: string; group: string;
  planGrade: number; teaching: keyof typeof teaching; assessments: string[]; flags: string[]; rounding: keyof typeof roundings };
type Run = { id: number; status: keyof typeof statusNames; error: string | null; version: string;
  created_at: string; verdict: keyof typeof verdictNames | null };
type Attached = { id: number; name: string; type: string; grade: boolean };
type Detail = { id: number; scope: Scope; version: string; expected: string[]; optional: string[]; editable: boolean;
  plan: { name: string } | null; files: Attached[]; runs: Run[] };
type Picklists = { flags: Record<string, string>; majors: string[]; programs: readonly string[]; groups: string[]; college: boolean };
type GradeRow = { location: string; line: number; cells: Record<string, string>; uncertain: string[]; ocr: boolean };
type GradeEdit = { location: string; line: number; column: string; value: string };
type GradeData = { rows: GradeRow[]; edits: GradeEdit[]; weights: Record<string, number>; weightEdits: Record<string, number> | null;
  scanned: boolean; weightsVerified: boolean };
type Finding = { status: string; location: string; detail: string };
type Rule = { code: string; title: string; materials: string[]; status: string; findings: Finding[] };
type Result = { verdict: keyof typeof verdictNames; rules: Rule[]; files: { id: number; name: string; type: string; warnings: string[] }[];
  stats: { id: number; file: string; weights: Record<string, number>; stats: { column: string; count: number; rows: number; excluded: number; unreadable: number; mean: number | null; bands: number[] }[] }[] };

export default function Materials() {
  const { id } = useParams();
  return id ? <CaseDetail key={id} id={id} /> : <CaseList />;
}

function CaseList() {
  const [settings, setSettings] = useState<Picklists>();
  const [data, setData] = useState<{ id: number; scope: Scope; latest: Run | null }[]>([]);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [form] = Form.useForm<Scope>();
  const level = Form.useWatch('level', form) ?? 'course';
  const nav = useNavigate();
  const { message } = App.useApp();
  useEffect(() => {
    Promise.all([api.get<Picklists>(`${base}/options`), api.get<typeof data>(base)])
      .then(([picklists, records]) => { setSettings(picklists); setData(records); }).catch((e) => message.error(e.message));
  }, [message]);
  const levelOptions = choices(levels).filter(({ value }) => value === 'course' || (value === 'program' ? settings?.programs.length
    : value === 'group' ? settings?.groups.length : settings?.college));
  return <div className="page">
    <div className="page-head">
      <div><h1>全套教学材料检查</h1><div className="sub">按课程、学期和教学班送检，也可查专业、课程组或学院的专项材料。</div></div>
      <Button type="primary" disabled={!settings} onClick={() => { form.resetFields(); setOpen(true); }}>新建送检档案</Button>
    </div>
    <Card>
      <Table rowKey="id" dataSource={data} loading={!settings} scroll={{ x: 680 }} pagination={{ pageSize: 12 }} columns={[
        { title: '送检档案', render: (_, r) => <Link to={`/materials/${r.id}`}>{r.scope.title}</Link> },
        { title: '范围', render: (_, r) => levels[r.scope.level] },
        { title: '学期／教学班', render: (_, r) => [r.scope.term, r.scope.section].filter(Boolean).join(' · ') },
        { title: '最近检查', render: (_, r) => r.latest ? r.latest.verdict ? verdictNames[r.latest.verdict] : statusNames[r.latest.status] : '未检查' },
      ]} />
    </Card>
    <Modal title="新建送检档案" width={760} open={open} destroyOnHidden onCancel={() => setOpen(false)} okText="建档并上传" confirmLoading={busy} onOk={() => form.submit()}>
      <Form form={form} layout="vertical" initialValues={{ level: 'course', teaching: 'theory', rounding: 'unknown', planGrade: 2025, flags: ['coursework', 'textbook'] }}
        onFinish={async (values) => {
          setBusy(true);
          try { const record = await api.post<{ id: number }>(base, values); nav(`/materials/${record.id}`); }
          catch (e) { message.error((e as Error).message); } finally { setBusy(false); }
        }}>
        <Form.Item name="level" label="检查范围" rules={[{ required: true }]}><Select options={levelOptions} /></Form.Item>
        <Row gutter={16}>
          <Col xs={24} sm={12}><Form.Item name="title" label={level === 'course' ? '课程名称' : '复核名称'} rules={[{ required: true }]}><Input maxLength={120} /></Form.Item></Col>
          <Col xs={24} sm={12}><Form.Item name="term" label="学年学期／复核时段" rules={[{ required: true }]}><Input placeholder="例如 2025-2026 第2学期" maxLength={120} /></Form.Item></Col>
        </Row>
        {(level === 'course' || level === 'program') && <Row gutter={16}>
          <Col xs={24} sm={12}><Form.Item name="major" label="专业" rules={[{ required: true }]}><Select options={options([...(level === 'course' ? settings?.majors ?? [] : settings?.programs ?? [])])} /></Form.Item></Col>
          <Col xs={24} sm={12}><Form.Item name="planGrade" label="对照培养方案年级"><InputNumber min={2000} max={2100} style={{ width: '100%' }} /></Form.Item></Col>
        </Row>}
        {level === 'group' && <Form.Item name="group" label="课程组" rules={[{ required: true }]}><Select options={options(settings?.groups ?? [])} /></Form.Item>}
        {level === 'course' && <>
          <Row gutter={16}>
            <Col xs={24} sm={12}><Form.Item name="section" label="教学班" rules={[{ required: true }]}><Input maxLength={120} placeholder="填写班号或合班名称" /></Form.Item></Col>
            <Col xs={24} sm={12}><Form.Item name="teaching" label="授课类型"><Select options={choices(teaching)} /></Form.Item></Col>
          </Row>
          <Form.Item name="assessments" label="实际考核形式" rules={[{ required: true, type: 'array', min: 1 }]}><Checkbox.Group options={choices(assessments)} /></Form.Item>
          <Form.Item name="rounding" label="总评取整规则" extra="仅当分项是百分制原始分，且按总评权重加权时选取整方式；否则选未确认。"><Select options={choices(roundings)} /></Form.Item>
        </>}
        {level !== 'college' && <Form.Item name="flags" label="适用情形" extra="按实际情况勾选；不要把未送检当作不适用。">
          <Checkbox.Group options={choices(settings?.flags ?? {}).filter(({ value }) => level === 'program' ? value === 'mockProgram'
            : level === 'group' ? value === 'examReview2024' : !['mockProgram', 'examReview2024'].includes(value))} />
        </Form.Item>}
      </Form>
    </Modal>
  </div>;
}

function CaseDetail({ id }: { id: string }) {
  const url = `${base}/${id}`;
  const { message } = App.useApp();
  const [entry, setEntry] = useState<Detail>();
  const [error, setError] = useState('');
  const [runId, setRunId] = useState<number>();
  const [result, setResult] = useState<Result | null>(null);
  const [pending, setPending] = useState(false);
  const [type, setType] = useState<string>();
  const [upload, setUpload] = useState<File[]>([]);
  const [picker, setPicker] = useState(0);
  const [editGrade, setEditGrade] = useState<Attached>();
  const [verify, setVerify] = useState<Rule>();
  const [verifyForm] = Form.useForm<{ finding: string; note: string }>();
  const fetchCase = useCallback(async () => {
    const detail = await api.get<Detail>(url);
    setEntry(detail);
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
  if (error) return <div className="page"><Alert type="error" message={error} /><Link to="/materials">返回档案列表</Link></div>;
  if (!entry) return <div className="page"><Spin /></div>;
  const { scope } = entry;
  const readonly = !entry.editable || active;
  return <div className="page">
    <div className="page-head">
      <div><Link to="/materials">全套材料档案</Link><h1>{scope.title}</h1>
        <div className="sub">{[levels[scope.level], scope.term, scope.section, scope.major, scope.group, scope.level === 'course' && teaching[scope.teaching]].filter(Boolean).join(' · ')}</div>
      </div>
      {entry.editable && <Button type="primary" disabled={active || !entry.files.length} loading={pending}
        onClick={() => perform(async () => { const r = await api.post<{ id: number }>(`${url}/runs`); setRunId(r.id); })}>
        {latest ? '重新检查当前材料' : '开始检查'}
      </Button>}
    </div>
    <Space direction="vertical" size="middle" style={{ width: '100%' }}>
      <Card title="本次送检材料" extra={<Tag>规则 {entry.version}</Tag>}>
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
            {r.status === '需核实' && onVerify && <Button onClick={() => onVerify(r)}>记录人工核实</Button>}
          </Space>,
        }))} />
      </Space> },
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
