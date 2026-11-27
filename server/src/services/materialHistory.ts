import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import { parse as parseCsv } from 'csv-parse/sync';
import JSZip from 'jszip';
import readXlsxFile from 'read-excel-file/node';
import { db } from '../db.js';
import type { PublicUser } from '../auth.js';
import type { CheckResult } from './ai/schema.js';
import type { MaterialScope } from './materialChecklist.js';
import { readTencentSheetWorkbook } from './tencentSheet.js';
import { readXlsWorkbook } from './xlsWorkbook.js';

export type HistoryCourse = { name: string; code: string; major: string };
export type Teacher = { name: string; staffNo: string };
export type TeacherMatch = Teacher & { matchedUserId: number | null; status: 'matched' | 'ambiguous' | 'unmatched' };
export type Feedback = {
  teachers: Teacher[];
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
export type HistoryIssue = Feedback & {
  id: string;
  course: HistoryCourse;
  uploader: string;
  date: string;
  outline?: true;
  submissionId?: number;
  outlineDetail?: Pick<CheckResult['issues'][number], 'title' | 'problem' | 'advice' | 'evidence'>;
};
export type HistoryKind = 'history' | 'outline';
type ImportRow = Feedback & { key: string; row: number; sheet: string; course: HistoryCourse };
export type HistoryPreviewRow = ImportRow & {
  status: 'matched' | 'ambiguous' | 'unmatched' | 'invalid';
  candidates: HistoryCourse[];
  teacherMatches?: TeacherMatch[];
};
export type HistoryPreviewSummary = {
  format: 'flat' | 'matrix' | 'mixed';
  sourceName: string;
  sourceUrl?: string;
  totalRows: number;
  matchedTeachers: number;
  unmatchedTeachers: number;
  courses: (HistoryCourse & { key: string })[];
  rows: (Omit<HistoryPreviewRow, 'candidates'> & { candidates: (HistoryCourse & { key: string })[] })[];
  previewId: string;
};

const clean = (value: unknown) => String(value ?? '').trim();
const normalize = (value: string) => value.normalize('NFKC').trim().toLowerCase();
const termKey = (term: string) => normalize(term).replace(/[‐‑–—]/g, '-');
const names = (value: string) => value.split(/[、,，;；\n]+/).map((s) => s.trim()).filter(Boolean);
const majorAliases = new Map([
  ['计算机公共教学', '公共'],
  ['专转本', '计算机科学与技术（专转本）'],
  ['中外物联网', '物联网工程（中外合作）'],
  ['物联网工程（合作办学）', '物联网工程（中外合作）'],
]);
const standardMajor = (major: string) => majorAliases.get(major) ?? major;
const majorKey = (major: string) => normalize(standardMajor(major));
export const courseKey = (course: HistoryCourse) => JSON.stringify(
  course.code ? [normalize(course.code)] : [normalize(course.name), majorKey(course.major)],
);
export const canManageHistory = (user: PublicUser) => user.role === 'admin' || user.college_role === 'teaching';

export const HISTORY_UPLOAD_EXTENSIONS = ['.xls', '.xlsx', '.csv', '.docx'];

const FLAT_COURSE_NAMES = ['课程', '课程名称', '课程名'];
const FLAT_CODES = ['课程代码', '课程编号', '课程编码'];
const FLAT_FEEDBACK = ['具体反馈', '反馈', '检查意见', '问题描述', '存在问题', '主要问题', '问题记录', '问题', '检查问题', '整改意见'];
const TEACHER_HEADERS = ['任课教师', '任课教师姓名', '教师姓名', '教师名称', '授课教师', '教师', '执笔人', '大纲执笔人'];
const STAFF_NO_HEADERS = ['任课教师工号', '教师工号', '工号', '执笔人工号'];
const CONTEXT_HEADERS = ['教学班或专业', '教学班组成', '教学班', '班级', '授课班级'];

const MATRIX_METADATA_HEADERS = new Set([
  ...FLAT_COURSE_NAMES,
  ...FLAT_CODES,
  ...TEACHER_HEADERS,
  ...STAFF_NO_HEADERS,
  ...CONTEXT_HEADERS,
  '学年', '学期', '学年学期', '学分', '选课人数', '人数', '多人授课', '开课类型',
  '课程性质', '考试方式', '开课学院', '学院', '专业', '审核专业', '开课专业',
  '源表行号', '行号', '序号', '编号', '检查人', '复核人', '备注',
  '课程讲授学时总学时', '课程实验总学时', '讲授学时', '实验学时', '总学时', '理论学时',
]);

const FLAT_NO_PROBLEM_VALUES = new Set([
  '', '无', '无问题', '没问题', '没有问题', '正常', '无异常', '无误', '通过', '合格',
  '-', '--', '---', '—', '——', '–', '/', '\\', '不涉及', '无须', '无需', '不适用',
]);

const MATRIX_OK_VALUES = new Set([
  '', '是', '有', '对', '✓', '✔', '√', '☑', 'ok', 'yes', 'y', 'true', 'pass',
  '通过', '正常', '合理', '匹配', '一致', '齐全', '完整', '规范', '符合',
  '已签字', '有签字', '无问题', '没问题', '没有问题', '无异常', '无误', '达标',
  '已体现', '已标注', '已注明', '清晰', '明确', '合格',
  '不涉及', '无须', '无需', '不适用', '无此项', 'n/a', 'na',
  '-', '--', '---', '—', '——', '–', '/', '\\', '略',
]);

function stripTrailingPunctuation(text: string): string {
  return text.replace(/[。，、；：！？.,;:!?\s]+$/g, '').trim();
}

function isMatrixProblemCell(rawValue: string, checkItem = ''): boolean {
  const trimmed = clean(rawValue);
  if (!trimmed) return false;
  const norm = stripTrailingPunctuation(normalize(trimmed));
  if (!norm || MATRIX_OK_VALUES.has(norm)) return false;
  // Pure repeated positive answers like "是是", "是、是", "√√"
  if (/^(?:[是✓✔√☑][\s、,，;；]*)+$/.test(norm)) return false;
  // Excel/Tencent Docs stores "100%" as numeric 1 in 100-point/ratio columns
  if ((norm === '1' || norm === '100%' || norm === '100') && /100分|比例|百分/.test(checkItem)) return false;
  if (/^[2-9]\d*\s*种$/.test(norm) || /^[二两三四五六七八九十]\s*种$/.test(norm)) return false;
  return true;
}

function formatTerm(academicYear: string, semester: string): string {
  const y = clean(academicYear);
  const s = clean(semester);
  if (!y && !s) return '';
  if (s && /\d{4}/.test(s)) return s;
  if (y && s) {
    if (/^第.+学期$/.test(s)) return `${y} ${s}`;
    return `${y} 第${s}学期`;
  }
  return y || s;
}

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
  return course.code
    ? courses.filter((c) => normalize(c.code) === normalize(course.code))
    : courses.filter((c) => normalize(c.name) === normalize(course.name) && (!course.major || majorKey(c.major) === majorKey(course.major)));
}

