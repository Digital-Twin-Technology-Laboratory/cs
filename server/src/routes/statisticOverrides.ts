import { Router } from 'express';
import { z } from 'zod';
import { requireAdmin, requireAuth } from '../auth.js';
import { audit, db } from '../db.js';
import { availableViews, scopeOutlineRows } from '../services/outlineProgress.js';

export const statisticOverridesRouter = Router();
statisticOverridesRouter.use(requireAuth);

statisticOverridesRouter.get('/', (req, res) => {
  const user = req.user!;
  const scopes = new Set([`personal:${user.id}`]);
  for (const view of availableViews(user)) {
    scopes.add(view === 'college' ? 'college' : `${view}:${user.id}`);
    if (view !== 'college') continue;
    for (const row of scopeOutlineRows(user, view)) {
      scopes.add(row.user_id !== null ? `personal:${row.user_id}` : `person:${JSON.stringify([row.username, row.writer_name])}`);
    }
  }
  const rows = db.prepare(`SELECT scope, name, value FROM statistic_overrides WHERE scope IN (${[...scopes].map(() => '?').join(',')})`).all(...scopes);
  res.json({ rows });
});

statisticOverridesRouter.put('/', requireAdmin, (req, res) => {
  const { scope, name, value } = z.object({
    scope: z.string().min(1).max(300),
    name: z.string().min(1).max(1000),
    value: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).nullable(),
  }).parse(req.body);
  db.transaction(() => {
    const before = db.prepare('SELECT value FROM statistic_overrides WHERE scope = ? AND name = ?').get(scope, name);
    if (value === null) db.prepare('DELETE FROM statistic_overrides WHERE scope = ? AND name = ?').run(scope, name);
    else db.prepare(`INSERT INTO statistic_overrides (scope, name, value) VALUES (?, ?, ?)
      ON CONFLICT(scope, name) DO UPDATE SET value = excluded.value`).run(scope, name, value);
    audit(req.user, '修改统计数字', `${scope}/${name}`, JSON.stringify({ before: before ?? null, after: value }), req.ip);
  })();
  res.json({ ok: true });
});
