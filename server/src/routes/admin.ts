import { Router } from 'express';
import fs from 'node:fs/promises';
import bcrypt from 'bcryptjs';
import { CsvError, parse } from 'csv-parse/sync';
import { InvalidInputError, InvalidSpreadsheetError, readSheet, SheetNotFoundError } from 'read-excel-file/node';
import { z } from 'zod';
import { audit, db } from '../db.js';
import { requireAdmin, toPublic, type UserRow } from '../auth.js';
import { getSettings, saveSettings, type AiSettings } from '../settings.js';
import { decrypt, encrypt, mask } from '../services/crypto.js';
import { DEFAULT_SYSTEM_PROMPT } from '../services/ai/prompt.js';
import { aiReady, listModels, testConnection } from '../services/ai/provider.js';
import { loadChecklist } from '../services/checklist.js';
import { aiStructureChecklist, parseChecklistFile } from '../services/checklistImport.js';
import { extractFile, ExtractError } from '../services/extract.js';
import { cleanupTmp, removeFile, sendStored, singleUpload, storeFile } from '../services/upload.js';
import { kickQueue } from '../services/checkQueue.js';
import { passwordSchema } from './auth.js';
import { COURSE_LIST_SQL } from './user.js';

export const adminRouter = Router();
adminRouter.use(requireAdmin);

const idParam = (v: string) => z.coerce.number().int().positive().parse(v);
const paging = (q: Record<string, unknown>) => {
  const page = Math.max(1, Number(q.page) || 1);
  const pageSize = Math.min(200, Math.max(1, Number(q.pageSize) || 20));
  return { page, pageSize, offset: (page - 1) * pageSize };
};

// ---------- 概览 ----------
adminRouter.get('/stats', (_req, res) => {
  const one = (sql: string) => (db.prepare(sql).get() as { n: number }).n;
  res.json({
    users: one('SELECT COUNT(*) AS n FROM users'),
    pendingUsers: one("SELECT COUNT(*) AS n FROM users WHERE status = 'pending'"),
    courses: one('SELECT COUNT(*) AS n FROM courses'),
    passedCourses: one(`SELECT COUNT(*) AS n FROM courses c WHERE (SELECT verdict FROM submissions WHERE course_id = c.id ORDER BY id DESC LIMIT 1) = 'passed'`),
    submissions: one('SELECT COUNT(*) AS n FROM submissions'),
    today: one("SELECT COUNT(*) AS n FROM submissions WHERE date(created_at) = date('now','localtime')"),
    queued: one("SELECT COUNT(*) AS n FROM submissions WHERE status IN ('queued','running')"),
    failed: one("SELECT COUNT(*) AS n FROM submissions WHERE status = 'failed'"),
    aiProblem: aiReady(),
    recent: db
      .prepare(
        `SELECT s.id, s.seq, s.status, s.verdict, s.created_at, c.name AS course_name, u.name AS user_name, u.username
         FROM submissions s JOIN courses c ON c.id = s.course_id JOIN users u ON u.id = s.user_id ORDER BY s.id DESC LIMIT 8`,
      )
      .all(),
  });
});

// ---------- 用户管理 ----------
adminRouter.get('/users', (req, res) => {
  const { q = '', status = '', role = '' } = req.query as Record<string, string>;
  const { page, pageSize, offset } = paging(req.query);
  const where = ['1=1'];
  const args: unknown[] = [];
  if (q) {
    where.push('(u.username LIKE ? OR u.name LIKE ? OR u.department LIKE ?)');
    args.push(`%${q}%`, `%${q}%`, `%${q}%`);
  }
  if (status) where.push('u.status = ?'), args.push(status);
  if (role) where.push('u.role = ?'), args.push(role);
  const w = where.join(' AND ');
  const total = (db.prepare(`SELECT COUNT(*) AS n FROM users u WHERE ${w}`).get(...args) as { n: number }).n;
  const rows = db
    .prepare(
      `SELECT u.id, u.username, u.name, u.department, u.role, u.status, u.roster_login, u.created_at, u.last_login_at,
        (SELECT COUNT(*) FROM courses WHERE user_id = u.id) AS course_count,
        (SELECT COUNT(*) FROM submissions WHERE user_id = u.id) AS submission_count
       FROM users u WHERE ${w} ORDER BY (u.status = 'pending') DESC, u.id DESC LIMIT ? OFFSET ?`,
    )
    .all(...args, pageSize, offset);
  res.json({ total, rows });
});

