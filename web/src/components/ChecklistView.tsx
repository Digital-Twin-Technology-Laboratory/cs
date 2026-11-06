import { Card, Collapse, Empty, Input, Segmented, Space } from 'antd';
import Table from './ResponsiveTable';
import { useMemo, useState } from 'react';
import type { Checklist, Section, SectionMeta } from '../types';

function Highlight({ text, q }: { text: string; q: string }) {
  if (!q) return <>{text}</>;
  const parts = text.split(q);
  return (
    <>
      {parts.map((p, i) => (
        <span key={i}>
          {p}
          {i < parts.length - 1 && <mark className="hl">{q}</mark>}
        </span>
      ))}
    </>
  );
}

/** 检查清单展示：保留原版三部分结构，支持关键词搜索与按部分筛选 */
export default function ChecklistView({ checklist, sections }: { checklist: Checklist; sections: SectionMeta }) {
  const [q, setQ] = useState('');
  const [sec, setSec] = useState<'all' | Section>('all');
  const kw = q.trim();

  const filtered = useMemo(
    () =>
      checklist.items.filter(
        (i) => (sec === 'all' || i.section === sec) && (!kw || i.title.includes(kw) || i.content.includes(kw) || i.code.includes(kw.toUpperCase())),
      ),
    [checklist, sec, kw],
  );

  const count = (s: Section) => checklist.items.filter((i) => i.section === s).length;

  return (
    <Space orientation="vertical" size={16} style={{ width: '100%' }}>
      {checklist.intro && (
        <Card size="small">
          <div className="prose">{checklist.intro}</div>
        </Card>
      )}
      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', justifyContent: 'space-between' }}>
        <Segmented
          value={sec}
          onChange={(v) => setSec(v as typeof sec)}
          options={[
            { value: 'all', label: `全部（${checklist.items.length}）` },
            { value: 'main', label: `主要检查（${count('main')}）` },
            { value: 'matrix', label: `矩阵专项（${count('matrix')}）` },
            { value: 'suggest', label: `建议完善（${count('suggest')}）` },
          ]}
        />
        <Input.Search placeholder="搜索关键词，如：考核、实验、矩阵" allowClear onChange={(e) => setQ(e.target.value)} style={{ maxWidth: 300 }} />
      </div>
      {(['main', 'matrix', 'suggest'] as Section[]).map((s) => {
        const rows = filtered.filter((i) => i.section === s);
        if (!rows.length) return null;
        const note = checklist.notes[s];
        return (
          <Card key={s} title={sections[s].title} size="small">
            {note?.before && !kw && (
              <div className="note-box" style={{ marginBottom: 12 }}>
                {note.before}
              </div>
            )}
            <Table
              size="small"
              rowKey="code"
              pagination={false}
              dataSource={rows}
              columns={[
                { title: '编号', dataIndex: 'code', width: 70, render: (v) => <span className="code-cell">{v}</span> },
                { title: sections[s].colTitle, dataIndex: 'title', width: 180, render: (v) => <b><Highlight text={v} q={kw} /></b> },
                { title: sections[s].colContent, dataIndex: 'content', render: (v) => <span style={{ lineHeight: 1.8 }}><Highlight text={v} q={kw} /></span> },
              ]}
            />
            {note?.after && !kw && (
              <div className="note-box" style={{ marginTop: 12 }}>
                {note.after}
              </div>
            )}
          </Card>
        );
      })}
      {!filtered.length && <Empty description="没有匹配的检查项目" />}
      {checklist.rules && (
        <Collapse
          items={[{ key: 'rules', label: '判定时应保留的区别', children: <div className="prose small">{checklist.rules}</div> }]}
        />
      )}
      <div className="muted small">编号 C、M、S 为系统增设的稳定标识，用于识别和引用，不代表优先级。</div>
    </Space>
  );
}
