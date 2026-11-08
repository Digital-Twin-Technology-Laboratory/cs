import { db } from '../db.js';
import type { PublicUser } from '../auth.js';

export const PROFESSIONALS = ['计算机科学与技术', '物联网工程', '人工智能', '计算机公共教学', '智能无人机系统与应用（微专业）'];
export type View = 'college' | 'group' | 'program';

export interface OutlineProgressRow {
  id: number;
  source_key: string;
  course_name: string;
  course_group: string;
  professional: string;
  teacher_names: string;
  writer_name: string;
  writer_identifier: string;
  writer_manual: number;
  username: string;
  name: string;
  user_id: number | null;
  uploader_id: number | null;
  uploader_name: string;
  uploader_username: string;
  latest_id: number | null;
  status: 'queued' | 'running' | 'done' | 'failed' | null;
  verdict: 'passed' | 'failed' | null;
  confirmed_at: string | null;
  confirmed_by: string;
  created_at: string | null;
}

// The legacy upload form called the cooperative program "中外物联网".
const matchingMajor = (course: string, requirement: string) => `(${course}.major = ${requirement}.professional OR (${course}.major = '中外物联网' AND ${requirement}.professional = '物联网工程（合作办学）'))`;

function matchesOutline(submission: string, course: string) {
  return `(${submission}.outline_requirement_id = r.id OR (
    ${submission}.outline_requirement_id IS NULL
    AND TRIM(${course}.name) = r.course_name COLLATE NOCASE AND ${matchingMajor(course, 'r')}
    AND (SELECT COUNT(*) FROM outline_requirements other
      WHERE other.course_name = TRIM(${course}.name) COLLATE NOCASE AND ${matchingMajor(course, 'other')}) = 1
  ))`;
}

export function getOutlineRows() {
  return db.prepare(`
    SELECT r.*, u.id AS user_id, COALESCE(u.username, r.writer_identifier) AS username,
      COALESCE(u.name, r.writer_name) AS name,
      s.id AS latest_id, s.status, s.verdict, s.confirmed_at,
      COALESCE(s.confirmed_by, '') AS confirmed_by, s.created_at,
      uploader.id AS uploader_id, COALESCE(uploader.name, '') AS uploader_name,
      COALESCE(uploader.username, '') AS uploader_username
    FROM outline_requirements r LEFT JOIN users u ON u.id = r.writer_user_id
    LEFT JOIN submissions s ON s.id = (
      SELECT MAX(s2.id) FROM submissions s2 JOIN courses c ON c.id = s2.course_id
      WHERE ${matchesOutline('s2', 'c')}
    )
    LEFT JOIN users uploader ON uploader.id = s.user_id
    ORDER BY r.course_group, r.professional, r.course_name
  `).all() as OutlineProgressRow[];
}

export function availableViews(user: PublicUser): View[] {
  const views: View[] = [];
  if (user.role === 'admin' || user.college_role === 'teaching') views.push('college');
  if (user.college_role === 'program' || user.program_scopes.length) views.push('program');
  if (user.led_groups.length) views.push('group');
  return views;
}

export function scopeOutlineRows(user: PublicUser, view: View) {
  return getOutlineRows().filter((r) => view === 'college'
    || (view === 'group' && user.led_groups.includes(r.course_group))
    || (view === 'program' && user.program_scopes.includes(r.professional)));
}

export function summarizeOutlines(rows: OutlineProgressRow[]) {
  return {
    people: new Set(rows.filter((r) => r.name || r.username).map((r) => r.user_id ?? JSON.stringify([r.username, r.name]))).size,
    required: rows.length,
    uploaded: rows.filter((r) => r.latest_id !== null).length,
    passed: rows.filter((r) => r.status === 'done' && r.verdict === 'passed').length,
    confirmed: rows.filter((r) => r.status === 'done' && r.confirmed_at !== null).length,
    unassigned: rows.filter((r) => !r.name && !r.username).length,
  };
}

export function groupOutlinePeople(rows: OutlineProgressRow[]) {
  const people = new Map<string, {
    username: string; name: string; user_id: number | null; required_count: number;
    uploaded_count: number; passed_count: number; confirmed_count: number; courses: OutlineProgressRow[];
  }>();
  for (const course of rows) {
    const key = course.user_id !== null ? String(course.user_id) : JSON.stringify([course.username, course.name]);
    if (!people.has(key)) people.set(key, {
      username: course.username, name: course.name || '待分配', user_id: course.user_id,
      required_count: 0, uploaded_count: 0, passed_count: 0, confirmed_count: 0, courses: [],
    });
    const p = people.get(key)!;
    p.required_count++;
    p.uploaded_count += Number(course.latest_id !== null);
    p.passed_count += Number(course.status === 'done' && course.verdict === 'passed');
    p.confirmed_count += Number(course.status === 'done' && course.confirmed_at !== null);
    p.courses.push(course);
  }
  return [...people.values()];
}

export function supervisesOutlineSubmission(user: PublicUser, submissionId: number, confirm = false, latestOnly = false) {
  const matches = db.prepare(`
    SELECT r.course_group, r.professional, r.writer_user_id FROM submissions s JOIN courses c ON c.id = s.course_id
    JOIN outline_requirements r ON ${matchesOutline('s', 'c')}
    WHERE s.id = ? ${latestOnly ? `AND s.id = (
      SELECT MAX(s2.id) FROM submissions s2 JOIN courses c ON c.id = s2.course_id
      WHERE ${matchesOutline('s2', 'c')}
    )` : ''}
  `).all(submissionId) as { course_group: string; professional: string; writer_user_id: number | null }[];
  return matches.some((r) => user.led_groups.includes(r.course_group)
    || (!confirm && (r.writer_user_id === user.id || user.college_role === 'teaching'
      || user.program_scopes.includes(r.professional))));
}
