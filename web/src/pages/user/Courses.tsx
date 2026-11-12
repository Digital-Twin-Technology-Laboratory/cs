import { Button, Card, Empty, Input, Space } from 'antd';
import Table from '../../components/ResponsiveTable';
import { PlusOutlined } from '@ant-design/icons';
import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api } from '../../api';
import { ConfirmationTag, SubmissionTag } from '../../components/StatusTag';
import type { CourseRow } from '../../types';

export default function Courses() {
  const nav = useNavigate();
  const [rows, setRows] = useState<CourseRow[] | null>(null);
  const [q, setQ] = useState('');

  useEffect(() => {
    const load = () => api.get<{ courses: CourseRow[] }>('/api/courses').then((r) => setRows(r.courses));
    load();
    const t = setInterval(load, 8000);
    return () => clearInterval(t);
  }, []);

  const data = useMemo(() => (rows ?? []).filter((r) => !q || r.name.includes(q) || r.major.includes(q)), [rows, q]);

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>我的课程</h1>
          <div className="sub">每门课程的历次上传与检查结果都会保存。检查完成后，请在结果详情中确认提交。</div>
        </div>
        <Space>
          <Input.Search placeholder="搜索课程或专业" allowClear onChange={(e) => setQ(e.target.value)} style={{ width: 220 }} />
          <Button type="primary" icon={<PlusOutlined />} onClick={() => nav('/upload')}>
            上传检查
          </Button>
        </Space>
      </div>
      <Card styles={{ body: { padding: 0 } }}>
        <Table
          rowKey="id"
          loading={rows === null}
          dataSource={data}
          pagination={{ pageSize: 20, hideOnSinglePage: true }}
          locale={{ emptyText: <Empty description="还没有课程，点击右上角“上传检查”开始" /> }}
          columns={[
            { title: '课程名称', dataIndex: 'name', render: (v, r) => <Link to={`/courses/${r.id}`}>{v}</Link> },
            { title: '专业', dataIndex: 'major' },
            { title: '培养类型', dataIndex: 'training_type', width: 100 },
            { title: '学生年级', dataIndex: 'student_grade', width: 90, render: (v) => `${v}级` },
            { title: '对照方案', dataIndex: 'plan_grade', width: 90, render: (v) => `${v}级` },
            { title: '最近检查结果', width: 120, render: (_, r) => <SubmissionTag status={r.latest_status} verdict={r.latest_verdict} /> },
            { title: '提交状态', width: 130, render: (_, r) => <ConfirmationTag confirmedAt={r.latest_confirmed_at} status={r.latest_status} withdrawnAt={r.latest_withdrawn_at} /> },
            { title: '检查次数', dataIndex: 'submission_count', width: 90, align: 'center' },
            { title: '最近检查时间', dataIndex: 'latest_at', width: 170 },
            {
              title: '操作',
              width: 170,
              fixed: 'right',
              render: (_, r) => (
                <Space size={4}>
                  {r.latest_id && (
                    <Button size="small" type="link" onClick={() => nav(`/submissions/${r.latest_id}`)}>
                      查看结果
                    </Button>
                  )}
                </Space>
              ),
            },
          ]}
        />
      </Card>
    </div>
  );
}
