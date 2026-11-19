import { Alert, Button, Card, Empty, Pagination, Select, Space, Spin, Tag } from 'antd';
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, download, qs } from '../api';
import type { TeacherIssueHistoryData } from '../types';
import { NatureTag, SubmissionTag } from './StatusTag';

export default function TeacherIssueHistory({ teacherId, beforeId }: { teacherId: number; beforeId?: number }) {
  const [page, setPage] = useState(1);
  const [refresh, setRefresh] = useState(0);
  const [data, setData] = useState<TeacherIssueHistoryData | null>(null);
  const [error, setError] = useState('');
  const [course, setCourse] = useState<string>();
  const [printData, setPrintData] = useState<TeacherIssueHistoryData | null>(null);
  const [printing, setPrinting] = useState(false);
  useEffect(() => {
    let active = true;
    setData(null);
    setError('');
    api.get<TeacherIssueHistoryData>(`/api/supervision/issue-history?${qs({ teacherId, beforeId, course, page, pageSize: 10 })}`)
      .then((result) => { if (active) setData(result); })
      .catch((e: Error) => { if (active) setError(e.message); });
    return () => { active = false; };
  }, [teacherId, beforeId, course, page, refresh]);

  useEffect(() => {
    if (!printData) return;
    const clear = () => setPrintData(null);
    window.addEventListener('afterprint', clear);
    window.print();
    return () => window.removeEventListener('afterprint', clear);
  }, [printData]);

  const print = async () => {
    setPrinting(true);
    try {
      setPrintData(await api.get<TeacherIssueHistoryData>(`/api/supervision/issue-history?${qs({ teacherId, beforeId, course, all: 1 })}`));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setPrinting(false);
    }
  };

  if (error) return <Alert type="error" showIcon title={error} action={<Button onClick={() => setRefresh((n) => n + 1)}>重试</Button>} />;
  if (!data) return <div style={{ padding: 32, textAlign: 'center' }}><Spin /></div>;
  const renderHistory = (history: TeacherIssueHistoryData) => <Space orientation="vertical" size={16} style={{ width: '100%' }}>
    <Alert type="info" showIcon title={`${history.teacher.name || history.teacher.username}（${history.teacher.username}）的历史检查问题${course ? ` — ${course}` : ''}`}
      description={`${beforeId ? '仅列出本次上传之前' : '列出历次'}已完成检查中的问题、建议修改和需核实事项，按实际上传人账号归集，最新记录在前。历史问题不代表当前仍未整改；需核实事项不属于已确认问题，请结合本次大纲人工对照。`} />
    <div className="muted small">{beforeId ? '本次上传之前' : '历次'}共 {history.total} 条含问题、建议或需核实事项的检查记录；未完成及无上述事项的记录不列入。重复出现的问题按原次保留。</div>
    {!history.rows.length && <Empty description="该教师暂无符合范围的历史问题记录" />}
    {history.rows.map((row) => <Card key={row.id} size="small" title={`《${row.course.name}》第${row.seq}次检查`}>
      <Space wrap style={{ marginBottom: 8 }}>
        <SubmissionTag status="done" verdict={row.verdict} />
        <span>{row.course.studentGrade}级 · {row.course.major}</span>
        <span className="muted small">上传：{row.created_at}；检查完成：{row.finished_at}</span>
      </Space>
      <div className="muted small">文件：{row.file_name}；记录 #{row.id}</div>
      {row.verdict_edited_at && <p className="muted small">结论由{row.verdict_edited_by}于{row.verdict_edited_at}手工修改，以下保留原 AI 问题明细，不代表已整改。</p>}
      {row.result.issues.map((issue, index) => <div key={index} style={{ marginTop: 16 }}>
        <Space wrap><NatureTag nature={issue.nature} /><strong>{issue.title}</strong></Space>
        <div className="prose"><b>位置：</b>{issue.location}</div>
        <div className="prose"><b>问题：</b>{issue.problem}</div>
        <div className="prose"><b>整改意见：</b>{issue.advice}</div>
      </div>)}
      {row.result.toVerify.map((item, index) => <div key={`verify-${index}`} style={{ marginTop: 16 }}>
        <Tag color="warning">需核实（非已确认问题）</Tag>
        {item.location && <div className="prose"><b>位置：</b>{item.location}</div>}
        <div className="prose">{item.content}</div>
      </div>)}
      <Space wrap className="no-print" style={{ marginTop: 16 }}>
        <Link to={`/submissions/${row.id}`} target="_blank" rel="noopener noreferrer">查看完整记录（新窗口）</Link>
        <Button size="small" onClick={() => download(`/api/submissions/${row.id}/file`)}>下载原文件</Button>
        <Button size="small" onClick={() => download(`/api/submissions/${row.id}/report.docx`)}>下载检查结果</Button>
      </Space>
    </Card>)}
  </Space>;
  return <>
    {!beforeId && <Space wrap className="no-print" style={{ marginBottom: 16 }}>
      <label htmlFor="history-course">筛选课程</label>
      <Select id="history-course" aria-label="筛选课程" showSearch={{ optionFilterProp: 'label' }} allowClear placeholder="全部课程"
        style={{ width: 260 }} value={course} options={data.courses.map((name) => ({ value: name, label: name }))}
        onChange={(value) => { setCourse(value); setPage(1); }} />
      <Button onClick={print} loading={printing} disabled={!data.total}>打印筛选结果</Button>
    </Space>}
    <div className={printData ? 'no-print' : ''}>
      {renderHistory(data)}
      {data.total > 10 && <Pagination className="no-print" style={{ marginTop: 16 }} current={page} total={data.total} pageSize={10} onChange={setPage} showSizeChanger={false} />}
    </div>
    {printData && <div className="print-only">{renderHistory(printData)}</div>}
  </>;
}
