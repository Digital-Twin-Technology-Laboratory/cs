// Run: node --disable-warning=ExperimentalWarning --import tsx --test scripts/syllabus-scope.test.mjs
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { LEGACY_SEED_NAME, MATERIALS_REMINDER, SEED_INTRO, SEED_ITEMS, SEED_NAME, SEED_NOTES, SEED_RULES } from '../server/src/seed/checklist.ts';
import { buildUserPrompt } from '../server/src/services/ai/prompt.ts';
import { AI_RESULT_NOTICE, reportText } from '../server/src/services/report.ts';
import * as webNotices from '../web/src/checkNotices.ts';

test('syllabus scope retains internal checks and plan comparison, with cross-material checks only a reminder', () => {
  const reminder = SEED_ITEMS.find((item) => item.code === 'C11');
  assert.equal(reminder.section, 'suggest');
  assert.equal(reminder.content, MATERIALS_REMINDER);
  assert.doesNotMatch(SEED_ITEMS.find((item) => item.code === 'C06').content, /教学进度表|实验计划|实验报告/);
  assert.match(SEED_ITEMS.find((item) => item.code === 'C09').content, /可执行的评分要点/);
  const text = buildUserPrompt({
    checklist: { name: SEED_NAME, intro: SEED_INTRO, notes: SEED_NOTES, rules: SEED_RULES, items: SEED_ITEMS },
    course: { name: '测试课程', major: '人工智能', trainingType: '普通本科', studentGrade: 2024, planGrade: 2025, adjustNote: '' },
    plan: { name: '2025人工智能培养方案', text: '课程支撑矩阵' },
    syllabus: { fileName: '大纲.docx', text: '课程目标与考核比例' },
  });
  assert.match(text, /不因未提供这些材料判定存在问题，也不将其列入 toVerify 或要求补交/);
  assert.match(text, /跨材料条目在 itemResults 中记为“不适用”/);
  assert.match(text, /2025人工智能培养方案/);
  const report = reportText({
    course: { name: '测试课程', major: '人工智能', trainingType: '普通本科', studentGrade: 2024, planGrade: 2025, adjustNote: '' },
    planName: null, seq: 1, checkedAt: '2026-11-13', verdict: 'passed',
    result: { summary: '', itemResults: [], issues: [], toVerify: [] },
  });
  assert.ok(report.indexOf(AI_RESULT_NOTICE) < report.indexOf('检查对象：'));
  assert.ok(report.indexOf(MATERIALS_REMINDER) > report.indexOf('二 建议完善项'));
  assert.match(report, /检查结论：检查通过/);
  assert.equal(webNotices.AI_RESULT_NOTICE, AI_RESULT_NOTICE);
  assert.equal(webNotices.MATERIALS_REMINDER, MATERIALS_REMINDER);
});

test('upgrading the active legacy default forks a version, preserves historical records and custom items, and is idempotent', () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const dataDir = mkdtempSync(path.join(root, '.tmp-syllabus-scope-'));
  const initialize = () => {
    const child = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', '--import', 'tsx', '--input-type=module', '-e', "await import('./server/src/db.ts')"], {
      cwd: root, env: { ...process.env, DATA_DIR: dataDir }, encoding: 'utf8', timeout: 10000,
    });
    assert.equal(child.status, 0, child.stderr);
  };
  let database;
  try {
    initialize();
    database = new DatabaseSync(path.join(dataDir, 'app.db'));
    const oldId = database.prepare('SELECT id FROM checklist_versions WHERE is_active = 1').get().id;
    database.prepare('UPDATE checklist_versions SET name = ?, rules = ?, notes = ? WHERE id = ?')
      .run(LEGACY_SEED_NAME, '- 材料不足：未提供实验记录，应先记录待核实。\n自定义规则保留。', '{"main":{"before":"自定义说明保留"}}', oldId);
    database.prepare("UPDATE checklist_items SET section = 'main', title = '跨材料一致性', content = '核对大纲、教案、进度表和成绩记录。' WHERE version_id = ? AND code = 'C11'").run(oldId);
    database.prepare("UPDATE checklist_items SET content = '教学进度表应标注实验项目。' WHERE version_id = ? AND code = 'C06'").run(oldId);
    database.prepare("INSERT INTO checklist_items (version_id, code, section, title, content, sort) VALUES (?, 'S09', 'suggest', '自定义条目', '保留这一内容', 99)").run(oldId);
    const userId = Number(database.prepare("INSERT INTO users (username, password_hash) VALUES ('history', 'unused')").run().lastInsertRowid);
    const courseId = Number(database.prepare("INSERT INTO courses (user_id, name, major, training_type, student_grade) VALUES (?, '历史课程', '人工智能', '普通本科', 2024)").run(userId).lastInsertRowid);
    const submissionId = Number(database.prepare("INSERT INTO submissions (course_id, user_id, seq, file_name, file_path, file_size, checklist_version_id, status, result_json) VALUES (?, ?, 1, '历史.docx', 'unused.docx', 1, ?, 'done', '{}')").run(courseId, userId, oldId).lastInsertRowid);
    const oldItems = database.prepare('SELECT * FROM checklist_items WHERE version_id = ? ORDER BY id').all(oldId);
    const oldVersion = database.prepare('SELECT * FROM checklist_versions WHERE id = ?').get(oldId);
    const oldSubmission = database.prepare('SELECT * FROM submissions WHERE id = ?').get(submissionId);
    database.close();
    database = undefined;
    initialize();
    database = new DatabaseSync(path.join(dataDir, 'app.db'));
    const current = database.prepare('SELECT * FROM checklist_versions WHERE is_active = 1').get();
    assert.notEqual(current.id, oldId);
    assert.equal(current.name, SEED_NAME);
    assert.match(current.rules, /自定义规则保留/);
    assert.doesNotMatch(current.rules, /材料不足：未提供实验记录/);
    assert.equal(current.notes, oldVersion.notes);
    assert.deepEqual({ ...database.prepare('SELECT * FROM checklist_versions WHERE id = ?').get(oldId) }, { ...oldVersion, is_active: 0 });
    assert.deepEqual(database.prepare('SELECT * FROM checklist_items WHERE version_id = ? ORDER BY id').all(oldId), oldItems);
    assert.deepEqual(database.prepare('SELECT * FROM submissions WHERE id = ?').get(submissionId), oldSubmission);
    assert.equal(database.prepare("SELECT section FROM checklist_items WHERE version_id = ? AND code = 'C11'").get(current.id).section, 'suggest');
    assert.equal(database.prepare("SELECT content FROM checklist_items WHERE version_id = ? AND code = 'S09'").get(current.id).content, '保留这一内容');
    database.close();
    database = undefined;
    initialize();
    database = new DatabaseSync(path.join(dataDir, 'app.db'));
    assert.equal(database.prepare('SELECT COUNT(*) AS n FROM checklist_versions').get().n, 2);
    database.prepare("UPDATE checklist_versions SET name = '自定义清单' WHERE id = ?").run(current.id);
    database.close();
    database = undefined;
    initialize();
    database = new DatabaseSync(path.join(dataDir, 'app.db'));
    assert.equal(database.prepare('SELECT COUNT(*) AS n FROM checklist_versions').get().n, 2);
    assert.equal(database.prepare('SELECT id FROM checklist_versions WHERE is_active = 1').get().id, current.id);
  } finally {
    database?.close();
    assert.equal(path.dirname(dataDir), root);
    assert.match(path.basename(dataDir), /^\.tmp-syllabus-scope-/);
    rmSync(dataDir, { recursive: true, force: true });
  }
});
