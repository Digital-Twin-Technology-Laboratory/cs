import { Alert, App, Button, Card, Col, Empty, Input, Modal, Row, Select, Space, Statistic, Tag, Upload, type UploadFile } from 'antd';
import { ReloadOutlined, UploadOutlined } from '@ant-design/icons';
import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../../api';
import Table from '../../components/ResponsiveTable';
import CourseProgressTable from '../../components/CourseProgressTable';
import type { RequiredCourseProgress } from '../../types';

interface ProgressRow {
  username: string;
  name: string;
  user_id: number | null;
  required_count: number;
  uploaded_count: number;
  passed_count: number;
  confirmed_count: number;
  courses: RequiredCourseProgress[];
}
interface ProgressData {
  roster: { timetableName: string; planName: string; importedAt: string; sourceRows: number; mergedRows: number; planPairs: number; warnings: string[] } | null;
  summary: { total: number; uploaded: number; passed: number; confirmed: number; requiredOutlines: number; uploadedOutlines: number; passedOutlines: number; confirmedOutlines: number };
  rows: ProgressRow[];
}
const allPassed = (r: ProgressRow) => r.required_count > 0 && r.passed_count === r.required_count;

export default function RosterProgress() {
  const { message } = App.useApp();
  const [data, setData] = useState<ProgressData | null>(null);
  const [error, setError] = useState('');
  const [q, setQ] = useState('');
  const [filter, setFilter] = useState('');
  const [page, setPage] = useState(1);
  const [importOpen, setImportOpen] = useState(false);
  const [timetable, setTimetable] = useState<UploadFile[]>([]);
  const [plan, setPlan] = useState<UploadFile[]>([]);
  const [importing, setImporting] = useState(false);
  const load = useCallback(async () => {
    try {
      setData(await api.get<ProgressData>('/api/admin/progress'));
      setError('');
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);
  useEffect(() => {
    load();
    const timer = setInterval(load, 10000);
    return () => clearInterval(timer);
  }, [load]);

  const importRoster = async () => {
    const timetableFile = timetable[0]?.originFileObj;
    const planFile = plan[0]?.originFileObj;
    if (!timetableFile || !planFile) return message.warning('请同时选择整周课表和磨课计划');
    const form = new FormData();
    form.append('timetable', timetableFile);
    form.append('plan', planFile);
    setImporting(true);
    try {
      const result = await api.post<{ people: number; required: number; warnings: string[] }>('/api/admin/progress/import', form);
      message.success(`统计名单已更新：${result.people} 人，应交 ${result.required} 份大纲${result.warnings.length ? `，磨课核对有 ${result.warnings.length} 项待核实` : ''}`);
      setImportOpen(false);
      setTimetable([]);
      setPlan([]);
      setQ('');
      setFilter('');
      setPage(1);
      await load();
    } catch (e) {
      message.error((e as Error).message);
    } finally {
      setImporting(false);
    }
  };
  const rows = data?.rows.filter((r) => {
    if (!`${r.name} ${r.username} ${r.courses.map((c) => `${c.course_name} ${c.course_group}`).join(' ')}`.toLowerCase().includes(q.trim().toLowerCase())) return false;
    switch (filter) {
      case 'uploaded': return r.uploaded_count > 0;
      case 'not-uploaded': return r.uploaded_count === 0;
      case 'passed': return allPassed(r);
      case 'not-passed': return !allPassed(r);
      case 'confirmed': return r.confirmed_count > 0;
      case 'not-confirmed': return r.confirmed_count < r.required_count;
      case 'unmatched': return r.user_id === null;
      default: return true;
    }
  }) ?? [];

  return <>
    <Card title="名单进度全览（仅管理员）" loading={!data && !error} style={{ marginBottom: 20 }}
      extra={<Space wrap>
        <Button icon={<ReloadOutlined />} onClick={load} aria-label="刷新名单进度" />
        <Button type="primary" icon={<UploadOutlined />} onClick={() => setImportOpen(true)}>{data?.roster ? '更换统计名单' : '上传统计名单'}</Button>
      </Space>}>
      {error && <Alert type="error" showIcon title={`名单进度刷新失败：${error}`} style={{ marginBottom: 16 }} />}
      {data && (data.roster ? <>
        <div className="muted small" style={{ marginBottom: 16, overflowWrap: 'anywhere' }}>
          课表：{data.roster.timetableName}；磨课计划：{data.roster.planName}。导入于 {data.roster.importedAt}，每 10 秒自动刷新。
        </div>
        <Row gutter={[16, 16]}>
          <Col xs={12} md={6}><Statistic title="应交教师（人数分母）" value={data.summary.total} suffix="人" /></Col>
          {([['uploaded', '有上传的教师'], ['passed', '全部应交课程通过'], ['confirmed', '有确认的教师']] as const).map(([key, title]) => <Col xs={12} md={6} key={key}>
            <Statistic title={title} value={data.summary[key]} suffix="人" />
            <div className="muted small">{(data.summary[key] / data.summary.total * 100).toFixed(1)}%（{data.summary[key]} / {data.summary.total}）</div>
          </Col>)}
        </Row>
        <Row gutter={[16, 16]} style={{ marginTop: 20 }}>
          {([['requiredOutlines', '应交大纲（份数分母）'], ['uploadedOutlines', '已上传大纲'], ['passedOutlines', '最新检查通过'], ['confirmedOutlines', '最终已确认']] as const).map(([key, title]) => <Col xs={12} md={6} key={key}>
            <Statistic title={title} value={data.summary[key]} suffix="份" valueStyle={{ fontSize: 20 }} />
            {key !== 'requiredOutlines' && <div className="muted small">{(data.summary[key] / data.summary.requiredOutlines * 100).toFixed(1)}%（{data.summary[key]} / {data.summary.requiredOutlines}）</div>}
          </Col>)}
        </Row>
        <Alert type="info" showIcon style={{ margin: '16px 0' }} title="整周课表确定应交范围，磨课表仅交叉核对，不排除其他有课教师。"
          description="按“教师工号＋课程名称”合并平行班、重复课次和教学环节，共同授课拆到各自工号。只统计名单内课程，取该教师该课程最新一次检查和确认；有一门未上传或未通过，就不算个人全部通过。确认独立于通过，新上传需重新确认。人数和份数的分母分别为应交教师数和应交大纲数。" />
        <div className="muted small" style={{ marginBottom: 16 }}>课表 {data.roster.sourceRows} 行，拆分共同授课后合并 {data.roster.mergedRows} 条重复任课记录；磨课表按“授课教师＋课程”核对 {data.roster.planPairs} 项，不计指导老师。</div>
        {!!data.roster.warnings.length && <Alert type="warning" showIcon title="磨课表有待核实项（不改变课表分母）" description={<ul>{data.roster.warnings.map((w) => <li key={w}>{w}</li>)}</ul>} style={{ marginBottom: 16 }} />}
        <Space wrap style={{ marginBottom: 16 }}>
          <Input placeholder="姓名 / 工号 / 课程 / 课程组" aria-label="搜索名单姓名或工号" value={q} allowClear onChange={(e) => { setQ(e.target.value); setPage(1); }} style={{ width: 240 }} />
          <Select value={filter} aria-label="筛选名单进度" onChange={(value) => { setFilter(value); setPage(1); }} style={{ width: 170 }} options={[
            { value: '', label: '全部教师' }, { value: 'uploaded', label: '有上传' }, { value: 'not-uploaded', label: '尚未上传' },
            { value: 'passed', label: '全部课程已通过' }, { value: 'not-passed', label: '尚未全部通过' },
            { value: 'confirmed', label: '有确认' }, { value: 'not-confirmed', label: '尚未全部确认' }, { value: 'unmatched', label: '未匹配到账号' },
          ]} />
          <span className="muted small">展开教师查看逐门课程；筛选不改变上方统计。</span>
        </Space>
        <Table<ProgressRow> rowKey="username" size="small" dataSource={rows}
          expandable={{ expandedRowRender: (r) => <CourseProgressTable courses={r.courses} showPlan /> }}
          pagination={{ current: page, pageSize: 20, showSizeChanger: false, total: rows.length, onChange: setPage, showTotal: (total) => `共 ${total} 人` }}
          columns={[
            { title: '教师', width: 190, render: (_, r) => <div><strong>{r.name}</strong><div className="muted small">{r.username}</div>{r.user_id === null && <Tag>未匹配到账号</Tag>}</div> },
            { title: '应交大纲', width: 90, render: (_, r) => `${r.required_count} 份` },
            { title: '已上传', width: 110, render: (_, r) => `${r.uploaded_count} / ${r.required_count} 份` },
            { title: '已通过', width: 160, render: (_, r) => <div>{r.passed_count} / {r.required_count} 份<div><Tag color={allPassed(r) ? 'success' : undefined}>{allPassed(r) ? '全部已通过' : '尚未全部通过'}</Tag></div></div> },
            { title: '最终已确认', width: 110, render: (_, r) => `${r.confirmed_count} / ${r.required_count} 份` },
            { title: '上传历史', width: 100, render: (_, r) => r.user_id === null ? '-' : <Link to={`/admin/records?tab=submissions&userId=${r.user_id}`}>查看记录</Link> },
          ]} />
      </> : <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="上传整周课表和磨课计划，生成应交名单及全站进度。" />)}
    </Card>
    <Modal title={data?.roster ? '更换统计名单' : '上传统计名单'} open={importOpen} onOk={importRoster}
      onCancel={() => { setImportOpen(false); setTimetable([]); setPlan([]); }} confirmLoading={importing}
      closable={!importing} maskClosable={!importing} cancelButtonProps={{ disabled: importing }}
      okButtonProps={{ disabled: !timetable.length || !plan.length }} okText={data?.roster ? '确认替换名单' : '导入统计名单'}>
      <p>请分别选择两份原始 .xlsx，无需整理表头或删除工作表。整周课表提供“星期几、课程名称、姓名、教工号、课程组”；磨课计划读取含“授课教师、课程名称”的逐场安排。未填写课程组的课程仍计入全院，磨课清单中的未分组课程会提示待核实。</p>
      <p>统计整周所有有课教师，按工号匹配账号；同一教师同一课程合并平行班和重复课次。工号请保留文本格式。只更新统计名单，不创建账号或修改检查记录。</p>
      {data?.roster && <Alert type="warning" showIcon title={`确认后整体替换当前 ${data.summary.total} 人、${data.summary.requiredOutlines} 份应交大纲的名单，教师个人总览也将同步更新。`} style={{ marginBottom: 16 }} />}
      <div style={{ marginBottom: 16 }}><strong>整周课表（带课程组）</strong><div style={{ marginTop: 8 }}><Upload accept=".xlsx" maxCount={1} fileList={timetable} beforeUpload={() => false} onChange={({ fileList }) => setTimetable(fileList.slice(-1))} disabled={importing}><Button icon={<UploadOutlined />}>选择课表文件</Button></Upload></div></div>
      <div><strong>磨课计划安排表</strong><div style={{ marginTop: 8 }}><Upload accept=".xlsx" maxCount={1} fileList={plan} beforeUpload={() => false} onChange={({ fileList }) => setPlan(fileList.slice(-1))} disabled={importing}><Button icon={<UploadOutlined />}>选择磨课计划文件</Button></Upload></div></div>
    </Modal>
  </>;
}
