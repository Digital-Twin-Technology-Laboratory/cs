import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { DATA_DIR } from './config.js';
import { LEGACY_SEED_NAME, SEED_INTRO, SEED_ITEMS, SEED_NAME, SEED_NOTES, SEED_RULES, SYLLABUS_SCOPE_RULES, type SeedItem } from './seed/checklist.js';
import { COLLEGE_PRESETS, GROUP_PRESETS } from './services/supervisionRoles.js';

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
CREATE TABLE IF NOT EXISTS progress_roster (
  username TEXT PRIMARY KEY COLLATE NOCASE,
  name TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS progress_requirements (
  username TEXT NOT NULL COLLATE NOCASE REFERENCES progress_roster(username) ON DELETE CASCADE,
  course_name TEXT NOT NULL,
  course_group TEXT NOT NULL DEFAULT '',
  in_plan INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (username, course_name)
);
CREATE TABLE IF NOT EXISTS course_group_leaders (
  course_group TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS program_leader_scopes (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  professional TEXT NOT NULL,
  PRIMARY KEY (user_id, professional)
);
CREATE TABLE IF NOT EXISTS outline_requirements (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_key TEXT NOT NULL UNIQUE,
  course_name TEXT NOT NULL,
  course_group TEXT NOT NULL DEFAULT '',
  professional TEXT NOT NULL DEFAULT '',
  teacher_names TEXT NOT NULL DEFAULT '',
  writer_name TEXT NOT NULL DEFAULT '',
  writer_identifier TEXT NOT NULL DEFAULT '',
  writer_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  writer_manual INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS statistic_overrides (
  scope TEXT NOT NULL,
  name TEXT NOT NULL,
  value INTEGER NOT NULL,
  PRIMARY KEY (scope, name)
);
CREATE TABLE IF NOT EXISTS ai_profiles (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  settings_json TEXT NOT NULL,
  is_active INTEGER NOT NULL DEFAULT 0
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_ai_active ON ai_profiles(is_active) WHERE is_active = 1;
CREATE TABLE IF NOT EXISTS check_quota_grants (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  quota_date TEXT NOT NULL,
  amount INTEGER NOT NULL,
  PRIMARY KEY (user_id, quota_date)
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
  outline_requirement_id INTEGER REFERENCES outline_requirements(id) ON DELETE SET NULL,
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
  finished_at TEXT,
  confirmed_at TEXT
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

db.prepare(`
  INSERT INTO ai_profiles (name, settings_json, is_active)
  SELECT '默认配置', value, 1 FROM settings
  WHERE key = 'ai' AND NOT EXISTS (SELECT 1 FROM ai_profiles)
`).run();

db.prepare(`
  UPDATE settings
  SET value = json_set(value, '$.siteName', ?)
  WHERE key = 'site' AND json_extract(value, '$.siteName') = ?
`).run('教学材料检查系统', '本科教学大纲检查系统');

const userColumns = db.prepare('PRAGMA table_info(users)').all() as { name: string }[];
if (!userColumns.some((column) => column.name === 'roster_login')) {
  db.exec('ALTER TABLE users ADD COLUMN roster_login INTEGER NOT NULL DEFAULT 0');
}
if (!userColumns.some((column) => column.name === 'college_role')) {
  db.exec("ALTER TABLE users ADD COLUMN college_role TEXT NOT NULL DEFAULT 'none'");
}
if (!userColumns.some((column) => column.name === 'must_change_password')) {
  db.exec('ALTER TABLE users ADD COLUMN must_change_password INTEGER NOT NULL DEFAULT 0');
}
if (!userColumns.some((column) => column.name === 'supervision_manager')) {
  db.exec('ALTER TABLE users ADD COLUMN supervision_manager INTEGER NOT NULL DEFAULT 0');
}
if (!db.prepare("SELECT 1 FROM settings WHERE key = 'supervision_manager_initialized'").get()) {
  const tang = db.prepare("SELECT id FROM users WHERE name = '汤家华'").all() as { id: number }[];
  if (tang.length === 1) db.prepare("UPDATE users SET supervision_manager = 1, college_role = CASE WHEN college_role='none' THEN 'teaching' ELSE college_role END WHERE id = ?").run(tang[0].id);
  db.prepare("INSERT INTO settings (key, value) VALUES ('supervision_manager_initialized', '1')").run();
}

export function applyDefaultProfessionalView(userId: number, name: string) {
  const preset = COLLEGE_PRESETS.find((p) => p.name === name);
  if (!preset || preset.role !== 'program') return;
  const matches = db.prepare('SELECT id FROM users WHERE name = ?').all(name);
  if (matches.length !== 1) return;
  db.prepare("UPDATE users SET college_role = 'program' WHERE id = ? AND college_role = 'none'").run(userId);
}

if (!db.prepare("SELECT 1 FROM settings WHERE key = 'professional_views_initialized'").get()) {
  db.transaction(() => {
    for (const preset of COLLEGE_PRESETS) {
      if (preset.role !== 'program') continue;
      const matches = db.prepare('SELECT id FROM users WHERE name = ?').all(preset.name) as { id: number }[];
      if (matches.length === 1) applyDefaultProfessionalView(matches[0].id, preset.name);
    }
    db.prepare("INSERT INTO settings (key, value) VALUES ('professional_views_initialized', '1')").run();
  })();
}

export function applyDefaultGroupView(userId: number, name: string) {
  const preset = GROUP_PRESETS.find((p) => p.name === name);
  if (!preset) return;
  if (db.prepare('SELECT id FROM users WHERE name = ?').all(name).length !== 1) return;
  if (db.prepare('SELECT 1 FROM course_group_leaders WHERE user_id = ?').get(userId)) return;
  db.prepare('INSERT INTO course_group_leaders (course_group, user_id) VALUES (?, ?) ON CONFLICT(course_group) DO NOTHING').run(preset.group, userId);
}

if (!db.prepare("SELECT 1 FROM settings WHERE key = 'course_group_views_initialized'").get()) {
  db.transaction(() => {
    for (const preset of GROUP_PRESETS) {
      const matches = db.prepare('SELECT id FROM users WHERE name = ?').all(preset.name) as { id: number }[];
      if (matches.length === 1) applyDefaultGroupView(matches[0].id, preset.name);
    }
    db.prepare("INSERT INTO settings (key, value) VALUES ('course_group_views_initialized', '1')").run();
  })();
}

const submissionColumns = db.prepare('PRAGMA table_info(submissions)').all() as { name: string }[];
if (!submissionColumns.some((column) => column.name === 'outline_requirement_id')) {
  db.exec('ALTER TABLE submissions ADD COLUMN outline_requirement_id INTEGER REFERENCES outline_requirements(id) ON DELETE SET NULL');
}
db.exec('CREATE INDEX IF NOT EXISTS idx_sub_outline_requirement ON submissions(outline_requirement_id)');
if (!submissionColumns.some((column) => column.name === 'confirmed_at')) {
  db.exec('ALTER TABLE submissions ADD COLUMN confirmed_at TEXT');
}
if (!submissionColumns.some((column) => column.name === 'confirmed_by')) {
  db.exec("ALTER TABLE submissions ADD COLUMN confirmed_by TEXT NOT NULL DEFAULT ''");
}
if (!submissionColumns.some((column) => column.name === 'withdrawn_at')) {
  db.exec('ALTER TABLE submissions ADD COLUMN withdrawn_at TEXT');
}
if (!submissionColumns.some((column) => column.name === 'verdict_edited_at')) {
  db.exec('ALTER TABLE submissions ADD COLUMN verdict_edited_at TEXT');
}
if (!submissionColumns.some((column) => column.name === 'verdict_edited_by')) {
  db.exec("ALTER TABLE submissions ADD COLUMN verdict_edited_by TEXT NOT NULL DEFAULT ''");
}
if (!db.prepare("SELECT 1 FROM settings WHERE key = 'submission_sequences_initialized'").get()) {
  db.transaction(() => {
    db.exec(`
      WITH numbered AS (
        SELECT id, ROW_NUMBER() OVER (
          PARTITION BY user_id, outline_requirement_id,
            CASE WHEN outline_requirement_id IS NULL THEN json_extract(course_snapshot, '$.name') ELSE '' END COLLATE NOCASE,
            json_extract(course_snapshot, '$.major'), json_extract(course_snapshot, '$.trainingType'),
            json_extract(course_snapshot, '$.studentGrade')
          ORDER BY id
        ) AS sequence FROM submissions
      )
      UPDATE submissions SET seq = (SELECT sequence FROM numbered WHERE numbered.id = submissions.id)
    `);
    db.prepare("INSERT INTO settings (key, value) VALUES ('submission_sequences_initialized', '1')").run();
  })();
}

/** 首次写入默认清单；升级旧默认清单时另存版本，保留历史检查依据。 */
function seedChecklist() {
  const n = db.prepare('SELECT COUNT(*) AS n FROM checklist_versions').get() as { n: number };
  const legacy = db.prepare('SELECT id, notes, rules FROM checklist_versions WHERE name = ? AND is_active = 1 ORDER BY id DESC LIMIT 1')
    .get(LEGACY_SEED_NAME) as { id: number; notes: string; rules: string } | undefined;
  if (n.n > 0 && !legacy) return;
  const changedCodes = new Set(['C06', 'C07', 'C08', 'C09', 'C10', 'C11']);
  const items = legacy
    ? (db.prepare('SELECT code, section, title, content FROM checklist_items WHERE version_id = ? ORDER BY sort, id').all(legacy.id) as SeedItem[])
      .map((item) => changedCodes.has(item.code) ? SEED_ITEMS.find((replacement) => replacement.code === item.code)! : item)
    : SEED_ITEMS;
  const tx = db.transaction(() => {
    if (legacy) db.prepare('UPDATE checklist_versions SET is_active = 0 WHERE id = ?').run(legacy.id);
    const r = db
      .prepare('INSERT INTO checklist_versions (name, intro, notes, rules, is_active) VALUES (?, ?, ?, ?, 1)')
      .run(SEED_NAME, SEED_INTRO, legacy?.notes ?? JSON.stringify(SEED_NOTES),
        legacy ? `${legacy.rules.replace(/^- 材料不足：.*(?:\r?\n|$)/m, '')}\n${SYLLABUS_SCOPE_RULES}` : SEED_RULES);
    const ins = db.prepare(
      'INSERT INTO checklist_items (version_id, code, section, title, content, sort) VALUES (?, ?, ?, ?, ?, ?)',
    );
    items.forEach((it, i) => ins.run(r.lastInsertRowid, it.code, it.section, it.title, it.content, i));
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
