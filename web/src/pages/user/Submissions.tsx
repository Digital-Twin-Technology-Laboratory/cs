import { App, Button, Card, Empty, Input, InputNumber, Select, Space, Tooltip } from 'antd';
import Table from '../../components/ResponsiveTable';
import { FileWordOutlined, ReloadOutlined, UploadOutlined } from '@ant-design/icons';
import { useCallback, useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { api, download, qs } from '../../api';
import { useAuth } from '../../auth';
import { ConfirmationTag, SubmissionTag } from '../../components/StatusTag';
import { fmtSize } from './CourseDetail';
import dayjs from 'dayjs';
import { useDemo, type DemoRecord as Row } from '../../demo';

export default function Submissions() {
  const { message } = App.useApp();
  const { user } = useAuth();
  const demo = useDemo();
  const [demoCount, setDemoCount] = useState(4);
  const [params, setParams] = useSearchParams();
  const scope = params.get('scope') === 'college' ? 'college' : 'mine';
  const canViewCollege = user?.role === 'admin' || user?.college_role === 'teaching';
  const [filters, setFilters] = useState({ q: '', status: '', confirmation: '' });
  const [page, setPage] = useState(1);
  const [data, setData] = useState<{ total: number; rows: Row[] }>({ total: 0, rows: [] });
  const [loading, setLoading] = useState(false);
  const load = useCallback(async () => {
    setLoading(true);
    try {
      setData(await api.get(`/api/submissions?${qs({ ...filters, scope, page, pageSize: 20 })}`));
    } catch (e) {
      setData({ total: 0, rows: [] });
      message.error((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [filters, scope, page, message]);

  useEffect(() => { load(); }, [load, canViewCollege]);
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
  const rows = demo.enabled ? (demo.records[scope] ?? data.rows).map((row) => ({ ...row, ...demo.recordEdits[row.id] }))
    .filter((row) => (!filters.status || row.status === filters.status)
      && (!filters.confirmation || (filters.confirmation === 'confirmed') === !!row.confirmed_at)
      && `${row.course_name} ${row.major} ${row.file_name} ${row.user_name} ${row.username}`.includes(filters.q)) : data.rows;
  const generateHistory = () => {
    const base: Row = data.rows[0] ?? {
      id: 0, course_id: 0, seq: 1, course_name: '数据库原理与设计', student_grade: 2024, major: '计算机科学与技术',
      training_type: '普通本科', file_name: '数据库原理与设计教学大纲.docx', file_size: 40960,
      status: 'done', verdict: 'failed', error: null, created_at: '', finished_at: null, confirmed_at: null,
      user_name: demo.teacherName!, username: user!.username,
    };
    demo.setRecords(scope, Array.from({ length: demoCount }, (_, i): Row => {
      const at = dayjs().subtract(demoCount - i - 1, 'hour').format('YYYY-MM-DD HH:mm:ss');
      const last = i === demoCount - 1;
      return { ...base, id: -(i + 1 + (scope === 'college' ? 100 : 0)), seq: i + 1,
        user_name: demo.teacherName!,
        file_name: `${base.course_name}教学大纲${i ? `（修改${i}）` : ''}.docx`,
        status: 'done', verdict: last ? 'passed' : 'failed', error: null,
        created_at: at, finished_at: at, confirmed_at: last ? at : null };
    }).reverse());
    setPage(1);
    setFilters({ q: '', status: '', confirmation: '' });
  };

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>{scope === 'college' ? '全院检查记录' : '我的上传记录'}</h1>
          <div className="sub">{scope === 'college' ? '查看全院所有上传文件和检查结果，包括未关联云清单的记录；不改变应交课程进度统计。' : '所有上传文件、检查结果和确认时间均保留。检查完成后，进入结果详情确认上传。'}</div>
        </div>
        <Link to="/upload" onClick={(e) => { if (demo.enabled) e.preventDefault(); }}><Button disabled={demo.enabled} type="primary" icon={<UploadOutlined />}>上传检查</Button></Link>
      </div>
      <Card>
        <Space wrap style={{ marginBottom: 16 }}>
          {canViewCollege && <Select aria-label="检查记录范围" value={scope} style={{ width: 170 }}
            options={[{ value: 'mine', label: '我的上传记录' }, { value: 'college', label: '全院检查记录' }]}
            onChange={(next) => { setPage(1); setParams(next === 'college' ? { scope: next } : {}); }} />}
          <Input.Search placeholder={scope === 'college' ? '课程 / 专业 / 上传人 / 文件名' : '课程 / 专业 / 文件名'} allowClear onSearch={(q) => filter({ q })} style={{ width: 280 }} />
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
          {demo.editing && <>
            <Select aria-label="示意上传次数" value={demoCount} style={{ width: 100 }} options={[3, 4, 5].map((n) => ({ value: n, label: `${n} 次` }))} onChange={setDemoCount} />
            <Button onClick={generateHistory}>生成修改过程</Button>
          </>}
        </Space>
        <Table<Row>
          rowKey="id"
          loading={loading}
          dataSource={rows}
          pagination={{ current: page, pageSize: 20, total: demo.records[scope] ? rows.length : data.total, onChange: setPage, showSizeChanger: false, showTotal: (total) => `共 ${total} 条上传记录` }}
          locale={{ emptyText: <Empty description="暂无上传记录" /> }}
          columns={[
            { title: '课程', dataIndex: 'course_name', render: (name, row) => demo.editing ? <Input aria-label={`课程-${row.id}`} value={name} onChange={(e) => demo.editRecord(row.id, { course_name: e.target.value })} /> : demo.enabled ? <span style={{ color: '#1f4e8c' }}>{name}</span> : <Link to={`/submissions/${row.id}`}>{name}</Link> },
            { title: '年级', dataIndex: 'student_grade', width: 80, render: (grade, row) => demo.editing ? <InputNumber aria-label={`年级-${row.id}`} value={grade} min={2000} max={2100} precision={0} style={{ width: '100%' }} onChange={(n) => { if (n !== null) demo.editRecord(row.id, { student_grade: n }); }} /> : `${String(grade).slice(-2)}级` },
            { title: '专业', dataIndex: 'major', width: 180, render: (major, row) => demo.editing ? <Input aria-label={`专业-${row.id}`} value={major} onChange={(e) => demo.editRecord(row.id, { major: e.target.value })} /> : major },
            ...(scope === 'college' ? [{ title: '上传人', width: 150, render: (_: unknown, row: Row) => <div>{demo.editing ? <Input aria-label={`上传人-${row.id}`} value={row.user_name} onChange={(e) => demo.editRecord(row.id, { user_name: e.target.value })} /> : row.user_name}<div className="muted small">{row.username}</div></div> }] : []),
            { title: '次数', dataIndex: 'seq', width: 75, render: (seq, row) => demo.editing ? <InputNumber aria-label={`次数-${row.id}`} min={1} precision={0} value={seq} style={{ width: '100%' }} onChange={(n) => { if (n !== null) demo.editRecord(row.id, { seq: n }); }} /> : `第${seq}次` },
            { title: '文件', dataIndex: 'file_name', width: 210, ellipsis: true, render: (name, row) => demo.editing ? <Input aria-label={`文件-${row.id}`} value={name} onChange={(e) => demo.editRecord(row.id, { file_name: e.target.value })} /> : <Tooltip title={name}>{name} <span className="muted small">{fmtSize(row.file_size)}</span></Tooltip> },
            { title: '检查结果', width: 115, render: (_, row) => demo.editing ? <Select<'passed' | 'failed' | 'queued' | 'running' | 'error'> aria-label={`检查结果-${row.id}`} value={row.status === 'done' ? row.verdict : row.status === 'failed' ? 'error' : row.status} style={{ width: '100%' }} options={[{ value: 'passed', label: '已通过' }, { value: 'failed', label: '未通过' }, { value: 'queued', label: '排队中' }, { value: 'running', label: '检查中' }, { value: 'error', label: '检查失败' }]} onChange={(v) => demo.editRecord(row.id, v === 'passed' || v === 'failed' ? { status: 'done', verdict: v } : { status: v === 'error' ? 'failed' : v, verdict: null, confirmed_at: null })} /> : <SubmissionTag status={row.status} verdict={row.verdict} /> },
            { title: '结果上传状态', width: 165, render: (_, row) => demo.editing ? <Select aria-label={`结果上传状态-${row.id}`} value={row.confirmed_at ? 'confirmed' : 'pending'} style={{ width: '100%' }} options={[{ value: 'pending', label: '待确认上传' }, { value: 'confirmed', label: '已确认上传' }]} onChange={(v) => demo.editRecord(row.id, { confirmed_at: v === 'confirmed' ? dayjs().format('YYYY-MM-DD HH:mm:ss') : null, ...(v === 'confirmed' ? { status: 'done' as const } : {}) })} /> : <><ConfirmationTag confirmedAt={row.confirmed_at} status={row.status} />{row.confirmed_at && <div className="muted small">{row.confirmed_at}</div>}</> },
            { title: '文件上传时间', dataIndex: 'created_at', width: 170, render: (at, row) => demo.editing ? <Input aria-label={`上传时间-${row.id}`} value={at} onChange={(e) => demo.editRecord(row.id, { created_at: e.target.value })} /> : at },
            {
              title: '操作', width: 220,
              render: (_, row) => (
                <Space size={0}>
                  <Link to={`/submissions/${row.id}`} onClick={(e) => { if (demo.enabled) e.preventDefault(); }}><Button disabled={demo.enabled} type="link" size="small">{scope === 'mine' && row.status === 'done' && !row.confirmed_at ? '查看并确认' : '查看详情'}</Button></Link>
                  {row.status === 'done' && <Button disabled={demo.enabled} type="primary" ghost size="small" icon={<FileWordOutlined />} onClick={() => download(`/api/submissions/${row.id}/report.docx`)}>下载检查结果</Button>}
                  <Button disabled={demo.enabled} type="link" size="small" onClick={() => download(`/api/submissions/${row.id}/file`)}>原文件</Button>
                </Space>
              ),
            },
          ]}
        />
      </Card>
    </div>
  );
}
