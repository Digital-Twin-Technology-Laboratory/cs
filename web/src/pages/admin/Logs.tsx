import { Card, Input, Space } from 'antd';
import Table from '../../components/ResponsiveTable';
import { useEffect, useState } from 'react';
import { api, qs } from '../../api';

interface Row {
  id: number;
  username: string | null;
  action: string;
  target: string | null;
  detail: string | null;
  ip: string | null;
  created_at: string;
}

export default function Logs() {
  const [q, setQ] = useState('');
  const [page, setPage] = useState(1);
  const [data, setData] = useState<{ total: number; rows: Row[] }>({ total: 0, rows: [] });
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    setLoading(true);
    api
      .get<typeof data>(`/api/admin/logs?${qs({ q, page, pageSize: 30 })}`)
      .then(setData)
      .finally(() => setLoading(false));
  }, [q, page]);

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>操作日志</h1>
          <div className="sub">记录登录、上传、审核、配置修改、删除等操作</div>
        </div>
        <Space>
          <Input.Search placeholder="用户 / 操作 / 对象" allowClear onSearch={(v) => (setPage(1), setQ(v))} style={{ width: 240 }} />
        </Space>
      </div>
      <Card styles={{ body: { padding: 0 } }}>
        <Table
          rowKey="id"
          size="small"
          loading={loading}
          dataSource={data.rows}
          pagination={{ current: page, pageSize: 30, total: data.total, onChange: setPage, showTotal: (t) => `共 ${t} 条` }}
          columns={[
            { title: '时间', dataIndex: 'created_at', width: 170 },
            { title: '用户', dataIndex: 'username', width: 140, render: (v) => v || '—' },
            { title: '操作', dataIndex: 'action', width: 200 },
            { title: '对象', dataIndex: 'target', render: (v) => v || '—' },
            { title: '详情', dataIndex: 'detail', render: (v) => v || '—' },
            { title: 'IP', dataIndex: 'ip', width: 140 },
          ]}
        />
      </Card>
    </div>
  );
}
