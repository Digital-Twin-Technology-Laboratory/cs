import path from 'node:path';
import { Router, type Request, type Response } from 'express';
import { Document, HeadingLevel, Packer, Paragraph } from 'docx';
import { z } from 'zod';
import { requireAuth } from '../auth.js';
import { audit, db } from '../db.js';
import { PLAN_MAJORS } from '../services/planIdentification.js';
import { findPlan, kickQueue } from '../services/checkQueue.js';
import { CHECK_QUOTA_ERROR, getCheckQuota } from '../services/checkQuota.js';
import { availableMaterials, optionalMaterials, flags, materialScopeSchema, materialVersion, planMaterial, scopeRules, type MaterialScope } from '../services/materialChecklist.js';
import { MATERIAL_EXTENSIONS } from '../services/materialExtract.js';
import { extractGradeRows, GRADE_TYPES, materialWeights } from '../services/materialGrades.js';
import { canAccessMaterial, filePages, fullAccess, type MaterialCaseRow, type MaterialFileRow, type MaterialRunRow, type RunSnapshot } from '../services/materialRuns.js';
import type { MaterialResult } from '../services/materialReview.js';
import { absPath, cleanupTmp, removeFile, sendStored, singleUpload, storeFile } from '../services/upload.js';
import { GROUP_PRESETS } from '../services/supervisionRoles.js';

export const materialsRouter = Router();
materialsRouter.use(requireAuth);
const id = z.coerce.number().int().positive();
const code = z.string().regex(/^[CS]\d{3}$/);
const results = { passed: '通过', partial: '已检部分未发现问题（仍有待补／待核）', failed: '需整改' };
const extensions = new Set(MATERIAL_EXTENSIONS);
const manual = z.object({ finding: z.enum(['未发现问题', '需整改']), note: z.string().trim().min(3).max(800) });
const corrections = z.object({
  edits: z.array(z.object({ location: z.string(), line: z.number().int().positive(),
    column: z.string(), value: z.string().trim().max(120) })).max(1000),
  weights: z.partialRecord(z.enum(['平时', '期中', '实验', '期末']), z.number().min(0).max(100)).nullable().optional(),
  weightsVerified: z.boolean().optional(),
});
const listRuns = db.prepare('SELECT id, status, version, error, created_at, finished_at, json_extract(result_json, \'$.verdict\') AS verdict FROM material_runs WHERE case_id = ? ORDER BY id DESC');
const listFiles = db.prepare('SELECT * FROM material_files WHERE case_id = ? AND active = 1 ORDER BY id');

function findCase(req: Request, res: Response, write = false) {
  const row = db.prepare('SELECT * FROM material_cases WHERE id = ?').get(id.parse(req.params.caseId)) as MaterialCaseRow | undefined;
  const scope = row && JSON.parse(row.scope_json) as MaterialScope;
  if (!row || !scope || !canAccessMaterial(req.user!, scope, row.user_id)) {
    res.status(404).json({ error: '送检档案不存在' });
    return;
  }
  if (write && row.user_id !== req.user!.id && !fullAccess(req.user!)) {
    res.status(403).json({ error: '只有建档人或全院管理人员可修改档案' });
    return;
  }
  if (write && db.prepare("SELECT 1 FROM material_runs WHERE case_id = ? AND status IN ('queued', 'running')").get(row.id)) {
    res.status(409).json({ error: '正在检查，等待结束后再修改材料' });
    return;
  }
  return { row, scope };
}

function findFile(caseId: number, req: Request, res: Response) {
  const file = db.prepare('SELECT * FROM material_files WHERE id = ? AND case_id = ?')
    .get(id.parse(req.params.fileId), caseId) as MaterialFileRow | undefined;
  if (!file) res.status(404).json({ error: '材料不存在' });
  return file;
}

function findRun(caseId: number, req: Request, res: Response) {
  const row = db.prepare('SELECT * FROM material_runs WHERE id = ? AND case_id = ?')
    .get(id.parse(req.params.runId), caseId) as MaterialRunRow | undefined;
  if (!row) res.status(404).json({ error: '检查记录不存在' });
  return row;
}

function courseGroup(scope: MaterialScope) {
  const matches = db.prepare('SELECT DISTINCT course_group FROM outline_requirements WHERE course_name = ? COLLATE NOCASE AND professional IN (?, ?) AND course_group != \'\'')
    .all(scope.title, scope.major, scope.major === '公共' ? '计算机公共教学' : scope.major === '计算机科学与技术（专转本）' ? '专转本' : scope.major) as { course_group: string }[];
  return matches.length === 1 ? matches[0].course_group : '';
}