function teacherDirectory() {
  const rows = db.prepare(`SELECT name, username AS staffNo FROM users WHERE name <> ''
    UNION SELECT name, username FROM progress_roster WHERE name <> ''`).all() as Teacher[];
  const byName = new Map<string, Map<string, string>>();
  for (const { name, staffNo } of rows) {
    const key = normalize(name);
    if (!byName.has(key)) byName.set(key, new Map());
    byName.get(key)!.set(normalize(staffNo), staffNo);
  }
  return byName;
}

function userLookupDirectory() {
  const rows = db.prepare('SELECT id, name, username FROM users').all() as { id: number; name: string; username: string }[];
  const byStaff = new Map<string, number>();
  const byName = new Map<string, number[]>();
  for (const row of rows) {
    byStaff.set(normalize(row.username), row.id);
    if (row.name.trim()) {
      const nk = normalize(row.name);
      const list = byName.get(nk) ?? [];
      list.push(row.id);
      byName.set(nk, list);
    }
  }
  return { byStaff, byName };
}

function identifyTeachers(teachers: Teacher[], directory: ReturnType<typeof teacherDirectory>) {
  const unique = new Map<string, Teacher>();
  for (const teacher of teachers) {
    const ids = directory.get(normalize(teacher.name));
    const staffNo = teacher.staffNo || (ids?.size === 1 ? [...ids.values()][0] : '');
    const key = staffNo ? normalize(staffNo) : normalize(teacher.name);
    if (!key) continue;
    unique.set(key, { name: teacher.name || unique.get(key)?.name || '', staffNo });
  }
  return [...unique.values()];
}

