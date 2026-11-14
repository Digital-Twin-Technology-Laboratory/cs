import { Router, type Request, type Response } from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import JSZip from 'jszip';
import { z } from 'zod';
import { Document, HeadingLevel, Packer, Paragraph } from 'docx';
import { audit, db } from '../db.js';
import { requireAuth } from '../auth.js';
import { getSettings } from '../settings.js';
import { activeChecklistId, loadChecklist } from '../services/checklist.js';
import { docxToHtml, extractFile, ExtractError, SUPPORTED_DOC_EXT } from '../services/extract.js';
import { absPath, cleanupTmp, sendStored, singleUpload, storeFile } from '../services/upload.js';
import { findPlan, kickQueue, type CourseSnapshot } from '../services/checkQueue.js';
import { aiReady } from '../services/ai/provider.js';
import { reportDocx, reportText, type ReportInput } from '../services/report.js';
import { SECTION_META } from '../seed/checklist.js';
import type { CheckResult } from '../services/ai/schema.js';
import { CHECK_QUOTA_ERROR, getCheckQuota } from '../services/checkQuota.js';
import { getOutlineRows, groupOutlinePeople, matchesOutline, supervisesOutlineSubmission } from '../services/outlineProgress.js';
import { PLAN_MAJORS as majors } from '../services/planIdentification.js';
import { identifyCourse } from '../services/courseIdentification.js';
import { ROOT_DIR } from '../config.js';

export const userRouter = Router();
userRouter.use(requireAuth);

userRouter.get('/progress', (req, res) => {
  const person = groupOutlinePeople(getOutlineRows().filter((r) => r.user_id === req.user!.id))[0];
  res.json({
    configured: !!db.prepare("SELECT 1 FROM settings WHERE key = 'outline_source'").get(),
    required: person?.required_count ?? 0,
    uploaded: person?.uploaded_count ?? 0,
    passed: person?.passed_count ?? 0,
    confirmed: person?.confirmed_count ?? 0,
    courses: person?.courses ?? [],
  });
});

const legacyMajors = ['中外物联网', '物联网工程（合作办学）', '智能无人机系统与应用（微专业）', '计算机公共教学', '专转本'] as const;
const studentGrades = [2022, 2023, 2024, 2025, 2026];
export const courseSchema = z.object({
  name: z.string().trim().min(1, '请填写课程名称').max(100),
  major: z.enum([...majors, ...legacyMajors], { error: '请选择指定的专业' }),
  trainingType: z.string().trim().min(1, '请选择培养类型').max(50).default('普通本科'),
  studentGrade: z.coerce.number().int().refine((grade) => studentGrades.includes(grade), '请选择22、23、24、25或26级'),
  planGrade: z.coerce.number().int().refine((grade) => studentGrades.includes(grade), '请选择2022、2023、2024、2025或2026级人才培养方案').default(2025),
  adjustNote: z.string().trim().max(500).default(''),
});

// ---------- 检查清单与选项 ----------
userRouter.get('/checklist', (_req, res) => {
  const c = loadChecklist();
  res.json({ checklist: c, sections: SECTION_META });
});

userRouter.get('/syllabus-template.docx', (_req, res) => {
  res.download(path.join(ROOT_DIR, 'server/assets/syllabus-template.docx'), '教学大纲模板.docx');
});

