import { db } from '../db.js';
import type { PublicUser } from '../auth.js';
import type { CheckResult } from './ai/schema.js';
import type { MaterialScope } from './materialChecklist.js';
import { canManageHistory, type Feedback, type Teacher } from './materialHistory.js';
import { materialIssueReport } from './materialIssues.js';
import type { MaterialResult } from './materialReview.js';
import { canAccessMaterial } from './materialRuns.js';

const normalize = (value: string) => value.normalize('NFKC').trim().toLowerCase();
const splitNames = (value: string) => value.split(/[、,，;；\n]+/).map((s) => s.trim()).filter(Boolean);

function normalizeIssueFingerprint(text: string): string {
  return text
    .normalize('NFKC')
    .toLowerCase()
    .replace(/^[ab]\d{1,3}[\s.:：、)\]-]*/i, '')
    .replace(/^(?:\d+[.、)）]|（\d+）|\(\d+\))\s*/, '')
    .replace(/[\s，。、；：！？""''（）()【】[\]《》<>·—–\-.,;:!?/\\]+/g, '');
}

/** 将「1.xxx；2.xxx」或换行的多条问题拆分成清晰要点，便于阅读排版 */
export function splitNumberedPoints(text: string): string[] {
  const trimmed = text.trim();
  if (!trimmed) return [];
  // Normalize inline numbered delimiters such as "；2." or "。2." or "3；" (typo in real sheets)
  const expanded = trimmed
    .replace(/([；;。！？!?\n])\s*(\d{1,2})\s*[.、．)）:：；;]\s*/g, '\n$2. ')
    .replace(/\s+(\d{1,2})\s*[.、．)）]\s*(?=[^\d])/g, '\n$1. ');
  const lines = expanded
    .split(/\r?\n+/)
    .map((line) => line.trim())
    .filter(Boolean);
  const numbered = lines.filter((line) => /^(?:\d{1,2}[.、．)）]|（\d{1,2}）|\(\d{1,2}\))/.test(line));
  if (lines.length >= 2 && numbered.length >= 2) {
    return lines.map((line) => line.replace(/^(?:\d{1,2}\s*[.、．)）]|（\d{1,2}）|\(\d{1,2}\))\s*/, '').trim()).filter(Boolean);
  }
  return [trimmed];
}