function matchTeachersToUsers(teachers: Teacher[], lookup: ReturnType<typeof userLookupDirectory>): TeacherMatch[] {
  return teachers.map((teacher) => {
    if (teacher.staffNo) {
      const id = lookup.byStaff.get(normalize(teacher.staffNo));
      if (id !== undefined) return { ...teacher, matchedUserId: id, status: 'matched' };
    }
    const ids = teacher.name ? lookup.byName.get(normalize(teacher.name)) ?? [] : [];
    if (ids.length === 1) return { ...teacher, matchedUserId: ids[0], status: 'matched' };
    if (ids.length > 1) return { ...teacher, matchedUserId: null, status: 'ambiguous' };
    return { ...teacher, matchedUserId: null, status: 'unmatched' };
  });
}

function decodeCsvBuffer(buffer: Buffer): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buffer);
  } catch {
    return new TextDecoder('gb18030').decode(buffer);
  }
}

async function readDocxTables(filePath: string): Promise<{ sheet: string; data: string[][] }[]> {
  const bytes = await fs.readFile(filePath);
  const zip = await JSZip.loadAsync(bytes);
  const docXml = await zip.file('word/document.xml')?.async('string');
  if (!docXml) return [];
  const decodeEntities = (s: string) => s
    .replaceAll('&amp;', '&')
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&quot;', '"')
    .replaceAll('&apos;', "'");
  const tables: { sheet: string; data: string[][] }[] = [];
  let tableIdx = 0;
  for (const tblMatch of docXml.matchAll(/<w:tbl\b[\s\S]*?<\/w:tbl>/g)) {
    tableIdx++;
    const data: string[][] = [];
    for (const trMatch of tblMatch[0].matchAll(/<w:tr\b[\s\S]*?<\/w:tr>/g)) {
      const row: string[] = [];
      for (const tcMatch of trMatch[0].matchAll(/<w:tc\b[\s\S]*?<\/w:tc>/g)) {
        const paragraphs: string[] = [];
        for (const pMatch of tcMatch[0].matchAll(/<w:p\b[\s\S]*?<\/w:p>/g)) {
          const texts = [...pMatch[0].matchAll(/<w:t\b[^>]*>([\s\S]*?)<\/w:t>/g)].map((m) => decodeEntities(m[1]));
          const joined = texts.join('');
          if (joined) paragraphs.push(joined);
        }
        row.push(paragraphs.join('\n').trim());
      }
      if (row.some((cell) => cell)) data.push(row);
    }
    if (data.length >= 2) tables.push({ sheet: `表格${tableIdx}`, data });
  }
  return tables;
}

async function readHistorySheetsFromFile(filePath: string, fileName: string): Promise<{ sheet: string; data: unknown[][] }[]> {
  const lower = fileName.toLowerCase();
  if (lower.endsWith('.csv')) {
    const text = decodeCsvBuffer(await fs.readFile(filePath));
    const records = parseCsv(text, {
      bom: true,
      relax_column_count: true,
      skip_empty_lines: false,
      trim: false,
    }) as string[][];
    return [{ sheet: 'CSV', data: records }];
  }
  if (lower.endsWith('.docx')) {
    return await readDocxTables(filePath);
  }
  if (lower.endsWith('.xls')) {
    return await readXlsWorkbook(filePath);
  }
  return await readXlsxFile(filePath, { trim: false, parseNumber: (value) => value });
}

