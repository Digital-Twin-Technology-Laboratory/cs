import {
  Alert,
  App,
  Button,
  Card,
  Empty,
  Input,
  Modal,
  Popconfirm,
  Segmented,
  Space,
  Spin,
  Switch,
  Table,
  Tag,
} from 'antd';
import {
  AppstoreOutlined,
  CloudUploadOutlined,
  DatabaseOutlined,
  DeleteOutlined,
  LinkOutlined,
  RightOutlined,
  SearchOutlined,
  UnorderedListOutlined,
} from '@ant-design/icons';
import { useCallback, useEffect, useState } from 'react';
import { api, qs } from '../../api';
import HistoryImportModal from '../../components/HistoryImportModal';
import PersonIssueModal from '../../components/PersonIssueModal';

interface ArchivePerson {
  personKey: string;
  userId: number | null;
  name: string;
  username: string;
  department: string;
  matchedAccount: boolean;
  coursesCount: number;
  outlineCoursesCount: number;
  outlineChecksCount: number;
  outlineDistinctIssues: number;
  outlineLatestRemaining: number;
  materialIssuesCount: number;
  historyIssuesCount: number;
  totalIssues: number;
  severeCount: number;
  latestActivityAt: string;
  courseNames: string[];
}

interface ArchiveResponse {
  canImport: boolean;
  stats: {
    totalPeople: number;
    peopleWithIssues: number;
    totalOutlineIssues: number;
    totalHistoryIssues: number;
    totalMaterialIssues: number;
    importedSourcesCount: number;
  };
  people: ArchivePerson[];
}

interface ImportedSource {
  source: string;
  sourceUrl: string;
  uploader: string;
  count: number;
  latestAt: string;
}

