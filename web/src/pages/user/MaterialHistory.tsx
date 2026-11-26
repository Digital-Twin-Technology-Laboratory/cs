import { useEffect, useState } from 'react';
import { Alert, App, Button, Card, Collapse, Empty, Form, Input, Pagination, Select, Space, Spin, Table, Tabs, Tag, Typography } from 'antd';
import { Link } from 'react-router-dom';
import { api, qs } from '../../api';
import { NatureTag } from '../../components/StatusTag';

const url = '/api/materials/history';
export type HistoryCourse = { name: string; code: string; major: string; key: string };
type Teacher = { name: string; staffNo: string };
type Feedback = { teachers: Teacher[]; text: string; term: string; context: string; source: string; position: string; nature: string };
export type HistoryIssue = Feedback & { id: string; course: Omit<HistoryCourse, 'key'>; uploader: string; date: string; submissionId?: number;
  outlineDetail?: { title: string; problem: string; advice: string; evidence: string } };
type PreviewRow = Feedback & { key: string; sheet: string; row: number; course: Omit<HistoryCourse, 'key'>;
  status: 'matched' | 'ambiguous' | 'unmatched' | 'invalid'; candidates: HistoryCourse[] };
type Preview = { courses: HistoryCourse[]; rows: PreviewRow[] };
type HistoryKind = 'history' | 'outline';
type HistoryGroup = { id: string; issues: HistoryIssue[] };
type HistoryPage = { groups: HistoryGroup[]; total: number; pageSize: number; counts: Record<HistoryKind, number> };
type HistoryQuery = { course?: string; teacher?: string };
type HistoryView = { query?: HistoryQuery; kind: HistoryKind; page: number };
const historyTabs = [
  { key: 'history', label: '往期检查问题', hint: '来自往期检查表，按课程和学期分组。' },
  { key: 'outline', label: '大纲检查问题', hint: '按大纲检查记录分组，可直接查看修改位置和建议。' },
] as const;

export const courseLabel = (course: Omit<HistoryCourse, 'key'>) => [course.name, course.code, course.major].filter(Boolean).join(' · ');
const teacherLabel = (teacher: Teacher) => teacher.name && teacher.staffNo ? `${teacher.name}（${teacher.staffNo}）` : teacher.name || teacher.staffNo;
const feedbackText = (text: string) => <div style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{text}</div>;