function isFlatHeaderRow(line: string[]): boolean {
  return [...FLAT_COURSE_NAMES, ...FLAT_CODES].some((key) => line.includes(key))
    && FLAT_FEEDBACK.some((key) => line.includes(key));
}

function findMatrixHeaderIndex(headers: string[][]): number {
  return headers.findIndex((line) => {
    const hasTeacher = TEACHER_HEADERS.some((key) => line.includes(key));
    if (!hasTeacher) return false;
    const hasCourseOrContext = FLAT_COURSE_NAMES.some((key) => line.includes(key))
      || CONTEXT_HEADERS.some((key) => line.includes(key))
      || line.includes('学年')
      || line.includes('检查人');
    if (!hasCourseOrContext) return false;
    const nonMetaCount = line.filter((cell) => cell && !MATRIX_METADATA_HEADERS.has(cell) && !/^\d+$/.test(cell)).length;
    return nonMetaCount >= 3;
  });
}

function parseFlatSheet(
  sheet: string,
  sheetIndex: number,
  data: unknown[][],
  headers: string[][],
  fileName: string,
  sourceUrl: string | undefined,
  courses: HistoryCourse[],
  directory: ReturnType<typeof teacherDirectory>,
  hasExplicitFeedbackOnlyHeader: boolean,
): HistoryPreviewRow[] {
  const rows: HistoryPreviewRow[] = [];
  let header: string[] | null = null;
  let blockIndex = 0;

  for (let i = 0; i < data.length; i++) {
    const line = headers[i];
    if (isFlatHeaderRow(line)) {
      header = line;
      blockIndex++;
      continue;
    }
    if (!header) continue;
    const cells = data[i];
    if (!cells.some((cell) => clean(cell))) continue;

    const raw = (keys: string[]) => {
      const idx = header!.findIndex((key) => keys.includes(key));
      return idx >= 0 ? String(cells[idx] ?? '') : '';
    };
    const value = (...keys: string[]) => raw(keys).trim();

    const teacherNames = names(value(...TEACHER_HEADERS));
    const staffNos = names(value(...STAFF_NO_HEADERS));
    const staffMismatch = !!(teacherNames.length && staffNos.length && teacherNames.length !== staffNos.length);
    const teachers = identifyTeachers(
      Array.from({ length: Math.max(teacherNames.length, staffNos.length) }, (_, n) => ({
        name: teacherNames[n] ?? '',
        staffNo: staffNos[n] ?? '',
      })),
      directory,
    );

    const name = value(...FLAT_COURSE_NAMES);
    const code = value(...FLAT_CODES);
    const text = raw(FLAT_FEEDBACK);
    const trimmedText = text.trim();

    // In roster-style tables (e.g. with 存在问题), rows with empty / "无" problem cells have no issue and are skipped.
    const normFeedback = stripTrailingPunctuation(normalize(trimmedText));
    if (!trimmedText || (!hasExplicitFeedbackOnlyHeader && FLAT_NO_PROBLEM_VALUES.has(normFeedback))) {
      if (!trimmedText) continue;
      if (FLAT_NO_PROBLEM_VALUES.has(normFeedback)) continue;
    }

    const term = formatTerm(value('学年'), value('学期', '学年学期'));
    const context = value(...CONTEXT_HEADERS);
    const examType = value('考试方式');
    const reviewer = value('检查人', '复核人');
    const source = value('来源文件（全名）', '来源文件') || fileName;
    const position = value('原表位置', '反馈位置');
    const nature = value('反馈性质');

    const courseNamesInCell = !code && name.includes('、') ? name.split('、').map(clean).filter(Boolean) : [name];
    for (const [n, courseName] of courseNamesInCell.entries()) {
      const course = { name: courseName, code, major: value('专业', '审核专业', '开课专业') };
      const candidates = resolveCourse(course, courses);
      const status = (!courseName && !code) || !trimmedText || staffMismatch
        ? 'invalid'
        : candidates.length > 1
          ? 'ambiguous'
          : candidates.length === 1
            ? 'matched'
            : 'unmatched';
      const entry: HistoryPreviewRow = {
        key: `${sheetIndex}:${i}:${n}`,
        row: i + 1,
        sheet: blockIndex > 1 && sheet === 'CSV' ? `${sheet}·表${blockIndex}` : sheet,
        course,
        status,
        candidates,
        teachers,
        text,
        term,
        context,
        source,
        position,
        nature,
      };
      if (examType) entry.examType = examType;
      if (reviewer) entry.reviewer = reviewer;
      if (sourceUrl) entry.sourceUrl = sourceUrl;
      rows.push(entry);
    }
  }
  return rows;
}

