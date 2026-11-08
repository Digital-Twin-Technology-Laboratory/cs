import { Alert, App, AutoComplete, Button, Card, Col, Form, Input, InputNumber, Row, Select, Space, Tag, Upload as AntUpload } from 'antd';
import Table from '../../components/ResponsiveTable';
import { DeleteOutlined, DownloadOutlined, InboxOutlined } from '@ant-design/icons';
import type { UploadFile } from 'antd';
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../../api';
import { useAuth } from '../../auth';
import type { CourseInfo, Options } from '../../types';

interface UploadValues {
  trainingType: string;
  planGrade: number;
  adjustNote?: string;
  outlines: Record<string, Pick<CourseInfo, 'name' | 'major' | 'studentGrade'> & { outlineRequirementId?: number }>;
}

interface UploadResult {
  submissionId?: number;
  error?: string;
}

export default function Upload() {
  const { message } = App.useApp();
  const { checkQuota, refresh } = useAuth();
  const [form] = Form.useForm<UploadValues>();
  const [options, setOptions] = useState<Options | null>(null);
  const [files, setFiles] = useState<UploadFile[]>([]);
  const [results, setResults] = useState<Record<string, UploadResult>>({});
  const [submitting, setSubmitting] = useState(false);
  const [activeUid, setActiveUid] = useState<string | null>(null);
  const planGrade = Form.useWatch('planGrade', form);
  const pendingCount = files.filter((file) => !results[file.uid]?.submissionId).length;

  useEffect(() => {
    api.get<Options>('/api/options').then((r) => {
      setOptions(r);
      form.setFieldValue('trainingType', r.trainingTypes[0]);
    }).catch((e) => message.error(e.message));
  }, [form, message]);

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
        const fields = { ...values.outlines[file.uid], trainingType: values.trainingType, planGrade: values.planGrade, adjustNote: values.adjustNote ?? '' };
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

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>上传检查</h1>
          <div className="sub">支持一次选择多个大纲，每个文件一行，分别选择年级和专业。检查完成后，请查看结果并确认上传。</div>
        </div>
        <Link to="/submissions"><Button>查看上传记录</Button></Link>
      </div>
      <Card title="上传前自查" extra={<Button icon={<DownloadOutlined />} href="/api/checklist.docx" disabled={!options?.checklist}>下载检查清单</Button>} style={{ marginBottom: 16 }}>
        <div className="prose">
          请先核对课程信息、课程目标与毕业要求的对应关系，以及教学内容、学时和考核比例是否一致。<br />
          同时自查课程支撑矩阵、实验安排、评分标准及审核材料；完整要求请下载清单，逐项自查后再上传。
        </div>
        {options && !options.checklist && <div className="muted small">管理员尚未设置生效的检查清单，请联系管理员。</div>}
      </Card>
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
          onFinish={submit}
        >
          <Row gutter={16}>
            <Col xs={24} md={12}>
              <Form.Item label="培养类型（应用于待上传大纲）" name="trainingType" rules={[{ required: true, message: '请选择培养类型' }]}>
                <Select options={(options?.trainingTypes ?? []).map((t) => ({ value: t, label: t }))} placeholder="请选择培养类型" />
              </Form.Item>
            </Col>
            <Col xs={24} md={12}>
              <Form.Item label="对照方案年级" name="planGrade" rules={[{ required: true, message: '请填写对照方案年级' }]} extra="本轮统一以2025级人才培养方案为对照起点，与学生年级分开选择">
                <InputNumber min={2000} max={new Date().getFullYear() + 5} suffix="级" style={{ width: '100%' }} />
              </Form.Item>
            </Col>
          </Row>
          {planGrade !== undefined && planGrade !== 2025 && (
            <Form.Item label="对照方案调整说明" name="adjustNote" rules={[{ required: true, whitespace: true, message: '对照方案年级不是2025级时，请说明原因' }]}>
              <Input.TextArea rows={2} maxLength={500} />
            </Form.Item>
          )}
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
                    <>
                      <Form.Item name={['outlines', file.uid, 'outlineRequirementId']} hidden preserve={false}><Input type="hidden" /></Form.Item>
                      <Form.Item name={['outlines', file.uid, 'name']} initialValue={file.name.replace(/\.[^.]+$/, '').slice(0, 100)} rules={[{ required: true, whitespace: true, message: '请填写课程名称' }]} style={{ marginBottom: 0 }} preserve={false}>
                        <AutoComplete options={(options?.outlineCourses ?? []).map((c) => ({
                          key: c.id, value: `${c.name}（${c.professional || '未配置专业'} / ${c.course_group || '未分组'}）`,
                          name: c.name, professional: c.professional, requirementId: c.id,
                        }))}
                          onChange={() => form.setFieldValue(['outlines', file.uid, 'outlineRequirementId'], undefined)}
                          onSelect={(_, option) => form.setFields([
                            { name: ['outlines', file.uid, 'name'], value: option.name },
                            { name: ['outlines', file.uid, 'major'], value: option.professional },
                            { name: ['outlines', file.uid, 'outlineRequirementId'], value: option.requirementId },
                          ])}
                          filterOption={(input, option) => String(option?.value).toLowerCase().includes(input.toLowerCase())} style={{ width: '100%' }} disabled={submitting || !!results[file.uid]?.submissionId}>
                          <Input maxLength={100} aria-label={`${file.name}的课程名称`} />
                        </AutoComplete>
                      </Form.Item>
                    </>
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
                  title: '专业', width: 210,
                  render: (_: unknown, file: UploadFile) => (
                    <Form.Item name={['outlines', file.uid, 'major']} rules={[{ required: true, message: '请选择专业' }]} style={{ marginBottom: 0 }} preserve={false}>
                      <Select placeholder="选择专业" disabled={submitting || !!results[file.uid]?.submissionId} aria-label={`${file.name}的专业`} onChange={() => form.setFieldValue(['outlines', file.uid, 'outlineRequirementId'], undefined)} options={(options?.majors ?? []).map((m) => ({ value: m, label: m }))} />
                    </Form.Item>
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
          {files.length > 0 && <p className="muted small">请从云清单下拉选择准确课程及课程组，系统会关联对应课程并填入审核专业；执笔人尚未指定也可上传，系统记录实际上传人并同步课程组进度。系统按每行专业匹配培养方案，未预置方案时仍可检查；名单外课程也可手工填写上传。</p>}
          <Button type="primary" size="large" htmlType="submit" loading={submitting} disabled={!options?.aiReady || !options.checklist || !pendingCount || checkQuota?.remaining === 0}>
            {files.length > 1 ? `提交检查（${pendingCount}份）` : '提交检查'}
          </Button>
        </Form>
      </Card>
    </div>
  );
}
