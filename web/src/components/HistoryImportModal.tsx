import {
  Alert,
  App,
  Button,
  Input,
  Modal,
  Select,
  Space,
  Table,
  Tabs,
  Tag,
  Upload,
  type UploadFile,
} from 'antd';
import { InboxOutlined, LinkOutlined, UploadOutlined } from '@ant-design/icons';
import { useState } from 'react';
import { api } from '../api';

type HistoryCourse = { name: string; code: string; major: string; key: string };
type TeacherMatch = { name: string; staffNo: string; matchedUserId: number | null; status: 'matched' | 'ambiguous' | 'unmatched' };
type PreviewRow = {
  key: string;
  sheet: string;
  row: number;
  course: Omit<HistoryCourse, 'key'>;
  status: 'matched' | 'ambiguous' | 'unmatched' | 'invalid';
  candidates: HistoryCourse[];
  teachers: { name: string; staffNo: string }[];
  teacherMatches?: TeacherMatch[];
  text: string;
  term: string;
  context: string;
  source: string;
  position: string;
  nature: string;
  category?: string;
  checkItem?: string;
  reviewer?: string;
  examType?: string;
  sourceUrl?: string;
};

interface PreviewResponse {
  previewId: string;
  format: 'flat' | 'matrix' | 'mixed';
  sourceName: string;
  sourceUrl?: string;
  totalRows: number;
  matchedTeachers: number;
  unmatchedTeachers: number;
  courses: HistoryCourse[];
  rows: PreviewRow[];
}

const courseLabel = (course: Omit<HistoryCourse, 'key'>) => [course.name, course.code, course.major].filter(Boolean).join(' · ');

function buildInitialChoices(rows: PreviewRow[], autoArchiveUnmatched: boolean): Record<string, string> {
  const result: Record<string, string> = {};
  for (const row of rows) {
    if (row.status === 'matched' && row.candidates[0]) {
      result[row.key] = row.candidates[0].key;
    } else if (autoArchiveUnmatched && row.status === 'unmatched' && row.course.name) {
      result[row.key] = 'original';
    }
  }
  return result;
}

