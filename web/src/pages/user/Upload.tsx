import { Alert, App, Button, Card, Form, Segmented, Select, Upload as AntUpload } from 'antd';
import { InboxOutlined } from '@ant-design/icons';
import type { UploadFile } from 'antd';
import { useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { api, qs } from '../../api';
import CourseFields from '../../components/CourseFields';
import type { CourseRow, Options } from '../../types';

export default function Upload() {
  const [params] = useSearchParams();
  const nav = useNavigate();
  const { message } = App.useApp();
  const [form] = Form.useForm();
  const [options, setOptions] = useState<Options | null>(null);
  const [courses, setCourses] = useState<CourseRow[]>([]);
  const [mode, setMode] = useState<'new' | 'existing'>(params.get('courseId') ? 'existing' : 'new');
  const [courseId, setCourseId] = useState<number | undefined>(params.get('courseId') ? Number(params.get('courseId')) : undefined);
  const [files, setFiles] = useState<UploadFile[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [planName, setPlanName] = useState<string | null | undefined>(undefined);

  useEffect(() => {
    api.get<Options>('/api/options').then(setOptions);
    api.get<{ courses: CourseRow[] }>('/api/courses').then((r) => setCourses(r.courses));
  }, []);

  const major = Form.useWatch('major', form);
  const trainingType = Form.useWatch('trainingType', form);
  const planGrade = Form.useWatch('planGrade', form);
  const selected = courses.find((c) => c.id === courseId);

  // 根据专业、培养类型、对照方案年级查找预置的培养方案
  useEffect(() => {
    const q =
      mode === 'existing'
        ? selected && { major: selected.major, trainingType: selected.training_type, grade: selected.plan_grade }
        : major && trainingType && planGrade && { major, trainingType, grade: planGrade };
    if (!q) return setPlanName(undefined);
    const t = setTimeout(() => {
      api.get<{ plan: { name: string } | null }>(`/api/plan-match?${qs(q)}`).then((r) => setPlanName(r.plan?.name ?? null));
    }, 300);
    return () => clearTimeout(t);
  }, [mode, selected, major, trainingType, planGrade]);

  const submit = async () => {
    const values = mode === 'new' ? await form.validateFields() : {};
    if (mode === 'existing' && !courseId) return message.warning('请选择课程');
    const file = files[0]?.originFileObj;
    if (!file) return message.warning('请选择要上传的大纲文件');
    const fd = new FormData();
    if (mode === 'existing') fd.append('courseId', String(courseId));
    else Object.entries(values).forEach(([k, v]) => v !== undefined && v !== null && fd.append(k, String(v)));
    fd.append('file', file);
    setSubmitting(true);
    try {
      const r = await api.post<{ submissionId: number }>('/api/submissions', fd);
      message.success('上传成功，已开始检查');
      nav(`/submissions/${r.submissionId}`);
    } catch (e) {
      message.error((e as Error).message);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="page page-narrow">
      <div className="page-head">
        <div>
          <h1>上传检查</h1>
          <div className="sub">上传教学大纲，系统按检查清单进行 AI 检查并生成修改清单。每次上传独立检查，不与以往记录对比。</div>
        </div>
      </div>
      {options && !options.aiReady && (
        <Alert type="warning" showIcon style={{ marginBottom: 16 }} title="管理员尚未完成 AI 配置，暂时无法提交检查。" />
      )}
      <Card>
        <Segmented
          style={{ marginBottom: 20 }}
          value={mode}
          onChange={(v) => setMode(v as 'new' | 'existing')}
          options={[
            { value: 'new', label: '新课程' },
            { value: 'existing', label: '已有课程上传新版本', disabled: !courses.length },
          ]}
        />
        {mode === 'existing' ? (
          <Form layout="vertical">
            <Form.Item label="选择课程" required>
              <Select
                value={courseId}
                onChange={setCourseId}
                placeholder="请选择课程"
                showSearch={{ optionFilterProp: 'label' }}
                options={courses.map((c) => ({
                  value: c.id,
                  label: `${c.name}（${c.major}·${c.training_type}·${c.student_grade}级）`,
                }))}
              />
            </Form.Item>
            {selected && (
              <div className="muted small" style={{ marginTop: -12, marginBottom: 16 }}>
                对照方案：{selected.plan_grade}级{selected.major}（{selected.training_type}）　已检查 {selected.submission_count} 次。课程信息可在“我的课程”中修改。
              </div>
            )}
          </Form>
        ) : (
          <Form form={form} layout="vertical" initialValues={{ planGrade: 2025 }} requiredMark>
            <CourseFields options={options} />
          </Form>
        )}

        {planName !== undefined &&
          (planName ? (
            <Alert type="success" showIcon style={{ marginBottom: 16 }} title={`将对照：${planName}`} />
          ) : (
            <Alert
              type="warning"
              showIcon
              style={{ marginBottom: 16 }}
              title="未找到对应的预置培养方案"
              description="仍可提交检查：需要与培养方案比对的内容将列为“需核实事项”。如需完整对照，请联系管理员上传该专业的培养方案。"
            />
          ))}

        <Form layout="vertical">
          <Form.Item label="教学大纲文件" required extra={`支持 .docx、.pdf（可复制文字的版本），单个文件不超过 ${options?.maxUploadMB ?? 20}MB。旧版 .doc 请先另存为 .docx。`}>
            <AntUpload.Dragger
              accept=".docx,.pdf"
              maxCount={1}
              fileList={files}
              beforeUpload={() => false}
              onChange={({ fileList }) => setFiles(fileList.slice(-1))}
            >
              <p className="ant-upload-drag-icon">
                <InboxOutlined />
              </p>
              <p className="ant-upload-text">点击或拖拽文件到此处</p>
            </AntUpload.Dragger>
          </Form.Item>
        </Form>
        <Button type="primary" size="large" block loading={submitting} disabled={options ? !options.aiReady : true} onClick={submit}>
          提交检查
        </Button>
      </Card>
    </div>
  );
}
