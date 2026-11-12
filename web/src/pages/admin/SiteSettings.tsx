import { App, Button, Card, Form, Input, InputNumber, Radio, Select } from 'antd';
import { DownloadOutlined } from '@ant-design/icons';
import { useEffect } from 'react';
import { api } from '../../api';
import { useAuth } from '../../auth';

export default function SiteSettings() {
  const { message } = App.useApp();
  const { refresh } = useAuth();
  const [form] = Form.useForm();

  useEffect(() => {
    api.get('/api/admin/site').then((s) => form.setFieldsValue(s));
  }, [form]);

  const save = async () => {
    const v = await form.validateFields();
    try {
      await api.put('/api/admin/site', v);
      message.success('设置已保存');
      refresh();
    } catch (e) {
      message.error((e as Error).message);
    }
  };

  return (
    <div className="page page-narrow" style={{ marginLeft: 0 }}>
      <div className="page-head">
        <h1>系统设置</h1>
        <Button type="primary" onClick={save}>
          保存
        </Button>
      </div>
      <Card>
        <Form form={form} layout="vertical">
          <Form.Item label="网站名称" name="siteName" rules={[{ required: true, message: '请填写网站名称' }]}>
            <Input maxLength={100} />
          </Form.Item>
          <Form.Item label="注册设置" name="registrationMode">
            <Radio.Group
              style={{ display: 'flex', flexDirection: 'column', gap: 8 }}
              options={[
                { value: 'open', label: '开放注册：注册后即可使用' },
                { value: 'approval', label: '注册需审核：注册后由管理员在“用户管理”中审核通过' },
                { value: 'closed', label: '关闭注册：只能由管理员新建账号' },
              ]}
            />
          </Form.Item>
          <Form.Item label="培养类型" name="trainingTypes" extra="上传大纲和培养方案时可选的培养类型，输入后回车添加" rules={[{ required: true, message: '至少保留一个培养类型' }]}>
            <Select mode="tags" tokenSeparators={[',', '，']} />
          </Form.Item>
          <Form.Item label="单个文件大小上限" name="maxUploadMB" extra="用于防止误传过大的文件，不是使用额度">
            <InputNumber min={1} max={200} suffix="MB" style={{ width: 160 }} />
          </Form.Item>
        </Form>
      </Card>
      <Card title="数据备份" style={{ marginTop: 16 }}>
        <p>下载完整备份，包含账号与检查记录、上传原文件、培养方案和加密密钥。</p>
        <Button icon={<DownloadOutlined />} href="/api/admin/backup">下载备份</Button>
        <p className="muted small">生成备份需要一些时间，请等待浏览器开始下载。备份含敏感数据，请妥善保管并另存到其他设备。</p>
      </Card>
    </div>
  );
}