userRouter.get('/syllabus-template/preview', async (_req, res) => {
  const html = await docxToHtml(path.join(ROOT_DIR, 'server/assets/syllabus-template.docx'));
  res.set('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; img-src data:; sandbox");
  res.type('html').send(`<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>教学大纲模板预览</title>
<style>
body { margin: 24px; font: 14px/1.8 'Microsoft YaHei', sans-serif; color: #1f2329; overflow-wrap: anywhere; }
p { margin: 8px 0; }
table { width: 100%; table-layout: fixed; border-collapse: collapse; margin: 16px 0; }
td, th { border: 1px solid #d9d9d9; padding: 6px; vertical-align: top; }
img { max-width: 100%; height: auto; }
@media (max-width: 600px) { body { margin: 12px; } td, th { padding: 4px; } }
</style></head><body>${html}</body></html>`);
});

userRouter.get('/checklist.docx', async (_req, res) => {
  const checklist = loadChecklist();
  if (!checklist) return res.status(404).json({ error: '管理员尚未设置生效的检查清单' });
  const children = [new Paragraph({ text: checklist.name, heading: HeadingLevel.TITLE })];
  if (checklist.intro) {
    for (const line of checklist.intro.split('\n')) children.push(new Paragraph(line));
  }
  for (const section of ['main', 'matrix', 'suggest'] as const) {
    children.push(new Paragraph({ text: SECTION_META[section].title, heading: HeadingLevel.HEADING_1 }));
    const note = checklist.notes[section];
    if (note?.before) {
      for (const line of note.before.split('\n')) children.push(new Paragraph(line));
    }
    for (const item of checklist.items.filter((item) => item.section === section)) {
      children.push(new Paragraph({ text: `${item.code} ${item.title}`, heading: HeadingLevel.HEADING_2 }));
      for (const line of item.content.split('\n')) children.push(new Paragraph(line));
    }
    if (note?.after) {
      for (const line of note.after.split('\n')) children.push(new Paragraph(line));
    }
  }
  if (checklist.rules) {
    children.push(new Paragraph({ text: '判定时应保留的区别', heading: HeadingLevel.HEADING_1 }));
    for (const line of checklist.rules.split('\n')) children.push(new Paragraph(line));
  }
  const buffer = await Packer.toBuffer(new Document({
    styles: { default: { document: { run: { font: 'Microsoft YaHei', size: 22 }, paragraph: { spacing: { after: 120 } } } } },
    sections: [{ children }],
  }));
  res.attachment(`${checklist.name}.docx`);
  res.type('application/vnd.openxmlformats-officedocument.wordprocessingml.document').send(buffer);
});

userRouter.get('/options', (req, res) => {
  const plans = db
    .prepare("SELECT id, major, training_type, grade, name, file_path IS NOT NULL AND file_path != '' AS downloadable FROM training_plans WHERE enabled = 1 ORDER BY major, training_type, grade")
    .all() as { id: number; major: string; training_type: string; grade: number; name: string; downloadable: number }[];
  const site = getSettings('site');
  const checklist = loadChecklist();
  res.json({
    majors,
    studentGrades,
    plans,
    trainingTypes: site.trainingTypes,
    maxUploadMB: site.maxUploadMB,
    aiReady: aiReady() === null,
    checklist: checklist ? { id: checklist.id, name: checklist.name } : null,
    requiredCourses: db.prepare('SELECT DISTINCT course_name AS name, professional FROM outline_requirements WHERE writer_user_id = ? ORDER BY course_name').all(req.user!.id),
    outlineCourses: db.prepare('SELECT id, course_name AS name, professional, course_group, writer_name, writer_identifier FROM outline_requirements ORDER BY course_group, professional, course_name, writer_name').all(),
  });
});

userRouter.get('/plans/:id/file', (req, res) => {
  const id = z.coerce.number().int().positive().parse(req.params.id);
  const plan = db.prepare('SELECT file_path, file_name FROM training_plans WHERE id = ? AND enabled = 1').get(id) as
    | { file_path: string | null; file_name: string }
    | undefined;
  if (!plan?.file_path) return res.status(404).json({ error: '培养方案文件不存在或未启用' });
  sendStored(res, plan.file_path, plan.file_name);
});

userRouter.get('/plan-match', (req, res) => {
  const { major, trainingType, grade } = z
    .object({ major: z.string(), trainingType: z.string(), grade: z.coerce.number() })
    .parse(req.query);
  const p = findPlan(major, trainingType, grade);
  res.json({ plan: p ? { id: p.id, name: p.name, downloadable: !!p.downloadable } : null });
});

// ---------- 课程 ----------
type CourseRow = { id: number; user_id: number; name: string; major: string; training_type: string; student_grade: number; plan_grade: number; adjust_note: string };

function getOwnCourse(req: Request, res: Response): CourseRow | null {
  const c = db.prepare('SELECT * FROM courses WHERE id = ?').get(Number(req.params.id)) as CourseRow | undefined;
  if (!c || (c.user_id !== req.user!.id && req.user!.role !== 'admin')) {
    res.status(404).json({ error: '课程不存在' });
    return null;
  }
  return c;
}

export const COURSE_LIST_SQL = `
  SELECT c.*, u.username, u.name AS user_name,
    (SELECT COUNT(*) FROM submissions s WHERE s.course_id = c.id) AS submission_count,
    ls.id AS latest_id, ls.status AS latest_status, ls.verdict AS latest_verdict, ls.created_at AS latest_at,
    ls.confirmed_at AS latest_confirmed_at, ls.withdrawn_at AS latest_withdrawn_at
  FROM courses c
  JOIN users u ON u.id = c.user_id
  LEFT JOIN submissions ls ON ls.id = (SELECT MAX(id) FROM submissions WHERE course_id = c.id)`;

userRouter.get('/courses', (req, res) => {
  const rows = db.prepare(`${COURSE_LIST_SQL} WHERE c.user_id = ? ORDER BY COALESCE(ls.created_at, c.created_at) DESC`).all(req.user!.id);
  res.json({ courses: rows });
});

userRouter.get('/courses/:id', (req, res) => {
  const c = getOwnCourse(req, res);
  if (!c) return;
  const subs = db
    .prepare('SELECT id, seq, file_name, file_size, status, verdict, error, created_at, finished_at, confirmed_at, withdrawn_at FROM submissions WHERE course_id = ? ORDER BY id DESC')
    .all(c.id);
  const plan = findPlan(c.major, c.training_type, c.plan_grade);
  res.json({ course: c, submissions: subs, plan: plan ? { id: plan.id, name: plan.name } : null });
});

userRouter.put('/courses/:id', (req, res) => {
  const c = getOwnCourse(req, res);
  if (!c) return;
  const body = courseSchema.parse(req.body);
  if (body.major === '计算机科学与技术（专转本）') body.trainingType = '专转本';
  db.prepare(
    "UPDATE courses SET name=?, major=?, training_type=?, student_grade=?, plan_grade=?, updated_at=datetime('now','localtime') WHERE id=?",
  ).run(body.name, body.major, body.trainingType, body.studentGrade, body.planGrade, c.id);
  res.json({ ok: true });
});

// ---------- 上传与检查 ----------
userRouter.post('/submissions/identify-course', singleUpload(SUPPORTED_DOC_EXT), async (req, res) => {
  const file = req.file;
  try {
    if (!file) return res.status(400).json({ error: '请选择要识别的大纲文件' });
    const text = await extractFile(file.path, file.originalname);
    const courses = db.prepare('SELECT DISTINCT course_name FROM outline_requirements ORDER BY course_name').all() as { course_name: string }[];
    res.json(identifyCourse(file.originalname, text, courses.map((course) => course.course_name)));
  } catch (e) {
    if (e instanceof ExtractError) return res.status(400).json({ error: e.message });
    throw e;
  } finally {
    cleanupTmp(file);
  }
});

userRouter.post('/submissions', singleUpload(SUPPORTED_DOC_EXT), async (req, res) => {
  const file = req.file;
  try {
    if (!file) return res.status(400).json({ error: '请选择要上传的大纲文件' });
    if (!getCheckQuota(req.user!.id).remaining) return res.status(429).json({ error: CHECK_QUOTA_ERROR });
    const notReady = aiReady();
    if (notReady) return res.status(400).json({ error: `管理员尚未完成 AI 配置（${notReady}），暂时无法检查` });
    const checklistId = activeChecklistId();
    if (!checklistId) return res.status(400).json({ error: '管理员尚未设置生效的检查清单' });

    const body = courseSchema.extend({ outlineRequirementId: z.coerce.number().int().positive().optional() }).parse(req.body);
    if (body.major === '计算机科学与技术（专转本）') body.trainingType = '专转本';

    const requirements = db.prepare(`SELECT id, writer_user_id FROM outline_requirements WHERE course_name = ? COLLATE NOCASE
      AND (professional = ? OR (? IN ('中外物联网', '物联网工程（中外合作）') AND professional = '物联网工程（合作办学）')
        OR (? = '计算机科学与技术（专转本）' AND professional = '专转本')
        OR (? = '公共' AND professional = '计算机公共教学'))`)
      .all(body.name, body.major, body.major, body.major, body.major) as { id: number; writer_user_id: number | null }[];
    const ownRequirements = requirements.filter((r) => r.writer_user_id === req.user!.id);
    const matchingRequirements = ownRequirements.length ? ownRequirements : requirements;
    // 云清单只用于关联进度，匹配不明确或选择已失效时也允许上传。
    const requirementId = requirements.find((r) => r.id === body.outlineRequirementId)?.id
      ?? (matchingRequirements.length === 1 ? matchingRequirements[0].id : null);

    let text: string;
    try {
      text = await extractFile(file.path, file.originalname);
    } catch (e) {
      if (e instanceof ExtractError) return res.status(400).json({ error: e.message });
      throw e;
    }

    // 文件解析期间其他请求可能已占用名额；从复查到入队之间不再让出执行权。
    if (!getCheckQuota(req.user!.id).remaining) return res.status(429).json({ error: CHECK_QUOTA_ERROR });
    const created = db
      .prepare('INSERT INTO courses (user_id, name, major, training_type, student_grade, plan_grade, adjust_note) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(req.user!.id, body.name, body.major, body.trainingType, body.studentGrade, body.planGrade, body.adjustNote);
    const course = db.prepare('SELECT * FROM courses WHERE id = ?').get(created.lastInsertRowid) as CourseRow;
    const rel = storeFile(file.path, `uploads/${req.user!.id}`, file.originalname);
    const plan = findPlan(course.major, course.training_type, course.plan_grade);
    const snapshot: CourseSnapshot = {
      name: course.name,
      major: course.major,
      trainingType: course.training_type,
      studentGrade: course.student_grade,
      planGrade: course.plan_grade,
      adjustNote: course.adjust_note,
    };
    const seq = (db.prepare(`SELECT COALESCE(MAX(seq), 0) + 1 AS next FROM submissions
      WHERE user_id = ? AND outline_requirement_id IS ?
        AND (? IS NOT NULL OR json_extract(course_snapshot, '$.name') = ? COLLATE NOCASE)
        AND json_extract(course_snapshot, '$.major') = ?
        AND json_extract(course_snapshot, '$.trainingType') = ?
        AND json_extract(course_snapshot, '$.studentGrade') = ?`)
      .get(req.user!.id, requirementId, requirementId, body.name, body.major, body.trainingType, body.studentGrade) as { next: number }).next;
    const r = db
      .prepare(
        `INSERT INTO submissions (course_id, user_id, seq, file_name, file_path, file_size, extracted_text, checklist_version_id, plan_id, plan_name, course_snapshot, outline_requirement_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(course.id, req.user!.id, seq, file.originalname, rel, file.size, text, checklistId, plan?.id, plan?.name, JSON.stringify(snapshot), requirementId);
    audit(req.user, '上传大纲', `${course.name} 第${seq}次`, file.originalname, req.ip);
    kickQueue();
    res.json({ submissionId: r.lastInsertRowid, courseId: course.id, planFound: !!plan });
  } finally {
    cleanupTmp(file);
  }
});

type SubFull = {
  id: number; course_id: number; user_id: number; seq: number; file_name: string; file_path: string; file_size: number;
  checklist_version_id: number | null; plan_id: number | null; plan_name: string | null; course_snapshot: string; ai_model: string | null;
  status: string; error: string | null; verdict: 'passed' | 'failed' | null; result_json: string | null; created_at: string; started_at: string | null; finished_at: string | null;
  confirmed_at: string | null;
  confirmed_by: string;
  withdrawn_at: string | null;
  verdict_edited_at: string | null;
  verdict_edited_by: string;
  outline_requirement_id: number | null;
};

function getOwnSub(req: Request, res: Response, id = Number(req.params.id)): SubFull | null {
  const s = db.prepare('SELECT * FROM submissions WHERE id = ?').get(id) as SubFull | undefined;
  if (!s || (s.user_id !== req.user!.id && req.user!.role !== 'admin' && req.user!.college_role !== 'teaching' && !supervisesOutlineSubmission(req.user!, s.id))) {
    res.status(404).json({ error: '记录不存在' });
    return null;
  }
  return s;
}

userRouter.get('/submissions', (req, res) => {
  const { page, pageSize, q, status, confirmation, scope, major, studentGrade, verdict, courseGroup, from, to } = z.object({
    page: z.coerce.number().int().min(1).default(1),
    pageSize: z.coerce.number().int().min(1).max(200).default(20),
    q: z.string().trim().max(200).default(''),
    status: z.enum(['queued', 'running', 'done', 'failed']).optional(),
    confirmation: z.enum(['pending', 'confirmed', 'withdrawn']).optional(),
    scope: z.enum(['mine', 'college']).default('mine'),
    major: z.string().trim().max(100).optional(),
    studentGrade: z.coerce.number().int().optional(),
    verdict: z.enum(['passed', 'failed']).optional(),
    courseGroup: z.string().trim().max(100).optional(),
    from: z.iso.date().optional(),
    to: z.iso.date().optional(),
  }).parse(req.query);
  if (scope === 'college' && req.user!.role !== 'admin' && req.user!.college_role !== 'teaching') {
    return res.status(403).json({ error: '需要教学条线或管理员权限才能查看全院检查记录' });
  }
  const where = [scope === 'mine' ? 's.user_id = ?' : '1 = 1'];
  const args: unknown[] = scope === 'mine' ? [req.user!.id] : [];
  if (q) {
    where.push("(json_extract(s.course_snapshot, '$.name') LIKE ? OR json_extract(s.course_snapshot, '$.major') LIKE ? OR s.file_name LIKE ? OR u.name LIKE ? OR u.username LIKE ?)");
    args.push(...Array(5).fill(`%${q}%`));
  }
  if (status) where.push('s.status = ?'), args.push(status);
  if (major) where.push("json_extract(s.course_snapshot, '$.major') = ?"), args.push(major);
  if (studentGrade) where.push("json_extract(s.course_snapshot, '$.studentGrade') = ?"), args.push(studentGrade);
  if (verdict) where.push('s.verdict = ?'), args.push(verdict);
  if (courseGroup) {
    where.push(`EXISTS (SELECT 1 FROM outline_requirements r JOIN courses c ON c.id = s.course_id WHERE ${matchesOutline('s', 'c')} AND r.course_group = ?)`);
    args.push(courseGroup);
  }
  if (from) where.push('date(s.created_at) >= ?'), args.push(from);
  if (to) where.push('date(s.created_at) <= ?'), args.push(to);
  if (confirmation === 'pending') where.push('s.confirmed_at IS NULL');
  if (confirmation === 'confirmed') where.push('s.confirmed_at IS NOT NULL');
  if (confirmation === 'withdrawn') where.push('s.withdrawn_at IS NOT NULL');
  const w = where.join(' AND ');
  const total = (db.prepare(`SELECT COUNT(*) AS n FROM submissions s JOIN users u ON u.id = s.user_id WHERE ${w}`).get(...args) as { n: number }).n;
  const rows = db.prepare(
    `SELECT s.id, s.seq, s.course_id, s.user_id, s.file_name, s.file_size, s.status, s.verdict, s.error,
      s.created_at, s.finished_at, s.confirmed_at, s.withdrawn_at, u.username, u.name AS user_name,
      json_extract(s.course_snapshot, '$.name') AS course_name,
      json_extract(s.course_snapshot, '$.major') AS major,
      json_extract(s.course_snapshot, '$.trainingType') AS training_type,
      json_extract(s.course_snapshot, '$.studentGrade') AS student_grade
     FROM submissions s JOIN users u ON u.id = s.user_id WHERE ${w} ORDER BY s.id DESC LIMIT ? OFFSET ?`,
  ).all(...args, pageSize, (page - 1) * pageSize);
  res.json({ total, rows });
});

userRouter.post('/submissions/batch-download', async (req, res) => {
  const { ids, kind } = z.object({
    ids: z.array(z.number().int().positive()).min(1).max(100, '每次最多下载100条记录'),
    kind: z.enum(['files', 'reports']),
  }).parse(req.body);
  const submissions: SubFull[] = [];
  for (const id of new Set(ids)) {
    const s = getOwnSub(req, res, id);
    if (!s) return;
    submissions.push(s);
  }
  if (kind === 'reports' && submissions.some((s) => !reportInput(s))) {
    return res.status(400).json({ error: '所选记录中有尚未完成的检查，请仅选择已完成记录下载检查结果' });
  }
  if (kind === 'files' && submissions.some((s) => !fs.existsSync(absPath(s.file_path)))) {
    return res.status(404).json({ error: '所选原文件不存在或已被删除' });
  }
  const zip = new JSZip();
  for (const s of submissions) {
    const name = (kind === 'files' ? s.file_name : reportName(s, 'docx')).replace(/[<>:"/\\|?*\x00-\x1f]/g, '_');
    // The record ID prevents collisions between repeated uploads with identical names.
    zip.file(`${s.id}-${name}`, kind === 'files' ? fs.createReadStream(absPath(s.file_path)) : await reportDocx(reportInput(s)!));
  }
  res.attachment(kind === 'files' ? '大纲原文件.zip' : '大纲检查结果.zip');
  res.type('application/zip');
  try {
    await pipeline(zip.generateNodeStream({ streamFiles: true }), res);
  } catch (e) {
    if (!res.headersSent && !res.destroyed) throw e;
    res.destroy(e as Error);
  }
});

userRouter.put('/submissions/:id', (req, res) => {
  const canEditAll = req.user!.role === 'admin' || req.user!.college_role === 'teaching';
  const id = z.coerce.number().int().positive().parse(req.params.id);
  const before = db.prepare('SELECT * FROM submissions WHERE id = ?').get(id) as SubFull | undefined;
  if (!before) return res.status(404).json({ error: '记录不存在' });
  if (!canEditAll && before.user_id !== req.user!.id) return res.status(403).json({ error: '只能修改自己上传记录的课程名称' });
  const body = z.object({
    course_name: courseSchema.shape.name.optional(),
    major: courseSchema.shape.major.optional(),
    student_grade: courseSchema.shape.studentGrade.optional(),
    file_name: z.string().trim().min(1, '文件名不能为空').max(255).optional(),
    verdict: z.enum(['passed', 'failed']).optional(),
  }).strict().refine((value) => Object.keys(value).length > 0, '请填写要修改的内容').parse(req.body);
  if (!canEditAll && Object.keys(body).some((field) => field !== 'course_name')) return res.status(403).json({ error: '原上传者只能修改课程名称，其他字段需由管理员或教学条线修改' });
  if (before.status === 'queued' || before.status === 'running') return res.status(409).json({ error: '检查进行中，请完成后再修改记录' });
  if (body.verdict !== undefined && (before.status !== 'done' || !before.result_json)) {
    return res.status(400).json({ error: '检查尚未完成，不能修改检查结论' });
  }
  const previousCourse = JSON.parse(before.course_snapshot) as CourseSnapshot;
  const course = { ...previousCourse,
    name: body.course_name ?? previousCourse.name,
    major: body.major ?? previousCourse.major,
    studentGrade: body.student_grade ?? previousCourse.studentGrade,
  };
  if (body.course_name !== undefined || body.major !== undefined) delete course.publicPlanMatch;
  if (body.major !== undefined) {
    if (body.major === '计算机科学与技术（专转本）') course.trainingType = '专转本';
    else if (previousCourse.major === '计算机科学与技术（专转本）') course.trainingType = '普通本科';
  }
  const fileName = body.file_name ?? before.file_name;
  const verdict = body.verdict ?? before.verdict;
  let requirementId = before.outline_requirement_id;
  db.transaction(() => {
    if (body.course_name !== undefined || body.major !== undefined || body.student_grade !== undefined) {
      db.prepare("UPDATE courses SET name = COALESCE(?, name), major = COALESCE(?, major), student_grade = COALESCE(?, student_grade), training_type = COALESCE(?, training_type), updated_at = datetime('now','localtime') WHERE id = ?")
        .run(body.course_name, body.major, body.student_grade, body.major !== undefined ? course.trainingType : undefined, before.course_id);
    }
    if (requirementId === null && (body.course_name !== undefined || body.major !== undefined)) {
      const requirements = db.prepare(`SELECT id, writer_user_id FROM outline_requirements WHERE course_name = ? COLLATE NOCASE
        AND (professional = ? OR (? IN ('中外物联网', '物联网工程（中外合作）') AND professional = '物联网工程（合作办学）')
          OR (? = '计算机科学与技术（专转本）' AND professional = '专转本')
          OR (? = '公共' AND professional = '计算机公共教学'))`)
        .all(course.name, course.major, course.major, course.major, course.major) as { id: number; writer_user_id: number | null }[];
      const ownRequirements = requirements.filter((row) => row.writer_user_id === before.user_id);
      const matchingRequirements = ownRequirements.length ? ownRequirements : requirements;
      requirementId = matchingRequirements.length === 1 ? matchingRequirements[0].id : null;
      db.prepare('UPDATE submissions SET outline_requirement_id = ? WHERE id = ?').run(requirementId, id);
    }
    db.prepare('UPDATE submissions SET course_snapshot = ?, file_name = ?, verdict = ? WHERE id = ?')
      .run(JSON.stringify(course), fileName, verdict, id);
    if (body.major !== undefined) {
      const plan = findPlan(course.major, course.trainingType, course.planGrade);
      db.prepare('UPDATE submissions SET plan_id = ?, plan_name = ? WHERE id = ?').run(plan?.id, plan?.name, id);
    }
    if (body.verdict !== undefined && body.verdict !== before.verdict) {
      db.prepare("UPDATE submissions SET verdict_edited_at = datetime('now','localtime'), verdict_edited_by = ? WHERE id = ?")
        .run(`${req.user!.name}（${req.user!.username}）`, id);
    }
    audit(req.user, '修改上传记录', `记录#${id}`, JSON.stringify({
      before: { course: previousCourse, file_name: before.file_name, verdict: before.verdict, outline_requirement_id: before.outline_requirement_id },
      after: { course, file_name: fileName, verdict, outline_requirement_id: requirementId },
    }), req.ip);
  })();
  res.json({ ok: true, outlineRequirementId: requirementId });
});