export default function IssueArchive() {
  const { message } = App.useApp();
  const [data, setData] = useState<ArchiveResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [q, setQ] = useState('');
  const [sourceFilter, setSourceFilter] = useState<'all' | 'outline' | 'history' | 'material'>('all');
  const [onlyWithIssues, setOnlyWithIssues] = useState(true);
  const [layoutMode, setLayoutMode] = useState<'cards' | 'table'>('cards');
  const [selectedPerson, setSelectedPerson] = useState<string | null>(null);
  const [importOpen, setImportOpen] = useState(false);
  const [sourcesOpen, setSourcesOpen] = useState(false);
  const [sources, setSources] = useState<ImportedSource[]>([]);
  const [sourcesLoading, setSourcesLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const resp = await api.get<ArchiveResponse>(
        `/api/issue-archive/people?${qs({ q: q.trim(), source: sourceFilter, onlyWithIssues: onlyWithIssues ? '1' : '0' })}`,
      );
      setData(resp);
      setError('');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [q, sourceFilter, onlyWithIssues]);

  useEffect(() => {
    const timer = setTimeout(() => { void load(); }, q ? 200 : 0);
    return () => clearTimeout(timer);
  }, [load, q]);

  const loadSources = useCallback(async () => {
    setSourcesLoading(true);
    try {
      const res = await api.get<{ sources: ImportedSource[] }>('/api/issue-archive/imports');
      setSources(res.sources);
    } catch (e) {
      message.error((e as Error).message);
    } finally {
      setSourcesLoading(false);
    }
  }, [message]);

  const openSources = () => {
    setSourcesOpen(true);
    void loadSources();
  };

  const removeSource = async (source: string) => {
    try {
      const res = await api.del<{ removed: number }>('/api/issue-archive/imports', { source });
      message.success(`已删除「${source}」的 ${res.removed} 条记录`);
      await Promise.all([loadSources(), load()]);
    } catch (e) {
      message.error((e as Error).message);
    }
  };

  const stats = data?.stats;
  const people = data?.people ?? [];

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>问题记录汇总</h1>
          {stats && (
            <div className="archive-inline-summary">
              <span>涉及 <strong>{stats.peopleWithIssues}</strong> / {stats.totalPeople} 人</span>
              <span>大纲 <strong>{stats.totalOutlineIssues}</strong> 项</span>
              <span>历史导入 <strong>{stats.totalHistoryIssues}</strong> 条</span>
              {stats.totalMaterialIssues > 0 && <span>全套材料 <strong>{stats.totalMaterialIssues}</strong> 项</span>}
            </div>
          )}
        </div>
        <Space wrap>
          {data?.canImport && (
            <>
              <Button icon={<DatabaseOutlined />} onClick={openSources}>
                已导入来源{stats?.importedSourcesCount ? `（${stats.importedSourcesCount}）` : ''}
              </Button>
              <Button type="primary" icon={<CloudUploadOutlined />} onClick={() => setImportOpen(true)}>
                导入历史问题
              </Button>
            </>
          )}
        </Space>
      </div>

      {error && <Alert type="error" showIcon title={error} style={{ marginBottom: 16 }} />}

      <Card className="archive-toolbar-card" styles={{ body: { padding: '12px 16px' } }}>
        <div className="archive-toolbar">
          <div className="archive-toolbar-left">
            <Input
              allowClear
              prefix={<SearchOutlined style={{ color: '#94a3b8' }} />}
              placeholder="搜索姓名、工号、课程或问题"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              style={{ width: 'min(260px, 100%)' }}
            />
            <Segmented
              value={sourceFilter}
              onChange={(v) => setSourceFilter(v as typeof sourceFilter)}
              options={[
                { value: 'all', label: '全部' },
                { value: 'outline', label: '大纲检查' },
                { value: 'history', label: '历史导入' },
                { value: 'material', label: '全套材料' },
              ]}
            />
          </div>
          <div className="archive-toolbar-right">
            <label className="dossier-switch-label">
              <Switch size="small" checked={onlyWithIssues} onChange={setOnlyWithIssues} />
              <span>仅看有记录</span>
            </label>
            <Segmented
              size="small"
              value={layoutMode}
              onChange={(v) => setLayoutMode(v as 'cards' | 'table')}
              options={[
                { value: 'cards', icon: <AppstoreOutlined />, label: '卡片' },
                { value: 'table', icon: <UnorderedListOutlined />, label: '列表' },
              ]}
            />
          </div>
        </div>
      </Card>

      <Spin spinning={loading}>
        {!loading && people.length === 0 ? (
          <Card>
            <Empty
              image={Empty.PRESENTED_IMAGE_SIMPLE}
              description={onlyWithIssues && (stats?.totalPeople ?? 0) > 0 ? '暂无符合条件的问题记录' : '暂无人员记录'}
            >
              <Space wrap>
                {onlyWithIssues && <Button onClick={() => setOnlyWithIssues(false)}>显示全部人员</Button>}
                {data?.canImport && (
                  <Button type="primary" icon={<CloudUploadOutlined />} onClick={() => setImportOpen(true)}>
                    导入历史问题
                  </Button>
                )}
              </Space>
            </Empty>
          </Card>
        ) : layoutMode === 'cards' ? (
          <div className="archive-person-grid">
            {people.map((person) => (
              <div
                key={person.personKey}
                role="button"
                tabIndex={0}
                className="archive-person-card"
                onClick={() => setSelectedPerson(person.personKey)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    setSelectedPerson(person.personKey);
                  }
                }}
              >
                <div className="archive-person-head">
                  <div className="archive-person-id">
                    <div className="archive-person-name-row">
                      <strong>{person.name}</strong>
                      {person.username && <span className="dossier-staff-no">{person.username}</span>}
                      {!person.matchedAccount && <Tag color="gold" bordered={false}>仅历史</Tag>}
                    </div>
                    {person.department && <div className="muted small">{person.department}</div>}
                  </div>
                  <div className={`archive-total-pill${person.totalIssues > 0 ? ' is-warn' : ''}`}>
                    <span className="pill-num">{person.totalIssues}</span>
                    <span className="pill-unit">项</span>
                  </div>
                </div>

                <div className="archive-person-metrics">
                  <div className="mini-metric">
                    <span className="mini-label">大纲</span>
                    <span className="mini-val">
                      <strong>{person.outlineDistinctIssues}</strong>
                      {person.outlineLatestRemaining > 0 && (
                        <span className="mini-sub-danger"> · {person.outlineLatestRemaining} 仍存</span>
                      )}
                    </span>
                  </div>
                  <div className="mini-metric">
                    <span className="mini-label">历史</span>
                    <span className="mini-val"><strong>{person.historyIssuesCount}</strong></span>
                  </div>
                  <div className="mini-metric">
                    <span className="mini-label">材料</span>
                    <span className="mini-val"><strong>{person.materialIssuesCount}</strong></span>
                  </div>
                </div>

                <div className="archive-person-courses">
                  {person.courseNames.length > 0 ? (
                    <>
                      {person.courseNames.slice(0, 3).map((name) => (
                        <Tag key={name} bordered={false} className="archive-course-tag">{name}</Tag>
                      ))}
                      {person.courseNames.length > 3 && (
                        <Tag bordered={false} className="archive-course-tag">+{person.courseNames.length - 3}</Tag>
                      )}
                    </>
                  ) : (
                    <span className="muted small">无问题课程</span>
                  )}
                </div>

                <div className="archive-person-foot">
                  <span className="muted small">
                    {person.latestActivityAt ? person.latestActivityAt.slice(0, 10) : '—'}
                  </span>
                  <span className="archive-open-link">
                    查看详情 <RightOutlined style={{ fontSize: 10 }} />
                  </span>
                </div>
              </div>
            ))}
          </div>
        ) : (
          <Card styles={{ body: { padding: 0 } }}>
            <Table<ArchivePerson>
              rowKey="personKey"
              dataSource={people}
              scroll={{ x: 920 }}
              pagination={{ pageSize: 20, showTotal: (t) => `共 ${t} 人` }}
              onRow={(record) => ({
                onClick: () => setSelectedPerson(record.personKey),
                style: { cursor: 'pointer' },
              })}
              columns={[
                {
                  title: '人员',
                  width: 190,
                  render: (_, r) => (
                    <div>
                      <Space size={6}>
                        <strong>{r.name}</strong>
                        {!r.matchedAccount && <Tag color="gold" bordered={false}>仅历史</Tag>}
                      </Space>
                      <div className="muted small">{[r.username, r.department].filter(Boolean).join(' · ') || '—'}</div>
                    </div>
                  ),
                },
                {
                  title: '总问题',
                  width: 100,
                  sorter: (a, b) => a.totalIssues - b.totalIssues,
                  render: (_, r) => <Tag color={r.totalIssues > 0 ? 'volcano' : 'default'}>{r.totalIssues}</Tag>,
                },
                {
                  title: '大纲检查',
                  width: 150,
                  render: (_, r) => r.outlineDistinctIssues > 0 ? (
                    <span>
                      <strong>{r.outlineDistinctIssues}</strong>
                      {r.outlineLatestRemaining > 0 && <span className="mini-sub-danger">（{r.outlineLatestRemaining} 仍存）</span>}
                    </span>
                  ) : <span className="muted">—</span>,
                },
                {
                  title: '历史导入',
                  width: 100,
                  render: (_, r) => r.historyIssuesCount > 0 ? r.historyIssuesCount : <span className="muted">—</span>,
                },
                {
                  title: '全套材料',
                  width: 100,
                  render: (_, r) => r.materialIssuesCount > 0 ? r.materialIssuesCount : <span className="muted">—</span>,
                },
                {
                  title: '涉及课程',
                  render: (_, r) => r.courseNames.length ? (
                    <Space wrap size={4}>
                      {r.courseNames.slice(0, 4).map((name) => <Tag key={name} bordered={false}>{name}</Tag>)}
                      {r.courseNames.length > 4 && <span className="muted small">+{r.courseNames.length - 4}</span>}
                    </Space>
                  ) : <span className="muted">—</span>,
                },
                {
                  title: '操作',
                  width: 90,
                  fixed: 'right',
                  render: (_, r) => (
                    <Button type="link" size="small" onClick={(e) => { e.stopPropagation(); setSelectedPerson(r.personKey); }}>
                      查看
                    </Button>
                  ),
                },
              ]}
            />
          </Card>
        )}
      </Spin>

      <PersonIssueModal personKey={selectedPerson} onClose={() => setSelectedPerson(null)} />

      <HistoryImportModal
        open={importOpen}
        onClose={() => setImportOpen(false)}
        onImported={() => { void load(); }}
      />

      <Modal
        open={sourcesOpen}
        onCancel={() => setSourcesOpen(false)}
        footer={null}
        title="已导入来源"
        width={720}
        destroyOnHidden
      >
        <Table<ImportedSource>
          rowKey={(r) => `${r.source}|${r.sourceUrl}`}
          loading={sourcesLoading}
          dataSource={sources}
          size="small"
          pagination={false}
          locale={{ emptyText: '暂未导入任何历史问题文档' }}
          columns={[
            {
              title: '来源',
              render: (_, r) => (
                <div>
                  <strong>{r.source}</strong>
                  {r.sourceUrl && (
                    <div className="small">
                      <a href={r.sourceUrl} target="_blank" rel="noopener noreferrer">
                        <LinkOutlined /> 打开原文档
                      </a>
                    </div>
                  )}
                </div>
              ),
            },
            { title: '条数', width: 80, render: (_, r) => r.count },
            { title: '时间', width: 150, dataIndex: 'latestAt' },
            {
              title: '操作',
              width: 80,
              render: (_, r) => (
                <Popconfirm
                  title={`删除「${r.source}」的全部 ${r.count} 条记录？`}
                  okText="删除"
                  okButtonProps={{ danger: true }}
                  onConfirm={() => void removeSource(r.source)}
                >
                  <Button type="link" danger size="small" icon={<DeleteOutlined />}>删除</Button>
                </Popconfirm>
              ),
            },
          ]}
        />
      </Modal>
    </div>
  );
}
