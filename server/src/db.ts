import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { DATA_DIR } from './config.js';
import { SEED_INTRO, SEED_ITEMS, SEED_NAME, SEED_NOTES, SEED_RULES } from './seed/checklist.js';

const raw = new DatabaseSync(path.join(DATA_DIR, 'app.db'));
raw.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');

type Param = string | number | bigint | null | Uint8Array;
const norm = (args: unknown[]): Param[] =>
  args.map((a) => (a === undefined ? null : typeof a === 'boolean' ? (a ? 1 : 0) : (a as Param)));

/** node:sqlite 的轻量封装：参数中的 undefined/boolean 自动转换，提供事务 */
export const db = {
  exec: (sql: string) => raw.exec(sql),
  prepare(sql: string) {
    const st = raw.prepare(sql);
    return {
      run: (...a: unknown[]) => {
        const r = st.run(...norm(a));
        return { changes: Number(r.changes), lastInsertRowid: Number(r.lastInsertRowid) };
      },
      get: (...a: unknown[]) => st.get(...norm(a)) as unknown,
      all: (...a: unknown[]) => st.all(...norm(a)) as unknown[],
    };
  },
  transaction<T>(fn: () => T): () => T {
    return () => {
      raw.exec('BEGIN');
      try {
        const r = fn();
        raw.exec('COMMIT');
        return r;
      } catch (e) {
        raw.exec('ROLLBACK');
        throw e;
      }
    };
  },
};

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_hash TEXT NOT NULL,
  roster_login INTEGER NOT NULL DEFAULT 0,
  name TEXT NOT NULL DEFAULT '',
  department TEXT NOT NULL DEFAULT '',
  role TEXT NOT NULL DEFAULT 'user',          -- admin | user
  status TEXT NOT NULL DEFAULT 'active',      -- pending | active | disabled
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  last_login_at TEXT
);
CREATE TABLE IF NOT EXISTS sessions (
  sid TEXT PRIMARY KEY,
  sess TEXT NOT NULL,
  expires INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS checklist_versions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  intro TEXT NOT NULL DEFAULT '',
  notes TEXT NOT NULL DEFAULT '{}',
  rules TEXT NOT NULL DEFAULT '',
  is_active INTEGER NOT NULL DEFAULT 0,
  created_by INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
CREATE TABLE IF NOT EXISTS checklist_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  version_id INTEGER NOT NULL REFERENCES checklist_versions(id) ON DELETE CASCADE,
  code TEXT NOT NULL,
  section TEXT NOT NULL,
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  sort INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS training_plans (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  major TEXT NOT NULL,
  training_type TEXT NOT NULL,
  grade INTEGER NOT NULL DEFAULT 2025,
  name TEXT NOT NULL,
  file_name TEXT,
  file_path TEXT,
  extracted_text TEXT NOT NULL DEFAULT '',
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
CREATE TABLE IF NOT EXISTS courses (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  major TEXT NOT NULL,
  training_type TEXT NOT NULL,
  student_grade INTEGER NOT NULL,
  plan_grade INTEGER NOT NULL DEFAULT 2025,
  adjust_note TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
CREATE TABLE IF NOT EXISTS submissions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  course_id INTEGER NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  seq INTEGER NOT NULL,
  file_name TEXT NOT NULL,
  file_path TEXT NOT NULL,
  file_size INTEGER NOT NULL,
  extracted_text TEXT NOT NULL DEFAULT '',
  checklist_version_id INTEGER,
  plan_id INTEGER,
  plan_name TEXT,
  course_snapshot TEXT NOT NULL DEFAULT '{}',
  ai_model TEXT,
  status TEXT NOT NULL DEFAULT 'queued',      -- queued | running | done | failed
  error TEXT,
  verdict TEXT,                               -- passed | failed
  result_json TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  started_at TEXT,
  finished_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_sub_course ON submissions(course_id);
CREATE INDEX IF NOT EXISTS idx_sub_user ON submissions(user_id);
CREATE TABLE IF NOT EXISTS audit_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER,
  username TEXT,
  action TEXT NOT NULL,
  target TEXT,
  detail TEXT,
  ip TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
`);

const userColumns = db.prepare('PRAGMA table_info(users)').all() as { name: string }[];
if (!userColumns.some((column) => column.name === 'roster_login')) {
  db.exec('ALTER TABLE users ADD COLUMN roster_login INTEGER NOT NULL DEFAULT 0');
}

/** 首次启动写入初始检查清单 */
function seedChecklist() {
  const n = db.prepare('SELECT COUNT(*) AS n FROM checklist_versions').get() as { n: number };
  if (n.n > 0) return;
  const tx = db.transaction(() => {
    const r = db
      .prepare('INSERT INTO checklist_versions (name, intro, notes, rules, is_active) VALUES (?, ?, ?, ?, 1)')
      .run(SEED_NAME, SEED_INTRO, JSON.stringify(SEED_NOTES), SEED_RULES);
    const ins = db.prepare(
      'INSERT INTO checklist_items (version_id, code, section, title, content, sort) VALUES (?, ?, ?, ?, ?, ?)',
    );
    SEED_ITEMS.forEach((it, i) => ins.run(r.lastInsertRowid, it.code, it.section, it.title, it.content, i));
  });
  tx();
}
seedChecklist();

export function audit(
  user: { id: number; username: string } | null | undefined,
  action: string,
  target?: string,
  detail?: string,
  ip?: string,
) {
  db.prepare('INSERT INTO audit_logs (user_id, username, action, target, detail, ip) VALUES (?, ?, ?, ?, ?, ?)').run(
    user?.id ?? null,
    user?.username ?? null,
    action,
    target ?? null,
    detail ?? null,
    ip ?? null,
  );
}
