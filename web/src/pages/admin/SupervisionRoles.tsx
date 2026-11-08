import { Alert, App, Button, Modal, Select, Space } from 'antd';
import { useState } from 'react';
import { api } from '../../api';

interface Config {
  users: { id: number; username: string; name: string; college_role: string; status: string }[];
  groups: { group: string; name: string; userId: number | null }[];
  college: { name: string; role: string }[];
}

export default function SupervisionRoles({ onChange }: { onChange: () => Promise<void> }) {
  const { message } = App.useApp();
  const [open, setOpen] = useState(false);
  const [data, setData] = useState<Config | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const load = async () => {
    try { setData(await api.get<Config>('/api/admin/supervision-roles')); }
    catch (e) { message.error((e as Error).message); }
  };
  const applyPresets = async () => {
    setBusy(true);
    try {
      const result = await api.post<{ matched: number; missing: string[] }>('/api/admin/supervision-roles/apply-presets');
      setNotice(`已绑定 ${result.matched} 人。${result.missing.length ? `尚未建号：${result.missing.join('、')}；创建账号后请再次匹配或手动设置。` : '指定人员均已匹配。'}`);
      await load();
      await onChange();
    } catch (e) { message.error((e as Error).message); }
    finally { setBusy(false); }
  };
  const save = async () => {
    setBusy(true);
    try {
      await api.put('/api/admin/supervision-roles/groups', { groups: data!.groups.map(({ group, userId }) => ({ group, userId })) });
      message.success('课程组长权限已保存');
      setOpen(false);
      await onChange();
    } catch (e) { message.error((e as Error).message); }
    finally { setBusy(false); }
  };
  return <>
    <Button onClick={() => { setOpen(true); setNotice(''); load(); }}>监督权限设置</Button>
    <Modal title="教学条线、专业负责人及八个课程组长" open={open} onCancel={() => setOpen(false)} onOk={save} okText="保存课程组长" confirmLoading={busy} okButtonProps={{ disabled: !data }} cancelButtonProps={{ disabled: busy }} closable={!busy} maskClosable={!busy}>
      <Alert type="info" showIcon title="监督身份独立于系统管理员，可兼任。"
        description="教学条线、专业负责人查看全院；组长仅查看并最终确认本组磨课清单内课程。不会授予账号管理或 AI 配置权限。所有权限绑定账号工号，不会在注册时凭姓名自动授权。" style={{ marginBottom: 16 }} />
      {data && <>
        <p>教学条线：{data.college.filter((p) => p.role === 'teaching').map((p) => p.name).join('、')}。</p>
        <p>专业负责人：{data.college.filter((p) => p.role === 'program').map((p) => p.name).join('、')}。</p>
        <Button onClick={applyPresets} loading={busy} style={{ marginBottom: 16 }}>按指定人员匹配现有账号并授权</Button>
        {notice && <Alert type="info" title={notice} style={{ marginBottom: 16 }} />}
        <p className="muted small">同名账号请按工号手动选择。全院查看身份可在用户表的“监督身份”中单独调整；柳宝华新增账号后也可在那里设置。</p>
        <Space orientation="vertical" size={14} style={{ width: '100%' }}>
          {data.groups.map((g) => <div key={g.group}>
            <div style={{ marginBottom: 6 }}>{g.group}（指定组长：{g.name}）</div>
            <Select style={{ width: '100%' }} showSearch optionFilterProp="label" allowClear placeholder="请选择组长账号（姓名＋工号）" aria-label={`${g.group}的组长`} value={g.userId ?? undefined} disabled={busy}
              options={data.users.map((u) => ({ value: u.id, label: `${u.name}（${u.username}）${u.status === 'active' ? '' : '（非正常账号）'}` }))}
              onChange={(id) => setData({ ...data, groups: data.groups.map((item) => item.group === g.group ? { ...item, userId: id ?? null } : item) })} />
          </div>)}
        </Space>
      </>}
    </Modal>
  </>;
}
