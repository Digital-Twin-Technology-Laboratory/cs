import {
  Alert,
  App,
  Button,
  Empty,
  Input,
  Modal,
  Segmented,
  Space,
  Spin,
  Switch,
  Tag,
} from 'antd';
import {
  CopyOutlined,
  DownOutlined,
  DownloadOutlined,
  LinkOutlined,
  PrinterOutlined,
  RightOutlined,
  SearchOutlined,
} from '@ant-design/icons';
import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, download } from '../api';
import { NatureTag, SubmissionTag } from './StatusTag';

interface TeacherRef {
  name: string;
  staffNo: string;
}

export interface AggregatedOutlineIssue {
  key: string;
  nature: '重大问题' | '明确问题' | '建议修改' | '需核实';
  title: string;
  locations: string[];
  problem: string;
  advice: string;
  evidence: string;
  itemCodes: string[];
  occurrenceCount: number;
  seqs: number[];
  firstSeenAt: string;
  lastSeenAt: string;
  presentInLatest: boolean;
  occurrences: {
    submissionId: number;
    seq: number;
    date: string;
    fileName: string;
    location: string;
    problem: string;
    advice: string;
  }[];
}

interface OutlineTimelineEntry {
  submissionId: number;
  seq: number;
  fileName: string;
  createdAt: string;
  finishedAt: string | null;
  verdict: 'passed' | 'failed';
  verdictEditedBy: string;
  verdictEditedAt: string | null;
  uploaderName: string;
  relation: '本人上传' | '执笔课程' | '共同任课';
  majorCount: number;
  suggestionCount: number;
  verifyCount: number;
  canViewSubmission: boolean;
  issues: {
    nature: '重大问题' | '明确问题' | '建议修改';
    title: string;
    location: string;
    problem: string;
    advice: string;
    evidence: string;
  }[];
  toVerify: { location: string; content: string }[];
}

interface AggregatedOutlineCourse {
  courseKey: string;
  courseName: string;
  major: string;
  studentGrade: number;
  trainingType: string;
  relation: '本人上传' | '执笔课程' | '共同任课';
  checkCount: number;
  latestSubmissionId: number;
  latestSeq: number;
  latestVerdict: 'passed' | 'failed';
  latestAt: string;
  remainingCount: number;
  resolvedCount: number;
  aggregatedIssues: AggregatedOutlineIssue[];
  timeline: OutlineTimelineEntry[];
}

interface MaterialIssueItem {
  title: string;
  detail: string;
  action?: string;
  locations: string[];
  materials: string[];
  history?: string;
}

interface PersonMaterialCase {
  caseId: number;
  runId: number;
  title: string;
  courseCode: string;
  major: string;
  term: string;
  section: string;
  verdict: string;
  finishedAt: string;
  issueCount: number;
  report: {
    materials: { material: string; source?: string; sections: { label: string; issues: MaterialIssueItem[] }[] }[];
    missing: string[];
    toVerify: MaterialIssueItem[];
  };
}

interface PersonHistoryItem {
  id: string;
  text: string;
  points: string[];
  category: string;
  checkItem: string;
  nature: string;
  reviewer: string;
  source: string;
  sourceUrl: string;
  position: string;
  teachers: TeacherRef[];
  date: string;
  uploader: string;
}

interface PersonHistoryCourse {
  courseKey: string;
  courseName: string;
  courseCode: string;
  major: string;
  totalCount: number;
  groups: {
    groupKey: string;
    term: string;
    context: string;
    examType: string;
    items: PersonHistoryItem[];
  }[];
}

export interface PersonIssueDossier {
  person: {
    personKey: string;
    userId: number | null;
    name: string;
    username: string;
    department: string;
    matchedAccount: boolean;
  };
  summary: {
    totalDistinctIssues: number;
    outlineCoursesCount: number;
    outlineChecksCount: number;
    outlineDistinctIssues: number;
    outlineLatestRemaining: number;
    outlineResolvedInLater: number;
    materialIssuesCount: number;
    historyIssuesCount: number;
    severeCount: number;
    suggestionCount: number;
    verifyCount: number;
  };
  outlineCourses: AggregatedOutlineCourse[];
  materialCases: PersonMaterialCase[];
  historyCourses: PersonHistoryCourse[];
}

