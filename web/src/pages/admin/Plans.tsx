import { Alert, App, Button, Card, Col, Drawer, Form, Input, InputNumber, Modal, Popconfirm, Row, Select, Space, Switch, Tag, Upload } from 'antd';
import Table from '../../components/ResponsiveTable';
import { InboxOutlined, PlusOutlined } from '@ant-design/icons';
import type { UploadFile } from 'antd';
import { useCallback, useEffect, useRef, useState } from 'react';
import { api, download } from '../../api';
import type { Options } from '../../types';

interface Row {
  id: number;
  major: string;
  training_type: string;
  grade: number;
  name: string;
  file_name: string | null;
  enabled: number;
  text_length: number;
  usage_count: number;
  updated_at: string;
}

interface Identification {
  major: string | null;
  trainingType: string | null;
  ambiguous: boolean;
  evidence: string[];
}

export default function Plans() {
  const { message } = App.useApp();
  const [rows, setRows] = useState<Row[]>([]);
  const [types, setTypes] = useState<string[]>([]);
  const [majors, setMajors] = useState<string[]>([]);
  const [adding, setAdding] = useState(false);
  const [files, setFiles] = useState<UploadFile[]>([]);
  const [uploading, setUploading] = useState(false);
  const [identifying, setIdentifying] = useState(false);
  const [identification, setIdentification] = useState<Identification | null>(null);
  const [identifyError, setIdentifyError] = useState('');
  const identifyRequest = useRef(0);
  const [editing, setEditing] = useState<number | null>(null);
  const [reextracting, setReextracting] = useState<number | null>(null);
  const [addForm] = Form.useForm();
  const [editForm] = Form.useForm();

  const load = useCallback(() => api.get<{ rows: Row[] }>('/api/admin/plans').then((r) => setRows(r.rows)), []);
  useEffect(() => {
    load();
    api.get<Options>('/api/options').then((s) => { setTypes(s.trainingTypes); setMajors(s.majors); });
  }, [load]);

  const identify = async (fileList: UploadFile[]) => {
    const request = ++identifyRequest.current;
    setFiles(fileList.slice(-1));
    setIdentification(null);
    setIdentifyError('');
    addForm.setFieldsValue({ major: undefined, trainingType: undefined });
    const file = fileList.at(-1)?.originFileObj;
    if (!file) { setIdentifying(false); return; }
    const fd = new FormData();
    fd.append('file', file);
    setIdentifying(true);
    try {
      const result = await api.post<Identification>('/api/admin/plans/identify', fd);
      if (request !== identifyRequest.current) return;
      setIdentification(result);
      addForm.setFieldsValue({ major: result.major ?? undefined, trainingType: result.trainingType ?? undefined });
    } catch (e) {
      if (request === identifyRequest.current) setIdentifyError((e as Error).message);
    } finally {
      if (request === identifyRequest.current) setIdentifying(false);
    }
  };

  const add = async () => {
    const v = await addForm.validateFields();
    const file = files[0]?.originFileObj;
    if (!file) return message.warning('请选择培养方案文件');
    const fd = new FormData();
    Object.entries(v).forEach(([k, val]) => val !== undefined && fd.append(k, String(val)));
    fd.append('file', file);
    setUploading(true);
    try {
      await api.post('/api/admin/plans', fd);
      message.success('培养方案已上传并提取文本');
      setAdding(false);
      setFiles([]);
      setIdentification(null);
      addForm.resetFields();
      load();
    } catch (e) {
      message.error((e as Error).message);
    } finally {
      setUploading(false);
    }
  };

  const openEdit = async (id: number) => {
    const { plan } = await api.get<{ plan: Row & { extracted_text: string } }>(`/api/admin/plans/${id}`);
    editForm.setFieldsValue({
      major: plan.major,
      trainingType: plan.training_type,
      grade: plan.grade,
      name: plan.name,
      enabled: !!plan.enabled,
      extractedText: plan.extracted_text,
    });
    setEditing(id);
  };

  const saveEdit = async () => {
    const v = await editForm.validateFields();
    try {
      await api.put(`/api/admin/plans/${editing}`, v);
      message.success('已保存');
      setEditing(null);
      load();
    } catch (e) {
      message.error((e as Error).message);
    }
  };

  const reextract = async (id: number) => {
    setReextracting(id);
    try {
      await api.post(`/api/admin/plans/${id}/reextract`);
      await load();
      message.success('已从原文件重新提取并保存方案文本，已有检查结果未变更');
    } catch (e) {
      message.error((e as Error).message);
    } finally {
      setReextracting(null);
    }
  };

  const typeOptions = types.map((t) => ({ value: t, label: t }));
  const textLen = Form.useWatch('extractedText', editForm)?.length ?? 0;

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>培养方案管理</h1>
          <div className="sub">按专业、培养类型、年级预置人才培养方案。用户上传大纲时，系统按课程的专业、培养类型和对照方案年级自动带入对照。</div>
        </div>
        <Button type="primary" icon={<PlusOutlined />} onClick={() => setAdding(true)}>
          上传培养方案
        </Button>
      </div>
      <Card styles={{ body: { padding: 0 } }}>
        <Table
          rowKey="id"
          dataSource={rows}
          pagination={false}
          columns={[
            { title: '专业', dataIndex: 'major' },
            { title: '培养类型', dataIndex: 'training_type', width: 100 },
            { title: '年级', dataIndex: 'grade', width: 80, render: (v) => `${v}级` },
            { title: '方案名称', dataIndex: 'name' },
            { title: '文本字数', dataIndex: 'text_length', width: 100, render: (v) => v.toLocaleString() },
            { title: '已用于检查', dataIndex: 'usage_count', width: 100, render: (v) => `${v} 次` },
            { title: '状态', dataIndex: 'enabled', width: 80, render: (v) => (v ? <Tag color="green">启用</Tag> : <Tag>停用</Tag>) },
            {
              title: '操作',
              width: 300,
              render: (_, r) => (
                <Space size={0}>
                  <Button type="link" size="small" disabled={reextracting === r.id} onClick={() => openEdit(r.id)}>
                    查看 / 修订
                  </Button>
                  {r.file_name && (
                    <>
                      <Button type="link" size="small" onClick={() => download(`/api/admin/plans/${r.id}/file`)}>
                        原文件
                      </Button>
                      <Popconfirm
                        title="从原文件重新提取方案文本？"
                        description="将覆盖已保存的文本（含人工修订）。原文件、方案信息及已有检查结果保持不变。"
                        okText="确认覆盖并重新提取"
                        cancelText="取消"
                        onConfirm={() => reextract(r.id)}
                      >
                        <Button type="link" size="small" loading={reextracting === r.id} disabled={reextracting !== null}>
                          重新提取
                        </Button>
                      </Popconfirm>
                    </>
                  )}
                  <Popconfirm
                    title="删除该培养方案？"
                    okButtonProps={{ danger: true }}
                    onConfirm={() =>
                      api
                        .del(`/api/admin/plans/${r.id}`)
                        .then(() => (message.success('已删除'), load()))
                        .catch((e) => message.error(e.message))
                    }
                  >
                    <Button type="link" size="small" danger disabled={reextracting === r.id}>
                      删除
                    </Button>
                  </Popconfirm>
                </Space>
              ),
            },
          ]}
        />
      </Card>

      <Modal title="上传培养方案" open={adding} onOk={add} onCancel={() => { identifyRequest.current++; setIdentifying(false); setAdding(false); setFiles([]); setIdentification(null); setIdentifyError(''); }} okText="上传" confirmLoading={uploading} okButtonProps={{ disabled: identifying }} cancelButtonProps={{ disabled: uploading }} closable={!uploading} destroyOnHidden width={600}>
        <Form form={addForm} layout="vertical" initialValues={{ grade: 2025 }} preserve={false} disabled={uploading}>
          <Form.Item label="方案文件" required extra="支持 .docx、.pdf、.txt、.md；选择后按文件名或正文标题自动识别专业，可手动修正。">
            <Upload.Dragger accept=".docx,.pdf,.txt,.md" maxCount={1} fileList={files} beforeUpload={() => false} onChange={({ fileList }) => identify(fileList)}>
              <p className="ant-upload-drag-icon"><InboxOutlined /></p>
              <p className="ant-upload-text">点击或拖拽文件到此处</p>
            </Upload.Dragger>
          </Form.Item>
          {identifying && <Alert type="info" showIcon title="正在识别方案专业…" style={{ marginBottom: 16 }} />}
          {identifyError && <Alert type="error" showIcon title="专业识别失败，请手动选择或重新选择文件" description={identifyError} style={{ marginBottom: 16 }} />}
          {identification && <Alert type={identification.major ? 'success' : 'warning'} showIcon
            title={identification.major ? `已识别专业：${identification.major}（可在下方修正）` : identification.ambiguous ? '专业证据存在歧义，请手动选择专业与培养类型' : '未识别到明确专业，请手动选择专业与培养类型'}
            description={identification.evidence.map((line) => <div key={line}>{line}</div>)} style={{ marginBottom: 16 }} />}
          <Row gutter={16}>
            <Col span={24}>
              <Form.Item label="专业" name="major" rules={[{ required: true, message: '请选择专业' }]} extra="专业、培养类型及年级相符时自动用于对应大纲检查">
                <Select showSearch options={majors.map((major) => ({ value: major, label: major }))} placeholder="请选择专业" disabled={identifying || uploading}
                  onChange={(major) => addForm.setFieldValue('trainingType', major === '计算机科学与技术（专转本）' ? '专转本' : '普通本科')} />
              </Form.Item>
            </Col>
            <Col xs={24} md={12}>
              <Form.Item label="培养类型" name="trainingType" rules={[{ required: true, message: '请选择' }]}>
                <Select options={typeOptions} disabled={identifying || uploading} />
              </Form.Item>
            </Col>
            <Col xs={24} md={12}>
              <Form.Item label="年级" name="grade" rules={[{ required: true }]}>
                <InputNumber min={2000} max={2100} suffix="级" style={{ width: '100%' }} />
              </Form.Item>
            </Col>
          </Row>
          <Form.Item label="方案名称" name="name" extra="留空则自动生成，如“2025级计算机科学与技术（普通本科）人才培养方案”">
            <Input />
          </Form.Item>
        </Form>
      </Modal>

      <Drawer
        title="查看 / 修订培养方案"
        open={editing !== null}
        onClose={() => setEditing(null)}
        size="large"
        extra={
          <Button type="primary" onClick={saveEdit}>
            保存
          </Button>
        }
      >
        <Form form={editForm} layout="vertical">
          <Row gutter={16}>
            <Col xs={24} md={12}>
              <Form.Item label="专业" name="major" rules={[{ required: true }]}>
                <Select showSearch options={[...new Set([...majors, ...rows.map((row) => row.major)])].map((major) => ({ value: major, label: major }))}
                  onChange={(major) => editForm.setFieldValue('trainingType', major === '计算机科学与技术（专转本）' ? '专转本' : '普通本科')} />
              </Form.Item>
            </Col>
            <Col xs={12} md={6}>
              <Form.Item label="培养类型" name="trainingType" rules={[{ required: true }]}>
                <Select options={typeOptions} />
              </Form.Item>
            </Col>
            <Col xs={12} md={6}>
              <Form.Item label="年级" name="grade" rules={[{ required: true }]}>
                <InputNumber min={2000} max={2100} style={{ width: '100%' }} />
              </Form.Item>
            </Col>
          </Row>
          <Form.Item label="方案名称" name="name">
            <Input />
          </Form.Item>
          <Form.Item label="启用" name="enabled" valuePropName="checked">
            <Switch />
          </Form.Item>
          <Alert
            type="info"
            showIcon
            style={{ marginBottom: 12 }}
            title="下方为从文件提取的文本，AI 检查时会使用这段文本。可删除与大纲检查无关的章节（如培养目标说明、学分统计表等），保留毕业要求指标全文、课程设置表和课程与毕业要求支撑矩阵。"
          />
          <Form.Item label={`方案文本（${textLen.toLocaleString()} 字）`} name="extractedText" rules={[{ required: true, message: '方案文本不能为空' }]}>
            <Input.TextArea className="text-preview" autoSize={{ minRows: 20 }} />
          </Form.Item>
        </Form>
      </Drawer>
    </div>
  );
}
