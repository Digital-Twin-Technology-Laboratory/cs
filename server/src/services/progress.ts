import fs from 'node:fs/promises';
import readXlsxFile, { InvalidInputError, InvalidSpreadsheetError, SheetNotFoundError } from 'read-excel-file/node';
import { z } from 'zod';
import { db } from '../db.js';
import { RosterImportError } from './rosterImport.js';
import type { PublicUser } from '../auth.js';

const staffSchema = z.object({
  name: z.string().min(1).max(50),
  username: z.string().min(1).max(32).regex(/^[A-Za-z0-9_.@-]+$/),
  course: z.string().min(1).max(100),
});
const splitStaff = (value: string) => value.split(/[、,，;；\n]/).map((s) => s.trim()).filter(Boolean);

async function readTable(file: Express.Multer.File, required: string[]) {
  let sheets;
  try {
    sheets = await readXlsxFile(await fs.readFile(file.path), { parseNumber: (value) => value });
  } catch (e) {
    if (e instanceof InvalidInputError || e instanceof InvalidSpreadsheetError || e instanceof SheetNotFoundError) {
      throw new RosterImportError(`${file.originalname} 解析失败：${e.message}`);
    }
    throw e;
  }
  for (const sheet of sheets) {
    const rows = sheet.data.map((row) => row.map((cell) => String(cell ?? '').trim()));
    const headerIndex = rows.findIndex((row) => required.every((header) => row.includes(header)));
    if (headerIndex < 0) continue;
    const headers = rows[headerIndex];
    if (required.some((header) => headers.filter((cell) => cell === header).length !== 1)) {
      throw new RosterImportError(`${file.originalname} 的必需列名不能重复`);
    }
    return rows.slice(headerIndex + 1).flatMap((row, index) => row.some(Boolean) ? [{
      line: headerIndex + index + 2,
      values: Object.fromEntries(headers.map((header, column) => [header, row[column] ?? ''])),
    }] : []);
  }
  throw new RosterImportError(`${file.originalname} 中未找到包含 ${required.join('、')} 的表头`);
}

export async function readProgressRoster(timetable: Express.Multer.File, plan: Express.Multer.File) {
  const rows = await readTable(timetable, ['星期几', '课程名称', '姓名', '教工号', '课程组']);
  const people = new Map<string, { username: string; name: string }>();
  const requirements = new Map<string, { username: string; name: string; course: string; group: string; inPlan: boolean }>();
  let expandedRows = 0;
  for (const { line, values: row } of rows) {
    if (!/^(?:星期|周)?[一二三四五六日天1-7]$/.test(row['星期几'])) {
      throw new RosterImportError(`课表第 ${line} 行：星期几须为周一至周日中的一天`);
    }
    const names = splitStaff(row['姓名']);
    const numbers = splitStaff(row['教工号']);
    if (!names.length || names.length !== numbers.length) throw new RosterImportError(`课表第 ${line} 行：姓名与教工号须一一对应，共同授课用“、”分隔`);
    for (const [index, name] of names.entries()) {
      const parsed = staffSchema.safeParse({ name, username: numbers[index], course: row['课程名称'] });
      if (!parsed.success) throw new RosterImportError(`课表第 ${line} 行：请核对姓名、教工号和课程名称（工号须为文本）`);
      const { username, course } = parsed.data;
      const number = username.toLowerCase();
      if (people.has(number) && people.get(number)!.name !== name) throw new RosterImportError(`课表第 ${line} 行：工号 ${username} 对应多个姓名`);
      people.set(number, { username, name });
      const key = JSON.stringify([number, course]);
      if (!requirements.has(key)) requirements.set(key, { username, name, course, group: row['课程组'] ?? '', inPlan: false });
      expandedRows++;
    }
  }
  if (!requirements.size) throw new RosterImportError('课表中没有应交课程');

  const planRows = await readTable(plan, ['授课教师', '课程名称']);
  if (!planRows.length) throw new RosterImportError('磨课计划中没有逐场安排');
  const warnings: string[] = [];
  const planPairs = new Set<string>();
  for (const { line, values: row } of planRows) {
    if (!row['授课教师'] || !row['课程名称']) throw new RosterImportError(`磨课逐场安排第 ${line} 行：授课教师和课程名称不能为空`);
    for (const name of splitStaff(row['授课教师'])) {
      const key = JSON.stringify([name, row['课程名称']]);
      if (planPairs.has(key)) continue;
      planPairs.add(key);
      const matches = [...requirements.values()].filter((r) => r.name === name && r.course === row['课程名称']);
      if (matches.length === 1) {
        matches[0].inPlan = true;
        if (!matches[0].group) warnings.push(`${name} / ${row['课程名称']}：课表未填写课程组，保留在全院统计，暂不开放给课程组长`);
      }
      else warnings.push(`${name} / ${row['课程名称']}：${matches.length ? '存在同名教师，无法确定工号' : '未在课表中找到对应任课记录'}`);
    }
  }
  return {
    people: [...people.values()], requirements: [...requirements.values()],
    sourceRows: rows.length, mergedRows: expandedRows - requirements.size, planPairs: planPairs.size, warnings,
  };
}