userRouter.put('/submissions/:id/sequence', (req, res) => {
  if (req.user!.role !== 'admin' && req.user!.college_role !== 'teaching') return res.status(403).json({ error: '仅管理员或教学条线（全院）可修改上传记录' });
  const id = z.coerce.number().int().positive().parse(req.params.id);
  const { seq } = z.object({ seq: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER) }).parse(req.body);
  const before = db.prepare('SELECT seq FROM submissions WHERE id = ?').get(id) as { seq: number } | undefined;
  if (!before) return res.status(404).json({ error: '记录不存在' });
  db.transaction(() => {
    db.prepare('UPDATE submissions SET seq = ? WHERE id = ?').run(seq, id);
    audit(req.user, '修改上传次数', `记录#${id}`, JSON.stringify({ before: before.seq, after: seq }), req.ip);
  })();
  res.json({ ok: true });
});

userRouter.get('/submissions/:id', (req, res) => {
  const s = getOwnSub(req, res);
  if (!s) return;
  const checklist = s.checklist_version_id ? loadChecklist(s.checklist_version_id) : null;
  let queuePosition: number | null = null;
  if (s.status === 'queued') {
    queuePosition = (db.prepare("SELECT COUNT(*) AS n FROM submissions WHERE status = 'queued' AND id < ?").get(s.id) as { n: number }).n + 1;
  }
  const owner = db.prepare('SELECT username, name FROM users WHERE id = ?').get(s.user_id);
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { result_json, course_snapshot, file_path, ...rest } = s;
  res.json({
    submission: { ...rest, canConfirm: s.user_id === req.user!.id || supervisesOutlineSubmission(req.user!, s.id, true, true), course: JSON.parse(course_snapshot), result: result_json ? JSON.parse(result_json) : null, queuePosition, owner },
    checklist: checklist
      ? { id: checklist.id, name: checklist.name, items: checklist.items.map(({ code, section, title, content }) => ({ code, section, title, content })) }
      : null,
    sections: SECTION_META,
  });
});

