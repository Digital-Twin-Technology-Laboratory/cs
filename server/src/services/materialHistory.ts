import readXlsxFile from 'read-excel-file/node';
import { db } from '../db.js';
import type { PublicUser } from '../auth.js';
import type { CheckResult } from './ai/schema.js';
import type { MaterialScope } from './materialChecklist.js';
import { readXlsWorkbook } from './xlsWorkbook.js';

export type HistoryCourse = { name: string; code: string; major: string };
type Teacher = { name: string; staffNo: string };
type Feedback = {
  teachers: Teacher[]; text: string; term: string; context: string;
  source: string; position: string; nature: string;
};
export type HistoryIssue = Feedback & {
  id: string; course: HistoryCourse; uploader: string; date: string; outline?: true; submissionId?: number;
  outlineDetail?: Pick<CheckResult['issues'][number], 'title' | 'problem' | 'advice' | 'evidence'>;
};
export type HistoryKind = 'history' | 'outline';
type ImportRow = Feedback & { key: string; row: number; sheet: string; course: HistoryCourse };
export type HistoryPreviewRow = ImportRow & { status: 'matched' | 'ambiguous' | 'unmatched' | 'invalid'; candidates: HistoryCourse[] };

const clean = (value: unknown) => String(value ?? '').trim();
const normalize = (value: string) => value.normalize('NFKC').trim().toLowerCase();
const termKey = (term: string) => normalize(term).replace(/[‐‑–—]/g, '-');
const names = (value: string) => value.split(/[、,，;；\n]+/).map((s) => s.trim()).filter(Boolean);
const majorAliases = new Map([['计算机公共教学', '公共'], ['专转本', '计算机科学与技术（专转本）'],
  ['中外物联网', '物联网工程（中外合作）'], ['物联网工程（合作办学）', '物联网工程（中外合作）']]);
const standardMajor = (major: string) => majorAliases.get(major) ?? major;
const majorKey = (major: string) => normalize(standardMajor(major));
export const courseKey = (course: HistoryCourse) => JSON.stringify(course.code
  ? [normalize(course.code)] : [normalize(course.name), majorKey(course.major)]);
export const canManageHistory = (user: PublicUser) => user.role === 'admin' || user.college_role === 'teaching';

export function historyCourses() {
  const rows = db.prepare(`
    SELECT course_name AS name, '' AS code, professional AS major FROM outline_requirements
    UNION SELECT name, '', major FROM courses
    UNION SELECT course_name, course_code, major FROM material_history
    UNION SELECT json_extract(scope_json, '$.title'), COALESCE(json_extract(scope_json, '$.courseCode'), ''),
      json_extract(scope_json, '$.major') FROM material_cases WHERE json_extract(scope_json, '$.level') = 'course'
    ORDER BY code DESC, name, major`).all() as HistoryCourse[];
  return uniqueCourses(rows).sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'));
}

function uniqueCourses(rows: HistoryCourse[]) {
  const codedNames = new Set(rows.filter((r) => r.code).map((r) => courseKey({ ...r, code: '' })));
  const scopedNames = new Set(rows.filter((r) => r.major || r.code).map((r) => normalize(r.name)));
  const unique = new Map<string, HistoryCourse>();
  for (const row of rows) {
    const key = courseKey(row);
    if (!row.code && !row.major && scopedNames.has(normalize(row.name))) continue;
    if (row.code || !codedNames.has(key)) {
      if (!unique.has(key)) unique.set(key, { ...row, major: standardMajor(row.major) });
    }
  }
  return [...unique.values()];
}

function canonicalCourse(course: HistoryCourse, catalog: HistoryCourse[]) {
  const matches = resolveCourse(course, catalog);
  return matches.length === 1 ? matches[0] : course;
}

function resolveCourse(course: HistoryCourse, courses: HistoryCourse[]) {
  return course.code ? courses.filter((c) => normalize(c.code) === normalize(course.code))
    : courses.filter((c) => normalize(c.name) === normalize(course.name) && (!course.major || majorKey(c.major) === majorKey(course.major)));
}

