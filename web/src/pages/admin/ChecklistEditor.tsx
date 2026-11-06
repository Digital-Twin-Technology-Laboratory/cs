import { Alert, App, Breadcrumb, Button, Card, Checkbox, Input, Segmented, Space, Spin, Tag } from 'antd';
import Table from '../../components/ResponsiveTable';
import { ArrowDownOutlined, ArrowUpOutlined, DeleteOutlined, PlusOutlined } from '@ant-design/icons';
import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { api } from '../../api';
import ChecklistView from '../../components/ChecklistView';
import type { Checklist, ChecklistItem, Section, SectionMeta } from '../../types';
import { DRAFT_KEY } from './Checklists';

const SECTIONS: Section[] = ['main', 'matrix', 'suggest'];
const PREFIX: Record<Section, string> = { main: 'C', matrix: 'M', suggest: 'S' };
const SECTION_TITLES: SectionMeta = {
  main: { title: '一 主要检查项目', colTitle: '检查项目', colContent: '检查内容' },
  matrix: { title: '二 毕业要求与课程矩阵专项检查', colTitle: '核查内容', colContent: '常见问题及检查方法' },
  suggest: { title: '三 建议完善项目', colTitle: '项目', colContent: '完善方向' },
};

interface Draft {
  name: string;
  intro: string;
  rules: string;
  notes: Record<Section, { before: string; after: string }>;
  items: (ChecklistItem & { key: string })[];
}

let seq = 0;
const withKey = (items: ChecklistItem[]) => items.map((i) => ({ ...i, key: `k${++seq}` }));
const normNotes = (n: Checklist['notes'] | undefined): Draft['notes'] => ({
  main: { before: n?.main?.before ?? '', after: n?.main?.after ?? '' },
  matrix: { before: n?.matrix?.before ?? '', after: n?.matrix?.after ?? '' },
  suggest: { before: n?.suggest?.before ?? '', after: n?.suggest?.after ?? '' },
});

