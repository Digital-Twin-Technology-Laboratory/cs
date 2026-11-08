import { Alert, Button, Card, Col, Empty, Row, Statistic } from 'antd';
import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../../api';
import CourseProgressTable from '../../components/CourseProgressTable';
import type { PersonalProgress } from '../../types';

export default function Overview() {
  const [data, setData] = useState<PersonalProgress | null>(null);
  const [error, setError] = useState('');
  const load = useCallback(async () => {
    try {
      setData(await api.get<PersonalProgress>('/api/progress'));
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
  return <div className="page">
    <div className="page-head">
      <div><h1>个人总览</h1><div className="sub">仅显示你本人在管理员整周课表名单中的应交课程，每 10 秒自动刷新。</div></div>
      <Link to="/upload"><Button type="primary">上传大纲</Button></Link>
    </div>
    {error && <Alert type="error" showIcon title={error} action={<Button onClick={load}>重试</Button>} style={{ marginBottom: 16 }} />}
    <Card loading={!data && !error}>
      {data && <>
        <Row gutter={[16, 16]}>
          {([['required', '应交大纲'], ['uploaded', '已上传'], ['passed', '已通过'], ['confirmed', '最终已确认']] as const).map(([key, title]) => <Col xs={12} md={6} key={key}><Statistic title={title} value={data[key]} suffix="份" /></Col>)}
        </Row>
        <Alert type="info" showIcon style={{ margin: '20px 0' }}
          title="同一教师的同一课程合并平行班和重复课次，只需一份大纲。"
          description="按课程名称匹配你的上传，取每门课程最新一次检查及确认状态；未上传课程也计入应交总数。所有应交课程的最新检查均通过，才算个人全部通过。确认独立于通过，重新上传后需确认新结果。名单外课程不计入这些统计。" />
        {!data.configured ? <Empty description="管理员尚未导入统计名单，请联系管理员。" />
          : data.required === 0 ? <Empty description="当前整周课表名单中没有与你的工号匹配的应交课程，请联系管理员核对。" />
            : <CourseProgressTable courses={data.courses} />}
      </>}
    </Card>
  </div>;
}