function teacherDirectory() {
  const rows = db.prepare(`SELECT name, username AS staffNo FROM users WHERE name <> ''
    UNION SELECT name, username FROM progress_roster WHERE name <> ''`).all() as Teacher[];
  const byName = new Map<string, Map<string, string>>();
  for (const { name, staffNo } of rows) {
    if (!byName.has(name)) byName.set(name, new Map());
    byName.get(name)!.set(normalize(staffNo), staffNo);
  }
  return byName;
}

function identifyTeachers(teachers: Teacher[], directory: ReturnType<typeof teacherDirectory>) {
  const unique = new Map<string, Teacher>();
  for (const teacher of teachers) {
    const ids = directory.get(teacher.name);
    const staffNo = teacher.staffNo || (ids?.size === 1 ? [...ids.values()][0] : '');
    const key = staffNo ? normalize(staffNo) : teacher.name;
    unique.set(key, { name: teacher.name || unique.get(key)?.name || '', staffNo });
  }
  return [...unique.values()];
}

export async function previewHistory(path: string, fileName: string) {
  const sheets = fileName.toLowerCase().endsWith('.xls')
    ? await readXlsWorkbook(path)
    : await readXlsxFile(path, { trim: false, parseNumber: (value) => value });
  const courses = historyCourses();
  const directory = teacherDirectory();
  const rows: HistoryPreviewRow[] = [];
  for (const [sheetIndex, { sheet, data }] of sheets.entries()) {
    const headers = data.map((line) => line.map((cell) => clean(cell).replace(/\s/g, '')));
    const courseNames = ['课程', '课程名称', '课程名'];
    const codes = ['课程代码', '课程编号', '课程编码'];
    const feedback = ['具体反馈', '反馈', '检查意见', '问题描述'];
    const index = headers.findIndex((line) =>
      [...courseNames, ...codes].some((key) => line.includes(key)) && feedback.some((key) => line.includes(key)));
    if (index === -1) continue;
    const header = headers[index];
    for (let i = index + 1; i < data.length; i++) {
      const cells = data[i];
      if (!cells.some((cell) => clean(cell))) continue;
      const raw = (keys: string[]) => String(cells[header.findIndex((key) => keys.includes(key))] ?? '');
      const value = (...keys: string[]) => raw(keys).trim();
      const teacherNames = names(value('任课教师', '任课教师姓名', '教师姓名', '授课教师', '教师'));
      const staffNos = names(value('任课教师工号', '教师工号', '工号'));
      const staffMismatch = !!(teacherNames.length && staffNos.length && teacherNames.length !== staffNos.length);
      const teachers = identifyTeachers(Array.from({ length: Math.max(teacherNames.length, staffNos.length) },
        (_, n) => ({ name: teacherNames[n] ?? '', staffNo: staffNos[n] ?? '' })), directory);
      const name = value(...courseNames);
      const code = value(...codes);
      const text = raw(feedback);
      const courseNamesInCell = !code && name.includes('、') ? name.split('、').map(clean).filter(Boolean) : [name];
      for (const [n, courseName] of courseNamesInCell.entries()) {
        const course = { name: courseName, code, major: value('专业', '审核专业', '开课专业') };
        const candidates = resolveCourse(course, courses);
        const status = (!courseName && !code) || !text.trim() || staffMismatch ? 'invalid'
          : candidates.length > 1 ? 'ambiguous' : candidates.length === 1 ? 'matched' : 'unmatched';
        rows.push({
          key: `${sheetIndex}:${i}:${n}`, row: i + 1, sheet, course, status, candidates, teachers, text,
          term: value('学期', '学年学期'), context: value('教学班或专业', '教学班', '班级'),
          source: value('来源文件（全名）', '来源文件') || fileName, position: value('原表位置', '反馈位置'),
          nature: value('反馈性质'),
        });
      }
    }
  }
  return rows;
}