type NavEntry =
  | { id: string; kind: 'outline'; title: string; count: number; activeCount: number; checkCount: number; course: AggregatedOutlineCourse }
  | { id: string; kind: 'history'; title: string; count: number; course: PersonHistoryCourse }
  | { id: string; kind: 'material'; title: string; count: number; item: PersonMaterialCase };

function formatPlainText(dossier: PersonIssueDossier): string {
  const lines: string[] = [];
  const { person, summary } = dossier;
  lines.push(`【问题记录汇总】${person.name}${person.username ? `（${person.username}）` : ''}`);
  lines.push(
    `共 ${summary.totalDistinctIssues} 项：大纲 ${summary.outlineDistinctIssues} 项（仍存 ${summary.outlineLatestRemaining} 项）、历史导入 ${summary.historyIssuesCount} 条、全套材料 ${summary.materialIssuesCount} 项。`,
  );

  if (dossier.outlineCourses.length) {
    lines.push('\n一、大纲检查汇总');
    for (const c of dossier.outlineCourses) {
      lines.push(`\n《${c.courseName}》${[c.studentGrade ? `${c.studentGrade}级` : '', c.major, `${c.checkCount}次检查`, c.latestVerdict === 'passed' ? '已通过' : '未通过'].filter(Boolean).join(' · ')}`);
      c.aggregatedIssues.forEach((issue, idx) => {
        const status = issue.presentInLatest ? '仍存' : '已消';
        const freq = issue.seqs.length > 1 ? `第${issue.seqs.join('、')}次` : `第${issue.seqs[0]}次`;
        lines.push(`  ${idx + 1}. [${issue.nature}] ${issue.title}（${freq} · ${status}）`);
        if (issue.locations.length) lines.push(`     位置：${issue.locations.join('；')}`);
        lines.push(`     问题：${issue.problem}`);
        if (issue.advice) lines.push(`     建议：${issue.advice}`);
      });
    }
  }

  if (dossier.historyCourses.length) {
    lines.push('\n二、历史导入问题');
    for (const c of dossier.historyCourses) {
      lines.push(`\n《${c.courseName}》${[c.courseCode, c.major].filter(Boolean).join(' · ')}`);
      for (const g of c.groups) {
        const meta = [g.term, g.context, g.examType].filter(Boolean).join(' · ');
        if (meta) lines.push(`  [${meta}]`);
        g.items.forEach((item, idx) => {
          const prefix = [item.category, item.checkItem].filter(Boolean).join(' / ');
          const body = item.points.length > 1 ? item.points.map((p, pi) => `(${pi + 1}) ${p}`).join('；') : item.points[0] || item.text;
          lines.push(`  ${idx + 1}. ${prefix ? `【${prefix}】` : ''}${body}${item.reviewer ? `（检查人：${item.reviewer}）` : ''}`);
        });
      }
    }
  }

  if (dossier.materialCases.length) {
    lines.push('\n三、全套材料检查');
    for (const m of dossier.materialCases) {
      lines.push(`\n《${m.title}》${[m.term, m.section, m.major].filter(Boolean).join(' · ')}`);
      for (const mat of m.report.materials) {
        lines.push(`  [${mat.material}]`);
        for (const sec of mat.sections) {
          sec.issues.forEach((it, idx) => {
            lines.push(`    ${idx + 1}. [${sec.label}] ${it.title}：${it.detail}`);
            if (it.action) lines.push(`       建议：${it.action}`);
          });
        }
      }
    }
  }

  return lines.join('\n');
}

const categoryTone = (category: string): string => {
  if (category.includes('大纲')) return 'blue';
  if (category.includes('进度')) return 'cyan';
  if (category.includes('细目') || category.includes('命题')) return 'purple';
  if (category.includes('平时') || category.includes('实验')) return 'geekblue';
  if (category.includes('试卷') || category.includes('成绩')) return 'volcano';
  return 'default';
};

