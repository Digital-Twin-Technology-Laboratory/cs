import { App, Button, Card, Space, Upload } from 'antd';
import { DownloadOutlined, EyeOutlined, UploadOutlined } from '@ant-design/icons';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../../api';

export default function SyllabusTemplates() {
  const { message } = App.useApp();
  const [uploading, setUploading] = useState('');

  const upload = async (file: File, type: string) => {
    const body = new FormData();
    body.append('file', file);
    setUploading(type);
    try {
      await api.post(`/api/admin/${type}`, body);
      message.success('大纲文件已更换');
    } catch (e) {
      message.error((e as Error).message);
    } finally {
      setUploading('');
    }
  };

  return <div className="page page-narrow" style={{ marginLeft: 0 }}>
    <div className="page-head"><div><h1>大纲模板管理</h1>
      <div className="sub">分别管理上传页面提供的两个 Word 文件。更换后教师端立即使用新文件。</div>
    </div></div>
    <Card title="教务处大纲模板">
      <p>用于上传页面的“预览教学大纲模板”和“下载教务处大纲模板”。</p>
      <Space wrap>
        <Upload accept=".docx" showUploadList={false} beforeUpload={(file) => (upload(file, 'syllabus-template'), false)}>
          <Button icon={<UploadOutlined />} loading={uploading === 'syllabus-template'} disabled={!!uploading}>上传并更换</Button>
        </Upload>
        <Button icon={<EyeOutlined />} href="/api/syllabus-template/preview" target="_blank">预览当前模板</Button>
        <Button icon={<DownloadOutlined />} href="/api/syllabus-template.docx">下载当前模板</Button>
      </Space>
    </Card>
    <Card title="人工智能导论大纲" style={{ marginTop: 16 }}>
      <p>用于上传页面的“下载人工智能导论大纲”。</p>
      <Space wrap>
        <Upload accept=".docx" showUploadList={false} beforeUpload={(file) => (upload(file, 'ai-introduction-syllabus'), false)}>
          <Button icon={<UploadOutlined />} loading={uploading === 'ai-introduction-syllabus'} disabled={!!uploading}>上传并更换</Button>
        </Upload>
        <Button icon={<DownloadOutlined />} href="/api/ai-introduction-syllabus.docx">下载当前大纲</Button>
      </Space>
    </Card>
    <p className="muted small" style={{ marginTop: 16 }}>仅支持 .docx 文件。检查清单请在<Link to="/admin/checklists">检查清单管理</Link>中维护。</p>
  </div>;
}
