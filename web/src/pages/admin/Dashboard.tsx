import { Alert, Button, Card, Col, Row, Statistic, Table } from 'antd';
import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api } from '../../api';
import { SubmissionTag } from '../../components/StatusTag';
import type { SubStatus } from '../../types';

interface Stats {
  users: number;
  pendingUsers: number;
  courses: number;
  passedCourses: number;
  submissions: number;
  today: number;
  queued: number;
  failed: number;
  aiProblem: string | null;
  recent: { id: number; seq: number; status: SubStatus; verdict: 'passed' | 'failed' | null; created_at: string; course_name: string; user_name: string; username: string }[];
}

export default function Dashboard() {
  const nav = useNavigate();
  const [s, setS] = useState<Stats | null>(null);
  useEffect(() => {
    const load = () => api.get<Stats>('/api/admin/stats').then(setS);
    load();
    const t = setInterval(load, 10000);
    return () => clearInterval(t);
  }, []);

  const tile = (title: string, value: number | undefined, to?: string, suffix?: string) => (
    <Col xs={12} md={6}>
      <Card size="small" hoverable={!!to} onClick={() => to && nav(to)}>
        <Statistic title={title} value={value ?? '-'} suffix={suffix} />
      </Card>
    </Col>
  );

  return (
    <div className="page">
      <div className="page-head">
        <h1>概览</h1>
      </div>
      {s?.aiProblem && (
        <Alert
          type="warning"
          showIcon
          style={{ marginBottom: 16 }}
          title={`AI 尚未配置完成：${s.aiProblem}。用户暂时无法提交检查。`}
          action={<Button size="small" onClick={() => nav('/admin/ai')}>去配置</Button>}
        />
      )}
      {!!s?.pendingUsers && (
        <Alert
          type="info"
          showIcon
          style={{ marginBottom: 16 }}
          title={`有 ${s.pendingUsers} 个注册申请等待审核`}
          action={<Button size="small" onClick={() => nav('/admin/users?status=pending')}>去审核</Button>}
        />
      )}
      <Row gutter={[16, 16]}>
        {tile('用户数', s?.users, '/admin/users')}
        {tile('课程数', s?.courses, '/admin/records')}
        {tile('已通过课程', s?.passedCourses, '/admin/records')}
        {tile('累计检查次数', s?.submissions, '/admin/records?tab=submissions')}
        {tile('今日检查', s?.today)}
        {tile('排队/检查中', s?.queued)}
        {tile('检查失败', s?.failed, '/admin/records?tab=submissions&status=failed')}
        {tile('待审核用户', s?.pendingUsers, '/admin/users?status=pending')}
      </Row>
      <Card title="最近检查" style={{ marginTop: 16 }} extra={<Link to="/admin/records?tab=submissions">全部记录</Link>} styles={{ body: { padding: 0 } }}>
        <Table
          rowKey="id"
          size="small"
          pagination={false}
          dataSource={s?.recent ?? []}
          scroll={{ x: 640 }}
          columns={[
            { title: '课程', dataIndex: 'course_name', render: (v, r) => <Link to={`/submissions/${r.id}`}>{v}</Link> },
            { title: '次数', dataIndex: 'seq', width: 80, render: (v) => `第${v}次` },
            { title: '提交人', render: (_, r) => `${r.user_name}（${r.username}）` },
            { title: '结果', width: 120, render: (_, r) => <SubmissionTag status={r.status} verdict={r.verdict} /> },
            { title: '提交时间', dataIndex: 'created_at', width: 170 },
          ]}
        />
      </Card>
    </div>
  );
}
