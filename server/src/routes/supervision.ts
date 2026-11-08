import { Router } from 'express';
import { z } from 'zod';
import { db, audit } from '../db.js';
import { requireAuth, toPublic, type UserRow } from '../auth.js';
import { cleanupTmp, singleUpload } from '../services/upload.js';
import { RosterImportError } from '../services/rosterImport.js';
import { readOutlineFile, readTencentOutline } from '../services/outlineImport.js';
import { GROUP_PRESETS } from '../services/supervisionRoles.js';
import { availableViews, getOutlineRows, PROFESSIONALS, scopeOutlineRows, summarizeOutlines } from '../services/outlineProgress.js';

export const supervisionManagementRouter = Router();
supervisionManagementRouter.use(requireAuth);
supervisionManagementRouter.use((req, res, next) => {
  if (req.user!.role !== 'admin' && !req.user!.supervision_manager) return res.status(403).json({ error: '没有视图配置权限' });
  next();
});

const source = () => {
  const meta = db.prepare("SELECT value FROM settings WHERE key = 'outline_source'").get() as { value: string } | undefined;
  return meta ? JSON.parse(meta.value) : null;
};
const programs = () => [...new Set([...PROFESSIONALS, ...(db.prepare("SELECT DISTINCT professional FROM outline_requirements WHERE professional <> ''").all() as { professional: string }[]).map((r) => r.professional)])];

supervisionManagementRouter.get('/', (_req, res) => {
  res.json({
    users: (db.prepare('SELECT * FROM users ORDER BY name, username').all() as UserRow[]).map(toPublic),
    groups: GROUP_PRESETS.map((g) => g.group), programs: programs(),
    source: source(), requirements: getOutlineRows(),
  });
});

supervisionManagementRouter.put('/users/:id', (req, res) => {
  const id = z.coerce.number().int().positive().parse(req.params.id);
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(id) as UserRow | undefined;
  if (!user) return res.status(404).json({ error: '账号不存在' });
  const body = z.object({
    college_role: z.enum(['none', 'teaching', 'program']),
    led_groups: z.array(z.string()).max(8),
    program_scopes: z.array(z.string()).max(30),
    supervision_manager: z.coerce.number().int().min(0).max(1).optional(),
  }).parse(req.body);
  if (body.led_groups.some((g) => !GROUP_PRESETS.some((p) => p.group === g)) || new Set(body.led_groups).size !== body.led_groups.length) {
    return res.status(400).json({ error: '请选择正式课程组，课程组不能重复' });
  }
  if (body.program_scopes.some((p) => !programs().includes(p)) || new Set(body.program_scopes).size !== body.program_scopes.length) {
    return res.status(400).json({ error: '请选择有效专业，专业不能重复' });
  }
  if (body.supervision_manager !== undefined && req.user!.role !== 'admin') return res.status(403).json({ error: '仅管理员可授予视图配置权限' });
  db.transaction(() => {
    db.prepare('UPDATE users SET college_role = ?, supervision_manager = ? WHERE id = ?')
      .run(body.college_role, body.supervision_manager ?? user.supervision_manager, id);
    db.prepare('DELETE FROM course_group_leaders WHERE user_id = ?').run(id);
    for (const group of body.led_groups) db.prepare('INSERT INTO course_group_leaders (course_group, user_id) VALUES (?, ?) ON CONFLICT(course_group) DO UPDATE SET user_id = excluded.user_id').run(group, id);
    db.prepare('DELETE FROM program_leader_scopes WHERE user_id = ?').run(id);
    for (const professional of body.program_scopes) db.prepare('INSERT INTO program_leader_scopes (user_id, professional) VALUES (?, ?)').run(id, professional);
    audit(req.user, '配置监督视图', user.username, JSON.stringify(body), req.ip);
  })();
  res.json({ user: toPublic(db.prepare('SELECT * FROM users WHERE id = ?').get(id) as UserRow) });
});

supervisionManagementRouter.put('/requirements/:id', (req, res) => {
  const id = z.coerce.number().int().positive().parse(req.params.id);
  if (!db.prepare('SELECT 1 FROM outline_requirements WHERE id = ?').get(id)) return res.status(404).json({ error: '应交课程不存在' });
  const body = z.object({
    writer_user_id: z.number().int().positive().nullable(),
    writer_name: z.string().trim().max(50),
    professional: z.string().trim().max(100),
  }).parse(req.body);
  const writer = body.writer_user_id === null ? null : db.prepare('SELECT id, name, username FROM users WHERE id = ?').get(body.writer_user_id) as { id: number; name: string; username: string } | undefined;
  if (body.writer_user_id !== null && !writer) return res.status(400).json({ error: '所选执笔人账号不存在' });
  if (body.professional && !programs().includes(body.professional)) return res.status(400).json({ error: '请选择有效审核专业' });
  db.prepare('UPDATE outline_requirements SET writer_user_id = ?, writer_name = ?, writer_identifier = ?, professional = ?, writer_manual = 1 WHERE id = ?')
    .run(writer?.id, writer?.name ?? body.writer_name, writer?.username ?? '', body.professional, id);
  audit(req.user, '配置大纲执笔人', String(id), JSON.stringify(body), req.ip);
  res.json({ ok: true });
});

