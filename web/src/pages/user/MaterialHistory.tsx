import { useState } from 'react';
import { Alert, App, Button, Card, Form, Input, Select, Space, Table, Tag } from 'antd';
import { Link } from 'react-router-dom';
import { api, qs } from '../../api';

const url = '/api/materials/history';
export type HistoryCourse = { name: string; code: string; major: string; key: string };
type Teacher = { name: string; staffNo: string };
type Feedback = { teachers: Teacher[]; text: string; term: string; context: string; source: string; position: string; nature: string };
export type HistoryIssue = Feedback & { id: string; course: Omit<HistoryCourse, 'key'>; uploader: string; date: string; submissionId?: number };
type PreviewRow = Feedback & { key: string; sheet: string; row: number; course: Omit<HistoryCourse, 'key'>;
  status: 'matched' | 'ambiguous' | 'unmatched' | 'invalid'; candidates: HistoryCourse[] };
type Preview = { courses: HistoryCourse[]; rows: PreviewRow[] };
type HistoryPage = { rows: HistoryIssue[]; total: number };

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
      <Alert type="info" showIcon title="上传含多门课程的 .xlsx 文件，无需拆表。"
        description="使用「课程」或「课程代码」及「具体反馈」列；如有任课教师、工号、学期、来源文件和原表位置，也会一并保留。" />
      <Space wrap>
        <input aria-label="选择历史问题 Excel" type="file" accept=".xlsx" disabled={busy} onChange={(e) => {
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
  const [data, setData] = useState<HistoryPage>();
  const [query, setQuery] = useState<{ course?: string; teacher?: string }>({});
  const [page, setPage] = useState(1);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const search = async (filters: typeof query, next: number) => {
    setQuery(filters); setPage(next); setData(undefined); setBusy(true); setError('');
    try { setData(await api.get<HistoryPage>(`${url}?${qs({ ...filters, page: next })}`)); }
    catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  };
  return <Card>
    <Form layout="inline" onFinish={(values) => void search(values, 1)} style={{ rowGap: 8, marginBottom: 12 }}>
      <Form.Item name="course" label="课程"><Input allowClear maxLength={120} placeholder="课程名称或代码" /></Form.Item>
      <Form.Item name="teacher" label="任课教师"><Input allowClear maxLength={120} placeholder="姓名或工号" /></Form.Item>
      <Button htmlType="submit" type="primary" loading={busy}>查询</Button>
    </Form>
    <p className="muted small">可单独填写一个条件或组合查询。按任课关系查找；代传材料的上传人单独显示。</p>
    {error && <Alert type="error" showIcon title={error} />}
    <Table rowKey="id" loading={busy} dataSource={data?.rows ?? []} scroll={{ x: 920 }}
      pagination={{ current: page, total: data?.total ?? 0, pageSize: 20, showSizeChanger: false, onChange: (next) => void search(query, next) }}
      locale={{ emptyText: query.course?.trim() || query.teacher?.trim() ? '没有符合条件的历史问题' : '请输入课程或任课教师查询' }}
      columns={[
        { title: '课程', width: 210, render: (_, r) => <>{courseLabel(r.course)}
          {r.context && <div className="muted">{r.context}</div>}</> },
        { title: '任课教师', width: 185, render: (_, r) => <>
          {r.teachers.length > 1 && <Tag color="blue">共同授课</Tag>}
          <div>{r.teachers.map(teacherLabel).join('、') || '未记录任课关系'}</div>
        </> },
        { title: '历史反馈原文', render: (_, r) => <>{r.nature && <Tag>{r.nature}</Tag>}{feedbackText(r.text)}</> },
        { title: '来源', width: 240, render: (_, r) => <div style={{ overflowWrap: 'anywhere' }}>
          <div>{r.term || r.date}</div>
          <div>{r.source}{r.position && ` · ${r.position}`}</div>
          <div className="muted">上传人：{r.uploader}</div>
          {r.submissionId && <Link to={`/submissions/${r.submissionId}`}>查看原检查记录</Link>}
        </div> },
      ]} />
  </Card>;
}