export interface ArchivePersonSummary {
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
  searchBlob: string;
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

export interface OutlineTimelineEntry {
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
  issues: CheckResult['issues'];
  toVerify: CheckResult['toVerify'];
}

export interface AggregatedOutlineCourse {
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

export interface PersonMaterialCase {
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
  report: ReturnType<typeof materialIssueReport>;
}

export interface PersonHistoryItem {
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
  teachers: Teacher[];
  date: string;
  uploader: string;
}

export interface PersonHistoryCourse {
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

interface UserRecord {
  id: number;
  username: string;
  name: string;
  department: string;
}

interface SubmissionDbRow {
  id: number;
  course_id: number;
  outline_requirement_id: number | null;
  user_id: number;
  seq: number;
  file_name: string;
  created_at: string;
  finished_at: string | null;
  verdict: 'passed' | 'failed' | null;
  verdict_edited_at: string | null;
  verdict_edited_by: string;
  course_snapshot: string;
  result_json: string;
  uploader_name: string;
  uploader_username: string;
  req_writer_user_id: number | null;
  req_writer_name: string | null;
  req_writer_identifier: string | null;
  req_teacher_names: string | null;
  req_course_group: string | null;
  req_professional: string | null;
}

interface HistoryDbRow {
  id: number;
  course_name: string;
  course_code: string;
  major: string;
  payload: string;
  created_at: string;
}

interface MaterialRunDbRow {
  case_id: number;
  run_id: number;
  case_user_id: number;
  run_user_id: number;
  scope_json: string;
  result_json: string;
  finished_at: string;
}

interface PersonDirectory {
  users: UserRecord[];
  byId: Map<number, UserRecord>;
  byStaff: Map<string, UserRecord>;
  byUniqueName: Map<string, UserRecord>;
  rosterByName: Map<string, string[]>;
}

function loadDirectory(): PersonDirectory {
  const users = db.prepare('SELECT id, username, name, department FROM users ORDER BY name, username').all() as UserRecord[];
  const byId = new Map<number, UserRecord>();
  const byStaff = new Map<string, UserRecord>();
  const nameBuckets = new Map<string, UserRecord[]>();
  for (const u of users) {
    byId.set(u.id, u);
    byStaff.set(normalize(u.username), u);
    if (u.name.trim()) {
      const nk = normalize(u.name);
      const list = nameBuckets.get(nk) ?? [];
      list.push(u);
      nameBuckets.set(nk, list);
    }
  }
  const byUniqueName = new Map<string, UserRecord>();
  for (const [nk, list] of nameBuckets) {
    if (list.length === 1) byUniqueName.set(nk, list[0]);
  }
  const rosterRows = db.prepare("SELECT name, username FROM progress_roster WHERE name <> ''").all() as { name: string; username: string }[];
  const rosterByName = new Map<string, string[]>();
  for (const r of rosterRows) {
    const nk = normalize(r.name);
    const list = rosterByName.get(nk) ?? [];
    list.push(r.username);
    rosterByName.set(nk, list);
  }
  return { users, byId, byStaff, byUniqueName, rosterByName };
}

function resolvePersonFromTeacher(teacher: Teacher, dir: PersonDirectory): {
  personKey: string;
  user: UserRecord | null;
  name: string;
  username: string;
} | null {
  const staff = teacher.staffNo.trim();
  const name = teacher.name.trim();
  if (!staff && !name) return null;
  if (staff) {
    const user = dir.byStaff.get(normalize(staff));
    if (user) return { personKey: `user:${user.id}`, user, name: user.name || user.username, username: user.username };
  }
  if (name) {
    const user = dir.byUniqueName.get(normalize(name));
    if (user) return { personKey: `user:${user.id}`, user, name: user.name || user.username, username: user.username };
  }
  const rosterIds = !staff && name ? dir.rosterByName.get(normalize(name)) : undefined;
  const inferredStaff = staff || (rosterIds?.length === 1 ? rosterIds[0] : '');
  const key = inferredStaff ? `staff:${normalize(inferredStaff)}` : `name:${normalize(name)}`;
  return { personKey: key, user: null, name: name || inferredStaff, username: inferredStaff };
}

function allowedUserIdsForViewer(viewer: PublicUser, dir: PersonDirectory): Set<number> | 'all' {
  if (canManageHistory(viewer)) return 'all';
  const allowed = new Set<number>([viewer.id]);
  const hasGroupScope = viewer.led_groups.length > 0;
  const hasProgramScope = viewer.program_scopes.length > 0;
  if (!hasGroupScope && !hasProgramScope) return allowed;

  const reqs = db.prepare('SELECT course_group, professional, writer_user_id, writer_name, writer_identifier, teacher_names FROM outline_requirements').all() as {
    course_group: string; professional: string; writer_user_id: number | null; writer_name: string; writer_identifier: string; teacher_names: string;
  }[];
  for (const r of reqs) {
    const inGroup = hasGroupScope && viewer.led_groups.includes(r.course_group);
    const inProgram = hasProgramScope && viewer.program_scopes.includes(r.professional);
    if (!inGroup && !inProgram) continue;
    if (r.writer_user_id) allowed.add(r.writer_user_id);
    if (r.writer_identifier) {
      const u = dir.byStaff.get(normalize(r.writer_identifier));
      if (u) allowed.add(u.id);
    }
    if (r.writer_name) {
      const u = dir.byUniqueName.get(normalize(r.writer_name));
      if (u) allowed.add(u.id);
    }
    for (const tn of splitNames(r.teacher_names)) {
      const u = dir.byUniqueName.get(normalize(tn));
      if (u) allowed.add(u.id);
    }
  }
  return allowed;
}

function loadSubmissions(): SubmissionDbRow[] {
  return db.prepare(`
    SELECT s.id, s.course_id, s.outline_requirement_id, s.user_id, s.seq, s.file_name,
      s.created_at, s.finished_at, s.verdict, s.verdict_edited_at, s.verdict_edited_by,
      s.course_snapshot, s.result_json,
      u.name AS uploader_name, u.username AS uploader_username,
      o.writer_user_id AS req_writer_user_id, o.writer_name AS req_writer_name,
      o.writer_identifier AS req_writer_identifier, o.teacher_names AS req_teacher_names,
      o.course_group AS req_course_group, o.professional AS req_professional
    FROM submissions s
    JOIN users u ON u.id = s.user_id
    LEFT JOIN outline_requirements o ON o.id = s.outline_requirement_id
    WHERE s.status = 'done' AND s.result_json IS NOT NULL
    ORDER BY s.id ASC
  `).all() as SubmissionDbRow[];
}

function loadLatestMaterialRuns(): MaterialRunDbRow[] {
  return db.prepare(`
    SELECT r.case_id, r.id AS run_id, c.user_id AS case_user_id, r.user_id AS run_user_id,
      c.scope_json, r.result_json, COALESCE(r.finished_at, r.created_at) AS finished_at
    FROM material_runs r
    JOIN material_cases c ON c.id = r.case_id
    WHERE r.status = 'done' AND r.result_json IS NOT NULL
      AND r.id = (
        SELECT MAX(r2.id) FROM material_runs r2
        WHERE r2.case_id = r.case_id AND r2.status = 'done' AND r2.result_json IS NOT NULL
      )
    ORDER BY r.id DESC
  `).all() as MaterialRunDbRow[];
}

function loadHistoryRows(): HistoryDbRow[] {
  return db.prepare(`
    SELECT rowid AS id, course_name, course_code, major, payload, created_at
    FROM material_history
    ORDER BY rowid DESC
  `).all() as HistoryDbRow[];
}

interface ParsedSubmission {
  row: SubmissionDbRow;
  course: { name: string; major: string; studentGrade: number; trainingType: string };
  result: CheckResult;
  relations: Map<string, '本人上传' | '执笔课程' | '共同任课'>;
}

function mapSubmissionPersons(rows: SubmissionDbRow[], dir: PersonDirectory): ParsedSubmission[] {
  return rows.map((row) => {
    const snap = JSON.parse(row.course_snapshot) as { name?: string; major?: string; studentGrade?: number; trainingType?: string };
    const result = JSON.parse(row.result_json) as CheckResult;
    const relations = new Map<string, '本人上传' | '执笔课程' | '共同任课'>();
    relations.set(`user:${row.user_id}`, '本人上传');

    if (row.req_writer_user_id) {
      const k = `user:${row.req_writer_user_id}`;
      if (!relations.has(k)) relations.set(k, '执笔课程');
    } else if (row.req_writer_identifier || row.req_writer_name) {
      const resolved = resolvePersonFromTeacher({ name: row.req_writer_name ?? '', staffNo: row.req_writer_identifier ?? '' }, dir);
      if (resolved && !relations.has(resolved.personKey)) relations.set(resolved.personKey, '执笔课程');
    }

    for (const tn of splitNames(row.req_teacher_names ?? '')) {
      const resolved = resolvePersonFromTeacher({ name: tn, staffNo: '' }, dir);
      if (resolved && !relations.has(resolved.personKey)) relations.set(resolved.personKey, '共同任课');
    }

    return {
      row,
      course: {
        name: snap.name || '未命名课程',
        major: snap.major || '',
        studentGrade: Number(snap.studentGrade ?? 0),
        trainingType: snap.trainingType || '',
      },
      result,
      relations,
    };
  });
}

function buildOutlineCoursesForPerson(
  personKey: string,
  parsedSubs: ParsedSubmission[],
  viewer: PublicUser,
): AggregatedOutlineCourse[] {
  const canAll = canManageHistory(viewer);
  const buckets = new Map<string, { items: { sub: ParsedSubmission; relation: '本人上传' | '执笔课程' | '共同任课' }[] }>();
  // Also map courseName+major to req key when linked exists so unlinked & linked checks of same syllabus merge
  const nameMajorToKey = new Map<string, string>();
  const personSubs: { sub: ParsedSubmission; relation: '本人上传' | '执笔课程' | '共同任课' }[] = [];

  for (const sub of parsedSubs) {
    const relation = sub.relations.get(personKey);
    if (!relation) continue;
    personSubs.push({ sub, relation });
    if (sub.row.outline_requirement_id) {
      const nmKey = `${normalize(sub.course.name)}|${normalize(sub.course.major)}|${sub.course.studentGrade}`;
      if (!nameMajorToKey.has(nmKey)) nameMajorToKey.set(nmKey, `req:${sub.row.outline_requirement_id}`);
    }
  }

  for (const item of personSubs) {
    const { sub } = item;
    const nmKey = `${normalize(sub.course.name)}|${normalize(sub.course.major)}|${sub.course.studentGrade}`;
    const key = sub.row.outline_requirement_id
      ? `req:${sub.row.outline_requirement_id}`
      : (nameMajorToKey.get(nmKey) ?? `course:${nmKey}`);
    if (!buckets.has(key)) buckets.set(key, { items: [] });
    buckets.get(key)!.items.push(item);
  }

  const courses: AggregatedOutlineCourse[] = [];
  const natureRank: Record<AggregatedOutlineIssue['nature'], number> = {
    重大问题: 0, 明确问题: 1, 建议修改: 2, 需核实: 3,
  };

  for (const [key, { items }] of buckets) {
    // Sort chronologically ascending by submission id
    items.sort((a, b) => a.sub.row.id - b.sub.row.id);
    const latest = items[items.length - 1];
    const latestId = latest.sub.row.id;

    // Build deduplicated issue map across all checks of this same syllabus
    const merged = new Map<string, AggregatedOutlineIssue>();
    const seenInLatest = new Set<string>();

    for (const { sub } of items) {
      const date = sub.row.finished_at || sub.row.created_at;
      const isLatest = sub.row.id === latestId;

      for (const issue of sub.result.issues) {
        const titleFp = normalizeIssueFingerprint(issue.title);
        const probFp = normalizeIssueFingerprint(issue.problem);
        const dedupKey = titleFp.length >= 4
          ? `issue:${titleFp}`
          : probFp.length >= 6
            ? `prob:${probFp.slice(0, 60)}`
            : `raw:${issue.nature}:${issue.title}:${issue.location}`;
        if (isLatest) seenInLatest.add(dedupKey);

        const existing = merged.get(dedupKey);
        const occ = {
          submissionId: sub.row.id,
          seq: sub.row.seq,
          date,
          fileName: sub.row.file_name,
          location: issue.location,
          problem: issue.problem,
          advice: issue.advice,
        };
        if (!existing) {
          merged.set(dedupKey, {
            key: dedupKey,
            nature: issue.nature,
            title: issue.title,
            locations: issue.location ? [issue.location] : [],
            problem: issue.problem,
            advice: issue.advice,
            evidence: issue.evidence || '',
            itemCodes: [...issue.itemCodes],
            occurrenceCount: 1,
            seqs: [sub.row.seq],
            firstSeenAt: date,
            lastSeenAt: date,
            presentInLatest: isLatest,
            occurrences: [occ],
          });
        } else {
          // Keep higher severity if it changed between runs, and update wording to latest occurrence
          if (natureRank[issue.nature] < natureRank[existing.nature]) existing.nature = issue.nature;
          if (issue.location && !existing.locations.includes(issue.location)) existing.locations.push(issue.location);
          existing.problem = issue.problem || existing.problem;
          existing.advice = issue.advice || existing.advice;
          if (issue.evidence) existing.evidence = issue.evidence;
          existing.itemCodes = [...new Set([...existing.itemCodes, ...issue.itemCodes])];
          if (!existing.seqs.includes(sub.row.seq)) existing.seqs.push(sub.row.seq);
          existing.lastSeenAt = date;
          if (isLatest) existing.presentInLatest = true;
          existing.occurrences.push(occ);
          existing.occurrenceCount = existing.occurrences.length;
        }
      }

      for (const verify of sub.result.toVerify) {
        const fp = normalizeIssueFingerprint(`${verify.location}:${verify.content}`);
        const dedupKey = `verify:${fp.slice(0, 72) || verify.content}`;
        if (isLatest) seenInLatest.add(dedupKey);
        const existing = merged.get(dedupKey);
        const occ = {
          submissionId: sub.row.id,
          seq: sub.row.seq,
          date,
          fileName: sub.row.file_name,
          location: verify.location,
          problem: verify.content,
          advice: '',
        };
        if (!existing) {
          merged.set(dedupKey, {
            key: dedupKey,
            nature: '需核实',
            title: verify.location ? `需核实（${verify.location}）` : '需人工核实事项',
            locations: verify.location ? [verify.location] : [],
            problem: verify.content,
            advice: '',
            evidence: '',
            itemCodes: [...verify.itemCodes],
            occurrenceCount: 1,
            seqs: [sub.row.seq],
            firstSeenAt: date,
            lastSeenAt: date,
            presentInLatest: isLatest,
            occurrences: [occ],
          });
        } else {
          if (verify.location && !existing.locations.includes(verify.location)) existing.locations.push(verify.location);
          if (!existing.seqs.includes(sub.row.seq)) existing.seqs.push(sub.row.seq);
          existing.lastSeenAt = date;
          if (isLatest) existing.presentInLatest = true;
          existing.occurrences.push(occ);
          existing.occurrenceCount = existing.occurrences.length;
        }
      }
    }

    // Only include courses that had at least 1 issue or verification item in their history
    if (!merged.size) continue;

    for (const item of merged.values()) {
      item.presentInLatest = seenInLatest.has(item.key);
      item.seqs.sort((a, b) => a - b);
    }

    const aggregatedIssues = [...merged.values()].sort((a, b) =>
      natureRank[a.nature] - natureRank[b.nature]
      || Number(b.presentInLatest) - Number(a.presentInLatest)
      || b.occurrenceCount - a.occurrenceCount
      || b.lastSeenAt.localeCompare(a.lastSeenAt),
    );

    const timeline: OutlineTimelineEntry[] = [...items].reverse().map(({ sub, relation }) => ({
      submissionId: sub.row.id,
      seq: sub.row.seq,
      fileName: sub.row.file_name,
      createdAt: sub.row.created_at,
      finishedAt: sub.row.finished_at,
      verdict: sub.row.verdict ?? 'failed',
      verdictEditedBy: sub.row.verdict_edited_by,
      verdictEditedAt: sub.row.verdict_edited_at,
      uploaderName: sub.row.uploader_name || sub.row.uploader_username,
      relation,
      majorCount: sub.result.issues.filter((i) => i.nature === '重大问题' || i.nature === '明确问题').length,
      suggestionCount: sub.result.issues.filter((i) => i.nature === '建议修改').length,
      verifyCount: sub.result.toVerify.length,
      canViewSubmission: canAll || sub.row.user_id === viewer.id,
      issues: sub.result.issues,
      toVerify: sub.result.toVerify,
    }));

    // Prioritize relation label: 本人上传 > 执笔课程 > 共同任课
    const relSet = new Set(items.map((i) => i.relation));
    const relation = relSet.has('本人上传') ? '本人上传' : relSet.has('执笔课程') ? '执笔课程' : '共同任课';
    const remainingCount = aggregatedIssues.filter((i) => i.presentInLatest).length;

    courses.push({
      courseKey: key,
      courseName: latest.sub.course.name,
      major: latest.sub.course.major,
      studentGrade: latest.sub.course.studentGrade,
      trainingType: latest.sub.course.trainingType,
      relation,
      checkCount: items.length,
      latestSubmissionId: latest.sub.row.id,
      latestSeq: latest.sub.row.seq,
      latestVerdict: latest.sub.row.verdict ?? 'failed',
      latestAt: latest.sub.row.finished_at || latest.sub.row.created_at,
      remainingCount,
      resolvedCount: aggregatedIssues.length - remainingCount,
      aggregatedIssues,
      timeline,
    });
  }

  return courses.sort((a, b) =>
    b.remainingCount - a.remainingCount
    || b.latestAt.localeCompare(a.latestAt)
    || a.courseName.localeCompare(b.courseName, 'zh-CN'),
  );
}

function buildMaterialCasesForPerson(
  userId: number | null,
  runs: MaterialRunDbRow[],
  viewer: PublicUser,
): PersonMaterialCase[] {
  if (!userId) return [];
  const results: PersonMaterialCase[] = [];
  for (const run of runs) {
    if (run.case_user_id !== userId && run.run_user_id !== userId) continue;
    const scope = JSON.parse(run.scope_json) as MaterialScope;
    if (!canAccessMaterial(viewer, scope, run.case_user_id)) continue;
    const parsed = JSON.parse(run.result_json) as MaterialResult;
    const report = materialIssueReport(parsed);
    const issueCount = report.materials.reduce(
      (sum, mat) => sum + mat.sections.reduce((s, sec) => s + sec.issues.length, 0),
      0,
    ) + report.toVerify.length;
    if (issueCount === 0 && !report.missing.length) continue;
    results.push({
      caseId: run.case_id,
      runId: run.run_id,
      title: scope.title,
      courseCode: scope.courseCode ?? '',
      major: scope.major ?? '',
      term: scope.term ?? '',
      section: scope.section ?? '',
      verdict: parsed.verdict,
      finishedAt: run.finished_at,
      issueCount,
      report,
    });
  }
  return results;
}

function buildHistoryCoursesForPerson(
  personKey: string,
  historyRows: HistoryDbRow[],
  dir: PersonDirectory,
): PersonHistoryCourse[] {
  const byCourse = new Map<string, {
    courseKey: string;
    courseName: string;
    courseCode: string;
    major: string;
    groups: Map<string, { term: string; context: string; examType: string; items: PersonHistoryItem[] }>;
  }>();

  for (const row of historyRows) {
    const entry = JSON.parse(row.payload) as Feedback & { uploader?: string };
    const matched = entry.teachers.some((t) => resolvePersonFromTeacher(t, dir)?.personKey === personKey);
    if (!matched) continue;

    const ck = JSON.stringify([normalize(row.course_name), normalize(row.course_code), normalize(row.major)]);
    if (!byCourse.has(ck)) {
      byCourse.set(ck, {
        courseKey: ck,
        courseName: row.course_name || row.course_code || '未命名课程',
        courseCode: row.course_code,
        major: row.major,
        groups: new Map(),
      });
    }
    const bucket = byCourse.get(ck)!;
    const term = entry.term || '';
    const context = entry.context || '';
    const examType = entry.examType || '';
    const gk = JSON.stringify([term, context, examType]);
    if (!bucket.groups.has(gk)) {
      bucket.groups.set(gk, { term, context, examType, items: [] });
    }
    bucket.groups.get(gk)!.items.push({
      id: `import:${row.id}`,
      text: entry.text,
      points: entry.checkItem ? [entry.text.replace(/^【[^】]+】/, '').trim() || entry.text] : splitNumberedPoints(entry.text),
      category: entry.category || '',
      checkItem: entry.checkItem || '',
      nature: entry.nature || '',
      reviewer: entry.reviewer || '',
      source: entry.source || '',
      sourceUrl: entry.sourceUrl || '',
      position: entry.position || '',
      teachers: entry.teachers,
      date: row.created_at,
      uploader: entry.uploader || '',
    });
  }

  return [...byCourse.values()]
    .map((c) => {
      const groups = [...c.groups.entries()]
        .map(([groupKey, g]) => ({ groupKey, ...g }))
        .sort((a, b) => (b.term || '').localeCompare(a.term || '') || a.context.localeCompare(b.context, 'zh-CN'));
      const totalCount = groups.reduce((sum, g) => sum + g.items.length, 0);
      return {
        courseKey: c.courseKey,
        courseName: c.courseName,
        courseCode: c.courseCode,
        major: c.major,
        totalCount,
        groups,
      };
    })
    .sort((a, b) => b.totalCount - a.totalCount || a.courseName.localeCompare(b.courseName, 'zh-CN'));
}

export function listArchivePeople(
  viewer: PublicUser,
  filters: { q?: string; source?: 'all' | 'outline' | 'history' | 'material'; onlyWithIssues?: boolean },
) {
  const dir = loadDirectory();
  const allowed = allowedUserIdsForViewer(viewer, dir);
  const canAll = canManageHistory(viewer);
  const subs = mapSubmissionPersons(loadSubmissions(), dir);
  const materialRuns = loadLatestMaterialRuns();
  const historyRows = loadHistoryRows();

  // Build candidate people registry
  const registry = new Map<string, {
    personKey: string;
    userId: number | null;
    name: string;
    username: string;
    department: string;
    matchedAccount: boolean;
  }>();

  for (const u of dir.users) {
    if (allowed !== 'all' && !allowed.has(u.id)) continue;
    registry.set(`user:${u.id}`, {
      personKey: `user:${u.id}`,
      userId: u.id,
      name: u.name || u.username,
      username: u.username,
      department: u.department,
      matchedAccount: true,
    });
  }

  // Include unmatched teachers from imported historical sheets & outline requirements for full-access managers
  if (canAll) {
    for (const row of historyRows) {
      const entry = JSON.parse(row.payload) as Feedback;
      for (const t of entry.teachers) {
        const resolved = resolvePersonFromTeacher(t, dir);
        if (!resolved || registry.has(resolved.personKey)) continue;
        registry.set(resolved.personKey, {
          personKey: resolved.personKey,
          userId: resolved.user?.id ?? null,
          name: resolved.name,
          username: resolved.username,
          department: resolved.user?.department ?? '',
          matchedAccount: !!resolved.user,
        });
      }
    }
  }

  const summaries: ArchivePersonSummary[] = [];
  let totalOutlineIssues = 0;
  let totalHistoryIssues = 0;
  let totalMaterialIssues = 0;
  let peopleWithIssues = 0;

  for (const person of registry.values()) {
    const outlineCourses = buildOutlineCoursesForPerson(person.personKey, subs, viewer);
    const materialCases = buildMaterialCasesForPerson(person.userId, materialRuns, viewer);
    const historyCourses = buildHistoryCoursesForPerson(person.personKey, historyRows, dir);

    const outlineChecksCount = outlineCourses.reduce((sum, c) => sum + c.checkCount, 0);
    const outlineDistinctIssues = outlineCourses.reduce((sum, c) => sum + c.aggregatedIssues.length, 0);
    const outlineLatestRemaining = outlineCourses.reduce((sum, c) => sum + c.remainingCount, 0);
    const materialIssuesCount = materialCases.reduce((sum, c) => sum + c.issueCount, 0);
    const historyIssuesCount = historyCourses.reduce((sum, c) => sum + c.totalCount, 0);
    const totalIssues = outlineDistinctIssues + materialIssuesCount + historyIssuesCount;

    const severeCount = outlineCourses.reduce(
      (sum, c) => sum + c.aggregatedIssues.filter((i) => i.nature === '重大问题' || i.nature === '明确问题').length,
      0,
    ) + materialCases.reduce(
      (sum, c) => sum + c.report.materials.reduce((ms, mat) => ms + mat.sections.filter((s) => s.label === '重大及明确问题').reduce((ss, s) => ss + s.issues.length, 0), 0),
      0,
    );

    const courseNamesSet = new Set<string>();
    const searchParts = [person.name, person.username, person.department];
    let latestActivityAt = '';
    const bumpDate = (d: string) => { if (d && d > latestActivityAt) latestActivityAt = d; };

    for (const c of outlineCourses) {
      courseNamesSet.add(c.courseName);
      searchParts.push(c.courseName, ...c.aggregatedIssues.map((i) => `${i.title} ${i.problem}`));
      bumpDate(c.latestAt);
    }
    for (const m of materialCases) {
      courseNamesSet.add(m.title);
      searchParts.push(m.title);
      bumpDate(m.finishedAt);
    }
    for (const h of historyCourses) {
      courseNamesSet.add(h.courseName);
      searchParts.push(h.courseName, h.courseCode);
      for (const g of h.groups) {
        searchParts.push(g.context);
        for (const item of g.items) {
          searchParts.push(item.text, item.category, item.source);
          bumpDate(item.date);
        }
      }
    }

    if (totalIssues > 0) peopleWithIssues++;
    totalOutlineIssues += outlineDistinctIssues;
    totalHistoryIssues += historyIssuesCount;
    totalMaterialIssues += materialIssuesCount;

    summaries.push({
      ...person,
      coursesCount: courseNamesSet.size,
      outlineCoursesCount: outlineCourses.length,
      outlineChecksCount,
      outlineDistinctIssues,
      outlineLatestRemaining,
      materialIssuesCount,
      historyIssuesCount,
      totalIssues,
      severeCount,
      latestActivityAt,
      courseNames: [...courseNamesSet],
      searchBlob: searchParts.join(' ').toLowerCase(),
    });
  }

  const query = normalize(filters.q ?? '');
  const filtered = summaries.filter((p) => {
    if (filters.onlyWithIssues && p.totalIssues === 0) return false;
    if (filters.source === 'outline' && p.outlineDistinctIssues === 0) return false;
    if (filters.source === 'history' && p.historyIssuesCount === 0) return false;
    if (filters.source === 'material' && p.materialIssuesCount === 0) return false;
    if (query && !p.searchBlob.includes(query)) return false;
    return true;
  });

  filtered.sort((a, b) =>
    Number(b.totalIssues > 0) - Number(a.totalIssues > 0)
    || b.totalIssues - a.totalIssues
    || b.latestActivityAt.localeCompare(a.latestActivityAt)
    || a.name.localeCompare(b.name, 'zh-CN'),
  );

  const importedSourcesCount = (db.prepare("SELECT COUNT(DISTINCT json_extract(payload, '$.source')) AS n FROM material_history").get() as { n: number }).n;

  return {
    canImport: canAll,
    stats: {
      totalPeople: summaries.length,
      peopleWithIssues,
      totalOutlineIssues,
      totalHistoryIssues,
      totalMaterialIssues,
      importedSourcesCount,
    },
    people: filtered.map(({ searchBlob: _ignored, ...rest }) => rest),
  };
}

export function getPersonIssueDossier(viewer: PublicUser, personKey: string): PersonIssueDossier | null {
  const dir = loadDirectory();
  const allowed = allowedUserIdsForViewer(viewer, dir);
  const canAll = canManageHistory(viewer);

  let person: PersonIssueDossier['person'] | null = null;
  if (personKey.startsWith('user:')) {
    const uid = Number(personKey.slice(5));
    if (!Number.isInteger(uid) || uid <= 0) return null;
    if (allowed !== 'all' && !allowed.has(uid)) return null;
    const u = dir.byId.get(uid);
    if (!u) return null;
    person = {
      personKey,
      userId: u.id,
      name: u.name || u.username,
      username: u.username,
      department: u.department,
      matchedAccount: true,
    };
  } else if (canAll && (personKey.startsWith('name:') || personKey.startsWith('staff:'))) {
    const historyRows = loadHistoryRows();
    for (const row of historyRows) {
      const entry = JSON.parse(row.payload) as Feedback;
      for (const t of entry.teachers) {
        const resolved = resolvePersonFromTeacher(t, dir);
        if (resolved?.personKey === personKey) {
          person = {
            personKey,
            userId: null,
            name: resolved.name,
            username: resolved.username,
            department: '',
            matchedAccount: false,
          };
          break;
        }
      }
      if (person) break;
    }
    if (!person) return null;
  } else {
    return null;
  }

  const subs = mapSubmissionPersons(loadSubmissions(), dir);
  const materialRuns = loadLatestMaterialRuns();
  const historyRows = loadHistoryRows();

  const outlineCourses = buildOutlineCoursesForPerson(person.personKey, subs, viewer);
  const materialCases = buildMaterialCasesForPerson(person.userId, materialRuns, viewer);
  const historyCourses = buildHistoryCoursesForPerson(person.personKey, historyRows, dir);

  const outlineChecksCount = outlineCourses.reduce((sum, c) => sum + c.checkCount, 0);
  const outlineDistinctIssues = outlineCourses.reduce((sum, c) => sum + c.aggregatedIssues.length, 0);
  const outlineLatestRemaining = outlineCourses.reduce((sum, c) => sum + c.remainingCount, 0);
  const outlineResolvedInLater = outlineCourses.reduce((sum, c) => sum + c.resolvedCount, 0);
  const materialIssuesCount = materialCases.reduce((sum, c) => sum + c.issueCount, 0);
  const historyIssuesCount = historyCourses.reduce((sum, c) => sum + c.totalCount, 0);

  let severeCount = 0;
  let suggestionCount = 0;
  let verifyCount = 0;
  for (const c of outlineCourses) {
    for (const i of c.aggregatedIssues) {
      if (i.nature === '重大问题' || i.nature === '明确问题') severeCount++;
      else if (i.nature === '建议修改') suggestionCount++;
      else verifyCount++;
    }
  }
  for (const m of materialCases) {
    for (const mat of m.report.materials) {
      for (const sec of mat.sections) {
        if (sec.label === '重大及明确问题') severeCount += sec.issues.length;
        else suggestionCount += sec.issues.length;
      }
    }
    verifyCount += m.report.toVerify.length;
  }

  return {
    person,
    summary: {
      totalDistinctIssues: outlineDistinctIssues + materialIssuesCount + historyIssuesCount,
      outlineCoursesCount: outlineCourses.length,
      outlineChecksCount,
      outlineDistinctIssues,
      outlineLatestRemaining,
      outlineResolvedInLater,
      materialIssuesCount,
      historyIssuesCount,
      severeCount,
      suggestionCount,
      verifyCount,
    },
    outlineCourses,
    materialCases,
    historyCourses,
  };
}

export function listImportedSources() {
  const rows = db.prepare(`
    SELECT
      COALESCE(json_extract(payload, '$.source'), '未注明来源') AS source,
      COALESCE(json_extract(payload, '$.sourceUrl'), '') AS sourceUrl,
      COALESCE(json_extract(payload, '$.uploader'), '') AS uploader,
      COUNT(*) AS count,
      MAX(created_at) AS latestAt
    FROM material_history
    GROUP BY source, sourceUrl
    ORDER BY latestAt DESC, source ASC
  `).all() as { source: string; sourceUrl: string; uploader: string; count: number; latestAt: string }[];
  return rows;
}

export function deleteImportedSource(source: string): number {
  const result = db.prepare("DELETE FROM material_history WHERE COALESCE(json_extract(payload, '$.source'), '未注明来源') = ?").run(source);
  return result.changes;
}
