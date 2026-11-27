import { Router } from 'express';
import { z } from 'zod';
import { requireAuth } from '../auth.js';
import { audit } from '../db.js';
import { canManageHistory } from '../services/materialHistory.js';
import {
  deleteImportedSource,
  getPersonIssueDossier,
  listArchivePeople,
  listImportedSources,
} from '../services/issueArchive.js';

export const issueArchiveRouter = Router();
issueArchiveRouter.use(requireAuth);

issueArchiveRouter.get('/people', (req, res) => {
  const { q, source, onlyWithIssues } = z.object({
    q: z.string().trim().max(120).optional(),
    source: z.enum(['all', 'outline', 'history', 'material']).default('all'),
    onlyWithIssues: z.enum(['0', '1']).optional(),
  }).parse(req.query);
  res.setHeader('Cache-Control', 'private, no-store');
  res.json(listArchivePeople(req.user!, { q, source, onlyWithIssues: onlyWithIssues === '1' }));
});

issueArchiveRouter.get('/people/:personKey', (req, res) => {
  const personKey = z.string().trim().min(1).max(160).parse(req.params.personKey);
  const dossier = getPersonIssueDossier(req.user!, personKey);
  if (!dossier) return res.status(404).json({ error: '未找到该人员的问题记录或无权查看' });
  res.setHeader('Cache-Control', 'private, no-store');
  res.json(dossier);
});

issueArchiveRouter.get('/imports', (req, res) => {
  if (!canManageHistory(req.user!)) return res.status(403).json({ error: '仅教学条线或管理员可查看导入来源' });
  res.setHeader('Cache-Control', 'private, no-store');
  res.json({ sources: listImportedSources() });
});

issueArchiveRouter.delete('/imports', (req, res) => {
  if (!canManageHistory(req.user!)) return res.status(403).json({ error: '仅教学条线或管理员可删除导入批次' });
  const { source } = z.object({ source: z.string().trim().min(1).max(300) }).parse(req.body);
  const removed = deleteImportedSource(source);
  if (!removed) return res.status(404).json({ error: '未找到该来源的历史问题记录' });
  audit(req.user, '删除历史问题导入批次', source, `删除 ${removed} 条记录`, req.ip);
  res.json({ removed });
});