export function HistoryImport() {
  const { message } = App.useApp();
  const [file, setFile] = useState<File>();
  const [preview, setPreview] = useState<Preview>();
  const [choices, setChoices] = useState<Record<string, string>>({});
  const [onlyFlagged, setOnlyFlagged] = useState(false);
  const [busy, setBusy] = useState(false);
  const [summary, setSummary] = useState('');
  const load = async (upload: File) => {
    setBusy(true);
    setSummary('');
    try {
      const body = new FormData();
      body.set('file', upload);
      const data = await api.post<Preview>(`${url}/preview`, body);
      setChoices(Object.fromEntries(data.rows.filter((row) => row.status === 'matched').map((row) => [row.key, row.candidates[0].key])));
      setPreview(data);
    } catch (e) { message.error((e as Error).message); }
    finally { setBusy(false); }
  };
  const confirm = async () => {
    setBusy(true);
    try {
      const body = new FormData();
      body.set('file', file!);
      body.set('choices', JSON.stringify(choices));
      const result = await api.post<{ added: number; duplicates: number; skipped: number }>(`${url}/import`, body);
      setSummary(`已新增 ${result.added} 条，合并重复反馈 ${result.duplicates} 条，跳过 ${result.skipped} 条。`);
      setPreview(undefined);
    } catch (e) { message.error((e as Error).message); }
    finally { setBusy(false); }
  };
  const unresolved = preview?.rows.filter((row) => row.status !== 'matched') ?? [];
  const confirmed = preview?.rows.filter((row) => choices[row.key]).length ?? 0;
  const canKeep = unresolved.filter((row) => row.status === 'unmatched' && row.course.name);
  return <Card>
    <Space orientation="vertical" size="middle" style={{ width: '100%' }}>
      <Alert type="info" showIcon title="上传含多门课程的 .xls 或 .xlsx 文件，无需拆表。"
        description="使用「课程」或「课程代码」及「具体反馈」列；如有任课教师、工号、学期、来源文件和原表位置，也会一并保留。" />
      <Space wrap>
        <input aria-label="选择历史问题 Excel" type="file" accept=".xls,.xlsx" disabled={busy} onChange={(e) => {
          setFile(e.currentTarget.files?.[0]); setPreview(undefined); setChoices({}); setOnlyFlagged(false); setSummary('');
        }} />
        <Button type="primary" disabled={!file || busy} loading={busy && !preview} onClick={() => file && void load(file)}>预览匹配</Button>
      </Space>
      {summary && <Alert type="success" showIcon title={summary} />}
      {preview && <>
        <Space wrap>
          <span>共 {preview.rows.length} 条待归档反馈，{unresolved.length} 条需确认，已选 {confirmed} 条。</span>
          {!!unresolved.length && <Button onClick={() => setOnlyFlagged((value) => !value)}>{onlyFlagged ? '显示全部' : '仅看待确认'}</Button>}
          {!!canKeep.length && <Button disabled={busy} onClick={() => setChoices((previous) => ({ ...previous,
            ...Object.fromEntries(canKeep.filter((row) => !previous[row.key]).map((row) => [row.key, 'original'])),
          }))}>未匹配课程按原表归档</Button>}
        </Space>
        <Table rowKey="key" size="small" dataSource={onlyFlagged ? unresolved : preview.rows} scroll={{ x: 960 }} pagination={{ pageSize: 12 }}
          columns={[
            { title: 'Excel 位置', width: 135, render: (_, r) => `${r.sheet} · 第 ${r.row} 行` },
            { title: '原表课程／教师', width: 220, render: (_, r) => <>{courseLabel(r.course)}
              <div className="muted">{r.teachers.map(teacherLabel).join('、') || '原表未注明教师'}</div></> },
            { title: '具体反馈', dataIndex: 'text', render: feedbackText },
            { title: '课程归档确认', width: 290, render: (_, r) => {
              if (r.status === 'invalid') return <Tag color="red">课程、反馈或教师工号列需修正</Tag>;
              if (r.status === 'matched') return <><Tag color="green">{r.course.code ? '按代码匹配' : '按名称匹配'}</Tag>{courseLabel(r.candidates[0])}</>;
              const candidates = r.status === 'ambiguous' ? r.candidates : preview.courses;
              return <Space orientation="vertical" style={{ width: '100%' }}>
                <Tag color={r.status === 'ambiguous' ? 'orange' : 'red'}>{r.status === 'ambiguous' ? '同名课程' : '未匹配'}</Tag>
                <Select aria-label={`确认 ${r.sheet} 第 ${r.row} 行 ${r.course.name || r.course.code} 的课程`} showSearch={{ optionFilterProp: 'label' }}
                  allowClear disabled={busy} value={choices[r.key]} style={{ width: '100%' }} placeholder="选择归档课程，留空则跳过"
                  options={[
                    ...(r.status === 'unmatched' && r.course.name ? [{ value: 'original', label: '按原表课程归档' }] : []),
                    ...candidates.map((course) => ({ value: course.key, label: courseLabel(course) })),
                  ]} onChange={(value) => setChoices((previous) => ({ ...previous, [r.key]: value || '' }))} />
              </Space>;
            } },
          ]} />
        <Space wrap>
          <Button type="primary" disabled={!confirmed} loading={busy} onClick={() => void confirm()}>确认导入 {confirmed} 条</Button>
          <span className="muted">{preview.rows.length - confirmed} 条未选择或无效的记录将跳过。</span>
        </Space>
      </>}
    </Space>
  </Card>;
}