export interface RequiredCourseProgress {
  course_name: string;
  course_group: string;
  in_plan: number;
  latest_id: number | null;
  status: string | null;
  verdict: string | null;
  confirmed_at: string | null;
  confirmed_by: string;
  created_at: string | null;
}

export function getProgress(username?: string, groups?: string[], planOnly = false) {
  const where: string[] = [];
  const args: string[] = [];
  if (username !== undefined) { where.push('r.username = ?'); args.push(username); }
  if (groups !== undefined) {
    if (!groups.length) return [];
    where.push(`r.course_group IN (${groups.map(() => '?').join(',')})`);
    args.push(...groups);
  }
  if (planOnly) where.push('r.in_plan = 1');
  const courses = db.prepare(`
    SELECT p.username, p.name, u.id AS user_id, r.course_name, r.course_group, r.in_plan,
      s.id AS latest_id, s.status, s.verdict, s.confirmed_at, COALESCE(s.confirmed_by, '') AS confirmed_by, s.created_at
    FROM progress_requirements r JOIN progress_roster p ON p.username = r.username
    LEFT JOIN users u ON u.username = r.username
    LEFT JOIN submissions s ON s.id = (
      SELECT MAX(s2.id) FROM submissions s2 JOIN courses c ON c.id = s2.course_id
      WHERE s2.user_id = u.id AND TRIM(c.name) = r.course_name COLLATE NOCASE
    )
    ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
    ORDER BY p.name, r.username, r.course_name
  `).all(...args) as (RequiredCourseProgress & { username: string; name: string; user_id: number | null })[];
  const people = new Map<string, { username: string; name: string; user_id: number | null; required_count: number; uploaded_count: number; passed_count: number; confirmed_count: number; courses: RequiredCourseProgress[] }>();
  for (const { username: number, name, user_id, ...course } of courses) {
    if (!people.has(number)) people.set(number, { username: number, name, user_id, required_count: 0, uploaded_count: 0, passed_count: 0, confirmed_count: 0, courses: [] });
    const person = people.get(number)!;
    person.required_count++;
    if (course.latest_id !== null) person.uploaded_count++;
    if (course.status === 'done' && course.verdict === 'passed') person.passed_count++;
    if (course.status === 'done' && course.confirmed_at !== null) person.confirmed_count++;
    person.courses.push(course);
  }
  return [...people.values()];
}

export function leadsSubmission(user: PublicUser, submissionId: number, latestOnly = false) {
  if (!user.led_groups.length) return false;
  return !!db.prepare(`
    SELECT 1 FROM submissions s JOIN users u ON u.id = s.user_id JOIN courses c ON c.id = s.course_id
    JOIN progress_requirements r ON r.username = u.username AND r.course_name = TRIM(c.name) COLLATE NOCASE
    WHERE s.id = ? AND r.in_plan = 1 AND r.course_group IN (${user.led_groups.map(() => '?').join(',')})
    ${latestOnly ? `AND s.id = (SELECT MAX(s2.id) FROM submissions s2 JOIN courses c2 ON c2.id = s2.course_id
      WHERE s2.user_id = s.user_id AND TRIM(c2.name) = r.course_name COLLATE NOCASE)` : ''}
  `).get(submissionId, ...user.led_groups);
}
