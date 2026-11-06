import { App, Breadcrumb, Button, Card, Descriptions, Form, Modal, Space } from 'antd';
import Table from '../../components/ResponsiveTable';
import { EditOutlined } from '@ant-design/icons';
import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api, download } from '../../api';
import CourseFields from '../../components/CourseFields';
import { ConfirmationTag, SubmissionTag } from '../../components/StatusTag';
import { useAuth } from '../../auth';
import type { Options, SubStatus } from '../../types';

interface Course {
  id: number;
  user_id: number;
  name: string;
  major: string;
  training_type: string;
  student_grade: number;
  plan_grade: number;
  adjust_note: string;
  created_at: string;
}
interface Sub {
  id: number;
  seq: number;
  file_name: string;
  file_size: number;
  status: SubStatus;
  verdict: 'passed' | 'failed' | null;
  error: string | null;
  created_at: string;
  finished_at: string | null;
  confirmed_at: string | null;
}

export const fmtSize = (n: number) => (n > 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.ceil(n / 1024)} KB`);

export default function CourseDetail() {
  const { id } = useParams();
  const nav = useNavigate();
  const { user } = useAuth();
  const { message } = App.useApp();
  const [data, setData] = useState<{ course: Course; submissions: Sub[]; plan: { name: string } | null } | null>(null);
  const [editing, setEditing] = useState(false);
  const [options, setOptions] = useState<Options | null>(null);
  const [form] = Form.useForm();

  const load = useCallback(() => api.get<typeof data>(`/api/courses/${id}`).then(setData).catch((e) => message.error(e.message)), [id, message]);
  useEffect(() => {
    load();
  }, [load]);
  useEffect(() => {
    if (!data?.submissions.some((s) => s.status === 'queued' || s.status === 'running')) return;
    const t = setInterval(load, 4000);
    return () => clearInterval(t);
  }, [data, load]);

  if (!data) return <div className="page" />;
  const c = data.course;
  const own = c.user_id === user?.id;

  const openEdit = async () => {
    if (!options) setOptions(await api.get<Options>('/api/options'));
    form.setFieldsValue({
      name: c.name,
      major: c.major,
      trainingType: c.training_type,
      studentGrade: c.student_grade,
      planGrade: c.plan_grade,
      adjustNote: c.adjust_note,
    });
    setEditing(true);
  };

  const save = async () => {
    const v = await form.validateFields();
    try {
      await api.put(`/api/courses/${c.id}`, v);
      message.success('课程信息已保存，不影响已有检查结果');
      setEditing(false);
      load();
    } catch (e) {
      message.error((e as Error).message);
    }
  };

  return (
    <div className="page">
      <Breadcrumb style={{ marginBottom: 12 }} items={[{ title: <Link to="/courses">我的课程</Link> }, { title: c.name }]} />
      <div className="page-head">
        <div>
          <h1>{c.name}</h1>
          <div className="sub">
            {c.major} · {c.training_type} · {c.student_grade}级
          </div>
        </div>
        {own && (
          <Space>
            <Button icon={<EditOutlined />} onClick={openEdit}>
              修改课程信息
            </Button>
          </Space>
        )}
      </div>
      <Space orientation="vertical" size={16} style={{ width: '100%' }}>
        <Card title="课程信息">
          <Descriptions size="small" column={{ xs: 1, sm: 2, lg: 3 }}>
            <Descriptions.Item label="专业">{c.major}</Descriptions.Item>
            <Descriptions.Item label="培养类型">{c.training_type}</Descriptions.Item>
            <Descriptions.Item label="学生年级">{c.student_grade}级</Descriptions.Item>
            <Descriptions.Item label="对照方案">
              {data.plan?.name ?? `${c.plan_grade}级${c.major}（${c.training_type}）人才培养方案（未预置）`}
            </Descriptions.Item>
            {c.adjust_note && <Descriptions.Item label="调整说明">{c.adjust_note}</Descriptions.Item>}
          </Descriptions>
        </Card>
        <Card title={`检查记录（${data.submissions.length}次）`} styles={{ body: { padding: 0 } }}>
          <Table
            rowKey="id"
            dataSource={data.submissions}
            pagination={false}
            columns={[
              { title: '次数', dataIndex: 'seq', width: 80, render: (v) => `第${v}次` },
              { title: '文件', dataIndex: 'file_name', render: (v, r) => <>{v} <span className="muted small">{fmtSize(r.file_size)}</span></> },
              { title: '结果', width: 120, render: (_, r) => <SubmissionTag status={r.status} verdict={r.verdict} /> },
              { title: '结果上传状态', width: 165, render: (_, r) => <><ConfirmationTag confirmedAt={r.confirmed_at} status={r.status} />{r.confirmed_at && <div className="muted small">{r.confirmed_at}</div>}</> },
              { title: '文件上传时间', dataIndex: 'created_at', width: 170 },
              {
                title: '操作',
                width: 190,
                render: (_, r) => (
                  <Space size={4}>
                    <Button size="small" type="link" onClick={() => nav(`/submissions/${r.id}`)}>
                      查看
                    </Button>
                    {r.status === 'done' && (
                      <Button size="small" type="primary" ghost onClick={() => download(`/api/submissions/${r.id}/report.docx`)}>
                        下载检查结果
                      </Button>
                    )}
                  </Space>
                ),
              },
            ]}
          />
        </Card>
      </Space>
      <Modal title="修改课程信息" open={editing} onOk={save} onCancel={() => setEditing(false)} okText="保存" destroyOnHidden width={640}>
        <div className="muted small" style={{ marginBottom: 12 }}>
          修改用于课程信息展示，已上传文件和检查记录保留上传时的课程信息。
        </div>
        <Form form={form} layout="vertical">
          <CourseFields options={options} />
        </Form>
      </Modal>
    </div>
  );
}