adminRouter.post('/users', (req, res) => {
  const body = z
    .object({
      username: z.string().trim().min(3).max(32).regex(/^[A-Za-z0-9_.@-]+$/, '用户名只能包含字母、数字及 _ . @ -'),
      password: passwordSchema,
      name: z.string().trim().min(1, '请填写姓名').max(50),
      department: z.string().trim().max(100).default(''),
      role: z.enum(['admin', 'user']).default('user'),
    })
    .parse(req.body);
  if (db.prepare('SELECT 1 FROM users WHERE username = ?').get(body.username)) return res.status(400).json({ error: '该用户名已存在' });
  const r = db
    .prepare("INSERT INTO users (username, password_hash, name, department, role, status) VALUES (?, ?, ?, ?, ?, 'active')")
    .run(body.username, bcrypt.hashSync(body.password, 10), body.name, body.department, body.role);
  audit(req.user, '新建账号', body.username, body.role === 'admin' ? '管理员' : '普通用户', req.ip);
  res.json({ id: r.lastInsertRowid });
});

adminRouter.post('/users/import', singleUpload(['.xlsx', '.csv']), async (req, res) => {
  const file = req.file;
  try {
    if (!file) return res.status(400).json({ error: '请选择教工名单文件' });
    const contents = await fs.readFile(file.path);
    let rows: unknown[][];
    try {
      rows = file.originalname.toLowerCase().endsWith('.xlsx')
        ? await readSheet(contents, { parseNumber: (value) => value })
        : parse(contents, { bom: true, trim: true, skip_empty_lines: true });
    } catch (e) {
      if (e instanceof CsvError || e instanceof InvalidInputError || e instanceof InvalidSpreadsheetError || e instanceof SheetNotFoundError) {
        return res.status(400).json({ error: `名单文件解析失败，请检查文件格式：${e.message}` });
      }
      throw e;
    }

    const headers = (rows[0] ?? []).map((cell) => String(cell ?? '').trim());
    if (headers.filter((cell) => cell === '姓名').length !== 1 || headers.filter((cell) => cell === '工号').length !== 1) {
      return res.status(400).json({ error: '名单首行必须包含“姓名”和“工号”两列，且列名不能重复' });
    }
    const nameColumn = headers.indexOf('姓名');
    const numberColumn = headers.indexOf('工号');
    const entrySchema = z.object({
      name: z.string().min(1, '姓名不能为空').max(50, '姓名最多50个字符'),
      username: z.string().min(1, '工号不能为空').max(32, '工号最多32个字符').regex(/^[A-Za-z0-9_.@-]+$/, '工号只能包含字母、数字及 _ . @ -'),
    });
    const entries: { name: string; username: string }[] = [];
    const seen = new Set<string>();
    for (const [index, row] of rows.entries()) {
      if (index === 0 || row.every((cell) => !String(cell ?? '').trim())) continue;
      const entry = entrySchema.safeParse({
        name: String(row[nameColumn] ?? '').trim(),
        username: String(row[numberColumn] ?? '').trim(),
      });
      if (!entry.success) return res.status(400).json({ error: `第 ${index + 1} 行：${entry.error.issues.map((issue) => issue.message).join('；')}` });
      const key = entry.data.username.toLowerCase();
      if (seen.has(key)) return res.status(400).json({ error: `第 ${index + 1} 行：工号 ${entry.data.username} 在名单中重复` });
      seen.add(key);
      entries.push(entry.data);
    }
    if (!entries.length) return res.status(400).json({ error: '名单中没有教工数据' });

    const imported = db.transaction(() => {
      const insert = db.prepare(
        "INSERT INTO users (username, password_hash, name, role, status, roster_login) VALUES (?, '', ?, 'user', 'active', 1) ON CONFLICT(username) DO NOTHING",
      );
      return entries.reduce((count, entry) => count + insert.run(entry.username, entry.name).changes, 0);
    })();
    const skipped = entries.length - imported;
    audit(req.user, '导入教工名单', file.originalname, `导入 ${imported} 个免密码账号，跳过 ${skipped} 个已有工号`, req.ip);
    res.json({ imported, skipped });
  } finally {
    cleanupTmp(file);
  }
});