export function importHistory(rows: HistoryPreviewRow[], choices: Record<string, string>, user: PublicUser) {
  const confirmed: { row: HistoryPreviewRow; course: HistoryCourse }[] = [];
  const courses = new Map(historyCourses().map((course) => [courseKey(course), course]));
  for (const row of rows) {
    const choice = choices[row.key];
    if (!choice || row.status === 'invalid') continue;
    const match = choice === 'original' && row.status === 'unmatched' && row.course.name ? row.course
      : row.status === 'matched' ? row.candidates.find((candidate) => courseKey(candidate) === choice) : courses.get(choice);
    if (!match) return null;
    const course = !match.code && row.course.code ? { ...match, code: row.course.code } : match;
    confirmed.push({ row, course });
  }
  const source = `${user.name || user.username}（${user.username}）`;
  const catalog = uniqueCourses([...courses.values(), ...confirmed.map(({ course }) => course)]);
  const fingerprint = (course: HistoryCourse, feedback: Feedback) =>
    JSON.stringify([courseKey(canonicalCourse(course, catalog)), termKey(feedback.term),
      normalize(feedback.context), feedback.text.trim(), feedback.source]);
  type Payload = Feedback & { uploader: string };
  const stored = db.prepare('SELECT issue_key, course_name AS name, course_code AS code, major, payload FROM material_history')
    .all() as (HistoryCourse & { issue_key: string; payload: string })[];
  const existing = new Map(stored.map(({ issue_key, payload, ...course }) => {
    const parsed = JSON.parse(payload) as Payload;
    return [fingerprint(course, parsed), { issueKey: issue_key, payload: parsed }];
  }));
  const insert = db.prepare(`INSERT INTO material_history (issue_key, course_name, course_code, major, payload)
    VALUES (?, ?, ?, ?, ?) ON CONFLICT (issue_key) DO UPDATE SET course_name = excluded.course_name,
      course_code = excluded.course_code, major = excluded.major, payload = excluded.payload`);
  const directory = teacherDirectory();
  return db.transaction(() => {
    let added = 0;
    for (const { row, course } of confirmed) {
      // Co-teachers may appear on separate lines of the same source.
      const key = fingerprint(course, row);
      const previous = existing.get(key);
      const payload = previous?.payload ?? {
        teachers: row.teachers, text: row.text, term: row.term, context: row.context, source: row.source,
        position: row.position || `${row.sheet}!第 ${row.row} 行`, nature: row.nature, uploader: source,
      };
      if (previous) payload.teachers = identifyTeachers([...payload.teachers, ...row.teachers], directory);
      else added++;
      const issueKey = previous?.issueKey ?? key;
      const resolved = canonicalCourse(course, catalog);
      insert.run(issueKey, resolved.name, resolved.code, resolved.major, JSON.stringify(payload));
      existing.set(key, { issueKey, payload });
    }
    return { added, duplicates: confirmed.length - added, skipped: rows.length - confirmed.length };
  })();
}

