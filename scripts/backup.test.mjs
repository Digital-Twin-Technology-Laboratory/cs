import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import JSZip from 'jszip';

test('admin backup contains a restorable WAL snapshot, stored files and the encryption key', { timeout: 45000 }, async (t) => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const dataDir = mkdtempSync(path.join(root, '.tmp-backup-test-'));
  const reservation = http.createServer();
  reservation.listen(0, '127.0.0.1');
  await once(reservation, 'listening');
  const port = reservation.address().port;
  await new Promise((resolve) => reservation.close(resolve));
  const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', '--import', 'tsx', 'server/src/index.ts'], {
    cwd: root, env: { ...process.env, DATA_DIR: dataDir, HOST: '127.0.0.1', PORT: String(port) }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  let database;
  let restored;
  child.stdout.on('data', (chunk) => { output += chunk; });
  child.stderr.on('data', (chunk) => { output += chunk; });
  t.after(async () => {
    if (child.exitCode === null) { child.kill(); await once(child, 'exit'); }
    restored?.close();
    database?.close();
    assert.equal(path.dirname(dataDir), root);
    assert.match(path.basename(dataDir), /^\.tmp-backup-test-/);
    rmSync(dataDir, { recursive: true, force: true });
  });
  for (let i = 0; !output.includes('系统已启动'); i++) {
    assert.equal(child.exitCode, null, output);
    assert.ok(i < 100, output);
    await delay(50);
  }
  function client() {
    let cookie = '';
    return async (url, body) => {
      const response = await fetch(`http://127.0.0.1:${port}${url}`, {
        method: body === undefined ? 'GET' : 'POST',
        headers: { Cookie: cookie, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      if (response.headers.get('set-cookie')) cookie = response.headers.get('set-cookie').split(';')[0];
      const data = response.headers.get('content-type')?.includes('application/json')
        ? await response.json() : Buffer.from(await response.arrayBuffer());
      return { status: response.status, data, headers: response.headers };
    };
  }
  const endpoint = '/api/admin/backup';
  assert.equal((await client()(endpoint)).status, 401);
  const admin = client();
  assert.equal((await admin('/api/auth/register', { username: 'backup-root', name: 'Backup Admin', password: 'admin12345' })).status, 200);
  const created = await admin('/api/admin/users', { username: 'backup-teacher', name: 'Backup Teacher', password: 'teacher12345' });
  assert.equal(created.status, 200);
  const teacher = client();
  assert.equal((await teacher('/api/auth/login', { username: 'backup-teacher', password: 'teacher12345' })).status, 200);
  assert.equal((await teacher(endpoint)).status, 403);
  database = new DatabaseSync(path.join(dataDir, 'app.db'));
  database.exec('PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000; PRAGMA wal_autocheckpoint = 0;');
  database.prepare("UPDATE users SET college_role = 'teaching' WHERE id = ?").run(created.data.id);
  assert.equal((await teacher(endpoint)).status, 403);

  const original = Buffer.from('Original syllabus file content');
  const plan = Buffer.from('Original training plan file content');
  const uploadPath = `uploads/${created.data.id}/nested/syllabus.docx`;
  mkdirSync(path.dirname(path.join(dataDir, uploadPath)), { recursive: true });
  writeFileSync(path.join(dataDir, uploadPath), original);
  writeFileSync(path.join(dataDir, 'plans/plan.pdf'), plan);
  writeFileSync(path.join(dataDir, 'tmp/not-in-backup.txt'), 'Temporary upload');
  database.prepare("INSERT INTO settings (key, value) VALUES ('backup_fixture', ?)").run(JSON.stringify({ savedInWal: true }));
  const course = database.prepare(`INSERT INTO courses (user_id, name, major, training_type, student_grade)
    VALUES (?, 'Backup Course', 'Test Major', 'Test Type', 2025)`).run(created.data.id);
  const submission = database.prepare(`INSERT INTO submissions
    (course_id, user_id, seq, file_name, file_path, file_size, status, verdict, result_json, confirmed_at, confirmed_by)
    VALUES (?, ?, 1, 'syllabus.docx', ?, ?, 'done', 'passed', ?, '2026-11-12 10:00:00', 'Backup Teacher')`)
    .run(course.lastInsertRowid, created.data.id, uploadPath, original.length, JSON.stringify({ summary: 'Passed', issues: [] }));
  assert.ok(statSync(path.join(dataDir, 'app.db-wal')).size > 0);

  const response = await admin(endpoint);
  assert.equal(response.status, 200, response.data.toString());
  assert.match(response.headers.get('content-type'), /application\/zip/);
  assert.match(response.headers.get('content-disposition'), /attachment;.*teaching-backup-.*\.zip/);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  const zip = await JSZip.loadAsync(response.data, { checkCRC32: true });
  assert.deepEqual(Object.values(zip.files).filter((file) => !file.dir).map((file) => file.name).sort(),
    ['data/app.db', 'data/secret.key', `data/${uploadPath}`, 'data/plans/plan.pdf'].sort());
  assert.deepEqual(await zip.file(`data/${uploadPath}`).async('nodebuffer'), original);
  assert.deepEqual(await zip.file('data/plans/plan.pdf').async('nodebuffer'), plan);
  assert.deepEqual(await zip.file('data/secret.key').async('nodebuffer'), readFileSync(path.join(dataDir, 'secret.key')));
  writeFileSync(path.join(dataDir, 'restored.db'), await zip.file('data/app.db').async('nodebuffer'));
  restored = new DatabaseSync(path.join(dataDir, 'restored.db'));
  assert.equal(restored.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
  assert.deepEqual(restored.prepare('PRAGMA foreign_key_check').all(), []);
  assert.deepEqual(JSON.parse(restored.prepare("SELECT value FROM settings WHERE key = 'backup_fixture'").get().value), { savedInWal: true });
  const record = restored.prepare('SELECT * FROM submissions WHERE id = ?').get(submission.lastInsertRowid);
  assert.equal(record.file_path, uploadPath);
  assert.equal(record.verdict, 'passed');
  assert.equal(record.confirmed_by, 'Backup Teacher');
  assert.equal(record.confirmed_at, '2026-11-12 10:00:00');
  assert.equal(JSON.parse(record.result_json).summary, 'Passed');
  assert.equal(restored.prepare('SELECT username FROM users WHERE id = ?').get(created.data.id).username, 'backup-teacher');
  assert.deepEqual(readdirSync(path.join(dataDir, 'tmp')), ['not-in-backup.txt']);
  assert.equal(database.prepare("SELECT COUNT(*) AS n FROM audit_logs WHERE action = '下载数据备份'").get().n, 1);
  assert.equal((await admin('/api/admin/stats')).status, 200);
});