userRouter.post('/submissions/:id/confirm', (req, res) => {
  const s = getOwnSub(req, res);
  if (!s) return;
  const isLeader = supervisesOutlineSubmission(req.user!, s.id, true, true);
  if (s.user_id !== req.user!.id && !isLeader) return res.status(403).json({ error: '只能确认本人结果或本组应交大纲的最新结果' });
  if (s.status !== 'done' || !s.result_json || !s.verdict) {
    return res.status(400).json({ error: '检查完成后才能确认提交' });
  }
  const confirmedAt = db.transaction(() => {
    const actor = `${isLeader ? '课程组长' : '上传者'}：${req.user!.name}（${req.user!.username}）`;
    const updated = db.prepare("UPDATE submissions SET confirmed_at = datetime('now','localtime'), confirmed_by = ?, withdrawn_at = NULL WHERE id = ? AND confirmed_at IS NULL").run(actor, s.id);
    if (updated.changes) audit(req.user, isLeader ? '课程组长最终确认' : '确认提交', `记录#${s.id}`, actor, req.ip);
    return (db.prepare('SELECT confirmed_at FROM submissions WHERE id = ?').get(s.id) as { confirmed_at: string }).confirmed_at;
  })();
  res.json({ ok: true, confirmedAt });
});

userRouter.post('/submissions/:id/withdraw', (req, res) => {
  const s = getOwnSub(req, res);
  if (!s) return;
  if (s.user_id !== req.user!.id) return res.status(403).json({ error: '只能撤回本人上传的结果' });
  if (!s.confirmed_at) return res.status(409).json({ error: '仅已确认提交的结果可以撤回上传' });
  const withdrawn = db.transaction(() => {
    const row = db.prepare("UPDATE submissions SET confirmed_at = NULL, confirmed_by = '', withdrawn_at = datetime('now','localtime') WHERE id = ? RETURNING withdrawn_at")
      .get(s.id) as { withdrawn_at: string };
    audit(req.user, '撤回上传', `记录#${s.id}`, JSON.stringify({ confirmedAt: s.confirmed_at, confirmedBy: s.confirmed_by }), req.ip);
    return row;
  })();
  res.json({ ok: true, withdrawnAt: withdrawn.withdrawn_at });
});

