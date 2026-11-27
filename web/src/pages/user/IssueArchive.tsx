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
  FileTextOutlined,
  HistoryOutlined,
  LinkOutlined,
  RightOutlined,
  SearchOutlined,
  UnorderedListOutlined,
  UserOutlined,
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
      message.success(`已删除「${source}」的 ${res.removed} 条历史记录`);
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
          <div className="sub">
            按人员归集大纲历次检查、历史导入表格与全套材料检查的全部问题；同份大纲多次检查的不同问题自动合并去重，点击任意人员即可弹出完整问题档案。
          </div>
        </div>
        <Space wrap>
          {data?.canImport && (
            <>
              <Button icon={<DatabaseOutlined />} onClick={openSources}>
                已导入来源{stats?.importedSourcesCount ? `（${stats.importedSourcesCount}）` : ''}
              </Button>
              <Button type="primary" icon={<CloudUploadOutlined />} onClick={() => setImportOpen(true)}>
                导入历史问题（链接 / 文件）
              </Button>
            </>
          )}
        </Space>
      </div>

      {error && <Alert type="error" showIcon title={error} style={{ marginBottom: 16 }} />}

      {/* 顶部关系总览指标条 */}
      {stats && (
        <div className="archive-kpi-grid">
          <div className="archive-kpi-card">
            <div className="archive-kpi-label">涉及教师</div>
            <div className="archive-kpi-val">
              <strong>{stats.peopleWithIssues}</strong>
              <span className="muted"> / {stats.totalPeople} 人</span>
            </div>
            <div className="archive-kpi-note">点击任意人员卡片查看全部问题</div>
          </div>
          <div className="archive-kpi-card accent-blue">
            <div className="archive-kpi-label">大纲多次检查汇总</div>
            <div className="archive-kpi-val">
              <strong>{stats.totalOutlineIssues}</strong>
              <span className="muted"> 项</span>
            </div>
            <div className="archive-kpi-note">同份大纲多次检查问题自动去重</div>
          </div>
          <div className="archive-kpi-card accent-purple">
            <div className="archive-kpi-label">历史导入问题</div>
            <div className="archive-kpi-val">
              <strong>{stats.totalHistoryIssues}</strong>
              <span className="muted"> 条</span>
            </div>
            <div className="archive-kpi-note">来自 {stats.importedSourcesCount} 个在线表格或上传文件</div>
          </div>
          <div className="archive-kpi-card accent-cyan">
            <div className="archive-kpi-label">全套材料检查</div>
            <div className="archive-kpi-val">
              <strong>{stats.totalMaterialIssues}</strong>
              <span className="muted"> 项</span>
            </div>
            <div className="archive-kpi-note">后续新检查出现的问题会自动同步</div>
          </div>
        </div>
      )}

      {/* 筛选与视图工具栏 */}
      <Card className="archive-toolbar-card" styles={{ body: { padding: '14px 18px' } }}>
        <div className="archive-toolbar">
          <div className="archive-toolbar-left">
            <Input
              allowClear
              prefix={<SearchOutlined style={{ color: '#94a3b8' }} />}
              placeholder="搜索教师姓名、工号、课程名称或问题关键词"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              style={{ width: 'min(320px, 100%)' }}
            />
            <Segmented
              value={sourceFilter}
              onChange={(v) => setSourceFilter(v as typeof sourceFilter)}
              options={[
                { value: 'all', label: '全部来源' },
                { value: 'outline', label: '大纲检查' },
                { value: 'history', label: '历史导入' },
                { value: 'material', label: '全套材料' },
              ]}
            />
          </div>
          <div className="archive-toolbar-right">
            <label className="dossier-switch-label">
              <Switch size="small" checked={onlyWithIssues} onChange={setOnlyWithIssues} />
              <span>仅显示有问题记录</span>
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

      {/* 人员问题目录 */}
      <Spin spinning={loading}>
        {!loading && people.length === 0 ? (
          <Card>
            <Empty
              image={Empty.PRESENTED_IMAGE_SIMPLE}
              description={
                onlyWithIssues && (stats?.totalPeople ?? 0) > 0
                  ? '当前条件下暂无有问题记录的人员，可关闭「仅显示有问题记录」查看全部人员，或导入历史问题文档。'
                  : '暂无匹配的人员问题记录'
              }
            >
              <Space wrap>
                {onlyWithIssues && (
                  <Button onClick={() => setOnlyWithIssues(false)}>查看全部人员</Button>
                )}
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
                className={`archive-person-card${person.totalIssues > 0 ? ' has-issues' : ''}`}
                onClick={() => setSelectedPerson(person.personKey)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    setSelectedPerson(person.personKey);
                  }
                }}
              >
                <div className="archive-person-head">
                  <div className={`archive-avatar${person.totalIssues === 0 ? ' is-quiet' : ''}`}>
                    {person.name ? person.name.slice(0, 1) : <UserOutlined />}
                  </div>
                  <div className="archive-person-id">
                    <div className="archive-person-name-row">
                      <strong>{person.name}</strong>
                      {!person.matchedAccount && <Tag color="gold" bordered={false}>仅历史记录</Tag>}
                    </div>
                    <div className="muted small">
                      {[person.username, person.department].filter(Boolean).join(' · ') || '未关联工号'}
                    </div>
                  </div>
                  <div className={`archive-total-pill${person.totalIssues > 0 ? ' is-warn' : ''}`}>
                    <span className="pill-num">{person.totalIssues}</span>
                    <span className="pill-unit">项问题</span>
                  </div>
                </div>

                <div className="archive-person-metrics">
                  <div className="mini-metric">
                    <span className="mini-label"><FileTextOutlined /> 大纲汇总</span>
                    <span className="mini-val">
                      <strong>{person.outlineDistinctIssues}</strong>
                      {person.outlineLatestRemaining > 0 && (
                        <span className="mini-sub-danger">（{person.outlineLatestRemaining} 仍存）</span>
                      )}
                    </span>
                  </div>
                  <div className="mini-metric">
                    <span className="mini-label"><HistoryOutlined /> 历史导入</span>
                    <span className="mini-val"><strong>{person.historyIssuesCount}</strong></span>
                  </div>
                  <div className="mini-metric">
                    <span className="mini-label">全套材料</span>
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
                        <Tag bordered={false} className="archive-course-tag">+{person.courseNames.length - 3} 门</Tag>
                      )}
                    </>
                  ) : (
                    <span className="muted small">暂无问题课程</span>
                  )}
                </div>

                <div className="archive-person-foot">
                  <span className="muted small">
                    {person.latestActivityAt ? `最近记录：${person.latestActivityAt.slice(0, 16)}` : '暂无检查记录'}
                  </span>
                  <span className="archive-open-link">
                    查看全部问题 <RightOutlined style={{ fontSize: 11 }} />
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
              scroll={{ x: 960 }}
              pagination={{ pageSize: 20, showTotal: (t) => `共 ${t} 位人员` }}
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
                        {!r.matchedAccount && <Tag color="gold" bordered={false}>仅历史记录</Tag>}
                      </Space>
                      <div className="muted small">{[r.username, r.department].filter(Boolean).join(' · ') || '—'}</div>
                    </div>
                  ),
                },
                {
                  title: '汇总总问题',
                  width: 120,
                  sorter: (a, b) => a.totalIssues - b.totalIssues,
                  render: (_, r) => (
                    <Tag color={r.totalIssues > 0 ? 'volcano' : 'default'}>{r.totalIssues} 项</Tag>
                  ),
                },
                {
                  title: '大纲检查汇总',
                  width: 170,
                  render: (_, r) => r.outlineDistinctIssues > 0 ? (
                    <div>
                      <strong>{r.outlineDistinctIssues} 项</strong>
                      <span className="muted small">（{r.outlineChecksCount} 次检查）</span>
                      {r.outlineLatestRemaining > 0 && (
                        <div className="small" style={{ color: '#cf1322' }}>最新仍存 {r.outlineLatestRemaining} 项</div>
                      )}
                    </div>
                  ) : <span className="muted">—</span>,
                },
                {
                  title: '历史导入',
                  width: 110,
                  render: (_, r) => r.historyIssuesCount > 0 ? <Tag color="purple">{r.historyIssuesCount} 条</Tag> : <span className="muted">—</span>,
                },
                {
                  title: '全套材料',
                  width: 110,
                  render: (_, r) => r.materialIssuesCount > 0 ? <Tag color="cyan">{r.materialIssuesCount} 项</Tag> : <span className="muted">—</span>,
                },
                {
                  title: '涉及课程',
                  render: (_, r) => r.courseNames.length ? (
                    <Space wrap size={4}>
                      {r.courseNames.slice(0, 4).map((name) => <Tag key={name} bordered={false}>{name}</Tag>)}
                      {r.courseNames.length > 4 && <span className="muted small">等 {r.courseNames.length} 门</span>}
                    </Space>
                  ) : <span className="muted">—</span>,
                },
                {
                  title: '操作',
                  width: 120,
                  fixed: 'right',
                  render: (_, r) => (
                    <Button type="link" size="small" onClick={(e) => { e.stopPropagation(); setSelectedPerson(r.personKey); }}>
                      弹出问题汇总
                    </Button>
                  ),
                },
              ]}
            />
          </Card>
        )}
      </Spin>

      {/* 弹出式个人完整问题档案 */}
      <PersonIssueModal personKey={selectedPerson} onClose={() => setSelectedPerson(null)} />

      {/* 导入历史问题弹窗 */}
      <HistoryImportModal
        open={importOpen}
        onClose={() => setImportOpen(false)}
        onImported={() => { void load(); }}
      />

      {/* 已导入来源管理弹窗 */}
      <Modal
        open={sourcesOpen}
        onCancel={() => setSourcesOpen(false)}
        footer={null}
        title="已导入的历史问题来源"
        width={760}
        destroyOnHidden
      >
        <Alert
          type="info"
          showIcon
          title="此处列出所有通过文档链接或文件导入的历史问题来源"
          description="如需撤销某次误导入的整表记录，可点击右侧删除；仅删除导入的历史记录，不影响系统内的大纲或材料检查结果。"
          style={{ marginBottom: 16 }}
        />
        <Table<ImportedSource>
          rowKey={(r) => `${r.source}|${r.sourceUrl}`}
          loading={sourcesLoading}
          dataSource={sources}
          size="small"
          pagination={false}
          locale={{ emptyText: '暂未导入任何历史问题文档' }}
          columns={[
            {
              title: '来源文档 / 链接',
              render: (_, r) => (
                <div>
                  <strong>{r.source}</strong>
                  {r.sourceUrl && (
                    <div className="small">
                      <a href={r.sourceUrl} target="_blank" rel="noopener noreferrer">
                        <LinkOutlined /> 打开原在线文档
                      </a>
                    </div>
                  )}
                  {r.uploader && <div className="muted small">导入人：{r.uploader}</div>}
                </div>
              ),
            },
            { title: '记录数', width: 90, render: (_, r) => <Tag color="purple">{r.count} 条</Tag> },
            { title: '导入时间', width: 160, dataIndex: 'latestAt' },
            {
              title: '操作',
              width: 90,
              render: (_, r) => (
                <Popconfirm
                  title={`删除「${r.source}」的全部 ${r.count} 条历史问题？`}
                  description="删除后可随时重新导入。"
                  okText="确认删除"
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