function forwardFill(row: unknown[], startCol: number, totalCols: number): string[] {
  const filled = new Array<string>(totalCols).fill('');
  let current = '';
  for (let c = startCol; c < totalCols; c++) {
    const val = clean(row[c]);
    if (val) current = val;
    filled[c] = current;
  }
  return filled;
}

function parseMatrixSheet(
  sheet: string,
  sheetIndex: number,
  data: unknown[][],
  headers: string[][],
  headerIndex: number,
  fileName: string,
  sourceUrl: string | undefined,
  courses: HistoryCourse[],
  directory: ReturnType<typeof teacherDirectory>,
): HistoryPreviewRow[] {
  const header = headers[headerIndex];
  const rawHeader = data[headerIndex].map(clean);
  const totalCols = Math.max(
    header.length,
    headerIndex > 0 ? data[headerIndex - 1].length : 0,
    headerIndex > 1 ? data[headerIndex - 2].length : 0,
  );

  // Locate metadata column indices
  const findCol = (keys: string[]) => header.findIndex((cell) => keys.includes(cell));
  const teacherCol = findCol(TEACHER_HEADERS);
  let courseCol = findCol(FLAT_COURSE_NAMES);
  // If the "课程名称" header cell was accidentally overwritten (e.g. "1") or blank, infer col before teacherCol
  if (courseCol < 0 && teacherCol > 0) {
    const candidate = teacherCol - 1;
    if (!MATRIX_METADATA_HEADERS.has(header[candidate] ?? '')) courseCol = candidate;
  }
  const codeCol = findCol(FLAT_CODES);
  const staffCol = findCol(STAFF_NO_HEADERS);
  const yearCol = findCol(['学年']);
  const semCol = findCol(['学期', '学年学期']);
  const sectionCol = findCol(['教学班']);
  const classCompCol = findCol(['教学班组成', '教学班或专业', '班级', '授课班级']);
  const majorCol = findCol(['专业', '审核专业', '开课专业']);
  const reviewerCol = findCol(['检查人', '复核人']);
  const examCol = findCol(['考试方式']);

  // Determine the first check column (first column after metadata that has a non-meta header or upper-row category)
  const metaCols = new Set<number>();
  if (courseCol >= 0) metaCols.add(courseCol);
  let lastMetaCol = courseCol;
  for (let c = 0; c < totalCols; c++) {
    const h = header[c] ?? '';
    if (h && MATRIX_METADATA_HEADERS.has(h)) {
      metaCols.add(c);
      if (c > lastMetaCol) lastMetaCol = c;
    }
  }
  const checkStartCol = Math.max(0, lastMetaCol + 1);
  const upperRow1 = headerIndex >= 1 ? forwardFill(data[headerIndex - 1], checkStartCol, totalCols) : new Array<string>(totalCols).fill('');
  const upperRow2 = headerIndex >= 2 ? forwardFill(data[headerIndex - 2], checkStartCol, totalCols) : new Array<string>(totalCols).fill('');

  const checkCols: { col: number; category: string; checkItem: string }[] = [];
  let prevCheckItem = '';
  for (let c = checkStartCol; c < totalCols; c++) {
    if (metaCols.has(c)) continue;
    const itemTitle = rawHeader[c] ?? '';
    const cat = upperRow1[c] || upperRow2[c] || '';
    if (!itemTitle && !cat) continue;
    const checkItem = itemTitle || (cat ? `${cat}（补充说明）` : prevCheckItem ? `${prevCheckItem}（补充）` : `检查项${c + 1}`);
    if (itemTitle) prevCheckItem = itemTitle;
    checkCols.push({ col: c, category: cat || upperRow2[c] || '材料检查', checkItem });
  }
  if (!checkCols.length) return [];

  const rows: HistoryPreviewRow[] = [];
  for (let i = headerIndex + 1; i < data.length; i++) {
    const cells = data[i];
    if (!cells || !cells.some((cell) => clean(cell))) continue;
    // If we hit a repeated/appendix header table below, stop scanning matrix data
    const rowNorm = headers[i];
    if (rowNorm[0] === '序号' || rowNorm[0] === '课程名称' || rowNorm[0] === '课程代码') break;

    let courseName = courseCol >= 0 ? clean(cells[courseCol]) : '';
    const section = sectionCol >= 0 ? clean(cells[sectionCol]) : '';
    const classComp = classCompCol >= 0 ? clean(cells[classCompCol]) : '';
    if (!courseName && section && section.includes('-')) {
      courseName = section.split('-')[0].trim();
    }
    if (!courseName || ['合计', '总计', '统计', '小计'].includes(courseName)) continue;

    const code = codeCol >= 0 ? clean(cells[codeCol]) : '';
    const major = majorCol >= 0 ? clean(cells[majorCol]) : '';
    const teacherNames = teacherCol >= 0 ? names(clean(cells[teacherCol])) : [];
    const staffNos = staffCol >= 0 ? names(clean(cells[staffCol])) : [];
    const staffMismatch = !!(teacherNames.length && staffNos.length && teacherNames.length !== staffNos.length);
    const teachers = identifyTeachers(
      Array.from({ length: Math.max(teacherNames.length, staffNos.length) }, (_, n) => ({
        name: teacherNames[n] ?? '',
        staffNo: staffNos[n] ?? '',
      })),
      directory,
    );
    const term = formatTerm(yearCol >= 0 ? clean(cells[yearCol]) : '', semCol >= 0 ? clean(cells[semCol]) : '');
    const context = classComp || section;
    const reviewer = reviewerCol >= 0 ? clean(cells[reviewerCol]) : '';
    const examType = examCol >= 0 ? clean(cells[examCol]) : '';

    const course = { name: courseName, code, major };
    const candidates = resolveCourse(course, courses);

    for (const { col, category, checkItem } of checkCols) {
      const cellValue = clean(cells[col]);
      if (!isMatrixProblemCell(cellValue, checkItem)) continue;
      const text = `【${checkItem}】${cellValue}`;
      const status = staffMismatch
        ? 'invalid'
        : candidates.length > 1
          ? 'ambiguous'
          : candidates.length === 1
            ? 'matched'
            : 'unmatched';
      const entry: HistoryPreviewRow = {
        key: `${sheetIndex}:${i}:c${col}`,
        row: i + 1,
        sheet,
        course,
        status,
        candidates,
        teachers,
        text,
        term,
        context,
        source: fileName,
        position: `${sheet}!第 ${i + 1} 行 · ${category}`,
        nature: category,
        category,
        checkItem,
      };
      if (reviewer) entry.reviewer = reviewer;
      if (examType) entry.examType = examType;
      if (sourceUrl) entry.sourceUrl = sourceUrl;
      rows.push(entry);
    }
  }
  return rows;
}

