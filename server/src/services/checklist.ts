import { db } from '../db.js';
import type { Section } from '../seed/checklist.js';

export interface ChecklistItem {
  id: number;
  code: string;
  section: Section;
  title: string;
  content: string;
  sort: number;
}

export interface Checklist {
  id: number;
  name: string;
  intro: string;
  notes: Partial<Record<Section, { before?: string; after?: string }>>;
  rules: string;
  is_active: number;
  created_at: string;
  updated_at: string;
  items: ChecklistItem[];
}

export function activeChecklistId(): number | undefined {
  const r = db.prepare('SELECT id FROM checklist_versions WHERE is_active = 1 ORDER BY id DESC LIMIT 1').get() as
    | { id: number }
    | undefined;
  return r?.id;
}

/** 读取指定版本（缺省为当前生效版本） */
export function loadChecklist(id?: number): Checklist | null {
  const vid = id ?? activeChecklistId();
  if (!vid) return null;
  const v = db.prepare('SELECT * FROM checklist_versions WHERE id = ?').get(vid) as
    | (Omit<Checklist, 'notes' | 'items'> & { notes: string })
    | undefined;
  if (!v) return null;
  const items = db
    .prepare('SELECT id, code, section, title, content, sort FROM checklist_items WHERE version_id = ? ORDER BY sort, id')
    .all(vid) as ChecklistItem[];
  return { ...v, notes: JSON.parse(v.notes || '{}'), items };
}