function importRows(parsed: Awaited<ReturnType<typeof readOutlineFile>>, url: string, user: Express.Request['user'], ip?: string) {
  const warnings = [...parsed.warnings];
  db.transaction(() => {
    const keys = new Set(parsed.rows.map((r) => r.source_key));
    for (const old of db.prepare('SELECT id, source_key FROM outline_requirements').all() as { id: number; source_key: string }[]) {
      if (!keys.has(old.source_key)) db.prepare('DELETE FROM outline_requirements WHERE id = ?').run(old.id);
    }
    for (const r of parsed.rows) {
      const matched = r.writer_identifier
        ? db.prepare('SELECT id FROM users WHERE username = ?').all(r.writer_identifier)
        : r.writer_name ? db.prepare('SELECT id FROM users WHERE name = ?').all(r.writer_name) : [];
      const userId = matched.length === 1 ? (matched[0] as { id: number }).id : null;
      db.prepare(`INSERT INTO outline_requirements
        (source_key, course_name, course_group, professional, teacher_names, writer_name, writer_identifier, writer_user_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(source_key) DO UPDATE SET course_name=excluded.course_name, course_group=excluded.course_group,
          professional=excluded.professional, teacher_names=excluded.teacher_names,
          writer_name=CASE WHEN writer_manual=1 THEN writer_name ELSE excluded.writer_name END,
          writer_identifier=CASE WHEN writer_manual=1 THEN writer_identifier ELSE excluded.writer_identifier END,
          writer_user_id=CASE WHEN writer_manual=1 THEN writer_user_id ELSE excluded.writer_user_id END`)
        .run(r.source_key, r.course_name, r.course_group, r.professional, r.teacher_names, r.writer_name, r.writer_identifier, userId);
    }
    const unmatched = db.prepare("SELECT course_name, writer_name, writer_identifier FROM outline_requirements WHERE writer_user_id IS NULL AND (writer_name <> '' OR writer_identifier <> '')").all() as { course_name: string; writer_name: string; writer_identifier: string }[];
    for (const r of unmatched) warnings.push(`${r.course_name}：执笔人 ${r.writer_name || r.writer_identifier} 未匹配到唯一账号，请手动配置`);
    db.prepare(`INSERT INTO settings (key,value) VALUES ('outline_source',json_set(?, '$.importedAt',datetime('now','localtime')))
      ON CONFLICT(key) DO UPDATE SET value=excluded.value`).run(JSON.stringify({ url, name: parsed.name, warnings }));
    audit(user, '更新大纲应交清单', parsed.name, `${parsed.rows.length} 份；手工指定执笔人保留；不读取磨课安排`, ip);
  })();
  return { required: parsed.rows.length, unassigned: summarizeOutlines(getOutlineRows()).unassigned, warnings };
}

supervisionManagementRouter.post('/import', singleUpload(['.xlsx', '.csv']), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: '请选择云文档导出的 .xlsx 或 .csv 清单' });
    res.json(importRows(await readOutlineFile(req.file), '', req.user, req.ip));
  } catch (e) {
    if (e instanceof RosterImportError) return res.status(400).json({ error: e.message });
    throw e;
  } finally { cleanupTmp(req.file); }
});

supervisionManagementRouter.post('/sync', async (req, res) => {
  const { url } = z.object({ url: z.string().url() }).parse(req.body);
  try { res.json(importRows(await readTencentOutline(url), url, req.user, req.ip)); }
  catch (e) {
    if (e instanceof RosterImportError) return res.status(400).json({ error: e.message });
    throw e;
  }
});

export const supervisionViewRouter = Router();
supervisionViewRouter.use(requireAuth);
supervisionViewRouter.get('/progress', (req, res) => {
  const user = req.user!;
  const views = availableViews(user);
  if (!views.length) return res.status(403).json({ error: '没有课程监督权限，请联系管理员配置视图' });
  const view = z.enum(['college', 'group', 'program']).parse(req.query.view ?? views[0]);
  if (!views.includes(view)) return res.status(403).json({ error: '没有此视图的访问权限' });
  const rows = scopeOutlineRows(user, view).map((r) => ({ ...r, can_confirm: user.led_groups.includes(r.course_group) }));
  res.json({
    view, views, college: view === 'college', groups: [...new Set(rows.map((r) => r.course_group))].filter(Boolean),
    programs: view === 'program' ? user.program_scopes : [...new Set(rows.map((r) => r.professional))].filter(Boolean),
    rows, summary: summarizeOutlines(rows), source: source(),
  });
});