function parseHistorySheets(
  sheets: { sheet: string; data: unknown[][] }[],
  fileName: string,
  sourceUrl?: string,
): { rows: HistoryPreviewRow[]; format: 'flat' | 'matrix' | 'mixed' } {
  const courses = historyCourses();
  const directory = teacherDirectory();
  const rows: HistoryPreviewRow[] = [];
  let flatCount = 0;
  let matrixCount = 0;

  for (const [sheetIndex, { sheet, data }] of sheets.entries()) {
    const headers = data.map((line) => line.map((cell) => clean(cell).replace(/\s/g, '')));
    const flatIdx = headers.findIndex(isFlatHeaderRow);
    if (flatIdx !== -1) {
      // Distinguish strict legacy feedback columns vs roster-style "存在问题" columns
      const hasRosterProblemCol = headers[flatIdx].includes('存在问题');
      const parsed = parseFlatSheet(sheet, sheetIndex, data, headers, fileName, sourceUrl, courses, directory, !hasRosterProblemCol);
      if (parsed.length) flatCount++;
      rows.push(...parsed);
      continue;
    }
    const matrixIdx = findMatrixHeaderIndex(headers);
    if (matrixIdx !== -1) {
      const parsed = parseMatrixSheet(sheet, sheetIndex, data, headers, matrixIdx, fileName, sourceUrl, courses, directory);
      if (parsed.length) matrixCount++;
      rows.push(...parsed);
    }
  }

  const format: 'flat' | 'matrix' | 'mixed' = flatCount && matrixCount ? 'mixed' : matrixCount ? 'matrix' : 'flat';
  return { rows, format };
}