userRouter.get('/submissions/:id/file', (req, res) => {
  const s = getOwnSub(req, res);
  if (!s) return;
  sendStored(res, s.file_path, s.file_name);
});

function reportInput(s: SubFull): ReportInput | null {
  if (s.status !== 'done' || !s.result_json || !s.verdict) return null;
  return {
    course: JSON.parse(s.course_snapshot),
    planName: s.plan_name,
    seq: s.seq,
    checkedAt: s.finished_at ?? s.created_at,
    verdict: s.verdict,
    result: JSON.parse(s.result_json) as CheckResult,
    verdictEdit: s.verdict_edited_at ? { by: s.verdict_edited_by, at: s.verdict_edited_at } : null,
  };
}

const reportName = (s: SubFull, ext: string) => `${JSON.parse(s.course_snapshot).name}教学大纲检查结果（第${s.seq}次）.${ext}`;

userRouter.get('/submissions/:id/report.docx', async (req, res) => {
  const s = getOwnSub(req, res);
  if (!s) return;
  const input = reportInput(s);
  if (!input) return res.status(400).json({ error: '检查尚未完成' });
  const buf = await reportDocx(input);
  res.attachment(reportName(s, 'docx'));
  res.type('application/vnd.openxmlformats-officedocument.wordprocessingml.document').send(buf);
});

