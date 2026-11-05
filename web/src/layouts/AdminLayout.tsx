import { Grid, Layout, Menu, Select } from 'antd';
import {
  ApiOutlined,
  AuditOutlined,
  DashboardOutlined,
  FileTextOutlined,
  FolderOpenOutlined,
  ProfileOutlined,
  SettingOutlined,
  TeamOutlined,
} from '@ant-design/icons';
import { Link, Outlet, useLocation, useNavigate } from 'react-router-dom';

const ITEMS = [
  { key: '/admin', icon: <DashboardOutlined />, label: '概览' },
  { key: '/admin/users', icon: <TeamOutlined />, label: '用户管理' },
  { key: '/admin/records', icon: <FolderOpenOutlined />, label: '文件与检查记录' },
  { key: '/admin/checklists', icon: <ProfileOutlined />, label: '检查清单管理' },
  { key: '/admin/plans', icon: <FileTextOutlined />, label: '培养方案管理' },
  { key: '/admin/ai', icon: <ApiOutlined />, label: 'AI 配置' },
  { key: '/admin/settings', icon: <SettingOutlined />, label: '系统设置' },
  { key: '/admin/logs', icon: <AuditOutlined />, label: '操作日志' },
];

export default function AdminLayout() {
  const loc = useLocation();
  const nav = useNavigate();
  const screens = Grid.useBreakpoint();
  const selected =
    ITEMS.map((i) => i.key)
      .filter((k) => k === '/admin' ? loc.pathname === '/admin' : loc.pathname.startsWith(k))
      .pop() ?? '/admin';

  if (!screens.md) {
    return (
      <div>
        <div style={{ padding: '12px 12px 0' }}>
          <Select style={{ width: '100%' }} value={selected} onChange={(v) => nav(v)} options={ITEMS.map((i) => ({ value: i.key, label: i.label }))} />
        </div>
        <Outlet />
      </div>
    );
  }

  return (
    <Layout style={{ minHeight: 'calc(100vh - 56px)' }}>
      <Layout.Sider width={200} style={{ borderRight: '1px solid #e5e6eb' }}>
        <Menu
          mode="inline"
          selectedKeys={[selected]}
          style={{ borderInlineEnd: 'none', paddingTop: 8 }}
          items={ITEMS.map((i) => ({ ...i, label: <Link to={i.key}>{i.label}</Link> }))}
        />
      </Layout.Sider>
      <Layout.Content>
        <Outlet />
      </Layout.Content>
    </Layout>
  );
}
