import { Dropdown, Layout, Menu, Button } from 'antd';
import { DownOutlined, LogoutOutlined, SettingOutlined, UserOutlined } from '@ant-design/icons';
import { Link, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '../auth';

export default function AppLayout() {
  const { user, site, logout } = useAuth();
  const loc = useLocation();
  const nav = useNavigate();
  const selected = '/' + (loc.pathname.split('/')[1] || 'courses');

  const items = [
    { key: '/upload', label: <Link to="/upload">上传检查</Link> },
    { key: '/submissions', label: <Link to="/submissions">上传记录</Link> },
    { key: '/courses', label: <Link to="/courses">我的课程</Link> },
    { key: '/checklist', label: <Link to="/checklist">检查清单</Link> },
    ...(user?.role === 'admin' ? [{ key: '/admin', label: <Link to="/admin">管理后台</Link> }] : []),
  ];

  return (
    <Layout style={{ minHeight: '100vh' }}>
      <Layout.Header className="app-header">
        <Link to="/" className="brand">
          <span className="brand-mark">纲</span>
          <span className="brand-text">{site?.siteName}</span>
        </Link>
        <Menu mode="horizontal" selectedKeys={[selected]} items={items} />
        <Dropdown
          menu={{
            items: [
              { key: 'profile', icon: <SettingOutlined />, label: '个人设置', onClick: () => nav('/profile') },
              { type: 'divider' },
              {
                key: 'logout',
                icon: <LogoutOutlined />,
                label: '退出登录',
                onClick: async () => {
                  await logout();
                  nav('/login');
                },
              },
            ],
          }}
        >
          <Button type="text" icon={<UserOutlined />}>
            <span className="brand-text">{user?.name || user?.username}</span> <DownOutlined style={{ fontSize: 10 }} />
          </Button>
        </Dropdown>
      </Layout.Header>
      <Layout.Content>
        <Outlet />
      </Layout.Content>
    </Layout>
  );
}
