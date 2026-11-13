import { Alert, App, AutoComplete, Button, Card, Dropdown, Form, Input, Modal, Select, Space, Tag, Upload as AntUpload } from 'antd';
import Table from '../../components/ResponsiveTable';
import { DeleteOutlined, DownloadOutlined, EyeOutlined, InboxOutlined } from '@ant-design/icons';
import type { UploadFile } from 'antd';
import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, qs } from '../../api';
import { useAuth } from '../../auth';
import type { CourseInfo, Options } from '../../types';

interface UploadValues {
  planGrade: number;
  outlines: Record<string, Pick<CourseInfo, 'name' | 'major' | 'studentGrade'>>;
}

interface UploadResult {
  submissionId?: number;
  error?: string;
}

interface CourseIdentification {
  name: string | null;
  source: string | null;
  matched: boolean;
  candidates: string[];
}

interface IdentificationState {
  result?: CourseIdentification;
  error?: string;
}

function CourseName({ file, courseOptions, disabled, identification, onIdentified }: {
  file: UploadFile;
  courseOptions: { value: string }[];
  disabled: boolean;
  identification?: IdentificationState;
  onIdentified: (uid: string, state: IdentificationState) => void;
}) {
  const form = Form.useFormInstance<UploadValues>();
  useEffect(() => {
    let current = true;
    const fd = new FormData();
    fd.append('file', file.originFileObj!);
    api.post<CourseIdentification>('/api/submissions/identify-course', fd)
      .then((result) => {
        if (!current) return;
        if (result.name && !form.isFieldTouched(['outlines', file.uid, 'name'])) {
          form.setFieldValue(['outlines', file.uid, 'name'], result.name);
        }
        onIdentified(file.uid, { result });
      })
      .catch((e: Error) => { if (current) onIdentified(file.uid, { error: e.message }); });
    return () => { current = false; };
  }, [file.uid, file.originFileObj, form, onIdentified]);

  const result = identification?.result;
  const candidates = [...new Set([...(result?.candidates ?? []), ...courseOptions.map(({ value }) => value)])].map((value) => ({ value }));
  return <>
    <Form.Item name={['outlines', file.uid, 'name']} rules={[{ required: true, whitespace: true, message: '请填写或选择课程名称' }]} style={{ marginBottom: 4 }} preserve={false}>
      <AutoComplete options={candidates}
        filterOption={(input, option) => String(option?.value).toLowerCase().includes(input.toLowerCase())} style={{ width: '100%' }} disabled={disabled}>
        <Input maxLength={100} placeholder="自动识别后可修改或选择课程" aria-label={`${file.name}的课程名称`} />
      </AutoComplete>
    </Form.Item>
    <div className="small muted" role="status">
      {!identification ? '正在提取并匹配课程名称…'
        : identification.error ? `识别失败：${identification.error}；请手动填写课程名称。`
          : result?.name ? `${result.source}：${result.name}（${result.matched ? '已匹配课程清单' : '未在课程清单中找到，请核对'}）`
            : result?.candidates.length ? `识别到多个候选：${result.candidates.join('、')}，请选择。`
              : '未识别到课程名称，请手动填写或选择。'}
    </div>
  </>;
}

function MatchedPlan({ uid }: { uid: string }) {
  const form = Form.useFormInstance<UploadValues>();
  const major = Form.useWatch(['outlines', uid, 'major'], form);
  const grade = Form.useWatch('planGrade', form);
  const [plan, setPlan] = useState<{ id: number; name: string; downloadable: boolean } | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!major || !grade) return;
    let current = true;
    setLoading(true);
    setPlan(null);
    setError('');
    api.get<{ plan: typeof plan }>(`/api/plan-match?${qs({ major, grade, trainingType: major === '计算机科学与技术（专转本）' ? '专转本' : '普通本科' })}`)
      .then((result) => { if (current) setPlan(result.plan); })
      .catch((e) => { if (current) setError((e as Error).message); })
      .finally(() => { if (current) setLoading(false); });
    return () => { current = false; };
  }, [major, grade]);

  if (!major) return <span className="muted small">选择专业后自动匹配培养方案</span>;
  if (loading) return <span className="muted small">正在匹配培养方案…</span>;
  if (error) return <span className="small" style={{ color: '#cf1322' }}>匹配失败：{error}</span>;
  if (!plan) return <span className="small" style={{ color: '#ad6800' }}>未预置{grade}级{major}培养方案；仍可检查，方案比对项需核实。</span>;
  return <div className="small"><div>对应方案：{plan.name}</div>{plan.downloadable
    ? <Button type="link" size="small" icon={<DownloadOutlined />} href={`/api/plans/${plan.id}/file`}>下载对应培养方案</Button>
    : <span className="muted">方案原文件未上传</span>}{major === '公共' && <div className="muted">AI 将先从大纲中识别适用专业，再核对全校方案中对应专业的章节；无法确定时列为需核实。</div>}</div>;
}

