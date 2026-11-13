import { Alert, App, Breadcrumb, Button, Card, Collapse, Popconfirm, Result, Space, Spin } from 'antd';
import { CheckOutlined, ReloadOutlined } from '@ant-design/icons';
import { useCallback, useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api } from '../../api';
import { useAuth } from '../../auth';
import ResultView, { SubmissionMeta } from '../../components/ResultView';
import SubmissionCourseEditor from '../../components/SubmissionCourseEditor';
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
  const [confirming, setConfirming] = useState(false);
  const [withdrawing, setWithdrawing] = useState(false);

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
    setError(null);
    load();
  }, [load]);
  const status = data?.submission.status;
  useEffect(() => {
    if (status !== 'queued' && status !== 'running') return;
    const t = setInterval(load, 3000);
    return () => clearInterval(t);
  }, [status, load]);

  if (error) return <div className="page"><Result status="404" title={error} extra={<Link to="/submissions">返回上传记录</Link>} /></div>;
  if (!data) return <div className="page" style={{ textAlign: 'center', paddingTop: 80 }}><Spin /></div>;
  const s = data.submission;
  const isOther = s.user_id !== user?.id;

  const confirm = async () => {
    setConfirming(true);
    try {
      await api.post(`/api/submissions/${s.id}/confirm`);
      await load();
      message.success(isOther ? '已最终确认，管理员端与个人总览已同步' : '已确认提交，管理员端与个人总览已同步');
    } catch (e) {
      message.error((e as Error).message);
    } finally {
      setConfirming(false);
    }
  };

  const withdraw = async () => {
    setWithdrawing(true);
    try {
      await api.post(`/api/submissions/${s.id}/withdraw`);
      await load();
      message.success('已撤回上传，本条记录恢复为未上传，原文件和检查结果保留');
    } catch (e) {
      message.error((e as Error).message);
    } finally {
      setWithdrawing(false);
    }
  };

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
          isOther ? { title: <Link to={user?.role === 'admin' ? '/admin/records?tab=submissions' : '/supervision'}>监督记录</Link> } : { title: <Link to="/submissions">上传记录</Link> },
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
        <SubmissionCourseEditor id={s.id} name={s.course.name} status={s.status} onSaved={load} />
      </div>
      <Space orientation="vertical" size={16} style={{ width: '100%' }}>
        <Collapse className="no-print" items={[{ key: 'meta', label: '查看课程与上传信息', children: <SubmissionMeta sub={s} /> }]} />
        <Collapse className="no-print" items={[{ key: 'original', label: '在线查看大纲原文（提取文本）', children: <><p className="muted small">以下为上传文件提取的原文，原始排版请下载原文件查看。</p><div className="prose">{s.extracted_text}</div></> }]} />
        {s.status === 'done' && (
          <Alert
            className="no-print"
            type={s.confirmed_at ? 'success' : 'info'}
            showIcon
            title={s.confirmed_at ? '检查结果已提交' : s.withdrawn_at ? '已撤回上传，当前状态：未上传' : '检查已完成，结果尚未提交'}
            description={s.confirmed_at ? `确认时间：${s.confirmed_at}${s.confirmed_by ? `；${s.confirmed_by}` : ''}` : s.withdrawn_at ? `撤回时间：${s.withdrawn_at}。原文件和检查结果保留，可再次确认提交；应交进度暂不计入已上传、通过和确认数量。` : s.canConfirm ? '查看结果后可确认提交，状态同步到管理员与个人总览；组长最终确认后无需教师再次确认。' : '等待上传者确认提交或本课程组长最终确认。'}
            action={<Space>
              {s.canConfirm && !s.confirmed_at && <Popconfirm title={isOther ? '最终确认本次检查结果？' : '确认提交本次检查结果？'} description="保存提交状态，不改变检查结论。" okText={isOther ? '最终确认' : '确认提交'} onConfirm={confirm} okButtonProps={{ loading: confirming }}>
                <Button type="primary" icon={<CheckOutlined />} loading={confirming}>{isOther ? '组长最终确认' : '确认提交'}</Button>
              </Popconfirm>}
              {!isOther && s.confirmed_at && <Popconfirm title="撤回上传？" description="本条记录恢复为未上传；若为课程最新结果，应交进度同步恢复未上传。原文件和检查结果保留，可再次确认提交。" okText="撤回上传" onConfirm={withdraw} okButtonProps={{ loading: withdrawing }}>
                <Button danger loading={withdrawing}>撤回上传</Button>
              </Popconfirm>}
            </Space>}
          />
        )}
        {s.status === 'queued' && (
          <Card>
            <Result
              icon={<Spin size="large" />}
              title="排队等待检查"
              subTitle={`前方还有 ${Math.max(0, (s.queuePosition ?? 1) - 1)} 份大纲，页面会自动刷新。可以离开本页，稍后在“上传记录”中查看结果。`}
            />
          </Card>
        )}
        {s.status === 'running' && (
          <Card>
            <Result icon={<Spin size="large" />} title="AI 正在检查" subTitle="通常需要 1–5 分钟，页面会自动刷新。可以离开本页，稍后在“上传记录”中查看结果。" />
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
                (!isOther || user?.role === 'admin') && <Button icon={<ReloadOutlined />} onClick={recheck}>
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