userRouter.get('/submissions/:id/report.txt', (req, res) => {
  const s = getOwnSub(req, res);
  if (!s) return;
  const input = reportInput(s);
  if (!input) return res.status(400).json({ error: '检查尚未完成' });
  res.json({ text: reportText(input) });
});

/** 检查失败（接口错误、输出格式错误等）后重新检查；已完成的检查结果只读，不覆盖 */
userRouter.post('/submissions/:id/recheck', (req, res) => {
  const s = getOwnSub(req, res);
  if (!s) return;
  if (s.user_id !== req.user!.id && req.user!.role !== 'admin') return res.status(403).json({ error: '只能重新检查本人的记录' });
  if (s.status !== 'failed') return res.status(400).json({ error: '只有检查失败的记录可以重新检查' });
  if (!getCheckQuota(s.user_id).remaining) return res.status(429).json({ error: CHECK_QUOTA_ERROR });
  const notReady = aiReady();
  if (notReady) return res.status(400).json({ error: `AI 配置不完整：${notReady}` });
  db.prepare("UPDATE submissions SET status = 'queued', error = NULL, started_at = NULL, finished_at = NULL WHERE id = ?").run(s.id);
  audit(req.user, '重新检查', `记录#${s.id}`, undefined, req.ip);
  kickQueue();
  res.json({ ok: true });
});