export default function PersonIssueModal({
  personKey,
  onClose,
}: {
  personKey: string | null;
  onClose: () => void;
}) {
  const { message } = App.useApp();
  const [data, setData] = useState<PersonIssueDossier | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [keyword, setKeyword] = useState('');
  const [selectedId, setSelectedId] = useState<string>('');
  const [onlyActive, setOnlyActive] = useState(false);
  const [outlineMode, setOutlineMode] = useState<'summary' | 'timeline'>('summary');
  const [expandedKeys, setExpandedKeys] = useState<Set<string>>(new Set());

  useEffect(() => {
    if (!personKey) {
      setData(null);
      setError('');
      return;
    }
    let active = true;
    setLoading(true);
    setError('');
    setKeyword('');
    setSelectedId('');
    setOnlyActive(false);
    setOutlineMode('summary');
    setExpandedKeys(new Set());
    api.get<PersonIssueDossier>(`/api/issue-archive/people/${encodeURIComponent(personKey)}`)
      .then((res) => { if (active) setData(res); })
      .catch((e: Error) => { if (active) setError(e.message); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [personKey]);

  const q = keyword.trim().toLowerCase();

  const navEntries = useMemo<NavEntry[]>(() => {
    if (!data) return [];
    const entries: NavEntry[] = [];

    for (const c of data.outlineCourses) {
      const issues = c.aggregatedIssues.filter((i) => {
        if (onlyActive && !i.presentInLatest) return false;
        if (!q) return true;
        return `${c.courseName} ${i.title} ${i.problem} ${i.advice} ${i.locations.join(' ')} ${i.nature}`.toLowerCase().includes(q);
      });
      if (issues.length === 0 && (q || onlyActive)) continue;
      entries.push({
        id: `outline:${c.courseKey}`,
        kind: 'outline',
        title: c.courseName,
        count: issues.length,
        activeCount: issues.filter((i) => i.presentInLatest).length,
        checkCount: c.checkCount,
        course: { ...c, aggregatedIssues: issues },
      });
    }

    for (const h of data.historyCourses) {
      const groups = h.groups
        .map((g) => ({
          ...g,
          items: g.items.filter((it) => {
            if (!q) return true;
            return `${h.courseName} ${h.courseCode} ${g.term} ${g.context} ${it.text} ${it.category} ${it.checkItem} ${it.reviewer} ${it.source}`.toLowerCase().includes(q);
          }),
        }))
        .filter((g) => g.items.length > 0);
      if (!groups.length) continue;
      const totalCount = groups.reduce((s, g) => s + g.items.length, 0);
      entries.push({
        id: `history:${h.courseKey}`,
        kind: 'history',
        title: h.courseName,
        count: totalCount,
        course: { ...h, groups, totalCount },
      });
    }

    for (const m of data.materialCases) {
      if (q && !`${m.title} ${m.term} ${m.section} ${JSON.stringify(m.report)}`.toLowerCase().includes(q)) continue;
      entries.push({
        id: `material:${m.caseId}`,
        kind: 'material',
        title: m.title,
        count: m.issueCount,
        item: m,
      });
    }

    return entries;
  }, [data, q, onlyActive]);

  const activeEntry = useMemo(
    () => navEntries.find((e) => e.id === selectedId) ?? navEntries[0] ?? null,
    [navEntries, selectedId],
  );

  // When switching courses, auto-expand if the course has <= 5 issues; otherwise start compact for easy scanning
  useEffect(() => {
    setOutlineMode('summary');
    if (activeEntry?.kind === 'outline') {
      const list = activeEntry.course.aggregatedIssues;
      if (list.length <= 5) {
        setExpandedKeys(new Set(list.map((i) => i.key)));
      } else {
        setExpandedKeys(new Set());
      }
    } else {
      setExpandedKeys(new Set());
    }
  }, [activeEntry?.id]);

  const toggleExpand = (key: string) => {
    setExpandedKeys((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const copyAll = async () => {
    if (!data) return;
    try {
      await navigator.clipboard.writeText(formatPlainText(data));
      message.success('已复制问题汇总');
    } catch {
      message.error('复制失败');
    }
  };

  const outlineNav = navEntries.filter((e) => e.kind === 'outline');
  const historyNav = navEntries.filter((e) => e.kind === 'history');
  const materialNav = navEntries.filter((e) => e.kind === 'material');

  const allExpanded = activeEntry?.kind === 'outline'
    && activeEntry.course.aggregatedIssues.length > 0
    && activeEntry.course.aggregatedIssues.every((i) => expandedKeys.has(i.key));

  return (
    <Modal
      open={!!personKey}
      onCancel={onClose}
      footer={null}
      width="min(1140px, 96vw)"
      centered
      destroyOnHidden
      className="dossier-modal"
      styles={{ body: { padding: 0, overflow: 'hidden' } }}
    >
      {loading && (
        <div style={{ padding: '72px 24px', textAlign: 'center' }}>
          <Spin />
        </div>
      )}
      {!loading && error && (
        <div style={{ padding: 24 }}>
          <Alert type="error" showIcon title={error} />
        </div>
      )}
      {!loading && data && (
        <div className="dossier-shell">
          {/* 单行精简顶栏：姓名 + 工号 + 核心计数 + 操作 */}
          <div className="dossier-topbar">
            <div className="dossier-topbar-left">
              <h2>{data.person.name}</h2>
              {data.person.username && <span className="dossier-staff-no">{data.person.username}</span>}
              {data.person.department && <span className="muted small">{data.person.department}</span>}
              {!data.person.matchedAccount && <Tag color="gold" bordered={false}>仅历史记录</Tag>}
              <span className="dossier-topbar-sep" />
              <div className="dossier-inline-stats">
                <span>共 <strong>{data.summary.totalDistinctIssues}</strong> 项</span>
                {data.summary.outlineDistinctIssues > 0 && (
                  <span>
                    大纲 <strong>{data.summary.outlineDistinctIssues}</strong>
                    {data.summary.outlineLatestRemaining > 0 && (
                      <em className="stat-warn">（{data.summary.outlineLatestRemaining} 仍存）</em>
                    )}
                  </span>
                )}
                {data.summary.historyIssuesCount > 0 && (
                  <span>历史 <strong>{data.summary.historyIssuesCount}</strong></span>
                )}
                {data.summary.materialIssuesCount > 0 && (
                  <span>材料 <strong>{data.summary.materialIssuesCount}</strong></span>
                )}
              </div>
            </div>
            <Space size={8} className="no-print" style={{ paddingRight: 32 }}>
              <Button size="small" icon={<CopyOutlined />} onClick={() => void copyAll()} disabled={data.summary.totalDistinctIssues === 0}>
                复制
              </Button>
              <Button size="small" icon={<PrinterOutlined />} onClick={() => window.print()} disabled={data.summary.totalDistinctIssues === 0}>
                打印
              </Button>
            </Space>
          </div>

          {data.summary.totalDistinctIssues === 0 ? (
            <div className="dossier-empty-wrap">
              <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无问题记录" />
            </div>
          ) : (
            <div className="dossier-split">
              {/* 左侧课程目录树：一眼看清所有课程与问题归属关系 */}
              <aside className="dossier-sidebar no-print">
                <div className="dossier-sidebar-tools">
                  <Input
                    size="small"
                    allowClear
                    prefix={<SearchOutlined style={{ color: '#94a3b8' }} />}
                    placeholder="筛选课程或问题"
                    value={keyword}
                    onChange={(e) => setKeyword(e.target.value)}
                  />
                  {data.summary.outlineDistinctIssues > 0 && (
                    <label className="dossier-switch-label">
                      <Switch size="small" checked={onlyActive} onChange={setOnlyActive} />
                      <span>仅看仍存</span>
                    </label>
                  )}
                </div>

                <div className="dossier-nav-list">
                  {outlineNav.length > 0 && (
                    <div className="dossier-nav-group">
                      <div className="dossier-nav-group-label">大纲检查（{outlineNav.length}）</div>
                      {outlineNav.map((entry) => {
                        const selected = activeEntry?.id === entry.id;
                        return (
                          <button
                            key={entry.id}
                            type="button"
                            className={`dossier-nav-item${selected ? ' is-selected' : ''}`}
                            onClick={() => setSelectedId(entry.id)}
                          >
                            <div className="dossier-nav-title">{entry.title}</div>
                            <div className="dossier-nav-meta">
                              <span>{entry.count} 项 · {entry.checkCount} 次</span>
                              {entry.activeCount > 0
                                ? <span className="nav-dot-warn">{entry.activeCount} 仍存</span>
                                : <span className="nav-dot-ok">已消</span>}
                            </div>
                          </button>
                        );
                      })}
                    </div>
                  )}

                  {historyNav.length > 0 && (
                    <div className="dossier-nav-group">
                      <div className="dossier-nav-group-label">历史导入（{historyNav.length}）</div>
                      {historyNav.map((entry) => {
                        const selected = activeEntry?.id === entry.id;
                        return (
                          <button
                            key={entry.id}
                            type="button"
                            className={`dossier-nav-item${selected ? ' is-selected' : ''}`}
                            onClick={() => setSelectedId(entry.id)}
                          >
                            <div className="dossier-nav-title">{entry.title}</div>
                            <div className="dossier-nav-meta">
                              <span>{entry.count} 条</span>
                            </div>
                          </button>
                        );
                      })}
                    </div>
                  )}

                  {materialNav.length > 0 && (
                    <div className="dossier-nav-group">
                      <div className="dossier-nav-group-label">全套材料（{materialNav.length}）</div>
                      {materialNav.map((entry) => {
                        const selected = activeEntry?.id === entry.id;
                        return (
                          <button
                            key={entry.id}
                            type="button"
                            className={`dossier-nav-item${selected ? ' is-selected' : ''}`}
                            onClick={() => setSelectedId(entry.id)}
                          >
                            <div className="dossier-nav-title">{entry.title}</div>
                            <div className="dossier-nav-meta">
                              <span>{entry.count} 项</span>
                            </div>
                          </button>
                        );
                      })}
                    </div>
                  )}

                  {navEntries.length === 0 && (
                    <div className="muted small" style={{ padding: '24px 12px', textAlign: 'center' }}>
                      无匹配课程
                    </div>
                  )}
                </div>
              </aside>

              {/* 右侧主阅读区：聚焦当前选中的一门课，清爽分层 */}
              <main className="dossier-main">
                {!activeEntry ? (
                  <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="当前筛选条件下无记录" style={{ marginTop: 64 }} />
                ) : activeEntry.kind === 'outline' ? (
                  <>
                    <div className="dossier-pane-head">
                      <div className="dossier-pane-title-wrap">
                        <div className="dossier-pane-title-row">
                          <h3>{activeEntry.course.courseName}</h3>
                          <SubmissionTag status="done" verdict={activeEntry.course.latestVerdict} />
                          <Tag bordered={false}>{activeEntry.course.relation}</Tag>
                        </div>
                        <div className="dossier-pane-meta">
                          {[
                            activeEntry.course.studentGrade ? `${activeEntry.course.studentGrade}级` : '',
                            activeEntry.course.major,
                            `共 ${activeEntry.course.checkCount} 次检查`,
                            `最近 ${activeEntry.course.latestAt.slice(0, 16)}`,
                          ].filter(Boolean).join(' · ')}
                        </div>
                      </div>
                      <Space size={8} wrap className="no-print">
                        {outlineMode === 'summary' && activeEntry.course.aggregatedIssues.length > 1 && (
                          <Button
                            size="small"
                            type="text"
                            onClick={() => {
                              if (allExpanded) setExpandedKeys(new Set());
                              else setExpandedKeys(new Set(activeEntry.course.aggregatedIssues.map((i) => i.key)));
                            }}
                          >
                            {allExpanded ? '全部收起' : '全部展开'}
                          </Button>
                        )}
                        <Segmented
                          size="small"
                          value={outlineMode}
                          onChange={(v) => setOutlineMode(v as 'summary' | 'timeline')}
                          options={[
                            { value: 'summary', label: `汇总 (${activeEntry.course.aggregatedIssues.length})` },
                            { value: 'timeline', label: `按次 (${activeEntry.course.checkCount})` },
                          ]}
                        />
                      </Space>
                    </div>

                    {outlineMode === 'summary' ? (
                      <div className="dossier-clean-list">
                        {activeEntry.course.aggregatedIssues.map((issue, idx) => {
                          const expanded = expandedKeys.has(issue.key);
                          return (
                            <div key={issue.key} className={`dossier-row${expanded ? ' is-open' : ''}`}>
                              <div
                                role="button"
                                tabIndex={0}
                                className="dossier-row-head"
                                onClick={() => toggleExpand(issue.key)}
                                onKeyDown={(e) => {
                                  if (e.key === 'Enter' || e.key === ' ') {
                                    e.preventDefault();
                                    toggleExpand(issue.key);
                                  }
                                }}
                              >
                                <span className="dossier-row-chevron">
                                  {expanded ? <DownOutlined /> : <RightOutlined />}
                                </span>
                                <span className="dossier-row-num">{String(idx + 1).padStart(2, '0')}</span>
                                {issue.nature === '需核实'
                                  ? <Tag color="gold" bordered={false}>需核实</Tag>
                                  : <NatureTag nature={issue.nature} />}
                                <div className="dossier-row-title-col">
                                  <div className="dossier-row-title">{issue.title}</div>
                                  {issue.locations.length > 0 && (
                                    <div className="dossier-row-loc">{issue.locations.join('；')}</div>
                                  )}
                                </div>
                                <div className="dossier-row-right">
                                  <span className="dossier-freq-chip">
                                    {issue.occurrenceCount > 1 ? `第${issue.seqs.join('、')}次` : `第${issue.seqs[0]}次`}
                                  </span>
                                  <span className={`dossier-status-chip ${issue.presentInLatest ? 'is-active' : 'is-cleared'}`}>
                                    {issue.presentInLatest ? '仍存' : '已消'}
                                  </span>
                                </div>
                              </div>

                              {expanded && (
                                <div className="dossier-row-detail">
                                  <p className="dossier-detail-prose">{issue.problem}</p>
                                  {issue.advice && (
                                    <div className="dossier-detail-advice">
                                      <span className="advice-tag">建议</span>
                                      <span>{issue.advice}</span>
                                    </div>
                                  )}
                                  <div className="dossier-detail-foot no-print">
                                    {issue.occurrences.map((occ, oi) => (
                                      <Link
                                        key={`${occ.submissionId}-${oi}`}
                                        to={`/submissions/${occ.submissionId}`}
                                        target="_blank"
                                        rel="noopener noreferrer"
                                      >
                                        第{occ.seq}次报告（{occ.date.slice(0, 10)}）
                                      </Link>
                                    ))}
                                    {issue.evidence && (
                                      <details className="dossier-inline-evidence">
                                        <summary>原文依据</summary>
                                        <div className="dossier-evidence-text">{issue.evidence}</div>
                                      </details>
                                    )}
                                  </div>
                                </div>
                              )}
                            </div>
                          );
                        })}
                      </div>
                    ) : (
                      <div className="dossier-timeline">
                        {activeEntry.course.timeline.map((entry) => (
                          <div key={entry.submissionId} className="dossier-timeline-node">
                            <div className="dossier-timeline-dot" />
                            <div className="dossier-timeline-content">
                              <div className="dossier-timeline-head">
                                <Space wrap size={8}>
                                  <strong>第 {entry.seq} 次</strong>
                                  <SubmissionTag status="done" verdict={entry.verdict} />
                                  <span className="muted small">{(entry.finishedAt || entry.createdAt).slice(0, 16)}</span>
                                  <span className="muted small">{entry.fileName}</span>
                                </Space>
                                {entry.canViewSubmission && (
                                  <Space size={8} className="no-print">
                                    <Link to={`/submissions/${entry.submissionId}`} target="_blank" rel="noopener noreferrer">
                                      查看报告
                                    </Link>
                                    <Button size="small" type="text" icon={<DownloadOutlined />} onClick={() => download(`/api/submissions/${entry.submissionId}/report.docx`)}>
                                      Word
                                    </Button>
                                  </Space>
                                )}
                              </div>
                              {(entry.issues.length > 0 || entry.toVerify.length > 0) ? (
                                <ul className="dossier-timeline-brief">
                                  {entry.issues.map((it, ii) => (
                                    <li key={ii}>
                                      <NatureTag nature={it.nature} />
                                      <span>{it.title}</span>
                                    </li>
                                  ))}
                                  {entry.toVerify.map((tv, ti) => (
                                    <li key={`v-${ti}`}>
                                      <Tag color="gold" bordered={false}>需核实</Tag>
                                      <span>{tv.content}</span>
                                    </li>
                                  ))}
                                </ul>
                              ) : (
                                <div className="muted small" style={{ marginTop: 6 }}>无问题</div>
                              )}
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                  </>
                ) : activeEntry.kind === 'history' ? (
                  <>
                    <div className="dossier-pane-head">
                      <div className="dossier-pane-title-wrap">
                        <div className="dossier-pane-title-row">
                          <h3>{activeEntry.course.courseName}</h3>
                          {activeEntry.course.courseCode && <Tag bordered={false}>{activeEntry.course.courseCode}</Tag>}
                          {activeEntry.course.major && <Tag bordered={false}>{activeEntry.course.major}</Tag>}
                        </div>
                        <div className="dossier-pane-meta">历史导入 · 共 {activeEntry.course.totalCount} 条</div>
                      </div>
                    </div>

                    <div className="dossier-history-clean">
                      {activeEntry.course.groups.map((group) => (
                        <div key={group.groupKey} className="dossier-history-block">
                          {(group.term || group.context || group.examType) && (
                            <div className="dossier-history-block-head">
                              {[group.term, group.context, group.examType].filter(Boolean).join(' · ')}
                            </div>
                          )}
                          <div className="dossier-clean-list">
                            {group.items.map((item, idx) => (
                              <div key={item.id} className="dossier-history-row">
                                <div className="dossier-history-row-top">
                                  <span className="dossier-row-num">{String(idx + 1).padStart(2, '0')}</span>
                                  {(item.category || item.nature) && (
                                    <Tag color={categoryTone(item.category || item.nature)} bordered={false}>
                                      {item.category || item.nature}
                                    </Tag>
                                  )}
                                  {item.checkItem && <span className="dossier-check-criterion">{item.checkItem}</span>}
                                  {item.reviewer && <span className="muted small" style={{ marginLeft: 'auto' }}>检查人：{item.reviewer}</span>}
                                </div>
                                <div className="dossier-history-row-body">
                                  {item.points.length > 1 ? (
                                    <ol className="dossier-numbered-points">
                                      {item.points.map((pt, pi) => <li key={pi}>{pt}</li>)}
                                    </ol>
                                  ) : (
                                    <div className="dossier-detail-prose">{item.points[0] || item.text}</div>
                                  )}
                                </div>
                                <div className="dossier-history-row-foot">
                                  {item.sourceUrl ? (
                                    <a href={item.sourceUrl} target="_blank" rel="noopener noreferrer">
                                      <LinkOutlined /> {item.source}
                                    </a>
                                  ) : (
                                    <span>{item.source}</span>
                                  )}
                                  {item.position && <span>{item.position}</span>}
                                  {item.teachers.length > 1 && (
                                    <span>合授：{item.teachers.map((t) => t.name || t.staffNo).join('、')}</span>
                                  )}
                                </div>
                              </div>
                            ))}
                          </div>
                        </div>
                      ))}
                    </div>
                  </>
                ) : (
                  <>
                    <div className="dossier-pane-head">
                      <div className="dossier-pane-title-wrap">
                        <div className="dossier-pane-title-row">
                          <h3>{activeEntry.item.title}</h3>
                          <Tag color={activeEntry.item.verdict === 'passed' ? 'green' : activeEntry.item.verdict === 'partial' ? 'gold' : 'red'}>
                            {activeEntry.item.verdict === 'passed' ? '通过' : activeEntry.item.verdict === 'partial' ? '部分通过' : '需整改'}
                          </Tag>
                        </div>
                        <div className="dossier-pane-meta">
                          {[activeEntry.item.term, activeEntry.item.section, activeEntry.item.major, activeEntry.item.finishedAt.slice(0, 16)].filter(Boolean).join(' · ')}
                        </div>
                      </div>
                      <Link className="no-print" to={`/materials/${activeEntry.item.caseId}`} target="_blank" rel="noopener noreferrer">
                        打开材料档案
                      </Link>
                    </div>
                    <div className="dossier-history-clean">
                      {activeEntry.item.report.materials.map((mat) => (
                        <div key={mat.material} className="dossier-history-block">
                          <div className="dossier-history-block-head">{mat.material}</div>
                          <div className="dossier-clean-list">
                            {mat.sections.flatMap((sec) => sec.issues.map((it, ii) => (
                              <div key={`${sec.label}-${ii}`} className="dossier-history-row">
                                <div className="dossier-history-row-top">
                                  <Tag color={sec.label === '重大及明确问题' ? 'error' : 'blue'} bordered={false}>{sec.label}</Tag>
                                  <strong>{it.title}</strong>
                                </div>
                                {it.locations.length > 0 && <div className="dossier-row-loc">{it.locations.join('；')}</div>}
                                {it.detail !== it.title && <p className="dossier-detail-prose">{it.detail}</p>}
                                {it.action && (
                                  <div className="dossier-detail-advice">
                                    <span className="advice-tag">建议</span>
                                    <span>{it.action}</span>
                                  </div>
                                )}
                              </div>
                            )))}
                          </div>
                        </div>
                      ))}
                    </div>
                  </>
                )}
              </main>
            </div>
          )}
        </div>
      )}
    </Modal>
  );
}
