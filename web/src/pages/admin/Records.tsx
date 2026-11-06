import { App, Button, Card, DatePicker, Input, Popconfirm, Select, Space, Tabs, Tag, Tooltip } from 'antd';
import Table from '../../components/ResponsiveTable';
import { ReloadOutlined } from '@ant-design/icons';
import { useCallback, useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import type { Dayjs } from 'dayjs';
import { api, download, qs } from '../../api';
import { ConfirmationTag, SubmissionTag } from '../../components/StatusTag';
import { fmtSize } from '../user/CourseDetail';
import type { CourseRow, SubmissionRow } from '../../types';

interface SubRow extends SubmissionRow {
  ai_model: string | null;
  plan_name: string | null;
  user_id: number;
  username: string;
  user_name: string;
}

function useAct(reload: () => void) {
  const { message } = App.useApp();
  return async (fn: () => Promise<unknown>, ok: string) => {
    try {
      await fn();
      message.success(ok);
      reload();
    } catch (e) {
      message.error((e as Error).message);
    }
  };
}

function SubmissionsTab({ userId, initialStatus }: { userId?: string; initialStatus?: string }) {
  const [f, setF] = useState({ q: '', status: initialStatus ?? '', verdict: '', confirmation: '', from: '', to: '' });
  const [page, setPage] = useState(1);
  const [data, setData] = useState<{ total: number; rows: SubRow[] }>({ total: 0, rows: [] });
  const [loading, setLoading] = useState(false);
  const load = useCallback(async () => {
    setLoading(true);
    try {
      setData(await api.get(`/api/admin/submissions?${qs({ ...f, userId, page, pageSize: 20 })}`));
    } finally {
      setLoading(false);
    }
  }, [f, userId, page]);
  useEffect(() => {
    load();
  }, [load]);
  const act = useAct(load);
  const set = (patch: Partial<typeof f>) => (setPage(1), setF((x) => ({ ...x, ...patch })));

  return (
    <>
      <Space wrap style={{ marginBottom: 12, justifyContent: 'space-between', width: '100%' }}>
        <Space wrap>
          <Input.Search placeholder="课程 / 专业 / 提交人 / 文件名" allowClear onSearch={(q) => set({ q })} style={{ width: 260 }} />
          <Select
            value={f.status}
            onChange={(status) => set({ status })}
            style={{ width: 120 }}
            options={[
              { value: '', label: '全部状态' },
              { value: 'queued', label: '排队中' },
              { value: 'running', label: '检查中' },
              { value: 'done', label: '已完成' },
              { value: 'failed', label: '检查失败' },
            ]}
          />
          <Select
            value={f.verdict}
            onChange={(verdict) => set({ verdict })}
            style={{ width: 120 }}
            options={[
              { value: '', label: '全部结论' },
              { value: 'passed', label: '已通过' },
              { value: 'failed', label: '未通过' },
            ]}
          />
          <Select
            aria-label="结果上传状态"
            value={f.confirmation}
            onChange={(confirmation) => set({ confirmation })}
            style={{ width: 150 }}
            options={[
              { value: '', label: '全部结果上传状态' },
              { value: 'pending', label: '未确认上传' },
              { value: 'confirmed', label: '已确认上传' },
            ]}
          />
          <DatePicker.RangePicker
            onChange={(v) => set({ from: (v?.[0] as Dayjs | null)?.format('YYYY-MM-DD') ?? '', to: (v?.[1] as Dayjs | null)?.format('YYYY-MM-DD') ?? '' })}
          />
        </Space>
        <Popconfirm title="将全部“检查失败”的记录重新加入检查队列？" onConfirm={() => act(() => api.post('/api/admin/submissions/retry-failed'), '已重新排队')}>
          <Button icon={<ReloadOutlined />}>重新检查失败记录</Button>
        </Popconfirm>
      </Space>
      <Table
        rowKey="id"
        size="middle"
        loading={loading}
        dataSource={data.rows}
        pagination={{ current: page, pageSize: 20, total: data.total, onChange: setPage, showTotal: (t) => `共 ${t} 条` }}
        columns={[
          { title: '课程', dataIndex: 'course_name', render: (v, r) => <Link to={`/submissions/${r.id}`}>{v}</Link> },
          { title: '次数', dataIndex: 'seq', width: 75, render: (v) => `第${v}次` },
          { title: '专业 / 类型', width: 180, render: (_, r) => `${r.major} / ${r.training_type}` },
          { title: '年级', dataIndex: 'student_grade', width: 80, render: (v) => `${String(v).slice(-2)}级` },
          { title: '提交人', width: 150, render: (_, r) => `${r.user_name}（${r.username}）` },
          {
            title: '文件',
            dataIndex: 'file_name',
            ellipsis: true,
            render: (v, r) => (
              <Tooltip title={v}>
                {v} <span className="muted small">{fmtSize(r.file_size)}</span>
              </Tooltip>
            ),
          },
          {
            title: '结果',
            width: 120,
            render: (_, r) =>
              r.status === 'failed' ? (
                <Tooltip title={r.error}>
                  <span>
                    <SubmissionTag status={r.status} verdict={r.verdict} />
                  </span>
                </Tooltip>
              ) : (
                <SubmissionTag status={r.status} verdict={r.verdict} />
              ),
          },
          { title: '对照方案', dataIndex: 'plan_name', width: 120, render: (v) => (v ? <Tooltip title={v}><Tag color="green">已对照</Tag></Tooltip> : <Tag>未预置</Tag>) },
          { title: '结果上传状态', width: 165, render: (_, r) => <><ConfirmationTag confirmedAt={r.confirmed_at} status={r.status} />{r.confirmed_at && <div className="muted small">{r.confirmed_at}</div>}</> },
          { title: '文件上传时间', dataIndex: 'created_at', width: 165 },
          {
            title: '操作',
            width: 230,
            fixed: 'right',
            render: (_, r) => (
              <Space size={0}>
                <Button type="link" size="small" onClick={() => download(`/api/submissions/${r.id}/file`)}>
                  原文件
                </Button>
                {r.status === 'done' && (
                  <Button type="primary" ghost size="small" onClick={() => download(`/api/submissions/${r.id}/report.docx`)}>
                    下载检查结果
                  </Button>
                )}
                {r.status === 'failed' && (
                  <Button type="link" size="small" onClick={() => act(() => api.post(`/api/submissions/${r.id}/recheck`), '已重新排队')}>
                    重新检查
                  </Button>
                )}
                <Popconfirm
                  title="删除该次检查记录及上传文件？"
                  description="删除后无法恢复。"
                  okText="删除"
                  okButtonProps={{ danger: true }}
                  onConfirm={() => act(() => api.del(`/api/admin/submissions/${r.id}`), '已删除')}
                >
                  <Button type="link" size="small" danger>
                    删除
                  </Button>
                </Popconfirm>
              </Space>
            ),
          },
        ]}
      />
    </>
  );
}

function CoursesTab({ userId }: { userId?: string }) {
  const [f, setF] = useState({ q: '', verdict: '' });
  const [page, setPage] = useState(1);
  const [data, setData] = useState<{ total: number; rows: CourseRow[] }>({ total: 0, rows: [] });
  const [loading, setLoading] = useState(false);
  const load = useCallback(async () => {
    setLoading(true);
    try {
      setData(await api.get(`/api/admin/courses?${qs({ ...f, userId, page, pageSize: 20 })}`));
    } finally {
      setLoading(false);
    }
  }, [f, userId, page]);
  useEffect(() => {
    load();
  }, [load]);
  const act = useAct(load);

  return (
    <>
      <Space wrap style={{ marginBottom: 12 }}>
        <Input.Search placeholder="课程 / 专业 / 负责人" allowClear onSearch={(q) => (setPage(1), setF((x) => ({ ...x, q })))} style={{ width: 240 }} />
        <Select
          value={f.verdict}
          onChange={(verdict) => (setPage(1), setF((x) => ({ ...x, verdict })))}
          style={{ width: 140 }}
          options={[
            { value: '', label: '全部课程' },
            { value: 'passed', label: '最近一次通过' },
            { value: 'failed', label: '最近一次未通过' },
            { value: 'none', label: '尚无检查' },
          ]}
        />
      </Space>
      <Table
        rowKey="id"
        loading={loading}
        dataSource={data.rows}
        pagination={{ current: page, pageSize: 20, total: data.total, onChange: setPage, showTotal: (t) => `共 ${t} 门课程` }}
        columns={[
          { title: '课程名称', dataIndex: 'name', render: (v, r) => <Link to={`/courses/${r.id}`}>{v}</Link> },
          { title: '专业', dataIndex: 'major' },
          { title: '类型', dataIndex: 'training_type', width: 90 },
          { title: '学生年级', dataIndex: 'student_grade', width: 90, render: (v) => `${v}级` },
          { title: '负责人', width: 150, render: (_, r) => `${r.user_name}（${r.username}）` },
          { title: '最近结果', width: 120, render: (_, r) => <SubmissionTag status={r.latest_status} verdict={r.latest_verdict} /> },
          { title: '检查次数', dataIndex: 'submission_count', width: 90, align: 'center' },
          { title: '最近检查', dataIndex: 'latest_at', width: 165 },
          {
            title: '操作',
            width: 90,
            fixed: 'right',
            render: (_, r) => (
              <Popconfirm
                title="删除课程"
                description={`将删除该课程的 ${r.submission_count} 次检查记录及全部上传文件，无法恢复。`}
                okText="删除"
                okButtonProps={{ danger: true }}
                onConfirm={() => act(() => api.del(`/api/admin/courses/${r.id}`), '课程已删除')}
              >
                <Button type="link" size="small" danger>
                  删除
                </Button>
              </Popconfirm>
            ),
          },
        ]}
      />
    </>
  );
}

export default function Records() {
  const [params, setParams] = useSearchParams();
  const userId = params.get('userId') ?? undefined;
  const tab = params.get('tab') ?? 'submissions';
  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>文件与检查记录</h1>
          <div className="sub">全站课程、每次上传的文件和检查结果。{userId && '当前只显示所选用户的记录。'}</div>
        </div>
        {userId && (
          <Button onClick={() => setParams({ tab })}>显示全部用户</Button>
        )}
      </div>
      <Card>
        <Tabs
          activeKey={tab}
          onChange={(t) => setParams({ ...(userId ? { userId } : {}), tab: t })}
          items={[
            { key: 'courses', label: '课程', children: <CoursesTab userId={userId} /> },
            { key: 'submissions', label: '检查记录与文件', children: <SubmissionsTab userId={userId} initialStatus={params.get('status') ?? undefined} /> },
          ]}
        />
      </Card>
    </div>
  );
}