export function historyIssues(user: PublicUser, filters: { course?: string; teacher?: string; identity?: HistoryCourse }) {
  const directory = teacherDirectory();
  const all = canManageHistory(user);
  const courseQuery = normalize(filters.course ?? '');
  const teacher = normalize(filters.teacher ?? '');
  const identity = filters.identity;
  const courses = historyCourses();
  if (identity && !identity.code && resolveCourse(identity, courses).length > 1) return [];
  const canonical = (course: HistoryCourse) => canonicalCourse(course, courses);
  const selected = identity && canonical(identity);
  const accepted = (course: HistoryCourse, teachers: Teacher[], uploaderId?: number) =>
    (all || uploaderId === user.id || teachers.some((t) => normalize(t.staffNo) === normalize(user.username)))
    && (!selected || courseKey(canonical(course)) === courseKey(selected))
    && (!courseQuery || [course.name, course.code, canonical(course).code].some((s) => normalize(s).includes(courseQuery)))
    && (!teacher || teachers.some((t) => normalize(t.name).includes(teacher) || normalize(t.staffNo) === teacher));
  const imported = db.prepare(`SELECT rowid AS id, course_name AS name, course_code AS code, major, payload, created_at
    FROM material_history`).all() as (HistoryCourse & { id: number; payload: string; created_at: string })[];
  const issues: HistoryIssue[] = imported.flatMap(({ id, payload, created_at, ...course }) => {
    const entry = JSON.parse(payload) as Feedback & { uploader: string };
    const teachers = identifyTeachers(entry.teachers, directory);
    return accepted(course, teachers) ? [{ ...entry, teachers, course: canonical(course), id: `import:${id}`, date: created_at }] : [];
  });

  const previous = db.prepare(`SELECT s.id, s.user_id, s.result_json, s.file_name,
    COALESCE(NULLIF(json_extract(s.course_snapshot, '$.name'), ''), c.name) AS course_name,
    COALESCE(NULLIF(json_extract(s.course_snapshot, '$.major'), ''), c.major) AS major,
    COALESCE(json_extract(s.course_snapshot, '$.courseCode'), '') AS code,
    COALESCE(s.finished_at, s.created_at) AS date, o.teacher_names, u.name, u.username
    FROM submissions s JOIN courses c ON c.id = s.course_id JOIN users u ON u.id = s.user_id
    LEFT JOIN outline_requirements o ON o.id = s.outline_requirement_id
    WHERE s.status = 'done' AND s.result_json IS NOT NULL
      AND (json_array_length(s.result_json, '$.issues') > 0 OR json_array_length(s.result_json, '$.toVerify') > 0)`).all() as {
    id: number; user_id: number; result_json: string; course_name: string; code: string; major: string; file_name: string; date: string;
    teacher_names: string | null; name: string; username: string;
  }[];
  for (const row of previous) {
    const course = { name: row.course_name, major: row.major, code: row.code };
    const teachers = identifyTeachers(names(row.teacher_names ?? '').map((name) => ({ name, staffNo: '' })), directory);
    if (!accepted(course, teachers, row.user_id)) continue;
    const result = JSON.parse(row.result_json) as CheckResult;
    const base = { course: canonical(course), teachers, uploader: `${row.name || row.username}（${row.username}）`,
      source: row.file_name, date: row.date, term: '', context: '', outline: true as const,
      submissionId: all || row.user_id === user.id ? row.id : undefined };
    issues.push(...result.issues.map((item, i) => ({ ...base, id: `syllabus:${row.id}:${i}`,
      text: [item.title, item.problem, item.advice].filter(Boolean).join('\n'), position: item.location, nature: item.nature,
      outlineDetail: { title: item.title, problem: item.problem, advice: item.advice, evidence: item.evidence } })),
    ...result.toVerify.map((item, i) => ({ ...base, id: `verify:${row.id}:${i}`,
      text: item.content, position: item.location, nature: '需核实' })));
  }
  return issues.sort((a, b) => (b.term || b.date).localeCompare(a.term || a.date) || b.date.localeCompare(a.date));
}

export function groupHistoryIssues(rows: HistoryIssue[], selected: HistoryKind, page: number) {
  const counts = { history: 0, outline: 0 };
  const groups = new Map<string, HistoryIssue[]>();
  for (const row of rows) {
    const kind = row.outline ? 'outline' : 'history';
    counts[kind]++;
    if (kind !== selected) continue;
    // Both syllabus ID formats (issue and verify) have the same original check ID.
    const key = row.outline ? row.id.split(':')[1] : JSON.stringify([courseKey(row.course), termKey(row.term)]);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(row);
  }
  const pageSize = 6;
  return { counts, total: groups.size, pageSize, groups: [...groups].slice((page - 1) * pageSize, page * pageSize)
    .map(([id, issues]) => ({ id, issues })) };
}

export function courseHistory(user: PublicUser, scope: MaterialScope) {
  return historyIssues(user, { identity: { name: scope.title, major: scope.major, code: scope.courseCode } });
}