export async function previewHistory(filePath: string, fileName: string): Promise<HistoryPreviewRow[]> {
  const sheets = await readHistorySheetsFromFile(filePath, fileName);
  return parseHistorySheets(sheets, fileName).rows;
}

// Short-lived in-memory preview cache for both URL imports and file imports
interface CachedPreview {
  userId: number;
  createdAt: number;
  sourceName: string;
  sourceUrl?: string;
  format: 'flat' | 'matrix' | 'mixed';
  rows: HistoryPreviewRow[];
}

const previewCache = new Map<string, CachedPreview>();
const PREVIEW_TTL_MS = 30 * 60 * 1000;

function prunePreviewCache() {
  const now = Date.now();
  for (const [id, item] of previewCache) {
    if (now - item.createdAt > PREVIEW_TTL_MS) previewCache.delete(id);
  }
  if (previewCache.size > 40) {
    const oldest = [...previewCache.entries()].sort((a, b) => a[1].createdAt - b[1].createdAt);
    for (const [id] of oldest.slice(0, previewCache.size - 40)) previewCache.delete(id);
  }
}

function buildPreviewSummary(
  userId: number,
  sourceName: string,
  sourceUrl: string | undefined,
  parsed: { rows: HistoryPreviewRow[]; format: 'flat' | 'matrix' | 'mixed' },
): HistoryPreviewSummary {
  prunePreviewCache();
  const lookup = userLookupDirectory();
  const courses = historyCourses().map((course) => ({ ...course, key: courseKey(course) }));
  const matchedTeacherKeys = new Set<string>();
  const unmatchedTeacherKeys = new Set<string>();

  const rowsWithMatches = parsed.rows.map((row) => {
    const teacherMatches = matchTeachersToUsers(row.teachers, lookup);
    for (const tm of teacherMatches) {
      const tk = tm.staffNo ? normalize(tm.staffNo) : normalize(tm.name);
      if (!tk) continue;
      if (tm.status === 'matched') matchedTeacherKeys.add(tk);
      else unmatchedTeacherKeys.add(tk);
    }
    return {
      ...row,
      teacherMatches,
      candidates: row.candidates.map((course) => ({ ...course, key: courseKey(course) })),
    };
  });

  const previewId = crypto.randomUUID();
  previewCache.set(previewId, {
    userId,
    createdAt: Date.now(),
    sourceName,
    sourceUrl,
    format: parsed.format,
    rows: parsed.rows,
  });

  return {
    previewId,
    format: parsed.format,
    sourceName,
    sourceUrl,
    totalRows: parsed.rows.length,
    matchedTeachers: matchedTeacherKeys.size,
    unmatchedTeachers: unmatchedTeacherKeys.size,
    courses,
    rows: rowsWithMatches,
  };
}

