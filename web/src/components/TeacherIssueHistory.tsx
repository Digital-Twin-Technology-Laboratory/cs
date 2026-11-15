import { Alert, Button, Card, Empty, Pagination, Space, Spin, Tag } from 'antd';
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
  useEffect(() => {
    let active = true;
    setData(null);
    setError('');
    api.get<TeacherIssueHistoryData>(`/api/supervision/issue-history?${qs({ teacherId, beforeId, page, pageSize: 10 })}`)
      .then((result) => { if (active) setData(result); })
      .catch((e: Error) => { if (active) setError(e.message); });
    return () => { active = false; };
  }, [teacherId, beforeId, page, refresh]);

  if (error) return <Alert type="error" showIcon title={error} action={<Button onClick={() => setRefresh((n) => n + 1)}>重试</Button>} />;
  if (!data) return <div style={{ padding: 32, textAlign: 'center' }}><Spin /></div>;
  return <Space orientation="vertical" size={16} style={{ width: '100%' }}>
    <Alert type="info" showIcon title={`${data.teacher.name || data.teacher.username}（${data.teacher.username}）的历史检查问题`}
      description={`${beforeId ? '仅列出本次上传之前' : '列出历次'}已完成检查中的问题、建议修改和需核实事项，按实际上传人账号归集，最新记录在前。历史问题不代表当前仍未整改；需核实事项不属于已确认问题，请结合本次大纲人工对照。`} />
    <div className="muted small">{beforeId ? '本次上传之前' : '历次'}共 {data.total} 条含问题、建议或需核实事项的检查记录；未完成及无上述事项的记录不列入。重复出现的问题按原次保留。</div>
    {!data.rows.length && <Empty description="该教师暂无符合范围的历史问题记录" />}
    {data.rows.map((row) => <Card key={row.id} size="small" title={`《${row.course.name}》第${row.seq}次检查`}>
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
      <Space wrap style={{ marginTop: 16 }}>
        <Link to={`/submissions/${row.id}`} target="_blank" rel="noopener noreferrer">查看完整记录（新窗口）</Link>
        <Button size="small" onClick={() => download(`/api/submissions/${row.id}/file`)}>下载原文件</Button>
        <Button size="small" onClick={() => download(`/api/submissions/${row.id}/report.docx`)}>下载检查结果</Button>
      </Space>
    </Card>)}
    {data.total > 10 && <Pagination current={page} total={data.total} pageSize={10} onChange={setPage} showSizeChanger={false} />}
  </Space>;
}
