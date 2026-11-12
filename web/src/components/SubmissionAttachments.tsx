import { Alert, App, Button, Collapse, Modal, Space, Spin } from 'antd';
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, download } from '../api';
import ResultView, { SubmissionMeta } from './ResultView';
import type { ChecklistItem, SectionMeta, SubmissionDetail, SubStatus } from '../types';

interface Attachment { id: number; status: SubStatus | null }
interface Detail { submission: SubmissionDetail; checklist: { items: ChecklistItem[] } | null; sections: SectionMeta }

export default function SubmissionAttachments({ selected, onClear }: { selected: Attachment[]; onClear: () => void }) {
  const { message } = App.useApp();
  const [busy, setBusy] = useState('');
  const [previewIds, setPreviewIds] = useState<number[]>([]);
  const [index, setIndex] = useState(0);
  const [detail, setDetail] = useState<Detail | null>(null);
  const [error, setError] = useState('');
  const id = previewIds[index];
  useEffect(() => {
    setDetail(null);
    setError('');
    if (!id) return;
    let active = true;
    api.get<Detail>(`/api/submissions/${id}`).then((data) => { if (active) setDetail(data); })
      .catch((e) => { if (active) setError(e.message); });
    return () => { active = false; };
  }, [id]);
  const batchDownload = async (kind: 'files' | 'reports') => {
    setBusy(kind);
    try {
      const response = await fetch('/api/submissions/batch-download', {
        method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids: selected.map((s) => s.id), kind }),
      });
      if (!response.ok) {
        if (response.status === 401) window.dispatchEvent(new Event('auth:expired'));
        throw new Error((await response.json()).error);
      }
      const url = URL.createObjectURL(await response.blob());
      const a = document.createElement('a');
      a.href = url;
      a.download = kind === 'files' ? '大纲原文件.zip' : '大纲检查结果.zip';
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (e) { message.error((e as Error).message); }
    finally { setBusy(''); }
  };
  const reportsReady = selected.length > 0 && selected.every((s) => s.status === 'done');
  return <>
    <Space wrap style={{ marginBottom: 16 }}>
      <span>已选 {selected.length} 条（每次最多100条，可跨页勾选）</span>
      <Button disabled={!selected.length || selected.length > 100} onClick={() => { setPreviewIds(selected.map((s) => s.id)); setIndex(0); }}>批量查看</Button>
      <Button disabled={!selected.length || selected.length > 100 || !!busy} loading={busy === 'files'} onClick={() => batchDownload('files')}>批量下载原文件</Button>
      <Button disabled={!reportsReady || selected.length > 100 || !!busy} loading={busy === 'reports'} onClick={() => batchDownload('reports')}>批量下载检查结果</Button>
      <Button disabled={!selected.length} onClick={onClear}>清空选择</Button>
      {!!selected.length && !reportsReady && <span className="muted small">检查结果仅支持已完成记录</span>}
    </Space>
    <Modal title={`批量查看附件（${index + 1} / ${previewIds.length}）`} open={previewIds.length > 0} width={1100} onCancel={() => setPreviewIds([])}
      footer={<Space><Button disabled={index === 0} onClick={() => setIndex(index - 1)}>上一份</Button><Button disabled={index === previewIds.length - 1} onClick={() => setIndex(index + 1)}>下一份</Button><Button onClick={() => setPreviewIds([])}>关闭</Button></Space>}>
      {error ? <Alert type="error" showIcon title={error} /> : !detail ? <Spin /> : <Space orientation="vertical" style={{ width: '100%' }}>
        <Space wrap><Link to={`/submissions/${id}`} target="_blank">打开详情与确认</Link><Button onClick={() => download(`/api/submissions/${id}/file`)}>下载本份原文件</Button></Space>
        <SubmissionMeta sub={detail.submission} />
        <Collapse defaultActiveKey={['original']} items={[{ key: 'original', label: '大纲原文（提取文本，原始排版请下载原文件）', children: <div className="prose">{detail.submission.extracted_text}</div> }]} />
        {detail.submission.status === 'done' && detail.submission.result && detail.checklist
          ? <ResultView sub={detail.submission} items={detail.checklist.items} sections={detail.sections} />
          : <Alert type="info" title="检查尚未完成" description={detail.submission.error} />}
      </Space>}
    </Modal>
  </>;
}
