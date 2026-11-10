import { db } from '../db.js';
import { getSettings } from '../settings.js';
import { callAi } from './ai/provider.js';
import { buildUserPrompt } from './ai/prompt.js';
import { computeVerdict, extractJson, normalizeResult, ResultFormatError } from './ai/schema.js';
import { loadChecklist } from './checklist.js';
import { CHECK_QUOTA_ERROR, getCheckQuota } from './checkQuota.js';

export interface CourseSnapshot {
  name: string;
  major: string;
  trainingType: string;
  studentGrade: number;
  planGrade: number;
  adjustNote: string;
}

interface SubRow {
  id: number;
  file_name: string;
  extracted_text: string;
  checklist_version_id: number | null;
  plan_id: number | null;
  course_snapshot: string;
}

/** 按专业 + 培养类型 + 年级查找已启用的培养方案 */
export function findPlan(major: string, trainingType: string, grade: number) {
  const transfer = major === '计算机科学与技术（专转本）';
  // 兼容原有以“计算机科学与技术 + 专转本”保存的培养方案。
  return db
    .prepare(
      'SELECT id, name, extracted_text FROM training_plans WHERE major IN (?, ?) AND training_type = ? AND grade = ? AND enabled = 1 ORDER BY (major = ?) DESC, updated_at DESC LIMIT 1',
    )
    .get(major, transfer ? '计算机科学与技术' : major, transfer ? '专转本' : trainingType, grade, major) as { id: number; name: string; extracted_text: string } | undefined;
}

let running = 0;
let timer: NodeJS.Timeout | null = null;

export function kickQueue() {
  if (timer) return;
  timer = setTimeout(() => {
    timer = null;
    pump();
  }, 50);
}

function pump() {
  const limit = Math.max(1, getSettings('ai').concurrency);
  while (running < limit) {
    const next = db
      .prepare("SELECT id, user_id FROM submissions WHERE status = 'queued' ORDER BY id LIMIT 1")
      .get() as { id: number; user_id: number } | undefined;
    if (!next) return;
    const quota = getCheckQuota(next.user_id);
    if (quota.used >= quota.limit) {
      db.prepare("UPDATE submissions SET status = 'failed', error = ?, finished_at = datetime('now','localtime') WHERE id = ?")
        .run(CHECK_QUOTA_ERROR, next.id);
      continue;
    }
    if (quota.used + quota.running >= quota.limit) return;
    const claimed = db
      .prepare("UPDATE submissions SET status = 'running', started_at = datetime('now','localtime'), error = NULL WHERE id = ? AND status = 'queued'")
      .run(next.id);
    if (!claimed.changes) continue;
    running++;
    runCheck(next.id)
      .catch((e) => {
        db.prepare("UPDATE submissions SET status = 'failed', error = ?, finished_at = datetime('now','localtime') WHERE id = ?").run(
          String(e?.message || e).slice(0, 1000),
          next.id,
        );
      })
      .finally(() => {
        running--;
        kickQueue();
      });
  }
}

async function runCheck(id: number) {
  const sub = db.prepare('SELECT * FROM submissions WHERE id = ?').get(id) as SubRow | undefined;
  if (!sub) return;
  const checklist = loadChecklist(sub.checklist_version_id ?? undefined);
  if (!checklist) throw new Error('找不到检查清单');
  const course = JSON.parse(sub.course_snapshot) as CourseSnapshot;
  const plan = sub.plan_id
    ? (db.prepare('SELECT name, extracted_text FROM training_plans WHERE id = ?').get(sub.plan_id) as
        | { name: string; extracted_text: string }
        | undefined)
    : undefined;

  // 每次检查只使用本次上传的大纲，不带入任何历史提交
  const user = buildUserPrompt({
    checklist,
    course,
    plan: plan ? { name: plan.name, text: plan.extracted_text } : null,
    syllabus: { fileName: sub.file_name, text: sub.extracted_text },
  });
  const codes = checklist.items.map((i) => i.code);
  const settings = getSettings('ai');

  let lastErr: unknown;
  for (let attempt = 0; attempt < 2; attempt++) {
    const r = await callAi(user, { settings });
    try {
      if (r.truncated) throw new ResultFormatError('AI 输出被截断，请在 AI 配置中调大“最大输出 token”');
      const result = normalizeResult(extractJson(r.text), codes, attempt === 0);
      db.prepare(
        "UPDATE submissions SET status = 'done', verdict = ?, result_json = ?, ai_model = ?, error = NULL, finished_at = datetime('now','localtime') WHERE id = ?",
      ).run(computeVerdict(result), JSON.stringify(result), r.model, id);
      return;
    } catch (e) {
      lastErr = e;
      if (!(e instanceof ResultFormatError)) throw e;
    }
  }
  throw lastErr;
}

export function startQueue() {
  // 服务重启时，中断的任务重新排队
  db.prepare("UPDATE submissions SET status = 'queued' WHERE status = 'running'").run();
  kickQueue();
}
