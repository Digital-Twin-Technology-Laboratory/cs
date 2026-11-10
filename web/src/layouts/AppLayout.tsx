import { Alert, App, Dropdown, Input, Layout, Menu, Button, Space, Tag, Tooltip } from 'antd';
import { DownOutlined, LogoutOutlined, SettingOutlined, UserOutlined } from '@ant-design/icons';
import { Link, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '../auth';
import { useEffect } from 'react';
import { useDemo } from '../demo';

export default function AppLayout() {
  const { user, site, checkQuota, refresh, logout } = useAuth();
  const { message } = App.useApp();
  const loc = useLocation();
  const nav = useNavigate();
  const demo = useDemo();
  const selected = '/' + (loc.pathname.split('/')[1] || 'courses');

  useEffect(() => {
    const load = () => refresh().catch((e) => message.error(e.message));
    load();
    const timer = setInterval(load, 5000);
    return () => clearInterval(timer);
  }, [loc.pathname, refresh, message]);

  const items = [
    { key: '/overview', label: <Link to="/overview">个人总览</Link> },
    { key: '/upload', label: <Link to="/upload">上传检查</Link> },
    { key: '/submissions', label: <Link to="/submissions">上传记录</Link> },
    ...(user && (user.role === 'admin' || user.college_role !== 'none' || user.led_groups.length > 0 || user.program_scopes.length > 0) ? [{ key: '/supervision', label: <Link to="/supervision">{user.role === 'admin' || user.college_role === 'teaching' ? '全院总览' : user.college_role === 'program' || user.program_scopes.length ? '专业总览' : '课程组总览'}</Link> }] : []),
    ...(user && (user.role === 'admin' || user.supervision_manager) ? [{ key: '/view-management', label: <Link to="/view-management">视图与大纲配置</Link> }] : []),
    ...(user?.role === 'admin' ? [{ key: '/admin', label: <Link to="/admin">管理后台</Link> }] : []),
  ];

  return (
    <Layout style={{ minHeight: '100vh' }}>
      <Layout.Header className="app-header">
        <Link to="/" className="brand">
          <span className="brand-mark">纲</span>
          <span className="brand-text">{site?.siteName}</span>
        </Link>
        <Menu mode="horizontal" selectedKeys={[selected]} items={items.map((item) => ({ ...item, disabled: demo.enabled && !['/overview', '/submissions', '/supervision'].includes(item.key) }))} />
        {demo.allowed && <Space size={4}>
          {demo.enabled && <Tag color="orange">示意数据</Tag>}
          <Button type="text" onClick={() => demo.enabled ? demo.update({ editing: !demo.editing }) : demo.start()}>{demo.enabled ? demo.editing ? '预览示意图' : '编辑示意图' : '示意编辑'}</Button>
          {demo.enabled && <Button type="text" onClick={demo.exit}>退出示意</Button>}
        </Space>}
        {checkQuota && (
          <Tooltip title={`今日已完成 ${checkQuota.used} 次，排队或检查中 ${checkQuota.pending} 份。基础额度每天 5 次，管理员今日追加 ${checkQuota.bonus} 次；失败不计次，次日恢复基础额度。`}>
            <Tag color={checkQuota.remaining ? 'blue' : 'orange'} style={{ marginInlineEnd: 0, whiteSpace: 'nowrap' }} aria-live="polite">
              今日剩余 {checkQuota.remaining}/{checkQuota.limit} 次
            </Tag>
          </Tooltip>
        )}
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
            <span className="brand-text">{demo.teacherName || user?.username}</span> <DownOutlined style={{ fontSize: 10 }} />
          </Button>
        </Dropdown>
      </Layout.Header>
      {demo.editing && <div className="demo-toolbar">
        <span>示意编辑：仅影响本次页面展示，不保存真实记录。编辑完成后点击“预览示意图”截图；退出或刷新恢复。</span>
        <Input aria-label="示意任课老师姓名" addonBefore="任课老师" value={demo.teacherName} style={{ width: 240 }} onChange={(e) => demo.update({ teacherName: e.target.value })} />
      </div>}
      <Layout.Content>
        {demo.enabled && !['/overview', '/submissions', '/supervision'].includes(loc.pathname)
          ? <Alert type="info" title="示意模式仅支持个人总览、上传记录和监督总览；请先退出示意模式再进行真实操作。" />
          : <Outlet />}
      </Layout.Content>
    </Layout>
  );
}