export default function ChecklistEditor() {
  const { id } = useParams();
  const [params] = useSearchParams();
  const nav = useNavigate();
  const { message } = App.useApp();
  const isNew = id === 'new';
  const [draft, setDraft] = useState<Draft | null>(null);
  const [meta, setMeta] = useState<{ isActive: boolean; usageCount: number } | null>(null);
  const [activate, setActivate] = useState(false);
  const [view, setView] = useState<'edit' | 'preview'>('edit');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    const fromDraft = params.get('draft');
    const from = params.get('from');
    if (isNew && fromDraft) {
      const d = JSON.parse(sessionStorage.getItem(DRAFT_KEY) || 'null');
      if (d) setDraft({ ...d, notes: normNotes(d.notes), items: withKey(d.items) });
      else setDraft({ name: '', intro: '', rules: '', notes: normNotes(undefined), items: [] });
      setMeta({ isActive: false, usageCount: 0 });
      return;
    }
    const src = isNew ? from : id;
    if (!src) {
      setDraft({ name: '', intro: '', rules: '', notes: normNotes(undefined), items: [] });
      setMeta({ isActive: false, usageCount: 0 });
      return;
    }
    api.get<{ checklist: Checklist; usageCount: number }>(`/api/admin/checklists/${src}`).then((r) => {
      const c = r.checklist;
      setDraft({ name: isNew ? `${c.name}（副本）` : c.name, intro: c.intro, rules: c.rules, notes: normNotes(c.notes), items: withKey(c.items) });
      setMeta(isNew ? { isActive: false, usageCount: 0 } : { isActive: !!c.is_active, usageCount: r.usageCount });
    });
  }, [id, isNew, params]);

  if (!draft || !meta) return <div className="page"><Spin /></div>;

  const set = (patch: Partial<Draft>) => setDraft({ ...draft, ...patch });
  const setItem = (key: string, patch: Partial<ChecklistItem>) => set({ items: draft.items.map((i) => (i.key === key ? { ...i, ...patch } : i)) });
  const move = (key: string, dir: -1 | 1) => {
    const items = [...draft.items];
    const idx = items.findIndex((i) => i.key === key);
    const sec = items[idx].section;
    let j = idx + dir;
    while (j >= 0 && j < items.length && items[j].section !== sec) j += dir;
    if (j < 0 || j >= items.length) return;
    [items[idx], items[j]] = [items[j], items[idx]];
    set({ items });
  };
  const add = (sec: Section) => {
    const used = new Set(draft.items.map((i) => i.code));
    let n = draft.items.filter((i) => i.section === sec).length + 1;
    while (used.has(`${PREFIX[sec]}${String(n).padStart(2, '0')}`)) n++;
    set({ items: [...draft.items, ...withKey([{ code: `${PREFIX[sec]}${String(n).padStart(2, '0')}`, section: sec, title: '', content: '' }])] });
  };

  const save = async () => {
    if (!draft.name.trim()) return message.warning('请填写清单名称');
    const body = { name: draft.name, intro: draft.intro, rules: draft.rules, notes: draft.notes, items: draft.items.map(({ code, section, title, content }) => ({ code, section, title, content })), activate };
    setSaving(true);
    try {
      if (isNew) {
        const r = await api.post<{ id: number }>('/api/admin/checklists', body);
        sessionStorage.removeItem(DRAFT_KEY);
        message.success('清单已保存');
        nav(`/admin/checklists/${r.id}`, { replace: true });
      } else {
        const r = await api.put<{ id: number; newVersion: boolean }>(`/api/admin/checklists/${id}`, body);
        message.success(r.newVersion ? `原版本已被检查记录使用，已另存为新版本 #${r.id}` : '清单已保存');
        if (r.newVersion) nav(`/admin/checklists/${r.id}`, { replace: true });
      }
    } catch (e) {
      message.error((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const previewList: Checklist = { id: 0, name: draft.name, intro: draft.intro, rules: draft.rules, notes: draft.notes, is_active: 0, items: draft.items };

  return (
    <div className="page">
      <Breadcrumb style={{ marginBottom: 12 }} items={[{ title: <Link to="/admin/checklists">检查清单管理</Link> }, { title: isNew ? '新建清单' : `版本 #${id}` }]} />
      <div className="page-head">
        <div>
          <h1>
            {isNew ? '新建检查清单' : '编辑检查清单'} {meta.isActive && <Tag color="green">生效中</Tag>}
          </h1>
          <div className="sub">共 {draft.items.length} 个条目</div>
        </div>
        <Space wrap>
          <Segmented value={view} onChange={(v) => setView(v as typeof view)} options={[{ value: 'edit', label: '编辑' }, { value: 'preview', label: '预览' }]} />
          {isNew && (
            <Checkbox checked={activate} onChange={(e) => setActivate(e.target.checked)}>
              保存后设为生效
            </Checkbox>
          )}
          <Button type="primary" loading={saving} onClick={save}>
            保存
          </Button>
        </Space>
      </div>
      {meta.usageCount > 0 && (
        <Alert
          type="info"
          showIcon
          style={{ marginBottom: 16 }}
          title={`该版本已被 ${meta.usageCount} 次检查使用。保存修改时将另存为新版本${meta.isActive ? '并设为生效' : ''}，原版本保留不变。`}
        />
      )}
      {params.get('draft') && (
        <Alert type="warning" showIcon style={{ marginBottom: 16 }} title="以下内容由上传文件解析得到，请逐项核对编号、所属部分和文字后再保存。" />
      )}

      {view === 'preview' ? (
        <ChecklistView checklist={previewList} sections={SECTION_TITLES} />
      ) : (
        <Space orientation="vertical" size={16} style={{ width: '100%' }}>
          <Card title="基本信息">
            <div style={{ marginBottom: 12 }}>
              <div className="small muted" style={{ marginBottom: 4 }}>清单名称</div>
              <Input value={draft.name} onChange={(e) => set({ name: e.target.value })} maxLength={200} />
            </div>
            <div>
              <div className="small muted" style={{ marginBottom: 4 }}>开头说明</div>
              <Input.TextArea value={draft.intro} onChange={(e) => set({ intro: e.target.value })} autoSize={{ minRows: 3 }} />
            </div>
          </Card>
          {SECTIONS.map((sec) => (
            <Card key={sec} title={SECTION_TITLES[sec].title} extra={<Button size="small" icon={<PlusOutlined />} onClick={() => add(sec)}>添加条目</Button>}>
              <div className="small muted" style={{ marginBottom: 4 }}>表前说明（选填）</div>
              <Input.TextArea
                value={draft.notes[sec].before}
                onChange={(e) => set({ notes: { ...draft.notes, [sec]: { ...draft.notes[sec], before: e.target.value } } })}
                autoSize={{ minRows: 1 }}
                style={{ marginBottom: 12 }}
              />
              <Table
                size="small"
                rowKey="key"
                pagination={false}
                dataSource={draft.items.filter((i) => i.section === sec)}
                columns={[
                  { title: '编号', width: 90, render: (_, r) => <Input value={r.code} onChange={(e) => setItem(r.key, { code: e.target.value.toUpperCase() })} /> },
                  { title: SECTION_TITLES[sec].colTitle, width: 200, render: (_, r) => <Input.TextArea value={r.title} autoSize onChange={(e) => setItem(r.key, { title: e.target.value })} /> },
                  { title: SECTION_TITLES[sec].colContent, render: (_, r) => <Input.TextArea value={r.content} autoSize={{ minRows: 2 }} onChange={(e) => setItem(r.key, { content: e.target.value })} /> },
                  {
                    title: '',
                    width: 110,
                    render: (_, r) => (
                      <Space size={0}>
                        <Button type="text" size="small" icon={<ArrowUpOutlined />} aria-label="上移" onClick={() => move(r.key, -1)} />
                        <Button type="text" size="small" icon={<ArrowDownOutlined />} aria-label="下移" onClick={() => move(r.key, 1)} />
                        <Button type="text" size="small" danger icon={<DeleteOutlined />} aria-label="删除" onClick={() => set({ items: draft.items.filter((i) => i.key !== r.key) })} />
                      </Space>
                    ),
                  },
                ]}
              />
              <div className="small muted" style={{ margin: '12px 0 4px' }}>表后说明（选填）</div>
              <Input.TextArea
                value={draft.notes[sec].after}
                onChange={(e) => set({ notes: { ...draft.notes, [sec]: { ...draft.notes[sec], after: e.target.value } } })}
                autoSize={{ minRows: 1 }}
              />
            </Card>
          ))}
          <Card title="判定规则" extra={<span className="muted small">AI 判定时须遵循的区别，每条一行</span>}>
            <Input.TextArea value={draft.rules} onChange={(e) => set({ rules: e.target.value })} autoSize={{ minRows: 6 }} />
          </Card>
        </Space>
      )}
    </div>
  );
}
