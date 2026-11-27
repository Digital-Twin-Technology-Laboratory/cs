import {
  Alert,
  App,
  Button,
  Collapse,
  Empty,
  Input,
  Modal,
  Segmented,
  Select,
  Space,
  Spin,
  Switch,
  Tag,
  Tooltip,
} from 'antd';
import {
  CheckCircleOutlined,
  ClockCircleOutlined,
  CopyOutlined,
  DownloadOutlined,
  ExclamationCircleOutlined,
  FileTextOutlined,
  FolderOpenOutlined,
  HistoryOutlined,
  LinkOutlined,
  PrinterOutlined,
  SearchOutlined,
  UserOutlined,
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

function formatPlainText(dossier: PersonIssueDossier): string {
  const lines: string[] = [];
  const { person, summary } = dossier;
  lines.push(`【教师问题记录汇总】${person.name}${person.username ? `（${person.username}）` : ''}`);
  lines.push(
    `共汇总 ${summary.totalDistinctIssues} 项问题：大纲多次检查汇总 ${summary.outlineDistinctIssues} 项（最新仍存 ${summary.outlineLatestRemaining} 项 / 后续已消 ${summary.outlineResolvedInLater} 项）、历史导入 ${summary.historyIssuesCount} 条、全套材料检查 ${summary.materialIssuesCount} 项。`,
  );

  if (dossier.outlineCourses.length) {
    lines.push('\n一、大纲历次检查问题汇总');
    for (const c of dossier.outlineCourses) {
      lines.push(`\n《${c.courseName}》${[c.studentGrade ? `${c.studentGrade}级` : '', c.major, `共检查 ${c.checkCount} 次`, c.latestVerdict === 'passed' ? '最新：已通过' : '最新：未通过'].filter(Boolean).join(' · ')}`);
      c.aggregatedIssues.forEach((issue, idx) => {
        const status = issue.presentInLatest ? '最新一次仍存在' : '后续检查未再出现';
        const freq = issue.seqs.length > 1 ? `第${issue.seqs.join('、')}次共出现${issue.occurrenceCount}次` : `第${issue.seqs[0]}次出现`;
        lines.push(`  ${idx + 1}. [${issue.nature}] ${issue.title}（${freq}；${status}）`);
        if (issue.locations.length) lines.push(`     位置：${issue.locations.join('；')}`);
        lines.push(`     问题：${issue.problem}`);
        if (issue.advice) lines.push(`     建议：${issue.advice}`);
      });
    }
  }

  if (dossier.historyCourses.length) {
    lines.push('\n二、历史导入问题记录');
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
    lines.push('\n三、全套材料检查问题');
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
  const [section, setSection] = useState<'all' | 'outline' | 'history' | 'material'>('all');
  const [courseFilter, setCourseFilter] = useState<string>('');
  const [keyword, setKeyword] = useState('');
  const [onlyActive, setOnlyActive] = useState(false);
  const [courseModes, setCourseModes] = useState<Record<string, 'summary' | 'timeline'>>({});

  useEffect(() => {
    if (!personKey) {
      setData(null);
      setError('');
      return;
    }
    let active = true;
    setLoading(true);
    setError('');
    setSection('all');
    setCourseFilter('');
    setKeyword('');
    setOnlyActive(false);
    setCourseModes({});
    api.get<PersonIssueDossier>(`/api/issue-archive/people/${encodeURIComponent(personKey)}`)
      .then((res) => { if (active) setData(res); })
      .catch((e: Error) => { if (active) setError(e.message); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [personKey]);

  const allCourseNames = useMemo(() => {
    if (!data) return [];
    const set = new Set<string>();
    data.outlineCourses.forEach((c) => set.add(c.courseName));
    data.historyCourses.forEach((c) => set.add(c.courseName));
    data.materialCases.forEach((m) => set.add(m.title));
    return [...set].sort((a, b) => a.localeCompare(b, 'zh-CN'));
  }, [data]);

  const q = keyword.trim().toLowerCase();

  const filteredOutline = useMemo(() => {
    if (!data) return [];
    return data.outlineCourses
      .filter((c) => !courseFilter || c.courseName === courseFilter)
      .map((c) => {
        const issues = c.aggregatedIssues.filter((i) => {
          if (onlyActive && !i.presentInLatest) return false;
          if (!q) return true;
          return `${c.courseName} ${i.title} ${i.problem} ${i.advice} ${i.locations.join(' ')} ${i.nature}`.toLowerCase().includes(q);
        });
        return { ...c, aggregatedIssues: issues };
      })
      .filter((c) => c.aggregatedIssues.length > 0 || (!q && !onlyActive && c.timeline.length > 0));
  }, [data, courseFilter, q, onlyActive]);

  const filteredHistory = useMemo(() => {
    if (!data) return [];
    return data.historyCourses
      .filter((c) => !courseFilter || c.courseName === courseFilter)
      .map((c) => {
        const groups = c.groups
          .map((g) => ({
            ...g,
            items: g.items.filter((it) => {
              if (!q) return true;
              return `${c.courseName} ${c.courseCode} ${g.term} ${g.context} ${it.text} ${it.category} ${it.checkItem} ${it.reviewer} ${it.source}`.toLowerCase().includes(q);
            }),
          }))
          .filter((g) => g.items.length > 0);
        return { ...c, groups, totalCount: groups.reduce((s, g) => s + g.items.length, 0) };
      })
      .filter((c) => c.groups.length > 0);
  }, [data, courseFilter, q]);

  const filteredMaterials = useMemo(() => {
    if (!data) return [];
    return data.materialCases.filter((m) => {
      if (courseFilter && m.title !== courseFilter) return false;
      if (!q) return true;
      return `${m.title} ${m.term} ${m.section} ${JSON.stringify(m.report)}`.toLowerCase().includes(q);
    });
  }, [data, courseFilter, q]);

  const copyAll = async () => {
    if (!data) return;
    try {
      await navigator.clipboard.writeText(formatPlainText(data));
      message.success('已复制该教师的完整问题汇总文本');
    } catch {
      message.error('复制失败，请手动选中复制');
    }
  };

  const showOutline = section === 'all' || section === 'outline';
  const showHistory = section === 'all' || section === 'history';
  const showMaterial = section === 'all' || section === 'material';
  const hasVisibleContent = (showOutline && filteredOutline.length > 0)
    || (showHistory && filteredHistory.length > 0)
    || (showMaterial && filteredMaterials.length > 0);

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
          <Spin size="large" />
          <div className="muted" style={{ marginTop: 12 }}>正在整理该教师的全部问题档案...</div>
        </div>
      )}
      {!loading && error && (
        <div style={{ padding: 24 }}>
          <Alert type="error" showIcon title={error} />
        </div>
      )}
      {!loading && data && (
        <div className="dossier-shell">
          {/* 顶部固定头部（精简高度，把最大视野留给正文阅读） */}
          <div className="dossier-header">
            <div className="dossier-person-row">
              <div className="dossier-avatar">
                {data.person.name ? data.person.name.slice(0, 1) : <UserOutlined />}
              </div>
              <div className="dossier-person-meta">
                <div className="dossier-person-title">
                  <h2>{data.person.name}</h2>
                  {data.person.username && <span className="dossier-staff-no">{data.person.username}</span>}
                  {data.person.department && <Tag>{data.person.department}</Tag>}
                  {!data.person.matchedAccount && <Tag color="gold">仅历史表记录（尚未绑定账号）</Tag>}
                </div>
                <div className="dossier-person-sub">
                  同份大纲多次检查的不同问题已合并去重，并与导入历史问题、全套材料检查统一归档。
                </div>
              </div>
              <Space wrap className="no-print">
                <Button size="small" icon={<CopyOutlined />} onClick={() => void copyAll()} disabled={data.summary.totalDistinctIssues === 0}>
                  复制汇总
                </Button>
                <Button size="small" icon={<PrinterOutlined />} onClick={() => window.print()} disabled={data.summary.totalDistinctIssues === 0}>
                  打印
                </Button>
              </Space>
            </div>

            {/* 筛选与分区切换栏 */}
            <div className="dossier-filter-bar no-print">
              <Segmented
                size="small"
                value={section}
                onChange={(v) => setSection(v as typeof section)}
                options={[
                  { value: 'all', label: `全部总览 (${data.summary.totalDistinctIssues})` },
                  { value: 'outline', label: `大纲汇总 (${data.summary.outlineDistinctIssues})` },
                  { value: 'history', label: `历史导入 (${data.summary.historyIssuesCount})` },
                  { value: 'material', label: `全套材料 (${data.summary.materialIssuesCount})` },
                ]}
              />
              <div className="dossier-filter-controls">
                <Select
                  size="small"
                  allowClear
                  showSearch
                  optionFilterProp="label"
                  placeholder="按课程筛选"
                  style={{ width: 170 }}
                  value={courseFilter || undefined}
                  onChange={(v) => setCourseFilter(v ?? '')}
                  options={allCourseNames.map((name) => ({ value: name, label: name }))}
                />
                <Input
                  size="small"
                  allowClear
                  prefix={<SearchOutlined style={{ color: '#94a3b8' }} />}
                  placeholder="搜索问题、位置..."
                  style={{ width: 180 }}
                  value={keyword}
                  onChange={(e) => setKeyword(e.target.value)}
                />
                {showOutline && data.summary.outlineDistinctIssues > 0 && (
                  <label className="dossier-switch-label">
                    <Switch size="small" checked={onlyActive} onChange={setOnlyActive} />
                    <span>仅看大纲最新仍存</span>
                  </label>
                )}
              </div>
            </div>
          </div>

          {/* 独立滚动正文区域（含概览卡片与三类问题分区） */}
          <div className="dossier-body">
            {/* 核心数字关系概览条 */}
            <div className="dossier-kpi-grid">
              <div className="dossier-kpi-card kpi-total">
                <div className="kpi-label">汇总问题总计</div>
                <div className="kpi-value">{data.summary.totalDistinctIssues}</div>
                <div className="kpi-sub">跨来源去重归集</div>
              </div>
              <div className="dossier-kpi-card kpi-outline">
                <div className="kpi-label">大纲多次检查汇总</div>
                <div className="kpi-value">{data.summary.outlineDistinctIssues}</div>
                <div className="kpi-sub">
                  {data.summary.outlineCoursesCount} 门课 · {data.summary.outlineChecksCount} 次检查
                  {data.summary.outlineDistinctIssues > 0 && (
                    <> · <span className="kpi-danger-text">{data.summary.outlineLatestRemaining} 项最新仍存</span></>
                  )}
                </div>
              </div>
              <div className="dossier-kpi-card kpi-history">
                <div className="kpi-label">历史导入问题</div>
                <div className="kpi-value">{data.summary.historyIssuesCount}</div>
                <div className="kpi-sub">涉及 {data.historyCourses.length} 门课程</div>
              </div>
              <div className="dossier-kpi-card kpi-material">
                <div className="kpi-label">全套材料检查</div>
                <div className="kpi-value">{data.summary.materialIssuesCount}</div>
                <div className="kpi-sub">涉及 {data.materialCases.length} 份送检档案</div>
              </div>
            </div>
            {!hasVisibleContent && (
              <Empty
                image={Empty.PRESENTED_IMAGE_SIMPLE}
                description={data.summary.totalDistinctIssues === 0 ? '该教师目前暂无问题记录' : '当前筛选条件下没有匹配的问题，可清除筛选后查看全部'}
                style={{ padding: '48px 0' }}
              />
            )}

            {/* 一、大纲多次检查问题汇总 */}
            {showOutline && filteredOutline.length > 0 && (
              <section className="dossier-section">
                <div className="dossier-section-head">
                  <div className="dossier-section-title">
                    <FileTextOutlined />
                    <span>大纲历次检查问题汇总</span>
                    <Tag color="blue">{filteredOutline.length} 门课程</Tag>
                  </div>
                  <span className="muted small">同一门大纲多次检查出现的不同问题已合并展示，并标明在最新一次检查中的状态</span>
                </div>

                <div className="dossier-course-stack">
                  {filteredOutline.map((course) => {
                    const mode = courseModes[course.courseKey] ?? 'summary';
                    return (
                      <div key={course.courseKey} className="dossier-course-card">
                        <div className="dossier-course-header">
                          <div className="dossier-course-info">
                            <div className="dossier-course-name-row">
                              <h3>《{course.courseName}》</h3>
                              <SubmissionTag status="done" verdict={course.latestVerdict} />
                              <Tag bordered={false} color="processing">{course.relation}</Tag>
                            </div>
                            <div className="dossier-course-meta">
                              {[
                                course.studentGrade ? `${course.studentGrade}级` : '',
                                course.major,
                                `累计检查 ${course.checkCount} 次`,
                                `共汇总 ${course.aggregatedIssues.length} 项不同问题`,
                                course.remainingCount > 0 ? `最新仍存 ${course.remainingCount} 项` : '最新检查已无遗留',
                                `最近检查：${course.latestAt}`,
                              ].filter(Boolean).join(' · ')}
                            </div>
                          </div>
                          <div className="no-print">
                            <Segmented
                              size="small"
                              value={mode}
                              onChange={(v) => setCourseModes((prev) => ({ ...prev, [course.courseKey]: v as 'summary' | 'timeline' }))}
                              options={[
                                { value: 'summary', label: `问题去重汇总 (${course.aggregatedIssues.length})` },
                                { value: 'timeline', label: `按次时间线 (${course.checkCount})` },
                              ]}
                            />
                          </div>
                        </div>

                        {mode === 'summary' ? (
                          <div className="dossier-issue-list">
                            {course.aggregatedIssues.map((issue, idx) => (
                              <div key={issue.key} className={`dossier-issue-item${issue.presentInLatest ? ' is-active-issue' : ' is-resolved-issue'}`}>
                                <div className="dossier-issue-top">
                                  <div className="dossier-issue-title-group">
                                    <span className="dossier-issue-index">{String(idx + 1).padStart(2, '0')}</span>
                                    {issue.nature === '需核实'
                                      ? <Tag color="gold">需核实</Tag>
                                      : <NatureTag nature={issue.nature} />}
                                    <strong className="dossier-issue-title">{issue.title}</strong>
                                  </div>
                                  <div className="dossier-issue-badges">
                                    <Tooltip title={`出现于第 ${issue.seqs.join('、')} 次检查（首次 ${issue.firstSeenAt}）`}>
                                      <Tag bordered={false} icon={<ClockCircleOutlined />}>
                                        {issue.occurrenceCount > 1
                                          ? `共出现 ${issue.occurrenceCount} 次（第 ${issue.seqs.join('、')} 次）`
                                          : `第 ${issue.seqs[0]} 次检查`}
                                      </Tag>
                                    </Tooltip>
                                    {issue.presentInLatest ? (
                                      <Tag color="error" bordered={false} icon={<ExclamationCircleOutlined />}>
                                        最新一次仍存在
                                      </Tag>
                                    ) : (
                                      <Tag color="success" bordered={false} icon={<CheckCircleOutlined />}>
                                        后续检查未再出现
                                      </Tag>
                                    )}
                                  </div>
                                </div>

                                {issue.locations.length > 0 && (
                                  <div className="dossier-issue-loc">
                                    <span className="dossier-field-label">涉及位置</span>
                                    <span>{issue.locations.join('；')}</span>
                                  </div>
                                )}

                                <div className="dossier-issue-prose">
                                  <span className="dossier-field-label">{issue.nature === '需核实' ? '核实内容' : '问题说明'}</span>
                                  <div className="dossier-prose-text">{issue.problem}</div>
                                </div>

                                {issue.advice && (
                                  <div className="dossier-advice-box">
                                    <span className="dossier-advice-label">整改建议</span>
                                    <div className="dossier-prose-text">{issue.advice}</div>
                                  </div>
                                )}

                                {(issue.evidence || issue.occurrences.length > 0) && (
                                  <details className="dossier-details no-print">
                                    <summary>
                                      查看原文依据与历次出现轨迹（{issue.occurrences.length} 条记录）
                                    </summary>
                                    <div className="dossier-details-body">
                                      {issue.evidence && (
                                        <div className="dossier-evidence-block">
                                          <div className="muted small" style={{ marginBottom: 4 }}>大纲原文依据：</div>
                                          <div className="dossier-prose-text muted">{issue.evidence}</div>
                                        </div>
                                      )}
                                      <div className="dossier-occ-list">
                                        {issue.occurrences.map((occ, oi) => (
                                          <div key={`${occ.submissionId}-${oi}`} className="dossier-occ-row">
                                            <Tag>第 {occ.seq} 次</Tag>
                                            <span className="muted small">{occ.date}</span>
                                            <span className="muted small">{occ.fileName}</span>
                                            {occ.location && <span className="small">位置：{occ.location}</span>}
                                            <Link to={`/submissions/${occ.submissionId}`} target="_blank" rel="noopener noreferrer">
                                              查看该次报告
                                            </Link>
                                          </div>
                                        ))}
                                      </div>
                                    </div>
                                  </details>
                                )}
                              </div>
                            ))}
                          </div>
                        ) : (
                          <div className="dossier-timeline">
                            {course.timeline.map((entry) => (
                              <div key={entry.submissionId} className="dossier-timeline-node">
                                <div className="dossier-timeline-dot" />
                                <div className="dossier-timeline-content">
                                  <div className="dossier-timeline-head">
                                    <Space wrap size={8}>
                                      <strong>第 {entry.seq} 次检查</strong>
                                      <SubmissionTag status="done" verdict={entry.verdict} />
                                      <span className="muted small">{entry.finishedAt || entry.createdAt}</span>
                                      <span className="muted small">文件：{entry.fileName}</span>
                                      <span className="muted small">上传人：{entry.uploaderName}</span>
                                    </Space>
                                    <Space wrap size={8} className="no-print">
                                      {entry.canViewSubmission && (
                                        <>
                                          <Link to={`/submissions/${entry.submissionId}`} target="_blank" rel="noopener noreferrer">
                                            在线查看
                                          </Link>
                                          <Button size="small" icon={<DownloadOutlined />} onClick={() => download(`/api/submissions/${entry.submissionId}/report.docx`)}>
                                            Word 报告
                                          </Button>
                                        </>
                                      )}
                                    </Space>
                                  </div>
                                  <div className="dossier-timeline-counts">
                                    <Tag color={entry.majorCount ? 'red' : 'default'}>重大/明确问题 {entry.majorCount}</Tag>
                                    <Tag color={entry.suggestionCount ? 'blue' : 'default'}>建议修改 {entry.suggestionCount}</Tag>
                                    <Tag color={entry.verifyCount ? 'gold' : 'default'}>需核实 {entry.verifyCount}</Tag>
                                    {entry.verdictEditedAt && (
                                      <span className="muted small">（结论曾由 {entry.verdictEditedBy} 于 {entry.verdictEditedAt} 手工修改）</span>
                                    )}
                                  </div>
                                  {(entry.issues.length > 0 || entry.toVerify.length > 0) ? (
                                    <ul className="dossier-timeline-brief">
                                      {entry.issues.map((it, ii) => (
                                        <li key={ii}>
                                          <NatureTag nature={it.nature} />
                                          <strong>{it.title}</strong>
                                          {it.location && <span className="muted small">（{it.location}）</span>}
                                        </li>
                                      ))}
                                      {entry.toVerify.map((tv, ti) => (
                                        <li key={`v-${ti}`}>
                                          <Tag color="gold">需核实</Tag>
                                          <span>{tv.content}</span>
                                        </li>
                                      ))}
                                    </ul>
                                  ) : (
                                    <div className="muted small" style={{ marginTop: 6 }}>本次检查未发现问题或需核实事项。</div>
                                  )}
                                </div>
                              </div>
                            ))}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              </section>
            )}

            {/* 二、历史导入问题记录 */}
            {showHistory && filteredHistory.length > 0 && (
              <section className="dossier-section">
                <div className="dossier-section-head">
                  <div className="dossier-section-title">
                    <HistoryOutlined />
                    <span>历史导入问题记录</span>
                    <Tag color="purple">{filteredHistory.reduce((s, c) => s + c.totalCount, 0)} 条 · {filteredHistory.length} 门课程</Tag>
                  </div>
                  <span className="muted small">来自导入的在线表格链接或上传的往期问题文档，按课程与教学班归类</span>
                </div>

                <div className="dossier-course-stack">
                  {filteredHistory.map((course) => (
                    <div key={course.courseKey} className="dossier-course-card dossier-history-card">
                      <div className="dossier-course-header">
                        <div className="dossier-course-info">
                          <div className="dossier-course-name-row">
                            <h3>《{course.courseName}》</h3>
                            {course.courseCode && <Tag bordered={false}>{course.courseCode}</Tag>}
                            {course.major && <Tag bordered={false}>{course.major}</Tag>}
                          </div>
                        </div>
                        <Tag color="purple">{course.totalCount} 条历史问题</Tag>
                      </div>

                      <div className="dossier-history-groups">
                        {course.groups.map((group) => (
                          <div key={group.groupKey} className="dossier-history-group">
                            {(group.term || group.context || group.examType) && (
                              <div className="dossier-history-group-head">
                                {group.term && <Tag color="geekblue" bordered={false}>{group.term}</Tag>}
                                {group.context && <span className="dossier-class-pill">教学班：{group.context}</span>}
                                {group.examType && <Tag bordered={false}>{group.examType}</Tag>}
                              </div>
                            )}

                            <div className="dossier-history-items">
                              {group.items.map((item, idx) => (
                                <div key={item.id} className="dossier-history-item">
                                  <div className="dossier-history-item-top">
                                    <span className="dossier-issue-index">{String(idx + 1).padStart(2, '0')}</span>
                                    {(item.category || item.nature) && (
                                      <Tag color={categoryTone(item.category || item.nature)} bordered={false}>
                                        {item.category || item.nature}
                                      </Tag>
                                    )}
                                    {item.checkItem && (
                                      <span className="dossier-check-criterion">{item.checkItem}</span>
                                    )}
                                    {item.reviewer && (
                                      <span className="dossier-reviewer-badge">检查人：{item.reviewer}</span>
                                    )}
                                  </div>

                                  <div className="dossier-history-item-body">
                                    {item.points.length > 1 ? (
                                      <ol className="dossier-numbered-points">
                                        {item.points.map((point, pi) => (
                                          <li key={pi}>{point}</li>
                                        ))}
                                      </ol>
                                    ) : (
                                      <div className="dossier-prose-text">{item.points[0] || item.text}</div>
                                    )}
                                  </div>

                                  <div className="dossier-history-provenance">
                                    <span>
                                      来源：
                                      {item.sourceUrl ? (
                                        <a href={item.sourceUrl} target="_blank" rel="noopener noreferrer">
                                          <LinkOutlined /> {item.source}
                                        </a>
                                      ) : (
                                        item.source
                                      )}
                                    </span>
                                    {item.position && <span>位置：{item.position}</span>}
                                    {item.teachers.length > 1 && (
                                      <span>共同授课：{item.teachers.map((t) => t.name || t.staffNo).join('、')}</span>
                                    )}
                                  </div>
                                </div>
                              ))}
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
              </section>
            )}

            {/* 三、全套材料检查问题 */}
            {showMaterial && filteredMaterials.length > 0 && (
              <section className="dossier-section">
                <div className="dossier-section-head">
                  <div className="dossier-section-title">
                    <FolderOpenOutlined />
                    <span>全套教学材料检查问题</span>
                    <Tag color="cyan">{filteredMaterials.length} 份档案</Tag>
                  </div>
                  <span className="muted small">取每份材料送检档案最新一次已完成检查的问题汇总</span>
                </div>

                <div className="dossier-course-stack">
                  {filteredMaterials.map((mc) => (
                    <div key={mc.caseId} className="dossier-course-card dossier-material-card">
                      <div className="dossier-course-header">
                        <div className="dossier-course-info">
                          <div className="dossier-course-name-row">
                            <h3>《{mc.title}》</h3>
                            {mc.courseCode && <Tag bordered={false}>{mc.courseCode}</Tag>}
                            <Tag color={mc.verdict === 'passed' ? 'green' : mc.verdict === 'partial' ? 'gold' : 'red'}>
                              {mc.verdict === 'passed' ? '通过' : mc.verdict === 'partial' ? '部分通过' : '需整改'}
                            </Tag>
                          </div>
                          <div className="dossier-course-meta">
                            {[mc.term, mc.section, mc.major, `检查完成：${mc.finishedAt}`].filter(Boolean).join(' · ')}
                          </div>
                        </div>
                        <Link className="no-print" to={`/materials/${mc.caseId}`} target="_blank" rel="noopener noreferrer">
                          打开材料档案
                        </Link>
                      </div>

                      <div className="dossier-issue-list">
                        {mc.report.materials.map((mat) => (
                          <div key={mat.material} className="dossier-material-block">
                            <div className="dossier-material-label">
                              <strong>{mat.material}</strong>
                              {mat.source && <span className="muted small">{mat.source}</span>}
                            </div>
                            {mat.sections.map((sec) => (
                              <div key={sec.label} className="dossier-material-sub">
                                {sec.issues.map((it, ii) => (
                                  <div key={ii} className="dossier-issue-item">
                                    <div className="dossier-issue-top">
                                      <div className="dossier-issue-title-group">
                                        <Tag color={sec.label === '重大及明确问题' ? 'error' : 'blue'}>{sec.label}</Tag>
                                        <strong className="dossier-issue-title">{it.title}</strong>
                                      </div>
                                    </div>
                                    {it.locations.length > 0 && (
                                      <div className="dossier-issue-loc">
                                        <span className="dossier-field-label">涉及位置</span>
                                        <span>{it.locations.join('；')}</span>
                                      </div>
                                    )}
                                    {it.detail !== it.title && (
                                      <div className="dossier-issue-prose">
                                        <span className="dossier-field-label">问题说明</span>
                                        <div className="dossier-prose-text">{it.detail}</div>
                                      </div>
                                    )}
                                    {it.action && (
                                      <div className="dossier-advice-box">
                                        <span className="dossier-advice-label">整改建议</span>
                                        <div className="dossier-prose-text">{it.action}</div>
                                      </div>
                                    )}
                                  </div>
                                ))}
                              </div>
                            ))}
                          </div>
                        ))}
                        {mc.report.toVerify.length > 0 && (
                          <Collapse
                            size="small"
                            items={[{
                              key: 'verify',
                              label: `需核实事项（${mc.report.toVerify.length} 项）`,
                              children: (
                                <ul className="dossier-numbered-points">
                                  {mc.report.toVerify.map((tv, i) => <li key={i}>{tv.detail}</li>)}
                                </ul>
                              ),
                            }]}
                          />
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              </section>
            )}
          </div>
        </div>
      )}
    </Modal>
  );
}
