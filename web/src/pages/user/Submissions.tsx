import { App, Button, Card, Empty, Input, Select, Space, Tooltip } from 'antd';
import Table from '../../components/ResponsiveTable';
import { FileWordOutlined, ReloadOutlined, UploadOutlined } from '@ant-design/icons';
import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, download, qs } from '../../api';
import { ConfirmationTag, SubmissionTag } from '../../components/StatusTag';
import { fmtSize } from './CourseDetail';
import type { SubmissionRow } from '../../types';

export default function Submissions() {
  const { message } = App.useApp();
  const [filters, setFilters] = useState({ q: '', status: '', confirmation: '' });
  const [page, setPage] = useState(1);
  const [data, setData] = useState<{ total: number; rows: SubmissionRow[] }>({ total: 0, rows: [] });
  const [loading, setLoading] = useState(false);
  const load = useCallback(async () => {
    setLoading(true);
    try {
      setData(await api.get(`/api/submissions?${qs({ ...filters, page, pageSize: 20 })}`));
    } catch (e) {
      message.error((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [filters, page, message]);

  useEffect(() => { load(); }, [load]);
  const checking = data.rows.some((s) => s.status === 'queued' || s.status === 'running');
  useEffect(() => {
    if (!checking) return;
    const timer = setInterval(load, 4000);
    return () => clearInterval(timer);
  }, [checking, load]);
  const filter = (patch: Partial<typeof filters>) => {
    setPage(1);
    setFilters((prev) => ({ ...prev, ...patch }));
  };

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>我的上传记录</h1>
          <div className="sub">所有上传文件、检查结果和确认时间均保留。检查完成后，进入结果详情确认上传。</div>
        </div>
        <Link to="/upload"><Button type="primary" icon={<UploadOutlined />}>上传检查</Button></Link>
      </div>
      <Card>
        <Space wrap style={{ marginBottom: 16 }}>
          <Input.Search placeholder="课程 / 专业 / 文件名" allowClear onSearch={(q) => filter({ q })} style={{ width: 240 }} />
          <Select
            aria-label="检查状态"
            value={filters.status}
            onChange={(status) => filter({ status })}
            style={{ width: 130 }}
            options={[
              { value: '', label: '全部检查状态' },
              { value: 'queued', label: '排队中' },
              { value: 'running', label: '检查中' },
              { value: 'done', label: '已完成' },
              { value: 'failed', label: '检查失败' },
            ]}
          />
          <Select
            aria-label="结果上传状态"
            value={filters.confirmation}
            onChange={(confirmation) => filter({ confirmation })}
            style={{ width: 150 }}
            options={[
              { value: '', label: '全部结果上传状态' },
              { value: 'pending', label: '未确认上传' },
              { value: 'confirmed', label: '已确认上传' },
            ]}
          />
          <Button icon={<ReloadOutlined />} onClick={load}>刷新</Button>
        </Space>
        <Table<SubmissionRow>
          rowKey="id"
          loading={loading}
          dataSource={data.rows}
          pagination={{ current: page, pageSize: 20, total: data.total, onChange: setPage, showSizeChanger: false, showTotal: (total) => `共 ${total} 条上传记录` }}
          locale={{ emptyText: <Empty description="暂无上传记录" /> }}
          columns={[
            { title: '课程', dataIndex: 'course_name', render: (name, row) => <Link to={`/submissions/${row.id}`}>{name}</Link> },
            { title: '年级', dataIndex: 'student_grade', width: 80, render: (grade) => `${String(grade).slice(-2)}级` },
            { title: '专业', dataIndex: 'major', width: 180 },
            { title: '次数', dataIndex: 'seq', width: 75, render: (seq) => `第${seq}次` },
            { title: '文件', dataIndex: 'file_name', width: 210, ellipsis: true, render: (name, row) => <Tooltip title={name}>{name} <span className="muted small">{fmtSize(row.file_size)}</span></Tooltip> },
            { title: '检查结果', width: 115, render: (_, row) => <SubmissionTag status={row.status} verdict={row.verdict} /> },
            { title: '结果上传状态', width: 165, render: (_, row) => <><ConfirmationTag confirmedAt={row.confirmed_at} status={row.status} />{row.confirmed_at && <div className="muted small">{row.confirmed_at}</div>}</> },
            { title: '文件上传时间', dataIndex: 'created_at', width: 170 },
            {
              title: '操作', width: 220,
              render: (_, row) => (
                <Space size={0}>
                  <Link to={`/submissions/${row.id}`}><Button type="link" size="small">{row.status === 'done' && !row.confirmed_at ? '查看并确认' : '查看详情'}</Button></Link>
                  {row.status === 'done' && <Button type="primary" ghost size="small" icon={<FileWordOutlined />} onClick={() => download(`/api/submissions/${row.id}/report.docx`)}>下载检查结果</Button>}
                  <Button type="link" size="small" onClick={() => download(`/api/submissions/${row.id}/file`)}>原文件</Button>
                </Space>
              ),
            },
          ]}
        />
      </Card>
    </div>
  );
}
