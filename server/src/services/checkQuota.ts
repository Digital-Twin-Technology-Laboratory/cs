import { db } from '../db.js';

export const DAILY_CHECK_LIMIT = 5;
export const CHECK_QUOTA_ERROR = '今日可用检查次数已用完，请联系管理员。排队或检查中的任务暂占名额，检查失败后自动释放。';

export function getCheckQuota(userId: number) {
  const counts = db.prepare(`
    SELECT
      COUNT(CASE WHEN status = 'done' AND date(finished_at) = date('now','localtime') THEN 1 END) AS used,
      COUNT(CASE WHEN status IN ('queued', 'running') THEN 1 END) AS pending,
      COUNT(CASE WHEN status = 'running' THEN 1 END) AS running
    FROM submissions WHERE user_id = ?
  `).get(userId) as { used: number; pending: number; running: number };
  const grant = db.prepare("SELECT amount FROM check_quota_grants WHERE user_id = ? AND quota_date = date('now','localtime')").get(userId) as { amount: number } | undefined;
  const bonus = grant?.amount ?? 0;
  const limit = DAILY_CHECK_LIMIT + bonus;
  return { ...counts, bonus, limit, remaining: Math.max(0, limit - counts.used - counts.pending) };
}