export default function Upload() {
  const { message, modal } = App.useApp();
  const { checkQuota, refresh } = useAuth();
  const [form] = Form.useForm<UploadValues>();
  const [options, setOptions] = useState<Options | null>(null);
  const [files, setFiles] = useState<UploadFile[]>([]);
  const [results, setResults] = useState<Record<string, UploadResult>>({});
  const [identifications, setIdentifications] = useState<Record<string, IdentificationState>>({});
  const [submitting, setSubmitting] = useState(false);
  const [templatePreviewOpen, setTemplatePreviewOpen] = useState(false);
  const [activeUid, setActiveUid] = useState<string | null>(null);
  const planGrade = Form.useWatch('planGrade', form) ?? 2025;
  const pendingCount = files.filter((file) => !results[file.uid]?.submissionId).length;
  const identifying = files.some((file) => !results[file.uid]?.submissionId && !identifications[file.uid]);
  const downloadablePlans = (options?.plans ?? []).filter((plan) => plan.grade === planGrade && plan.downloadable);
  const courseOptions = [...new Map((options?.outlineCourses ?? []).map(({ name }) => [name.toLowerCase(), { value: name }])).values()];

  useEffect(() => {
    api.get<Options>('/api/options').then(setOptions).catch((e) => message.error(e.message));
  }, [message]);

  const onIdentified = useCallback((uid: string, state: IdentificationState) => {
    setIdentifications((prev) => ({ ...prev, [uid]: state }));
  }, []);

  const submit = async (values: UploadValues) => {
    const pending = files.filter((file) => !results[file.uid]?.submissionId);
    if (!pending.length) return message.warning('请先选择要上传的大纲文件');
    if (checkQuota && pending.length > checkQuota.remaining) {
      return message.warning(`今日还可提交 ${checkQuota.remaining} 份大纲，请减少文件数量后提交；次数不足请联系管理员。`);
    }
    setSubmitting(true);
    let succeeded = 0;
    try {
      for (const file of pending) {
        setActiveUid(file.uid);
        const fd = new FormData();
        const fields = { ...values.outlines[file.uid], planGrade: values.planGrade };
        Object.entries(fields).forEach(([key, value]) => { if (value !== undefined) fd.append(key, String(value)); });
        fd.append('file', file.originFileObj!);
        try {
          const r = await api.post<{ submissionId: number }>('/api/submissions', fd);
          setResults((prev) => ({ ...prev, [file.uid]: { submissionId: r.submissionId } }));
          succeeded++;
        } catch (e) {
          setResults((prev) => ({ ...prev, [file.uid]: { error: (e as Error).message } }));
        }
      }
      if (succeeded === pending.length) message.success(`${succeeded} 份大纲上传成功，已加入检查队列`);
      else message.warning(`${succeeded} 份上传成功，${pending.length - succeeded} 份失败，请查看对应行的原因后重试`);
    } finally {
      setSubmitting(false);
      setActiveUid(null);
      await refresh().catch((e) => message.error(e.message));
    }
  };

  const confirmSubmit = (values: UploadValues) => {
    if (identifying) return message.warning('正在识别课程名称，请稍候');
    modal.confirm({
      title: '确认课程名称并提交检查',
      width: 760,
      okText: '确认并提交检查',
      cancelText: '返回修改',
      content: <>
        <p>请核对每个文件对应的课程名称。如不准确，请返回修改；确认后才会保存上传记录并加入检查队列。</p>
        <div style={{ maxHeight: '50vh', overflowY: 'auto' }}>
          {files.filter((file) => !results[file.uid]?.submissionId).map((file) => (
            <div key={file.uid} style={{ padding: '12px 0', borderBottom: '1px solid #f0f0f0', overflowWrap: 'anywhere' }}>
              <div className="muted small">文件：{file.name}</div>
              <div>课程名称：<strong>{values.outlines[file.uid].name}</strong></div>
            </div>
          ))}
        </div>
      </>,
      onOk: () => submit(values),
    });
  };

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>上传检查</h1>
          <div className="sub">支持一次选择多个大纲，自动提取并匹配课程名称，提交检查前请确认；年级和专业分别选择。检查完成后，请查看结果并确认提交。</div>
        </div>
        <Link to="/submissions"><Button>查看上传记录</Button></Link>
      </div>
      <Card title="上传前自查" style={{ marginBottom: 16 }}>
        <Space wrap style={{ marginBottom: 12 }}>
          <Button icon={<EyeOutlined />} onClick={() => setTemplatePreviewOpen(true)}>预览教学大纲模板</Button>
          <Button icon={<DownloadOutlined />} href="/api/syllabus-template.docx">下载教学大纲模板</Button>
          <Button icon={<DownloadOutlined />} href="/api/checklist.docx" disabled={!options?.checklist}>下载检查清单</Button>
        </Space>
        <div className="prose">
          请先核对课程信息、课程目标与毕业要求的对应关系，以及教学内容、学时和考核比例是否一致。<br />
          同时自查大纲中的课程支撑矩阵、实验安排、评分标准及审核信息；可下载教学大纲模板，完整要求请下载清单，逐项自查后再上传。
        </div>
        {options && !options.checklist && <div className="muted small">管理员尚未设置生效的检查清单，请联系管理员。</div>}
      </Card>
      <Modal title="教学大纲模板预览" open={templatePreviewOpen} width={1100} destroyOnHidden onCancel={() => setTemplatePreviewOpen(false)}
        footer={<Space wrap>
          <Button icon={<DownloadOutlined />} href="/api/syllabus-template.docx">下载 Word 原文件</Button>
          <Button onClick={() => setTemplatePreviewOpen(false)}>关闭</Button>
        </Space>}>
        <p className="muted small">在线预览展示模板正文和表格，字体、页边距及分页请以下载的 Word 原文件为准。</p>
        <iframe title="教学大纲模板内容" src="/api/syllabus-template/preview" sandbox=""
          style={{ width: '100%', height: '65vh', border: '1px solid #d9d9d9', borderRadius: 4 }} />
      </Modal>
      {options && !options.aiReady && <Alert type="warning" showIcon style={{ marginBottom: 16 }} title="管理员尚未完成 AI 配置，暂时无法提交检查。" />}
      {checkQuota?.remaining === 0 && (
        <Alert type="warning" showIcon style={{ marginBottom: 16 }}
          title={checkQuota.used >= checkQuota.limit ? '今日检查次数已用完，请联系管理员。' : '可用名额已被排队或检查中的任务占用，请等待任务完成或联系管理员。'}
          description={`今日额度共 ${checkQuota.limit} 次，含管理员追加 ${checkQuota.bonus} 次。发现问题也计次，检查失败不计次；次日零点恢复基础 5 次。`} />
      )}
      <Card>
        <Form
          form={form}
          layout="vertical"
          disabled={submitting}
          initialValues={{ planGrade: 2025 }}
          onFinish={confirmSubmit}
        >
          <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'space-between', columnGap: 16 }}>
            <Form.Item label="人才培养方案年级（应用于待上传大纲）" name="planGrade" rules={[{ required: true, message: '请选择人才培养方案年级' }]}
              extra="默认使用2025级人才培养方案，与下方学生年级分开选择。" style={{ width: '100%', maxWidth: 480 }}>
              <Select aria-label="人才培养方案年级" options={(options?.studentGrades ?? []).map((year) => ({ value: year, label: `${year}级` }))} />
            </Form.Item>
            <Dropdown trigger={['click']} disabled={!downloadablePlans.length} menu={{
              items: downloadablePlans.map((plan) => ({ key: plan.id, label: <a href={`/api/plans/${plan.id}/file`}>{plan.name}</a> })),
            }}>
              <Button icon={<DownloadOutlined />} disabled={!downloadablePlans.length} style={{ marginBottom: 24 }}
                title={!downloadablePlans.length ? `管理员尚未上传可下载的${planGrade}级人才培养方案` : '选择专业对应的培养方案'}>
                下载{String(planGrade).slice(-2)}级人才培养方案
              </Button>
            </Dropdown>
          </div>
          <Form.Item label="教学大纲文件" required extra={`支持 .docx、.pdf，单个文件不超过 ${options?.maxUploadMB ?? 20}MB。每次上传独立检查，不与以往记录对比。`}>
            <AntUpload.Dragger
              accept=".docx,.pdf"
              multiple
              disabled={submitting}
              fileList={files}
              showUploadList={false}
              beforeUpload={(file) => {
                if (!/\.(docx|pdf)$/i.test(file.name)) {
                  message.error(`${file.name}：只支持 .docx、.pdf 文件`);
                  return AntUpload.LIST_IGNORE;
                }
                if (file.size > (options?.maxUploadMB ?? 20) * 1024 * 1024) {
                  message.error(`${file.name}：文件超过大小上限`);
                  return AntUpload.LIST_IGNORE;
                }
                return false;
              }}
              onChange={({ fileList }) => setFiles(fileList)}
            >
              <p className="ant-upload-drag-icon"><InboxOutlined /></p>
              <p className="ant-upload-text">点击或拖拽多个大纲文件到此处</p>
            </AntUpload.Dragger>
          </Form.Item>
          {files.length > 0 && (
            <Table<UploadFile>
              rowKey="uid"
              dataSource={files}
              pagination={false}
              style={{ marginBottom: 20 }}
              columns={[
                { title: '大纲文件', dataIndex: 'name', width: 200, render: (name) => <span style={{ overflowWrap: 'anywhere' }}>{name}</span> },
                {
                  title: '课程名称', width: 210,
                  render: (_: unknown, file: UploadFile) => (
                    <CourseName file={file} courseOptions={courseOptions} disabled={submitting || !!results[file.uid]?.submissionId}
                      identification={identifications[file.uid]} onIdentified={onIdentified} />
                  ),
                },
                {
                  title: '年级', width: 120,
                  render: (_: unknown, file: UploadFile) => (
                    <Form.Item name={['outlines', file.uid, 'studentGrade']} rules={[{ required: true, message: '请选择年级' }]} style={{ marginBottom: 0 }} preserve={false}>
                      <Select placeholder="选择年级" disabled={submitting || !!results[file.uid]?.submissionId} aria-label={`${file.name}的年级`} options={(options?.studentGrades ?? []).map((y) => ({ value: y, label: `${String(y).slice(-2)}级` }))} />
                    </Form.Item>
                  ),
                },
                {
                  title: '专业', width: 260,
                  render: (_: unknown, file: UploadFile) => (
                    <>
                      <Form.Item name={['outlines', file.uid, 'major']} rules={[{ required: true, message: '请选择专业' }]} style={{ marginBottom: 6 }} preserve={false}>
                        <Select placeholder="选择专业" disabled={submitting || !!results[file.uid]?.submissionId} aria-label={`${file.name}的专业`} options={(options?.majors ?? []).map((m) => ({ value: m, label: m }))} />
                      </Form.Item>
                      <MatchedPlan uid={file.uid} />
                    </>
                  ),
                },
                {
                  title: '上传状态', width: 190,
                  render: (_, file) => {
                    const r = results[file.uid];
                    if (r?.submissionId) return <Space orientation="vertical" size={2}><Tag color="green">已上传，已加入检查队列</Tag><Link to={`/submissions/${r.submissionId}`}>查看检查结果</Link></Space>;
                    if (activeUid === file.uid) return <Tag color="processing">上传中</Tag>;
                    if (r?.error) return <span style={{ color: '#cf1322', overflowWrap: 'anywhere' }}>{r.error}</span>;
                    return <Tag>待上传</Tag>;
                  },
                },
                {
                  title: '操作', width: 80,
                  render: (_, file) => <Button type="text" danger icon={<DeleteOutlined />} aria-label={`移除${file.name}`} disabled={submitting || !!results[file.uid]?.submissionId} onClick={() => setFiles((prev) => prev.filter((f) => f.uid !== file.uid))} />,
                },
              ]}
            />
          )}
          {files.length > 0 && <p className="muted small">云清单仅用于总览展示和进度统计，不限制上传账号、课程或执笔人。课程下拉只选择课程名称，不自动填写专业；请按实际授课对象手动选择专业。公共课程请选择“公共”，AI 根据大纲的适用专业定位全校培养方案中相应章节，不会根据课程名称猜测专业。匹配明确时自动关联应交任务，无法明确关联时仍可上传并保留检查记录，不误计入其他任务的进度。系统按每行专业匹配培养方案，未预置方案时仍可检查，方案比对项列为需核实。</p>}
          <Button type="primary" size="large" htmlType="submit" loading={submitting} disabled={!options?.aiReady || !options.checklist || !pendingCount || identifying || checkQuota?.remaining === 0}>
            {identifying ? '正在识别课程名称…' : files.length > 1 ? `提交检查（${pendingCount}份）` : '提交检查'}
          </Button>
        </Form>
      </Card>
    </div>
  );
}