const activeAdmins = () => (db.prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'admin' AND status = 'active'").get() as { n: number }).n;

adminRouter.put('/users/:id', (req, res) => {
  const id = idParam(req.params.id);
  const u = db.prepare('SELECT * FROM users WHERE id = ?').get(id) as UserRow | undefined;
  if (!u) return res.status(404).json({ error: '用户不存在' });
  const body = z
    .object({
      name: z.string().trim().min(1).max(50).optional(),
      department: z.string().trim().max(100).optional(),
      role: z.enum(['admin', 'user']).optional(),
      status: z.enum(['active', 'disabled', 'pending']).optional(),
    })
    .parse(req.body);
  const next = { ...u, ...body };
  if (next.role === 'admin' && !u.password_hash) {
    return res.status(400).json({ error: '该教工账号使用免密码登录，请先重置密码再设为管理员；管理员必须使用密码登录' });
  }
  if (u.id === req.user!.id && (next.role !== 'admin' || next.status !== 'active')) {
    return res.status(400).json({ error: '不能取消自己的管理员权限或停用自己的账号' });
  }
  if (u.role === 'admin' && u.status === 'active' && (next.role !== 'admin' || next.status !== 'active') && activeAdmins() <= 1) {
    return res.status(400).json({ error: '系统至少需要保留一个可用的管理员账号' });
  }
  db.prepare('UPDATE users SET name = ?, department = ?, role = ?, status = ? WHERE id = ?').run(next.name, next.department, next.role, next.status, id);
  if (next.status !== 'active') db.prepare("DELETE FROM sessions WHERE json_extract(sess, '$.userId') = ?").run(id);
  const changes = [
    body.status && body.status !== u.status ? `状态：${u.status}→${body.status}` : '',
    body.role && body.role !== u.role ? `角色：${u.role}→${body.role}` : '',
  ].filter(Boolean);
  audit(req.user, u.status === 'pending' && body.status === 'active' ? '审核通过' : '修改账号', u.username, changes.join('；'), req.ip);
  res.json({ user: toPublic(db.prepare('SELECT * FROM users WHERE id = ?').get(id) as UserRow) });
});

adminRouter.post('/users/:id/reset-password', (req, res) => {
  const id = idParam(req.params.id);
  const { password } = z.object({ password: passwordSchema }).parse(req.body);
  const u = db.prepare('SELECT * FROM users WHERE id = ?').get(id) as UserRow | undefined;
  if (!u) return res.status(404).json({ error: '用户不存在' });
  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(bcrypt.hashSync(password, 10), id);
  audit(req.user, '重置密码', u.username, undefined, req.ip);
  res.json({ ok: true });
});

adminRouter.delete('/users/:id', (req, res) => {
  const id = idParam(req.params.id);
  const u = db.prepare('SELECT * FROM users WHERE id = ?').get(id) as UserRow | undefined;
  if (!u) return res.status(404).json({ error: '用户不存在' });
  if (u.id === req.user!.id) return res.status(400).json({ error: '不能删除自己的账号' });
  if (u.role === 'admin' && u.status === 'active' && activeAdmins() <= 1) return res.status(400).json({ error: '系统至少需要保留一个可用的管理员账号' });
  const files = db.prepare('SELECT file_path FROM submissions WHERE user_id = ?').all(id) as { file_path: string }[];
  db.transaction(() => {
    db.prepare('DELETE FROM users WHERE id = ?').run(id);
    db.prepare("DELETE FROM sessions WHERE json_extract(sess, '$.userId') = ?").run(id);
  })();
  files.forEach((f) => removeFile(f.file_path));
  audit(req.user, '删除账号', u.username, `连带删除 ${files.length} 个上传文件`, req.ip);
  res.json({ ok: true });
});

// ---------- 课程与检查记录 ----------
adminRouter.get('/courses', (req, res) => {
  const { q = '', userId = '', verdict = '' } = req.query as Record<string, string>;
  const { page, pageSize, offset } = paging(req.query);
  const where = ['1=1'];
  const args: unknown[] = [];
  if (q) where.push('(c.name LIKE ? OR c.major LIKE ? OR u.name LIKE ? OR u.username LIKE ?)'), args.push(...Array(4).fill(`%${q}%`));
  if (userId) where.push('c.user_id = ?'), args.push(Number(userId));
  if (verdict === 'passed') where.push("ls.verdict = 'passed'");
  if (verdict === 'failed') where.push("ls.status = 'done' AND ls.verdict = 'failed'");
  if (verdict === 'none') where.push('ls.id IS NULL');
  const w = where.join(' AND ');
  const base = `${COURSE_LIST_SQL} WHERE ${w}`;
  const total = (db.prepare(`SELECT COUNT(*) AS n FROM (${base})`).get(...args) as { n: number }).n;
  const rows = db.prepare(`${base} ORDER BY COALESCE(ls.created_at, c.created_at) DESC LIMIT ? OFFSET ?`).all(...args, pageSize, offset);
  res.json({ total, rows });
});

adminRouter.delete('/courses/:id', (req, res) => {
  const id = idParam(req.params.id);
  const c = db.prepare('SELECT * FROM courses WHERE id = ?').get(id) as { name: string } | undefined;
  if (!c) return res.status(404).json({ error: '课程不存在' });
  const files = db.prepare('SELECT file_path FROM submissions WHERE course_id = ?').all(id) as { file_path: string }[];
  db.prepare('DELETE FROM courses WHERE id = ?').run(id);
  files.forEach((f) => removeFile(f.file_path));
  audit(req.user, '删除课程', c.name, `连带删除 ${files.length} 次检查记录及文件`, req.ip);
  res.json({ ok: true });
});

adminRouter.get('/submissions', (req, res) => {
  const { q = '', status = '', verdict = '', userId = '', from = '', to = '', confirmation = '' } = req.query as Record<string, string>;
  const { page, pageSize, offset } = paging(req.query);
  const where = ['1=1'];
  const args: unknown[] = [];
  if (q) where.push("(json_extract(s.course_snapshot, '$.name') LIKE ? OR json_extract(s.course_snapshot, '$.major') LIKE ? OR u.name LIKE ? OR u.username LIKE ? OR s.file_name LIKE ?)"), args.push(...Array(5).fill(`%${q}%`));
  if (status) where.push('s.status = ?'), args.push(status);
  if (verdict) where.push('s.verdict = ?'), args.push(verdict);
  if (userId) where.push('s.user_id = ?'), args.push(Number(userId));
  if (from) where.push('date(s.created_at) >= ?'), args.push(from);
  if (to) where.push('date(s.created_at) <= ?'), args.push(to);
  if (confirmation === 'pending') where.push('s.confirmed_at IS NULL');
  if (confirmation === 'confirmed') where.push('s.confirmed_at IS NOT NULL');
  const w = where.join(' AND ');
  const join = 'FROM submissions s JOIN users u ON u.id = s.user_id';
  const total = (db.prepare(`SELECT COUNT(*) AS n ${join} WHERE ${w}`).get(...args) as { n: number }).n;
  const rows = db
    .prepare(
      `SELECT s.id, s.seq, s.course_id, s.file_name, s.file_size, s.status, s.verdict, s.error, s.ai_model, s.created_at, s.finished_at, s.confirmed_at, s.plan_name,
        json_extract(s.course_snapshot, '$.name') AS course_name,
        json_extract(s.course_snapshot, '$.major') AS major,
        json_extract(s.course_snapshot, '$.trainingType') AS training_type,
        json_extract(s.course_snapshot, '$.studentGrade') AS student_grade,
        u.id AS user_id, u.username, u.name AS user_name
       ${join} WHERE ${w} ORDER BY s.id DESC LIMIT ? OFFSET ?`,
    )
    .all(...args, pageSize, offset);
  res.json({ total, rows });
});

adminRouter.delete('/submissions/:id', (req, res) => {
  const id = idParam(req.params.id);
  const s = db.prepare('SELECT s.*, c.name AS course_name FROM submissions s JOIN courses c ON c.id = s.course_id WHERE s.id = ?').get(id) as
    | { file_path: string; course_name: string; seq: number; status: string }
    | undefined;
  if (!s) return res.status(404).json({ error: '记录不存在' });
  if (s.status === 'running') return res.status(400).json({ error: '该记录正在检查中，请稍后再删除' });
  db.prepare('DELETE FROM submissions WHERE id = ?').run(id);
  removeFile(s.file_path);
  audit(req.user, '删除检查记录', `${s.course_name} 第${s.seq}次`, undefined, req.ip);
  res.json({ ok: true });
});

adminRouter.post('/submissions/retry-failed', (req, res) => {
  const notReady = aiReady();
  if (notReady) return res.status(400).json({ error: `AI 配置不完整：${notReady}` });
  const r = db.prepare("UPDATE submissions SET status = 'queued', error = NULL, started_at = NULL, finished_at = NULL WHERE status = 'failed'").run();
  audit(req.user, '批量重新检查失败记录', undefined, `${r.changes} 条`, req.ip);
  kickQueue();
  res.json({ count: r.changes });
});

// ---------- 检查清单 ----------
const SectionEnum = z.enum(['main', 'matrix', 'suggest']);
const noteSchema = z.object({ before: z.string().default(''), after: z.string().default('') }).default({ before: '', after: '' });
const checklistBody = z.object({
  name: z.string().trim().min(1, '请填写清单名称').max(200),
  intro: z.string().default(''),
  rules: z.string().default(''),
  notes: z.object({ main: noteSchema, matrix: noteSchema, suggest: noteSchema }).partial().default({}),
  items: z
    .array(
      z.object({
        code: z.string().trim().toUpperCase().regex(/^[A-Z]{1,2}\d{1,3}$/, '编号格式应为字母+数字，如 C01'),
        section: SectionEnum,
        title: z.string().trim().min(1, '条目名称不能为空'),
        content: z.string().trim().min(1, '条目内容不能为空'),
      }),
    )
    .min(1, '至少需要一个检查条目'),
  activate: z.boolean().optional(),
});

function insertVersion(body: z.infer<typeof checklistBody>, userId: number, active: boolean) {
  return db.transaction(() => {
    if (active) db.prepare('UPDATE checklist_versions SET is_active = 0').run();
    const r = db
      .prepare('INSERT INTO checklist_versions (name, intro, notes, rules, is_active, created_by) VALUES (?, ?, ?, ?, ?, ?)')
      .run(body.name, body.intro, JSON.stringify(body.notes), body.rules, active ? 1 : 0, userId);
    const ins = db.prepare('INSERT INTO checklist_items (version_id, code, section, title, content, sort) VALUES (?, ?, ?, ?, ?, ?)');
    body.items.forEach((it, i) => ins.run(r.lastInsertRowid, it.code, it.section, it.title, it.content, i));
    return r.lastInsertRowid;
  })();
}

function dupCode(items: { code: string }[]) {
  const seen = new Set<string>();
  for (const i of items) {
    if (seen.has(i.code)) return i.code;
    seen.add(i.code);
  }
  return null;
}

const usageCount = (id: number) => (db.prepare('SELECT COUNT(*) AS n FROM submissions WHERE checklist_version_id = ?').get(id) as { n: number }).n;

adminRouter.get('/checklists', (_req, res) => {
  const rows = db
    .prepare(
      `SELECT v.id, v.name, v.is_active, v.created_at, v.updated_at,
        (SELECT COUNT(*) FROM checklist_items WHERE version_id = v.id) AS item_count,
        (SELECT COUNT(*) FROM submissions WHERE checklist_version_id = v.id) AS usage_count
       FROM checklist_versions v ORDER BY v.id DESC`,
    )
    .all();
  res.json({ rows });
});

adminRouter.get('/checklists/:id', (req, res) => {
  const c = loadChecklist(idParam(req.params.id));
  if (!c) return res.status(404).json({ error: '清单不存在' });
  res.json({ checklist: c, usageCount: usageCount(c.id) });
});

adminRouter.post('/checklists', (req, res) => {
  const body = checklistBody.parse(req.body);
  const d = dupCode(body.items);
  if (d) return res.status(400).json({ error: `条目编号重复：${d}` });
  const id = insertVersion(body, req.user!.id, !!body.activate);
  audit(req.user, '新建检查清单版本', body.name, body.activate ? '并设为生效' : undefined, req.ip);
  res.json({ id });
});

/** 编辑清单：已被检查记录使用的版本不直接改动（保证历史记录可追溯），自动另存为新版本 */
adminRouter.put('/checklists/:id', (req, res) => {
  const id = idParam(req.params.id);
  const old = db.prepare('SELECT * FROM checklist_versions WHERE id = ?').get(id) as { is_active: number; name: string } | undefined;
  if (!old) return res.status(404).json({ error: '清单不存在' });
  const body = checklistBody.parse(req.body);
  const d = dupCode(body.items);
  if (d) return res.status(400).json({ error: `条目编号重复：${d}` });
  if (usageCount(id) > 0) {
    const newId = insertVersion(body, req.user!.id, !!old.is_active);
    audit(req.user, '修改检查清单（另存为新版本）', body.name, `原版本#${id}已被使用，新版本#${newId}`, req.ip);
    return res.json({ id: newId, newVersion: true });
  }
  db.transaction(() => {
    db.prepare("UPDATE checklist_versions SET name = ?, intro = ?, notes = ?, rules = ?, updated_at = datetime('now','localtime') WHERE id = ?").run(
      body.name,
      body.intro,
      JSON.stringify(body.notes),
      body.rules,
      id,
    );
    db.prepare('DELETE FROM checklist_items WHERE version_id = ?').run(id);
    const ins = db.prepare('INSERT INTO checklist_items (version_id, code, section, title, content, sort) VALUES (?, ?, ?, ?, ?, ?)');
    body.items.forEach((it, i) => ins.run(id, it.code, it.section, it.title, it.content, i));
  })();
  audit(req.user, '修改检查清单', body.name, undefined, req.ip);
  res.json({ id, newVersion: false });
});

adminRouter.post('/checklists/:id/activate', (req, res) => {
  const id = idParam(req.params.id);
  const v = db.prepare('SELECT name FROM checklist_versions WHERE id = ?').get(id) as { name: string } | undefined;
  if (!v) return res.status(404).json({ error: '清单不存在' });
  db.transaction(() => {
    db.prepare('UPDATE checklist_versions SET is_active = 0').run();
    db.prepare('UPDATE checklist_versions SET is_active = 1 WHERE id = ?').run(id);
  })();
  audit(req.user, '设为生效清单', v.name, `版本#${id}`, req.ip);
  res.json({ ok: true });
});

adminRouter.delete('/checklists/:id', (req, res) => {
  const id = idParam(req.params.id);
  const v = db.prepare('SELECT name, is_active FROM checklist_versions WHERE id = ?').get(id) as { name: string; is_active: number } | undefined;
  if (!v) return res.status(404).json({ error: '清单不存在' });
  if (v.is_active) return res.status(400).json({ error: '不能删除当前生效的清单' });
  if (usageCount(id) > 0) return res.status(400).json({ error: '该版本已被检查记录使用，为保证记录可追溯，不能删除' });
  db.prepare('DELETE FROM checklist_versions WHERE id = ?').run(id);
  audit(req.user, '删除检查清单版本', v.name, undefined, req.ip);
  res.json({ ok: true });
});

/** 上传文件解析为清单草稿（不保存），管理员预览确认后再保存 */
adminRouter.post('/checklists/import', singleUpload(['.docx', '.txt', '.md']), async (req, res) => {
  const file = req.file;
  try {
    if (!file) return res.status(400).json({ error: '请选择文件' });
    const useAi = req.body.useAi === 'true';
    let draft = await parseChecklistFile(file.path, file.originalname);
    if (useAi || !draft.items.length) {
      if (!useAi) return res.json({ draft, needAi: true });
      const text = await extractFile(file.path, file.originalname);
      draft = await aiStructureChecklist(text, file.originalname);
    }
    res.json({ draft, needAi: false });
  } catch (e) {
    if (e instanceof ExtractError) return res.status(400).json({ error: e.message });
    throw e;
  } finally {
    cleanupTmp(file);
  }
});

// ---------- 培养方案 ----------
const planFields = z.object({
  major: z.string().trim().min(1, '请填写专业').max(100),
  trainingType: z.string().trim().min(1, '请选择培养类型').max(50),
  grade: z.coerce.number().int().min(2000).max(2100).default(2025),
  name: z.string().trim().max(200).default(''),
});

adminRouter.get('/plans', (_req, res) => {
  const rows = db
    .prepare(
      `SELECT id, major, training_type, grade, name, file_name, enabled, created_at, updated_at, length(extracted_text) AS text_length,
        (SELECT COUNT(*) FROM submissions WHERE plan_id = p.id) AS usage_count
       FROM training_plans p ORDER BY major, training_type, grade DESC`,
    )
    .all();
  res.json({ rows });
});

adminRouter.get('/plans/:id', (req, res) => {
  const p = db.prepare('SELECT * FROM training_plans WHERE id = ?').get(idParam(req.params.id));
  if (!p) return res.status(404).json({ error: '培养方案不存在' });
  res.json({ plan: p });
});

adminRouter.post('/plans', singleUpload(['.docx', '.pdf', '.txt', '.md']), async (req, res) => {
  const file = req.file;
  try {
    if (!file) return res.status(400).json({ error: '请选择培养方案文件' });
    const body = planFields.parse(req.body);
    const name = body.name || `${body.grade}级${body.major}（${body.trainingType}）人才培养方案`;
    const text = await extractFile(file.path, file.originalname);
    const rel = storeFile(file.path, 'plans', file.originalname);
    const r = db
      .prepare('INSERT INTO training_plans (major, training_type, grade, name, file_name, file_path, extracted_text) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(body.major, body.trainingType, body.grade, name, file.originalname, rel, text);
    audit(req.user, '上传培养方案', name, file.originalname, req.ip);
    res.json({ id: r.lastInsertRowid });
  } catch (e) {
    if (e instanceof ExtractError) return res.status(400).json({ error: e.message });
    throw e;
  } finally {
    cleanupTmp(file);
  }
});

adminRouter.put('/plans/:id', (req, res) => {
  const id = idParam(req.params.id);
  const p = db.prepare('SELECT * FROM training_plans WHERE id = ?').get(id) as { name: string } | undefined;
  if (!p) return res.status(404).json({ error: '培养方案不存在' });
  const body = planFields.extend({ extractedText: z.string().min(1, '方案文本不能为空'), enabled: z.boolean() }).parse(req.body);
  db.prepare(
    "UPDATE training_plans SET major=?, training_type=?, grade=?, name=?, extracted_text=?, enabled=?, updated_at=datetime('now','localtime') WHERE id=?",
  ).run(body.major, body.trainingType, body.grade, body.name || p.name, body.extractedText, body.enabled, id);
  audit(req.user, '修改培养方案', body.name || p.name, undefined, req.ip);
  res.json({ ok: true });
});

adminRouter.get('/plans/:id/file', (req, res) => {
  const p = db.prepare('SELECT file_path, file_name FROM training_plans WHERE id = ?').get(idParam(req.params.id)) as
    | { file_path: string; file_name: string }
    | undefined;
  if (!p?.file_path) return res.status(404).json({ error: '文件不存在' });
  sendStored(res, p.file_path, p.file_name);
});

adminRouter.delete('/plans/:id', (req, res) => {
  const id = idParam(req.params.id);
  const p = db.prepare('SELECT name, file_path FROM training_plans WHERE id = ?').get(id) as { name: string; file_path: string } | undefined;
  if (!p) return res.status(404).json({ error: '培养方案不存在' });
  const used = (db.prepare('SELECT COUNT(*) AS n FROM submissions WHERE plan_id = ?').get(id) as { n: number }).n;
  if (used) return res.status(400).json({ error: `该方案已被 ${used} 次检查使用，为保证记录可追溯，不能删除；如不再使用请停用` });
  db.prepare('DELETE FROM training_plans WHERE id = ?').run(id);
  removeFile(p.file_path);
  audit(req.user, '删除培养方案', p.name, undefined, req.ip);
  res.json({ ok: true });
});

// ---------- AI 配置 ----------
function publicAi(s: AiSettings) {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { apiKeyEnc, ...rest } = s;
  return { ...rest, apiKeyMasked: mask(decrypt(apiKeyEnc)), hasKey: !!decrypt(apiKeyEnc), defaultSystemPrompt: DEFAULT_SYSTEM_PROMPT };
}

const aiBody = z.object({
  provider: z.enum(['openai', 'anthropic']),
  baseUrl: z.string().trim().max(500).default(''),
  apiKey: z.string().trim().max(500).optional(), // 留空表示不修改
  model: z.string().trim().min(1, '请填写模型名称').max(200),
  temperature: z.coerce.number().min(0).max(2).default(0.2),
  maxTokens: z.coerce.number().int().min(256).max(128000).default(16000),
  timeoutSec: z.coerce.number().int().min(30).max(3600).default(600),
  concurrency: z.coerce.number().int().min(1).max(10).default(2),
  effort: z.enum(['low', 'medium', 'high', 'xhigh', 'max']).default('high'),
  anthropicFallback: z.boolean().default(true),
  jsonMode: z.boolean().default(true),
  systemPrompt: z.string().max(50000).default(''),
});

adminRouter.get('/ai', (_req, res) => res.json(publicAi(getSettings('ai'))));

adminRouter.post('/ai/models', async (req, res) => {
  const { apiKey, ...body } = aiBody.pick({ provider: true, baseUrl: true, apiKey: true }).parse(req.body);
  if (body.provider === 'openai' && !body.baseUrl) return res.status(400).json({ error: '请先填写接口地址（Base URL）' });
  const key = apiKey || decrypt(getSettings('ai').apiKeyEnc);
  if (!key) return res.status(400).json({ error: '请先填写 API Key' });
  try {
    res.json({ models: await listModels(body, key) });
  } catch (e) {
    res.status(400).json({ error: (e as Error).message });
  }
});

adminRouter.put('/ai', (req, res) => {
  const { apiKey, ...body } = aiBody.parse(req.body);
  const patch: Partial<AiSettings> = { ...body, systemPrompt: body.systemPrompt.trim() === DEFAULT_SYSTEM_PROMPT.trim() ? '' : body.systemPrompt };
  if (apiKey) patch.apiKeyEnc = encrypt(apiKey);
  const s = saveSettings('ai', patch);
  audit(req.user, '修改 AI 配置', `${s.provider} / ${s.model}`, apiKey ? '更新了 API Key' : undefined, req.ip);
  kickQueue();
  res.json(publicAi(s));
});

adminRouter.post('/ai/test', async (req, res) => {
  const { apiKey, ...body } = aiBody.parse(req.body);
  const stored = getSettings('ai');
  const key = apiKey || decrypt(stored.apiKeyEnc);
  if (!key) return res.status(400).json({ error: '请先填写 API Key' });
  try {
    res.json(await testConnection({ ...stored, ...body }, key));
  } catch (e) {
    res.status(400).json({ error: (e as Error).message || '连接失败' });
  }
});

// ---------- 系统设置 ----------
adminRouter.get('/site', (_req, res) => res.json(getSettings('site')));

adminRouter.put('/site', (req, res) => {
  const body = z
    .object({
      siteName: z.string().trim().min(1).max(100),
      registrationMode: z.enum(['open', 'approval', 'closed']),
      maxUploadMB: z.coerce.number().int().min(1).max(200),
      trainingTypes: z.array(z.string().trim().min(1).max(50)).min(1, '至少保留一个培养类型'),
    })
    .parse(req.body);
  const s = saveSettings('site', body);
  audit(req.user, '修改系统设置', undefined, `注册模式：${body.registrationMode}`, req.ip);
  res.json(s);
});

// ---------- 操作日志 ----------
adminRouter.get('/logs', (req, res) => {
  const { q = '' } = req.query as Record<string, string>;
  const { page, pageSize, offset } = paging(req.query);
  const where = q ? 'WHERE username LIKE ? OR action LIKE ? OR target LIKE ?' : '';
  const args = q ? [`%${q}%`, `%${q}%`, `%${q}%`] : [];
  const total = (db.prepare(`SELECT COUNT(*) AS n FROM audit_logs ${where}`).get(...args) as { n: number }).n;
  const rows = db.prepare(`SELECT * FROM audit_logs ${where} ORDER BY id DESC LIMIT ? OFFSET ?`).all(...args, pageSize, offset);
  res.json({ total, rows });
});