export function HistoryImportPanel({
  onImported,
  defaultAutoArchive = true,
}: {
  onImported?: (result: { added: number; duplicates: number; skipped: number }) => void;
  defaultAutoArchive?: boolean;
}) {
  const { message } = App.useApp();
  const [mode, setMode] = useState<'url' | 'file'>('url');
  const [docUrl, setDocUrl] = useState('');
  const [files, setFiles] = useState<UploadFile[]>([]);
  const [preview, setPreview] = useState<PreviewResponse | null>(null);
  const [choices, setChoices] = useState<Record<string, string>>({});
  const [onlyFlagged, setOnlyFlagged] = useState(false);
  const [busy, setBusy] = useState(false);
  const [summary, setSummary] = useState('');

  const resetPreview = () => {
    setPreview(null);
    setChoices({});
    setOnlyFlagged(false);
    setSummary('');
  };

  const loadFromUrl = async () => {
    const trimmed = docUrl.trim();
    if (!trimmed) return message.warning('请先粘贴在线表格链接');
    setBusy(true);
    setSummary('');
    try {
      const data = await api.post<PreviewResponse>('/api/materials/history/preview-url', { url: trimmed });
      setChoices(buildInitialChoices(data.rows, defaultAutoArchive));
      setPreview(data);
    } catch (e) {
      message.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const loadFromFile = async () => {
    const upload = files[0]?.originFileObj;
    if (!upload) return message.warning('请先选择要上传的文档或表格文件');
    setBusy(true);
    setSummary('');
    try {
      const body = new FormData();
      body.set('file', upload);
      const data = await api.post<PreviewResponse>('/api/materials/history/preview', body);
      setChoices(buildInitialChoices(data.rows, defaultAutoArchive));
      setPreview(data);
    } catch (e) {
      message.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const confirmImport = async () => {
    if (!preview) return;
    setBusy(true);
    try {
      const result = await api.post<{ added: number; duplicates: number; skipped: number }>('/api/materials/history/import', {
        previewId: preview.previewId,
        choices,
      });
      const text = `导入完成：新增 ${result.added} 条问题记录，合并重复 ${result.duplicates} 条，跳过 ${result.skipped} 条。`;
      setSummary(text);
      message.success(text);
      setPreview(null);
      setFiles([]);
      onImported?.(result);
    } catch (e) {
      message.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const unresolved = preview?.rows.filter((row) => row.status !== 'matched') ?? [];
  const confirmed = preview?.rows.filter((row) => choices[row.key]).length ?? 0;
  const canKeep = preview?.rows.filter((row) => (row.status === 'unmatched' || row.status === 'ambiguous') && row.course.name) ?? [];
  const formatName = preview?.format === 'matrix' ? '核查矩阵表' : preview?.format === 'mixed' ? '混合格式表格' : '问题明细表';

  return (
    <Space orientation="vertical" size="middle" style={{ width: '100%' }}>
      <Alert
        type="info"
        showIcon
        title="支持在线表格链接与本地文档文件，自动识别「存在问题 / 具体反馈」明细表与「多列核查项」矩阵表"
        description="系统会按工号或姓名自动匹配教师账号；尚未建账号的教师也会按姓名归集，建号后自动关联。导入后点击任意教师即可弹出全部历史与最新问题。"
      />

      <Tabs
        activeKey={mode}
        onChange={(k) => { setMode(k as 'url' | 'file'); resetPreview(); }}
        items={[
          {
            key: 'url',
            label: <span><LinkOutlined /> 导入文档链接</span>,
            children: (
              <Space orientation="vertical" size={10} style={{ width: '100%' }}>
                <Space.Compact style={{ width: '100%' }}>
                  <Input
                    aria-label="历史问题文档链接"
                    value={docUrl}
                    onChange={(e) => { setDocUrl(e.target.value); if (preview) resetPreview(); }}
                    placeholder="粘贴腾讯文档表格链接，例如 https://docs.qq.com/sheet/..."
                    disabled={busy}
                    allowClear
                    onPressEnter={() => void loadFromUrl()}
                  />
                  <Button type="primary" loading={busy && !preview} onClick={() => void loadFromUrl()}>
                    读取并预览
                  </Button>
                </Space.Compact>
                <div className="muted small">
                  请确保文档已开启「任何人可查看」权限；若文档受权限保护，可导出 Excel 或 CSV 后切换到「上传文档文件」导入。
                </div>
              </Space>
            ),
          },
          {
            key: 'file',
            label: <span><UploadOutlined /> 上传文档文件</span>,
            children: (
              <Space orientation="vertical" size={12} style={{ width: '100%' }}>
                <Upload.Dragger
                  accept=".xls,.xlsx,.csv,.docx"
                  maxCount={1}
                  fileList={files}
                  beforeUpload={() => false}
                  disabled={busy}
                  onChange={({ fileList }) => {
                    setFiles(fileList.slice(-1));
                    resetPreview();
                  }}
                >
                  <p className="ant-upload-drag-icon"><InboxOutlined /></p>
                  <p className="ant-upload-text">点击或拖拽历史问题文件到此处</p>
                  <p className="ant-upload-hint">支持 .xlsx、.xls、.csv（自动兼容 UTF-8 / GBK）及含表格的 .docx 文件</p>
                </Upload.Dragger>
                <Button type="primary" disabled={!files.length || busy} loading={busy && !preview} onClick={() => void loadFromFile()}>
                  解析并预览匹配
                </Button>
              </Space>
            ),
          },
        ]}
      />

      {summary && <Alert type="success" showIcon title={summary} />}

      {preview && (
        <div className="import-preview-box">
          <div className="import-preview-banner">
            <Space wrap size={8}>
              <strong>来源：{preview.sourceName}</strong>
              <Tag color="blue">{formatName}</Tag>
              <Tag color="geekblue">共识别 {preview.totalRows} 条问题</Tag>
              <Tag color="green">匹配系统账号 {preview.matchedTeachers} 人</Tag>
              {preview.unmatchedTeachers > 0 && (
                <Tag color="gold">按姓名归集 {preview.unmatchedTeachers} 人</Tag>
              )}
            </Space>
            <Space wrap size={8}>
              {unresolved.length > 0 && (
                <Button size="small" onClick={() => setOnlyFlagged((v) => !v)}>
                  {onlyFlagged ? '显示全部' : `仅看待确认课程 (${unresolved.length})`}
                </Button>
              )}
              {canKeep.length > 0 && (
                <Button
                  size="small"
                  disabled={busy}
                  onClick={() => setChoices((prev) => ({
                    ...prev,
                    ...Object.fromEntries(canKeep.filter((r) => !prev[r.key]).map((r) => [r.key, 'original'])),
                  }))}
                >
                  其余按原表课程归档
                </Button>
              )}
            </Space>
          </div>

          <Table<PreviewRow>
            rowKey="key"
            size="small"
            dataSource={onlyFlagged ? unresolved : preview.rows}
            scroll={{ x: 940 }}
            pagination={{ pageSize: 10, showTotal: (t) => `共 ${t} 条` }}
            columns={[
              {
                title: '原表位置 / 类别',
                width: 150,
                render: (_, r) => (
                  <div>
                    <div className="small">{r.sheet} · 第 {r.row} 行</div>
                    {r.category && <Tag bordered={false} style={{ marginTop: 4 }}>{r.category}</Tag>}
                  </div>
                ),
              },
              {
                title: '匹配教师',
                width: 180,
                render: (_, r) => {
                  const list = r.teacherMatches ?? r.teachers.map((t) => ({ ...t, matchedUserId: null, status: 'unmatched' as const }));
                  if (!list.length) return <span className="muted small">原表未注明教师</span>;
                  return (
                    <Space orientation="vertical" size={4}>
                      {list.map((t, i) => (
                        <div key={i}>
                          <strong>{t.name || t.staffNo}</strong>
                          {t.staffNo && <span className="muted small">（{t.staffNo}）</span>}
                          <div>
                            {t.status === 'matched'
                              ? <Tag color="green" bordered={false}>已匹配账号</Tag>
                              : t.status === 'ambiguous'
                                ? <Tag color="orange" bordered={false}>同名账号</Tag>
                                : <Tag color="default" bordered={false}>按姓名归集</Tag>}
                          </div>
                        </div>
                      ))}
                    </Space>
                  );
                },
              },
              {
                title: '原表课程与问题内容',
                render: (_, r) => (
                  <div>
                    <div className="small" style={{ marginBottom: 4 }}>
                      <strong>{courseLabel(r.course)}</strong>
                      {r.term && <span className="muted"> · {r.term}</span>}
                      {r.context && <span className="muted"> · {r.context}</span>}
                    </div>
                    <div style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', lineHeight: 1.6 }}>{r.text}</div>
                    {r.reviewer && <div className="muted small" style={{ marginTop: 2 }}>检查人：{r.reviewer}</div>}
                  </div>
                ),
              },
              {
                title: '课程归档方式',
                width: 260,
                render: (_, r) => {
                  if (r.status === 'invalid') return <Tag color="red">课程、问题或工号列需修正</Tag>;
                  if (r.status === 'matched') {
                    return (
                      <div>
                        <Tag color="green">{r.course.code ? '按代码匹配' : '按名称匹配'}</Tag>
                        <div className="small" style={{ marginTop: 4 }}>{courseLabel(r.candidates[0])}</div>
                      </div>
                    );
                  }
                  const candidates = r.status === 'ambiguous' ? r.candidates : preview.courses;
                  return (
                    <Space orientation="vertical" size={4} style={{ width: '100%' }}>
                      <Tag color={r.status === 'ambiguous' ? 'orange' : 'blue'}>
                        {r.status === 'ambiguous' ? '同名课程（请确认）' : '库中暂无该课（可按原表归档）'}
                      </Tag>
                      <Select
                        aria-label={`确认 ${r.sheet} 第 ${r.row} 行 ${r.course.name || r.course.code} 的课程`}
                        showSearch={{ optionFilterProp: 'label' }}
                        allowClear
                        disabled={busy}
                        value={choices[r.key]}
                        style={{ width: '100%' }}
                        placeholder="选择归档课程，留空则跳过"
                        options={[
                          ...(r.course.name ? [{ value: 'original', label: `按原表归档（${r.course.name}）` }] : []),
                          ...candidates.map((course) => ({ value: course.key, label: courseLabel(course) })),
                        ]}
                        onChange={(value) => setChoices((prev) => ({ ...prev, [r.key]: value || '' }))}
                      />
                    </Space>
                  );
                },
              },
            ]}
          />

          <div className="import-preview-footer">
            <span className="muted small">
              已确认归档 <strong>{confirmed}</strong> 条，{preview.rows.length - confirmed} 条将跳过。相同课程与问题会自动去重合并。
            </span>
            <Button type="primary" disabled={!confirmed} loading={busy} onClick={() => void confirmImport()}>
              确认导入 {confirmed} 条问题记录
            </Button>
          </div>
        </div>
      )}
    </Space>
  );
}

export default function HistoryImportModal({
  open,
  onClose,
  onImported,
}: {
  open: boolean;
  onClose: () => void;
  onImported: () => void;
}) {
  return (
    <Modal
      open={open}
      onCancel={onClose}
      footer={null}
      title="导入历史问题记录（链接或文件）"
      width="min(1080px, 96vw)"
      destroyOnHidden
    >
      <HistoryImportPanel
        onImported={() => {
          onImported();
        }}
      />
    </Modal>
  );
}
