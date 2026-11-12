import { App, Button, Card, DatePicker, Empty, Input, Popconfirm, Select, Space, Tooltip } from 'antd';
import Table from '../../components/ResponsiveTable';
import { FileWordOutlined, ReloadOutlined, UploadOutlined } from '@ant-design/icons';
import { useCallback, useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { api, download, qs } from '../../api';
import { useAuth } from '../../auth';
import { ConfirmationTag, SubmissionTag } from '../../components/StatusTag';
import { fmtSize } from './CourseDetail';
import { EditableNumber } from '../../components/EditableNumber';
import EditableText from '../../components/EditableText';
import type { SubmissionRow } from '../../types';
import SubmissionAttachments from '../../components/SubmissionAttachments';
import SubmissionFilters from '../../components/SubmissionFilters';

interface Row extends SubmissionRow { username: string; user_name: string }

export default function Submissions() {
  const { message } = App.useApp();
  const { user } = useAuth();
  const [params, setParams] = useSearchParams();
  const scope = params.get('scope') === 'college' ? 'college' : 'mine';
  const canViewCollege = user?.role === 'admin' || user?.college_role === 'teaching';
  const canEditRecords = user?.role === 'admin' || user?.college_role === 'teaching';
  const [filters, setFilters] = useState({ q: '', status: '', confirmation: '', major: '', studentGrade: '', courseGroup: '', verdict: '', from: '', to: '' });
  const [selected, setSelected] = useState<Row[]>([]);
  const [page, setPage] = useState(1);
  const [data, setData] = useState<{ total: number; rows: Row[] }>({ total: 0, rows: [] });
  const [loading, setLoading] = useState(false);
  const [withdrawing, setWithdrawing] = useState<number | null>(null);
  const load = useCallback(async () => {
    setLoading(true);
    try {
      const result = await api.get<{ total: number; rows: Row[] }>(`/api/submissions?${qs({ ...filters, scope, page, pageSize: 20 })}`);
      setData(result);
      setSelected((prev) => prev.map((s) => result.rows.find((r) => r.id === s.id) ?? s));
    } catch (e) {
      setData({ total: 0, rows: [] });
      message.error((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [filters, scope, page, message]);

  useEffect(() => { load(); }, [load, canViewCollege]);
  useEffect(() => { setSelected([]); }, [filters, scope]);
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
  const withdraw = async (id: number) => {
    setWithdrawing(id);
    try {
      await api.post(`/api/submissions/${id}/withdraw`);
      await load();
      message.success('已撤回上传，本条记录恢复为未上传');
    } catch (e) { message.error((e as Error).message); }
    finally { setWithdrawing(null); }
  };
  const editField = (row: Row, field: 'course_name' | 'major' | 'student_grade' | 'file_name', value: string, children: React.ReactNode, options?: { value: string; label: string }[]) =>
    <EditableText value={value} name={`${field}-${row.id}`} options={options} disabled={row.status === 'queued' || row.status === 'running'}
      onSave={async (next) => { await api.put(`/api/submissions/${row.id}`, { [field]: field === 'student_grade' ? Number(next) : next }); await load(); }}>{children}</EditableText>;

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>{scope === 'college' ? '全院检查记录' : '我的上传记录'}</h1>
          <div className="sub">{scope === 'college' ? '查看全院所有上传文件和检查结果，包括未关联云清单的记录；不改变应交课程进度统计。' : '所有上传文件和检查结果均保留。检查完成后，进入结果详情确认提交；提交后可撤回上传。'}</div>
        </div>
        <Link to="/upload"><Button type="primary" icon={<UploadOutlined />}>上传检查</Button></Link>
      </div>
      <Card>
        <Space wrap style={{ marginBottom: 16 }}>
          {canViewCollege && <Select aria-label="检查记录范围" value={scope} style={{ width: 170 }}
            options={[{ value: 'mine', label: '我的上传记录' }, { value: 'college', label: '全院检查记录' }]}
            onChange={(next) => { setPage(1); setParams(next === 'college' ? { scope: next } : {}); }} />}
          <Input.Search placeholder={scope === 'college' ? '课程 / 专业 / 上传人 / 文件名' : '课程 / 专业 / 文件名'} allowClear onSearch={(q) => filter({ q })} style={{ width: 280 }} />
          <SubmissionFilters value={filters} onChange={filter} />
          <Select aria-label="附件检查结论筛选" value={filters.verdict} onChange={(verdict) => filter({ verdict })} style={{ width: 130 }}
            options={[{ value: '', label: '全部检查结论' }, { value: 'passed', label: '已通过' }, { value: 'failed', label: '未通过' }]} />
          <DatePicker.RangePicker onChange={(v) => filter({ from: v?.[0]?.format('YYYY-MM-DD') ?? '', to: v?.[1]?.format('YYYY-MM-DD') ?? '' })} />
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
            aria-label="提交状态"
            value={filters.confirmation}
            onChange={(confirmation) => filter({ confirmation })}
            style={{ width: 150 }}
            options={[
              { value: '', label: '全部提交状态' },
              { value: 'pending', label: '未提交' },
              { value: 'confirmed', label: '已提交' },
              { value: 'withdrawn', label: '已撤回（未上传）' },
            ]}
          />
          <Button icon={<ReloadOutlined />} onClick={load}>刷新</Button>
        </Space>
        <SubmissionAttachments selected={selected} onClear={() => setSelected([])} />
        <Table<Row>
          rowKey="id"
          loading={loading}
          dataSource={data.rows}
          rowSelection={{ selectedRowKeys: selected.map((s) => s.id), preserveSelectedRowKeys: true, onChange: (_, rows) => setSelected(rows) }}
          pagination={{ current: page, pageSize: 20, total: data.total, onChange: setPage, showSizeChanger: false, showTotal: (total) => `共 ${total} 条上传记录` }}
          locale={{ emptyText: <Empty description="暂无上传记录" /> }}
          columns={[
            { title: '课程', dataIndex: 'course_name', render: (name, row) => editField(row, 'course_name', name, canEditRecords && row.status !== 'queued' && row.status !== 'running' ? <span style={{ color: '#1f4e8c' }}>{name}</span> : <Link to={`/submissions/${row.id}`}>{name}</Link>) },
            { title: '年级', dataIndex: 'student_grade', width: 80, render: (grade, row) => editField(row, 'student_grade', String(grade), `${String(grade).slice(-2)}级`, [2023, 2024, 2025, 2026].map((n) => ({ value: String(n), label: `${String(n).slice(-2)}级` }))) },
            { title: '专业', dataIndex: 'major', width: 180, render: (major, row) => editField(row, 'major', major, major, ['计算机科学与技术', '计算机科学与技术（专转本）', '物联网工程', '人工智能'].map((name) => ({ value: name, label: name }))) },
            ...(scope === 'college' ? [{ title: '上传人', width: 150, render: (_: unknown, row: Row) => <div>{row.user_name}<div className="muted small">{row.username}</div></div> }] : []),
            { title: '次数', dataIndex: 'seq', width: 75, render: (seq, row) => <EditableNumber name={`上传次数-${row.id}`} value={seq} min={1} editable={canEditRecords} format={(n) => `第${n}次`} onSave={async (next) => { await api.put(`/api/submissions/${row.id}/sequence`, { seq: next }); await load(); }} /> },
            { title: '文件', dataIndex: 'file_name', width: 210, ellipsis: true, render: (name, row) => editField(row, 'file_name', name, <Tooltip title={name}>{name} <span className="muted small">{fmtSize(row.file_size)}</span></Tooltip>) },
            {
              title: '检查结果', width: 180, className: 'submission-verdict',
              render: (_, row) => canEditRecords && row.status === 'done' ? (
                <Select aria-label={`检查结果-${row.id}`} value={row.verdict} style={{ width: 112 }} disabled={loading}
                  options={[{ value: 'passed', label: '已通过' }, { value: 'failed', label: '未通过' }]}
                  onChange={async (verdict) => {
                    setLoading(true);
                    try { await api.put(`/api/submissions/${row.id}`, { verdict }); await load(); }
                    catch (e) { message.error((e as Error).message); }
                    finally { setLoading(false); }
                  }} />
              ) : <SubmissionTag status={row.status} verdict={row.verdict} />,
            },
            { title: '提交状态', width: 165, render: (_, row) => <><ConfirmationTag confirmedAt={row.confirmed_at} status={row.status} withdrawnAt={row.withdrawn_at} />{row.confirmed_at && <div className="muted small">{row.confirmed_at}</div>}</> },
            { title: '文件上传时间', dataIndex: 'created_at', width: 170 },
            {
              title: '操作', width: 220,
              render: (_, row) => (
                <Space size={0}>
                  <Link to={`/submissions/${row.id}`}><Button type="link" size="small">{scope === 'mine' && row.status === 'done' && !row.confirmed_at ? '查看并提交' : '查看详情'}</Button></Link>
                  {scope === 'mine' && row.confirmed_at && <Popconfirm title="撤回上传？" description="本条记录恢复为未上传；若为课程最新结果，应交进度同步恢复未上传。原文件和检查结果保留，可再次确认提交。" okText="撤回上传" onConfirm={() => withdraw(row.id)} okButtonProps={{ loading: withdrawing === row.id }}>
                    <Button type="link" size="small" danger disabled={withdrawing !== null} loading={withdrawing === row.id}>撤回上传</Button>
                  </Popconfirm>}
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
