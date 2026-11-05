import { Alert, App, Button, Card, Col, Drawer, Form, Input, InputNumber, Modal, Popconfirm, Row, Select, Space, Switch, Table, Tag, Upload } from 'antd';
import { InboxOutlined, PlusOutlined } from '@ant-design/icons';
import type { UploadFile } from 'antd';
import { useCallback, useEffect, useState } from 'react';
import { api, download } from '../../api';

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

export default function Plans() {
  const { message } = App.useApp();
  const [rows, setRows] = useState<Row[]>([]);
  const [types, setTypes] = useState<string[]>([]);
  const [adding, setAdding] = useState(false);
  const [files, setFiles] = useState<UploadFile[]>([]);
  const [uploading, setUploading] = useState(false);
  const [editing, setEditing] = useState<number | null>(null);
  const [addForm] = Form.useForm();
  const [editForm] = Form.useForm();

  const load = useCallback(() => api.get<{ rows: Row[] }>('/api/admin/plans').then((r) => setRows(r.rows)), []);
  useEffect(() => {
    load();
    api.get<{ trainingTypes: string[] }>('/api/admin/site').then((s) => setTypes(s.trainingTypes));
  }, [load]);

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
          scroll={{ x: 1000 }}
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
              width: 220,
              render: (_, r) => (
                <Space size={0}>
                  <Button type="link" size="small" onClick={() => openEdit(r.id)}>
                    查看 / 修订
                  </Button>
                  {r.file_name && (
                    <Button type="link" size="small" onClick={() => download(`/api/admin/plans/${r.id}/file`)}>
                      原文件
                    </Button>
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
                    <Button type="link" size="small" danger>
                      删除
                    </Button>
                  </Popconfirm>
                </Space>
              ),
            },
          ]}
        />
      </Card>

      <Modal title="上传培养方案" open={adding} onOk={add} onCancel={() => setAdding(false)} okText="上传" confirmLoading={uploading} destroyOnHidden width={600}>
        <Form form={addForm} layout="vertical" initialValues={{ grade: 2025 }} preserve={false}>
          <Row gutter={16}>
            <Col span={24}>
              <Form.Item label="专业" name="major" rules={[{ required: true, message: '请填写专业全称' }]} extra="与教师上传时填写的专业名称一致才能自动匹配">
                <Input placeholder="如：计算机科学与技术" />
              </Form.Item>
            </Col>
            <Col xs={24} md={12}>
              <Form.Item label="培养类型" name="trainingType" rules={[{ required: true, message: '请选择' }]}>
                <Select options={typeOptions} />
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
          <Form.Item label="方案文件" required extra="支持 .docx、.pdf、.txt、.md">
            <Upload.Dragger accept=".docx,.pdf,.txt,.md" maxCount={1} fileList={files} beforeUpload={() => false} onChange={({ fileList }) => setFiles(fileList.slice(-1))}>
              <p className="ant-upload-drag-icon">
                <InboxOutlined />
              </p>
              <p className="ant-upload-text">点击或拖拽文件到此处</p>
            </Upload.Dragger>
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
                <Input />
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
            <Input.TextArea className="text-preview" autoSize={{ minRows: 20, maxRows: 40 }} />
          </Form.Item>
        </Form>
      </Drawer>
    </div>
  );
}
