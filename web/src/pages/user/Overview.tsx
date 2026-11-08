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
      <div><h1>个人总览</h1><div className="sub">仅显示云文档清单中指定你为执笔人的应交课程，每 10 秒自动刷新。</div></div>
      <Link to="/upload"><Button type="primary">上传大纲</Button></Link>
    </div>
    {error && <Alert type="error" showIcon title={error} action={<Button onClick={load}>重试</Button>} style={{ marginBottom: 16 }} />}
    <Card loading={!data && !error}>
      {data && <>
        <Row gutter={[16, 16]}>
          {([['required', '应交大纲'], ['uploaded', '已上传'], ['passed', '已通过'], ['confirmed', '最终已确认']] as const).map(([key, title]) => <Col xs={12} md={6} key={key}><Statistic title={title} value={key === 'required' ? data[key] : `${data[key]} / ${data.required}`} suffix="份" /></Col>)}
        </Row>
        <Alert type="info" showIcon style={{ margin: '20px 0' }}
          title="按云清单的课程、审核专业和课程组合并平行班，每门课程只需一份大纲。"
          description="显示指定给你的课程及该课程的最新上传、检查和确认，不限实际上传人；所有应交课程均通过才算个人全部通过。重新上传需确认新结果；执笔人调整后，个人应交范围同步调整，课程已有进度保留。名单外课程不计入这些统计。" />
        {!data.configured ? <Empty description="管理员尚未导入统计名单，请联系管理员。" />
          : data.required === 0 ? <Empty description="当前没有指定你为执笔人的应交大纲；如需调整，请联系管理员配置执笔人。" />
            : <CourseProgressTable courses={data.courses} />}
      </>}
    </Card>
  </div>;
}
