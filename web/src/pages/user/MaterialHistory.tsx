import { useEffect, useState } from 'react';
import { Alert, Button, Card, Collapse, Empty, Form, Input, Pagination, Spin, Tabs, Tag, Typography } from 'antd';
import { Link } from 'react-router-dom';
import { api, qs } from '../../api';
import { HistoryImportPanel } from '../../components/HistoryImportModal';
import { NatureTag } from '../../components/StatusTag';

const url = '/api/materials/history';
export type HistoryCourse = { name: string; code: string; major: string; key: string };
type Teacher = { name: string; staffNo: string };
type Feedback = { teachers: Teacher[]; text: string; term: string; context: string; source: string; position: string; nature: string };
export type HistoryIssue = Feedback & { id: string; course: Omit<HistoryCourse, 'key'>; uploader: string; date: string; submissionId?: number;
  outlineDetail?: { title: string; problem: string; advice: string; evidence: string } };
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

export function HistoryImport() {
  return <Card><HistoryImportPanel /></Card>;
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