function comparisonPlan(scope: MaterialScope) {
  if (!['course', 'program'].includes(scope.level)) return;
  return findPlan(scope.major, scope.major.endsWith('（专转本）') ? '专转本' : '普通本科', scope.planGrade);
}

materialsRouter.get('/options', (req, res) => {
  const user = req.user!;
  const all = fullAccess(user);
  const groups = all ? [...new Set([...GROUP_PRESETS.map((g) => g.group), ...(
    db.prepare("SELECT DISTINCT course_group FROM outline_requirements WHERE course_group != '' ORDER BY course_group").all() as { course_group: string }[])
    .map((g) => g.course_group)])] : user.led_groups;
  res.json({ flags, majors: [...new Set([...PLAN_MAJORS, ...user.program_scopes])],
    programs: all ? PLAN_MAJORS : user.program_scopes, groups, college: all });
});

materialsRouter.get('/', (req, res) => {
  const rows = db.prepare('SELECT * FROM material_cases ORDER BY id DESC').all() as MaterialCaseRow[];
  res.json(rows.flatMap((r) => {
    const scope = JSON.parse(r.scope_json) as MaterialScope;
    return canAccessMaterial(req.user!, scope, r.user_id) ? [{ id: r.id, scope, createdAt: r.created_at, latest: listRuns.get(r.id) ?? null }] : [];
  }).slice(0, 200));
});

materialsRouter.post('/', (req, res) => {
  const scope = materialScopeSchema.parse(req.body);
  if (!canAccessMaterial(req.user!, scope)) return res.status(403).json({ error: '没有此专项复核的权限' });
  if (scope.level === 'course') scope.group = courseGroup(scope);
  const { lastInsertRowid } = db.prepare('INSERT INTO material_cases (user_id, scope_json) VALUES (?, ?)')
    .run(req.user!.id, JSON.stringify(scope));
  audit(req.user, '创建材料检查档案', String(lastInsertRowid), scope.title, req.ip);
  res.status(201).json({ id: lastInsertRowid });
});

materialsRouter.get('/:caseId', (req, res) => {
  const entry = findCase(req, res);
  if (!entry) return;
  const files = listFiles.all(entry.row.id) as MaterialFileRow[];
  const supplied = new Set(files.map((f) => f.type));
  const plan = supplied.has(planMaterial) ? undefined : comparisonPlan(entry.scope);
  if (plan) supplied.add(planMaterial);
  const expected = availableMaterials(entry.scope, supplied);
  res.json({
    id: entry.row.id, scope: entry.scope, version: materialVersion, expected, optional: optionalMaterials(entry.scope, expected),
    editable: entry.row.user_id === req.user!.id || fullAccess(req.user!),
    plan: plan ? { name: plan.name } : null,
    files: files.map((f) => ({ id: f.id, type: f.type, name: f.file_name, grade: GRADE_TYPES.includes(f.type) && !!f.pages_json })),
    runs: listRuns.all(entry.row.id),
  });
});

materialsRouter.post('/:caseId/files', singleUpload([...extensions]), (req, res) => {
  const upload = req.file;
  try {
    const entry = findCase(req, res, true);
    if (!entry) return;
    if (!upload) return res.status(400).json({ error: '请选择要送检的文件' });
    const type = z.string().parse(req.body.type);
    const required = availableMaterials(entry.scope, new Set((listFiles.all(entry.row.id) as MaterialFileRow[]).map((f) => f.type)));
    const validTypes = new Set([...required, ...optionalMaterials(entry.scope, required)]);
    if (!validTypes.has(type)) return res.status(400).json({ error: '材料类型不适用于本档案' });
    const stored = storeFile(upload.path, `uploads/${entry.row.user_id}/materials`, upload.originalname);
    try {
      const { lastInsertRowid } = db.prepare('INSERT INTO material_files (case_id, type, file_name, file_path) VALUES (?, ?, ?, ?)')
        .run(entry.row.id, type, upload.originalname, stored);
      res.status(201).json({ id: lastInsertRowid });
    } catch (e) {
      removeFile(stored);
      throw e;
    }
  } finally {
    cleanupTmp(upload);
  }
});

materialsRouter.delete('/:caseId/files/:fileId', (req, res) => {
  const entry = findCase(req, res, true);
  if (!entry) return;
  const file = findFile(entry.row.id, req, res);
  if (!file) return;
  const used = db.prepare(`SELECT 1 FROM material_runs, json_each(json_extract(snapshot_json, '$.files'))
    WHERE case_id = ? AND json_extract(json_each.value, '$.id') = ? LIMIT 1`).get(entry.row.id, file.id);
  if (used) db.prepare('UPDATE material_files SET active = 0 WHERE id = ?').run(file.id);
  else {
    db.prepare('DELETE FROM material_files WHERE id = ?').run(file.id);
    removeFile(file.file_path);
  }
  res.json({ ok: true });
});