export function HistorySearch() {
  const [view, setView] = useState<HistoryView>({ kind: 'history', page: 1 });
  const [response, setResponse] = useState<{ view: HistoryView; data?: HistoryPage; error?: string }>();
  useEffect(() => {
    if (!view.query) return;
    let current = true;
    api.get<HistoryPage>(`${url}?${qs({ ...view.query, kind: view.kind, page: view.page })}`)
      .then((data) => { if (current) setResponse({ view, data }); })
      .catch((e: Error) => { if (current) setResponse({ view, error: e.message }); });
    return () => { current = false; };
  }, [view]);
  const counts = response?.view.query === view.query ? response?.data?.counts : undefined;
  const data = response?.view === view ? response.data : undefined;
  const error = response?.view === view ? response.error : undefined;
  const busy = !!view.query && response?.view !== view;

  return <Card>
    <Form<HistoryQuery> layout="inline" onFinish={({ course, teacher }) => setView((prev) => ({
      ...prev, page: 1, query: course?.trim() || teacher?.trim() ? { course: course?.trim(), teacher: teacher?.trim() } : undefined,
    }))} className="material-history-search">
      <Form.Item name="course" label="课程"><Input allowClear maxLength={120} placeholder="课程名称或代码" /></Form.Item>
      <Form.Item name="teacher" label="任课教师"><Input allowClear maxLength={120} placeholder="姓名或工号" /></Form.Item>
      <Button htmlType="submit" type="primary" loading={busy}>查询</Button>
    </Form>
    <p className="muted small">可按课程或任课教师查询，也可组合查询。代传不视为任课。</p>
    <Tabs activeKey={view.kind} onChange={(key) => setView((prev) => ({ ...prev, kind: key as HistoryKind, page: 1 }))}
      items={historyTabs.map(({ key, label, hint }) => ({
        key, label: <>{label}{counts && <span className="muted">（{counts[key]}）</span>}</>,
        children: key === view.kind && <div aria-busy={busy}>
          <p className="material-history-hint muted">{hint}</p>
          {busy ? <div className="material-history-loading" role="status"><Spin /> 正在查询</div>
            : error ? <Alert type="error" showIcon title={error} />
            : !data?.groups.length ? <Empty image={Empty.PRESENTED_IMAGE_SIMPLE}
              description={!view.query ? '请输入课程或任课教师查询' : counts?.[key === 'history' ? 'outline' : 'history']
                ? `没有符合条件的${label}，可切换到另一类查看。` : `没有符合条件的${label}，请调整查询条件。`} />
            : <>
              <Collapse defaultActiveKey={data.groups[0].id}
                items={data.groups.map((group) => {
                  const { course, term, date } = group.issues[0];
                  return {
                    key: group.id,
                    label: <div className="material-history-heading">
                      <strong>{course.name}</strong>
                      <span className="muted small">{[course.code, course.major, key === 'history' ? term || '学期未注明' : date]
                        .filter(Boolean).join(' · ')}</span>
                      <Tag>{group.issues.length} 条</Tag>
                    </div>,
                    children: <HistoryGroupContent group={group} kind={key} />,
                  };
                })} />
              <Pagination className="material-history-pagination" current={view.page} pageSize={data.pageSize} total={data.total}
                hideOnSinglePage showSizeChanger={false} onChange={(page) => setView((prev) => ({ ...prev, page }))} />
            </>}
        </div>,
      }))} />
  </Card>;
}

const teachersLabel = (row: HistoryIssue) => row.teachers.map(teacherLabel).join('、');

function HistoryGroupContent({ group, kind }: { group: HistoryGroup; kind: HistoryKind }) {
  const { issues } = group;
  const first = issues[0];
  const sharedTeachers = issues.every((row) => teachersLabel(row) === teachersLabel(first)) ? teachersLabel(first) : '';
  return <>
    <div className="material-history-meta muted small">
      {sharedTeachers && <div>{first.teachers.length > 1 ? '共同授课' : '任课教师'}：{sharedTeachers}</div>}
      {kind === 'outline' && <>
        {!sharedTeachers && <div>未记录任课关系</div>}
        <div>检查文件：{first.source}　上传人：{first.uploader}</div>
        {first.submissionId && <Link to={`/submissions/${first.submissionId}`}>查看原检查记录</Link>}
      </>}
    </div>
    <ol className="material-history-issues">
      {issues.map((row) => <li key={row.id} className="material-history-issue">
        {kind === 'history' ? <>
          <div className="material-history-heading">
            {row.nature && <Tag>{row.nature}</Tag>}
            <span className="muted small">{[row.context,
              !sharedTeachers && teachersLabel(row) ? `${row.teachers.length > 1 ? '共同授课' : '任课教师'}：${teachersLabel(row)}` : '',
            ].filter(Boolean).join(' · ')}</span>
          </div>
          <Typography.Paragraph className="material-history-reading"
            ellipsis={{ rows: 2, expandable: 'collapsible', symbol: (expanded) => expanded ? '收起原文' : '查看反馈全文' }}>
            {row.text}
          </Typography.Paragraph>
          <details>
            <summary>来源与原表位置</summary>
            <div className="material-history-meta muted small">
              <div>来源文件：{row.source}</div>
              {row.position && <div>原表位置：{row.position}</div>}
              <div>上传人：{row.uploader}</div>
            </div>
          </details>
        </> : <>
          <div className="material-history-heading">
            {row.outlineDetail ? <NatureTag nature={row.nature} /> : <Tag color="warning">需核实</Tag>}
            {row.outlineDetail && <strong>{row.outlineDetail.title}</strong>}
          </div>
          {row.position && <div className="material-history-meta muted small">{row.outlineDetail ? '修改位置' : '核查位置'}：{row.position}</div>}
          <p className="material-history-reading material-history-action">
            <strong>{row.outlineDetail ? '怎么改：' : '核实事项：'}</strong>
            {row.outlineDetail ? row.outlineDetail.advice : row.text}
          </p>
          {row.outlineDetail && <details>
            <summary>查看问题说明与依据</summary>
            <p className="material-history-reading">{row.outlineDetail.problem}</p>
            {row.outlineDetail.evidence && <p className="material-history-reading muted">原文依据：{row.outlineDetail.evidence}</p>}
          </details>}
        </>}
      </li>)}
    </ol>
  </>;
}
