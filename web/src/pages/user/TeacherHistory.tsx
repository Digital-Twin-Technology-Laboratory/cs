import { Alert, Button, Card, Empty, Select } from 'antd';
import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { api } from '../../api';
import TeacherIssueHistory from '../../components/TeacherIssueHistory';
import type { HistoryTeacher } from '../../types';

export default function TeacherHistory() {
  const [params, setParams] = useSearchParams();
  const teacherId = Number(params.get('teacherId')) || undefined;
  const [teachers, setTeachers] = useState<HistoryTeacher[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [refresh, setRefresh] = useState(0);
  useEffect(() => {
    let active = true;
    setLoading(true);
    setError('');
    api.get<{ teachers: HistoryTeacher[] }>('/api/supervision/issue-history/teachers')
      .then((data) => { if (active) setTeachers(data.teachers); })
      .catch((e: Error) => { if (active) setError(e.message); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [refresh]);

  return <div className="page">
    <div className="page-head"><div><h1>教师历史问题</h1>
      <div className="sub">按教师调取历次检查意见，供教学条线对照复查；在检查结果详情页也可直接查看该上传人此前的问题。</div>
    </div></div>
    <Card className="no-print" style={{ marginBottom: 16 }}>
      <label htmlFor="history-teacher" style={{ marginRight: 12 }}>选择教师</label>
      <Select id="history-teacher" aria-label="选择历史问题教师" showSearch={{ optionFilterProp: 'label' }} allowClear
        placeholder="搜索姓名或工号" loading={loading} disabled={loading || !!error} value={teacherId}
        style={{ width: '100%', maxWidth: 360 }}
        options={teachers.map((teacher) => ({ value: teacher.id, label: `${teacher.name || teacher.username}（${teacher.username}）` }))}
        onChange={(id) => setParams(id ? { teacherId: String(id) } : {})} />
      <p className="muted small" style={{ marginBottom: 0 }}>仅列出有上传记录的账号。同名教师按工号区分；代传材料归实际上传人，不自动归入执笔人。</p>
    </Card>
    {error ? <Alert type="error" showIcon title={error} action={<Button onClick={() => setRefresh((n) => n + 1)}>重试</Button>} />
      : teacherId ? <TeacherIssueHistory key={teacherId} teacherId={teacherId} />
        : <Empty description="请选择一位教师，查看其历史检查问题" />}
  </div>;
}
