import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { audit, db } from '../db.js';
import { requireAuth } from '../auth.js';
import { getSettings } from '../settings.js';
import { activeChecklistId, loadChecklist } from '../services/checklist.js';
import { extractFile, ExtractError, SUPPORTED_DOC_EXT } from '../services/extract.js';
import { cleanupTmp, sendStored, singleUpload, storeFile } from '../services/upload.js';
import { findPlan, kickQueue, type CourseSnapshot } from '../services/checkQueue.js';
import { aiReady } from '../services/ai/provider.js';
import { reportDocx, reportText, type ReportInput } from '../services/report.js';
import { SECTION_META } from '../seed/checklist.js';
import type { CheckResult } from '../services/ai/schema.js';

export const userRouter = Router();
userRouter.use(requireAuth);

const thisYear = new Date().getFullYear();
export const courseSchema = z.object({
  name: z.string().trim().min(1, '请填写课程名称').max(100),
  major: z.string().trim().min(1, '请填写专业').max(100),
  trainingType: z.string().trim().min(1, '请选择培养类型').max(50),
  studentGrade: z.coerce.number().int().min(2000).max(thisYear + 5),
  planGrade: z.coerce.number().int().min(2000).max(thisYear + 5).default(2025),
  adjustNote: z.string().trim().max(500).default(''),
});

function checkAdjust(c: z.infer<typeof courseSchema>) {
  if (c.planGrade !== 2025 && !c.adjustNote) return '对照方案年级不是2025级时，请填写调整说明';
  return null;
}

// ---------- 检查清单与选项 ----------
userRouter.get('/checklist', (_req, res) => {
  const c = loadChecklist();
  res.json({ checklist: c, sections: SECTION_META });
});

userRouter.get('/options', (_req, res) => {
  const plans = db
    .prepare('SELECT major, training_type, grade, name FROM training_plans WHERE enabled = 1 ORDER BY major, training_type, grade')
    .all() as { major: string; training_type: string; grade: number; name: string }[];
  const site = getSettings('site');
  res.json({
    majors: [...new Set(plans.map((p) => p.major))],
    plans,
    trainingTypes: site.trainingTypes,
    maxUploadMB: site.maxUploadMB,
    aiReady: aiReady() === null,
  });
});

userRouter.get('/plan-match', (req, res) => {
  const { major, trainingType, grade } = z
    .object({ major: z.string(), trainingType: z.string(), grade: z.coerce.number() })
    .parse(req.query);
  const p = findPlan(major, trainingType, grade);
  res.json({ plan: p ? { id: p.id, name: p.name } : null });
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
    ls.id AS latest_id, ls.status AS latest_status, ls.verdict AS latest_verdict, ls.created_at AS latest_at
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
    .prepare('SELECT id, seq, file_name, file_size, status, verdict, error, created_at, finished_at FROM submissions WHERE course_id = ? ORDER BY id DESC')
    .all(c.id);
  const plan = findPlan(c.major, c.training_type, c.plan_grade);
  res.json({ course: c, submissions: subs, plan: plan ? { id: plan.id, name: plan.name } : null });
});

userRouter.put('/courses/:id', (req, res) => {
  const c = getOwnCourse(req, res);
  if (!c) return;
  const body = courseSchema.parse(req.body);
  const err = checkAdjust(body);
  if (err) return res.status(400).json({ error: err });
  db.prepare(
    "UPDATE courses SET name=?, major=?, training_type=?, student_grade=?, plan_grade=?, adjust_note=?, updated_at=datetime('now','localtime') WHERE id=?",
  ).run(body.name, body.major, body.trainingType, body.studentGrade, body.planGrade, body.adjustNote, c.id);
  res.json({ ok: true });
});

// ---------- 上传与检查 ----------
userRouter.post('/submissions', singleUpload(SUPPORTED_DOC_EXT), async (req, res) => {
  const file = req.file;
  try {
    if (!file) return res.status(400).json({ error: '请选择要上传的大纲文件' });
    const notReady = aiReady();
    if (notReady) return res.status(400).json({ error: `管理员尚未完成 AI 配置（${notReady}），暂时无法检查` });
    const checklistId = activeChecklistId();
    if (!checklistId) return res.status(400).json({ error: '管理员尚未设置生效的检查清单' });

    // 已有课程上传新版本，或新建课程
    let course: CourseRow;
    if (req.body.courseId) {
      const found = db.prepare('SELECT * FROM courses WHERE id = ? AND user_id = ?').get(Number(req.body.courseId), req.user!.id) as
        | CourseRow
        | undefined;
      if (!found) return res.status(404).json({ error: '课程不存在' });
      course = found;
    } else {
      const body = courseSchema.parse(req.body);
      const err = checkAdjust(body);
      if (err) return res.status(400).json({ error: err });
      const r = db
        .prepare('INSERT INTO courses (user_id, name, major, training_type, student_grade, plan_grade, adjust_note) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(req.user!.id, body.name, body.major, body.trainingType, body.studentGrade, body.planGrade, body.adjustNote);
      course = db.prepare('SELECT * FROM courses WHERE id = ?').get(r.lastInsertRowid) as CourseRow;
    }

    let text: string;
    try {
      text = await extractFile(file.path, file.originalname);
    } catch (e) {
      if (!req.body.courseId) {
        const n = db.prepare('SELECT COUNT(*) AS n FROM submissions WHERE course_id = ?').get(course.id) as { n: number };
        if (!n.n) db.prepare('DELETE FROM courses WHERE id = ?').run(course.id);
      }
      if (e instanceof ExtractError) return res.status(400).json({ error: e.message });
      throw e;
    }

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
    const seq = (db.prepare('SELECT COUNT(*) AS n FROM submissions WHERE course_id = ?').get(course.id) as { n: number }).n + 1;
    const r = db
      .prepare(
        `INSERT INTO submissions (course_id, user_id, seq, file_name, file_path, file_size, extracted_text, checklist_version_id, plan_id, plan_name, course_snapshot)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(course.id, req.user!.id, seq, file.originalname, rel, file.size, text, checklistId, plan?.id, plan?.name, JSON.stringify(snapshot));
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
};

function getOwnSub(req: Request, res: Response): SubFull | null {
  const s = db.prepare('SELECT * FROM submissions WHERE id = ?').get(Number(req.params.id)) as SubFull | undefined;
  if (!s || (s.user_id !== req.user!.id && req.user!.role !== 'admin')) {
    res.status(404).json({ error: '记录不存在' });
    return null;
  }
  return s;
}

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
    submission: { ...rest, course: JSON.parse(course_snapshot), result: result_json ? JSON.parse(result_json) : null, queuePosition, owner },
    checklist: checklist
      ? { id: checklist.id, name: checklist.name, items: checklist.items.map(({ code, section, title, content }) => ({ code, section, title, content })) }
      : null,
    sections: SECTION_META,
  });
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
  };
}

const reportName = (s: SubFull, ext: string) => `${JSON.parse(s.course_snapshot).name}教学大纲修改清单（第${s.seq}次）.${ext}`;

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
  if (s.status !== 'failed') return res.status(400).json({ error: '只有检查失败的记录可以重新检查' });
  const notReady = aiReady();
  if (notReady) return res.status(400).json({ error: `AI 配置不完整：${notReady}` });
  db.prepare("UPDATE submissions SET status = 'queued', error = NULL, started_at = NULL, finished_at = NULL WHERE id = ?").run(s.id);
  audit(req.user, '重新检查', `记录#${s.id}`, undefined, req.ip);
  kickQueue();
  res.json({ ok: true });
});