materialsRouter.get('/:caseId/files/:fileId/original', (req, res) => {
  const entry = findCase(req, res);
  if (!entry) return;
  const file = findFile(entry.row.id, req, res);
  if (!file) return;
  const allowPreview = /\.(?:png|jpe?g|pdf)$/i.test(path.extname(file.file_name));
  res.setHeader('Cache-Control', 'private, no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
  if (req.query.preview === '1' && allowPreview) return res.sendFile(absPath(file.file_path), { dotfiles: 'allow' });
  sendStored(res, file.file_path, file.file_name);
});

materialsRouter.get('/:caseId/files/:fileId/grades', (req, res) => {
  const entry = findCase(req, res);
  if (!entry) return;
  const file = findFile(entry.row.id, req, res);
  if (!file) return;
  if (!GRADE_TYPES.includes(file.type)) return res.status(400).json({ error: '此材料不是成绩表' });
  const pages = filePages(file);
  res.setHeader('Cache-Control', 'private, no-store');
  res.json({ rows: extractGradeRows(pages, JSON.parse(file.edits_json)), edits: JSON.parse(file.edits_json),
    weights: materialWeights(pages), weightEdits: file.weights_json && JSON.parse(file.weights_json),
    scanned: pages.some((p) => p.ocr), weightsVerified: !!file.weights_verified });
});

materialsRouter.put('/:caseId/files/:fileId/grades', (req, res) => {
  const entry = findCase(req, res, true);
  if (!entry) return;
  const file = findFile(entry.row.id, req, res);
  if (!file) return;
  if (!file.active || !GRADE_TYPES.includes(file.type)) return res.status(400).json({ error: '只能校正当前送检的成绩表' });
  const body = corrections.parse(req.body);
  const pages = filePages(file);
  const rows = extractGradeRows(pages);
  const keys = new Set(rows.flatMap((r) => Object.keys(r.cells).filter((column) => column !== '序号').map((column) =>
    JSON.stringify([r.location, r.line, column]))));
  const edits = new Map<string, typeof body.edits[number]>();
  for (const edit of body.edits) {
    const key = JSON.stringify([edit.location, edit.line, edit.column]);
    if (!keys.has(key)) return res.status(400).json({ error: '校正的成绩单位置不存在' });
    edits.set(key, edit);
  }
  db.prepare('UPDATE material_files SET edits_json = ?, weights_json = ?, weights_verified = ? WHERE id = ?')
    .run(JSON.stringify([...edits.values()]), body.weights === undefined ? file.weights_json : body.weights && JSON.stringify(body.weights),
      body.weightsVerified ?? !!file.weights_verified, file.id);
  audit(req.user, '校正成绩识别结果', String(file.id), `涉及 ${edits.size} 个单元格`, req.ip);
  res.json({ ok: true });
});

materialsRouter.put('/:caseId/verification/:code', (req, res) => {
  const entry = findCase(req, res, true);
  if (!entry) return;
  const rule = code.parse(req.params.code);
  const body = manual.parse(req.body);
  const files = listFiles.all(entry.row.id) as MaterialFileRow[];
  const applies = scopeRules(entry.scope, new Set(files.map((f) => f.type))).find((r) => r.rule.code === rule && r.applies);
  if (!applies) return res.status(400).json({ error: '此条款不适用' });
  const verifications = JSON.parse(entry.row.verifications_json) as RunSnapshot['verifications'];
  const fileIds = files.filter((f) => applies.materials.includes(f.type)).map((f) => f.id);
  verifications[rule] = { ...body, reviewer: req.user!.name || req.user!.username, fileIds };
  db.prepare('UPDATE material_cases SET verifications_json = ? WHERE id = ?').run(JSON.stringify(verifications), entry.row.id);
  audit(req.user, '记录材料人工核实', `${entry.row.id}/${rule}`, body.finding, req.ip);
  res.json({ ok: true });
});

materialsRouter.post('/:caseId/runs', (req, res) => {
  const entry = findCase(req, res, true);
  if (!entry) return;
  const user = req.user!;
  const files = listFiles.all(entry.row.id) as MaterialFileRow[];
  if (!files.length) return res.status(400).json({ error: '请先上传至少一份材料' });
  if (!getCheckQuota(user.id).remaining) return res.status(429).json({ error: CHECK_QUOTA_ERROR });
  const plan = files.some((f) => f.type === planMaterial) ? undefined : comparisonPlan(entry.scope);
  const snapshot: RunSnapshot = {
    scope: entry.scope, files: files.map((f) => ({ id: f.id, edits: JSON.parse(f.edits_json),
      weights: f.weights_json ? JSON.parse(f.weights_json) : undefined, weightsVerified: !!f.weights_verified })),
    plan: plan ? { name: plan.name, text: plan.extracted_text } : null,
    verifications: JSON.parse(entry.row.verifications_json),
  };
  const { lastInsertRowid } = db.prepare('INSERT INTO material_runs (case_id, user_id, version, snapshot_json) VALUES (?, ?, ?, ?)')
    .run(entry.row.id, user.id, materialVersion, JSON.stringify(snapshot));
  audit(user, '启动全套材料检查', String(lastInsertRowid), entry.scope.title, req.ip);
  kickQueue();
  res.status(201).json({ id: lastInsertRowid });
});

materialsRouter.get('/:caseId/runs/:runId', (req, res) => {
  const entry = findCase(req, res);
  if (!entry) return;
  const run = findRun(entry.row.id, req, res);
  if (!run) return;
  res.setHeader('Cache-Control', 'private, no-store');
  res.json({ id: run.id, version: run.version, status: run.status, error: run.error,
    result: run.result_json ? JSON.parse(run.result_json) : null });
});

materialsRouter.get('/:caseId/runs/:runId/report.docx', async (req, res) => {
  const entry = findCase(req, res);
  if (!entry) return;
  const run = findRun(entry.row.id, req, res);
  if (!run) return;
  if (!run.result_json) return res.status(409).json({ error: '检查尚未生成报告' });
  const r = JSON.parse(run.result_json) as MaterialResult;
  const { scope } = JSON.parse(run.snapshot_json) as RunSnapshot;
  const types = [...new Set([...r.files.map((f) => f.type), ...r.rules.filter((rule) => rule.status !== '不适用').flatMap((rule) => rule.materials)])];
  const doc = new Document({ sections: [{ children: [
    new Paragraph({ text: '全套教学材料检查报告', heading: HeadingLevel.TITLE }),
    new Paragraph([scope.title, scope.term, scope.section, scope.major, scope.group].filter(Boolean).join(' · ')),
    new Paragraph(`结论：${results[r.verdict]} · 规则 ${run.version} · 检查 #${run.id} · ${run.finished_at}`),
    new Paragraph('本报告仅针对本次送检材料。请结合原件核实；报告和计算结果不修改正式成绩。'),
    new Paragraph({ text: '按材料查', heading: HeadingLevel.HEADING_1 }),
    ...types.flatMap((type) => {
      const files = r.files.filter((f) => f.type === type);
      const rules = r.rules.filter((rule) => rule.materials.includes(type) && rule.status !== '不适用');
      return [new Paragraph({ text: type, heading: HeadingLevel.HEADING_2 }),
        ...files.map((f) => new Paragraph(`${f.name}${f.id ? `（附件 #${f.id}）` : '（系统引用）'}${f.warnings.length ? ' · ' + f.warnings.join('；') : ''}`)),
        ...(!files.length ? [new Paragraph('本次未上传')] : []),
        new Paragraph(rules.map((rule) => `${rule.code} ${rule.title}：${rule.status}`).join('；'))];
    }),
    new Paragraph({ text: '按问题查', heading: HeadingLevel.HEADING_1 }),
    ...r.rules.flatMap((rule) => [
      new Paragraph({ text: `${rule.code} ${rule.title} · ${rule.status}`, heading: HeadingLevel.HEADING_2 }),
      ...rule.findings.map((f) => new Paragraph([f.status, f.location, f.detail].filter(Boolean).join(' | '))),
    ]),
    ...(r.stats.length ? [new Paragraph({ text: '成绩统计（本次可计算范围）', heading: HeadingLevel.HEADING_1 })] : []),
    ...r.stats.flatMap((sample) => [new Paragraph(`${sample.file}（附件 #${sample.id}）`),
      new Paragraph(Object.entries(sample.weights).map(([key, value]) => `${key} ${value}%`).join('、')),
      ...sample.stats.map((s) => new Paragraph(`${s.column}：识别 ${s.rows} 行，可统计 ${s.count} 行，特殊状态 ${s.excluded} 行，待核 ${s.unreadable} 行，均分 ${s.mean?.toFixed(2) ?? '待核实'}；各分段（<60 / 60–69 / 70–79 / 80–89 / ≥90）人数 ${s.bands.join(' / ')}`))]),
  ] }] });
  const buffer = await Packer.toBuffer(doc);
  res.setHeader('Cache-Control', 'private, no-store');
  res.attachment(`${scope.title.replace(/[<>:"/\\|?*]/g, '_')}-材料检查-${run.id}.docx`).send(buffer);
});
