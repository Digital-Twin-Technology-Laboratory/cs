import { Alert, App, Breadcrumb, Button, Card, Result, Space, Spin } from 'antd';
import { ReloadOutlined } from '@ant-design/icons';
import { useCallback, useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api } from '../../api';
import { useAuth } from '../../auth';
import ResultView, { SubmissionMeta } from '../../components/ResultView';
import type { ChecklistItem, SectionMeta, SubmissionDetail as Sub } from '../../types';

interface Resp {
  submission: Sub;
  checklist: { id: number; name: string; items: ChecklistItem[] } | null;
  sections: SectionMeta;
}

export default function SubmissionDetail() {
  const { id } = useParams();
  const { user } = useAuth();
  const { message } = App.useApp();
  const [data, setData] = useState<Resp | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(
    () =>
      api
        .get<Resp>(`/api/submissions/${id}`)
        .then(setData)
        .catch((e) => setError(e.message)),
    [id],
  );
  useEffect(() => {
    setData(null);
    load();
  }, [load]);
  const status = data?.submission.status;
  useEffect(() => {
    if (status !== 'queued' && status !== 'running') return;
    const t = setInterval(load, 3000);
    return () => clearInterval(t);
  }, [status, load]);

  if (error) return <div className="page"><Result status="404" title={error} extra={<Link to="/courses">返回我的课程</Link>} /></div>;
  if (!data) return <div className="page" style={{ textAlign: 'center', paddingTop: 80 }}><Spin /></div>;
  const s = data.submission;
  const isOther = s.user_id !== user?.id;

  const recheck = async () => {
    try {
      await api.post(`/api/submissions/${s.id}/recheck`);
      message.success('已重新加入检查队列');
      load();
    } catch (e) {
      message.error((e as Error).message);
    }
  };

  return (
    <div className="page">
      <Breadcrumb
        className="no-print"
        style={{ marginBottom: 12 }}
        items={[
          isOther ? { title: <Link to="/admin/records">文件与检查记录</Link> } : { title: <Link to="/courses">我的课程</Link> },
          { title: isOther ? s.course.name : <Link to={`/courses/${s.course_id}`}>{s.course.name}</Link> },
          { title: `第${s.seq}次检查` },
        ]}
      />
      <div className="page-head">
        <div>
          <h1>《{s.course.name}》第{s.seq}次检查</h1>
          <div className="sub">
            {isOther && `提交人：${s.owner?.name}（${s.owner?.username}）　`}检查清单：{data.checklist?.name ?? '—'}
          </div>
        </div>
      </div>
      <Space orientation="vertical" size={16} style={{ width: '100%' }}>
        <Card className="no-print">
          <SubmissionMeta sub={s} />
        </Card>
        {s.status === 'queued' && (
          <Card>
            <Result
              icon={<Spin size="large" />}
              title="排队等待检查"
              subTitle={`前方还有 ${Math.max(0, (s.queuePosition ?? 1) - 1)} 份大纲，页面会自动刷新。可以离开本页，稍后在“我的课程”中查看结果。`}
            />
          </Card>
        )}
        {s.status === 'running' && (
          <Card>
            <Result icon={<Spin size="large" />} title="AI 正在检查" subTitle="通常需要 1–5 分钟，页面会自动刷新。可以离开本页，稍后在“我的课程”中查看结果。" />
          </Card>
        )}
        {s.status === 'failed' && (
          <Card>
            <Alert
              type="warning"
              showIcon
              title="本次检查未能完成"
              description={<>原因：{s.error || '未知错误'}。上传的文件已保存，可直接重新检查；如多次失败，请联系管理员检查 AI 配置。</>}
              action={
                <Button icon={<ReloadOutlined />} onClick={recheck}>
                  重新检查
                </Button>
              }
            />
          </Card>
        )}
        {s.status === 'done' && s.result && data.checklist && <ResultView sub={s} items={data.checklist.items} sections={data.sections} />}
      </Space>
    </div>
  );
}