export async function createFileHistoryPreview(userId: number, filePath: string, fileName: string): Promise<HistoryPreviewSummary> {
  const sheets = await readHistorySheetsFromFile(filePath, fileName);
  const parsed = parseHistorySheets(sheets, fileName);
  return buildPreviewSummary(userId, fileName, undefined, parsed);
}

export async function createUrlHistoryPreview(userId: number, url: string): Promise<HistoryPreviewSummary> {
  const workbook = await readTencentSheetWorkbook(url);
  const parsed = parseHistorySheets(workbook.sheets, workbook.title, workbook.url);
  return buildPreviewSummary(userId, workbook.title, workbook.url, parsed);
}

export function consumeCachedPreview(previewId: string, userId: number): CachedPreview | null {
  prunePreviewCache();
  const entry = previewCache.get(previewId);
  if (!entry || entry.userId !== userId) return null;
  return entry;
}

export function deleteCachedPreview(previewId: string) {
  previewCache.delete(previewId);
}

export function importHistory(rows: HistoryPreviewRow[], choices: Record<string, string>, user: PublicUser) {
  const confirmed: { row: HistoryPreviewRow; course: HistoryCourse }[] = [];
  const courses = new Map(historyCourses().map((course) => [courseKey(course), course]));
  for (const row of rows) {
    const choice = choices[row.key];
    if (!choice || row.status === 'invalid') continue;
    const match = choice === 'original' && row.course.name
      ? row.course
      : row.status === 'matched'
        ? row.candidates.find((candidate) => courseKey(candidate) === choice) ?? courses.get(choice)
        : courses.get(choice);
    if (!match) return null;
    const course = !match.code && row.course.code ? { ...match, code: row.course.code } : match;
    confirmed.push({ row, course });
  }
  const uploader = `${user.name || user.username}（${user.username}）`;
  const catalog = uniqueCourses([...courses.values(), ...confirmed.map(({ course }) => course)]);
  const fingerprint = (course: HistoryCourse, feedback: Feedback) => JSON.stringify([
    courseKey(canonicalCourse(course, catalog)),
    termKey(feedback.term),
    normalize(feedback.context),
    feedback.text.trim(),
    feedback.source,
  ]);
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
      const payload: Payload = previous?.payload ?? {
        teachers: row.teachers,
        text: row.text,
        term: row.term,
        context: row.context,
        source: row.source,
        position: row.position || `${row.sheet}!第 ${row.row} 行`,
        nature: row.nature,
        uploader,
        ...(row.category ? { category: row.category } : {}),
        ...(row.checkItem ? { checkItem: row.checkItem } : {}),
        ...(row.reviewer ? { reviewer: row.reviewer } : {}),
        ...(row.examType ? { examType: row.examType } : {}),
        ...(row.sourceUrl ? { sourceUrl: row.sourceUrl } : {}),
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
    const base = {
      course: canonical(course),
      teachers,
      uploader: `${row.name || row.username}（${row.username}）`,
      source: row.file_name,
      date: row.date,
      term: '',
      context: '',
      outline: true as const,
      submissionId: all || row.user_id === user.id ? row.id : undefined,
    };
    issues.push(
      ...result.issues.map((item, i) => ({
        ...base,
        id: `syllabus:${row.id}:${i}`,
        text: [item.title, item.problem, item.advice].filter(Boolean).join('\n'),
        position: item.location,
        nature: item.nature,
        outlineDetail: { title: item.title, problem: item.problem, advice: item.advice, evidence: item.evidence },
      })),
      ...result.toVerify.map((item, i) => ({
        ...base,
        id: `verify:${row.id}:${i}`,
        text: item.content,
        position: item.location,
        nature: '需核实',
      })),
    );
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
  return {
    counts,
    total: groups.size,
    pageSize,
    groups: [...groups].slice((page - 1) * pageSize, page * pageSize).map(([id, issues]) => ({ id, issues })),
  };
}

export function courseHistory(user: PublicUser, scope: MaterialScope) {
  return historyIssues(user, { identity: { name: scope.title, major: scope.major, code: scope.courseCode } });
}
