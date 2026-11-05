import { App, Button, Card, Popconfirm, Space, Table, Tag, Upload } from 'antd';
import { PlusOutlined, UploadOutlined } from '@ant-design/icons';
import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../../api';

interface Row {
  id: number;
  name: string;
  is_active: number;
  item_count: number;
  usage_count: number;
  created_at: string;
  updated_at: string;
}

export const DRAFT_KEY = 'checklist-import-draft';

export default function Checklists() {
  const nav = useNavigate();
  const { message, modal } = App.useApp();
  const [rows, setRows] = useState<Row[]>([]);
  const [importing, setImporting] = useState(false);

  const load = useCallback(() => api.get<{ rows: Row[] }>('/api/admin/checklists').then((r) => setRows(r.rows)), []);
  useEffect(() => {
    load();
  }, [load]);

  const act = async (fn: () => Promise<unknown>, ok: string) => {
    try {
      await fn();
      message.success(ok);
      load();
    } catch (e) {
      message.error((e as Error).message);
    }
  };

  const doImport = async (file: File, useAi = false) => {
    const fd = new FormData();
    fd.append('file', file);
    fd.append('useAi', String(useAi));
    setImporting(true);
    try {
      const r = await api.post<{ draft: unknown; needAi: boolean }>('/api/admin/checklists/import', fd);
      if (r.needAi) {
        modal.confirm({
          title: '未能自动识别检查条目',
          content: '文件中没有识别到“项目—内容”表格或“C01 标题：内容”格式的条目。是否使用 AI 整理该文件的结构？整理结果会先给你预览，确认后才保存。',
          okText: '使用 AI 整理',
          onOk: () => doImport(file, true),
        });
        return;
      }
      sessionStorage.setItem(DRAFT_KEY, JSON.stringify(r.draft));
      message.success('已解析，请核对后保存');
      nav('/admin/checklists/new?draft=1');
    } catch (e) {
      message.error((e as Error).message);
    } finally {
      setImporting(false);
    }
  };

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>检查清单管理</h1>
          <div className="sub">AI 按“生效”版本检查。已被检查记录使用的版本修改时会自动另存为新版本，保证历史记录可追溯。</div>
        </div>
        <Space>
          <Upload accept=".docx,.txt,.md" showUploadList={false} beforeUpload={(f) => (doImport(f), false)}>
            <Button icon={<UploadOutlined />} loading={importing}>
              上传文件导入
            </Button>
          </Upload>
          <Button type="primary" icon={<PlusOutlined />} onClick={() => nav('/admin/checklists/new')}>
            新建清单
          </Button>
        </Space>
      </div>
      <Card styles={{ body: { padding: 0 } }}>
        <Table
          rowKey="id"
          dataSource={rows}
          pagination={false}
          scroll={{ x: 900 }}
          columns={[
            { title: '版本', dataIndex: 'id', width: 70, render: (v) => `#${v}` },
            { title: '名称', dataIndex: 'name', render: (v, r) => <>{v} {r.is_active ? <Tag color="green">生效中</Tag> : null}</> },
            { title: '条目数', dataIndex: 'item_count', width: 80, align: 'center' },
            { title: '已用于检查', dataIndex: 'usage_count', width: 100, align: 'center', render: (v) => `${v} 次` },
            { title: '更新时间', dataIndex: 'updated_at', width: 170 },
            {
              title: '操作',
              width: 300,
              render: (_, r) => (
                <Space size={0} wrap>
                  <Button type="link" size="small" onClick={() => nav(`/admin/checklists/${r.id}`)}>
                    查看 / 编辑
                  </Button>
                  <Button type="link" size="small" onClick={() => nav(`/admin/checklists/new?from=${r.id}`)}>
                    复制为新版本
                  </Button>
                  {!r.is_active && (
                    <Popconfirm title="设为生效后，新的检查将按此版本进行。确定？" onConfirm={() => act(() => api.post(`/api/admin/checklists/${r.id}/activate`), '已设为生效')}>
                      <Button type="link" size="small">
                        设为生效
                      </Button>
                    </Popconfirm>
                  )}
                  {!r.is_active && !r.usage_count && (
                    <Popconfirm title="删除该版本？" okButtonProps={{ danger: true }} onConfirm={() => act(() => api.del(`/api/admin/checklists/${r.id}`), '已删除')}>
                      <Button type="link" size="small" danger>
                        删除
                      </Button>
                    </Popconfirm>
                  )}
                </Space>
              ),
            },
          ]}
        />
      </Card>
    </div>
  );
}
