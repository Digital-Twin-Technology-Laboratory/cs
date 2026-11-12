import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { Document, Packer, Paragraph } from 'docx';
import JSZip from 'jszip';

test('attachment filters and batch downloads respect the same scope as individual records', { timeout: 45000 }, async (t) => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const dataDir = mkdtempSync(path.join(root, '.tmp-attachment-test-'));
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
  child.stdout.on('data', (chunk) => { output += chunk; });
  child.stderr.on('data', (chunk) => { output += chunk; });
  t.after(async () => {
    if (child.exitCode === null) { child.kill(); await once(child, 'exit'); }
    database?.close();
    assert.equal(path.dirname(dataDir), root);
    assert.match(path.basename(dataDir), /^\.tmp-attachment-test-/);
    rmSync(dataDir, { recursive: true, force: true });
  });
  for (let i = 0; !output.includes('系统已启动'); i++) {
    assert.equal(child.exitCode, null, output);
    assert.ok(i < 100, output);
    await delay(50);
  }
  function client() {
    let cookie = '';
    return async (url, body, method = body === undefined ? 'GET' : 'POST') => {
      const response = await fetch(`http://127.0.0.1:${port}${url}`, {
        method, headers: { Cookie: cookie, ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      if (response.headers.get('set-cookie')) cookie = response.headers.get('set-cookie').split(';')[0];
      const data = response.headers.get('content-type')?.includes('application/json') ? await response.json() : Buffer.from(await response.arrayBuffer());
      return { status: response.status, data, headers: response.headers };
    };
  }
  const admin = client();
  const registered = await admin('/api/auth/register', { username: 'attachment-root', name: 'Root', password: 'admin12345' });
  assert.equal(registered.status, 200);
  const users = {};
  for (const username of ['alice', 'bob', 'leader', 'head', 'teaching']) {
    const created = await admin('/api/admin/users', { username, name: username, password: 'teacher12345' });
    assert.equal(created.status, 200);
    const request = client();
    assert.equal((await request('/api/auth/login', { username, password: 'teacher12345' })).status, 200);
    users[username] = { id: created.data.id, request };
  }
  database = new DatabaseSync(path.join(dataDir, 'app.db'));
  database.exec('PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  const [groupA, groupB] = (await admin('/api/supervision-management')).data.groups;
  const cs = '计算机科学与技术', ai = '人工智能';
  const configure = (username, patch) => admin(`/api/supervision-management/users/${users[username].id}`, {
    college_role: 'none', led_groups: [], program_scopes: [], ...patch,
  }, 'PUT');
  assert.equal((await configure('leader', { led_groups: [groupA] })).status, 200);
  assert.equal((await configure('head', { college_role: 'program', program_scopes: [cs] })).status, 200);
  assert.equal((await configure('teaching', { college_role: 'teaching' })).status, 200);
  const original = await Packer.toBuffer(new Document({ sections: [{ children: [new Paragraph('Attachment original content')] }] }));
  mkdirSync(path.join(dataDir, 'uploads'), { recursive: true });
  writeFileSync(path.join(dataDir, 'uploads', 'fixture.docx'), original);
  const requirement = (name, major, group) => Number(database.prepare('INSERT INTO outline_requirements (source_key, course_name, professional, course_group) VALUES (?, ?, ?, ?)')
    .run(JSON.stringify([name, major, group]), name, major, group).lastInsertRowid);
  const taskA = requirement('附件课程', cs, groupA);
  const taskB = requirement('另一课程', ai, groupB);
  requirement('旧版附件', cs, groupA);
  function seed(userId, name, major, task, grade = 2025, verdict = 'passed', date = '2026-11-11 10:00:00', status = 'done') {
    const course = Number(database.prepare('INSERT INTO courses (user_id, name, major, training_type, student_grade, plan_grade) VALUES (?, ?, ?, ?, ?, ?)')
      .run(userId, name, major, '普通本科', grade, 2025).lastInsertRowid);
    const snapshot = { name, major, trainingType: '普通本科', studentGrade: grade, planGrade: 2025, adjustNote: '' };
    const result = { summary: 'Attachment check result', itemResults: [], issues: [], toVerify: [] };
    return Number(database.prepare(`INSERT INTO submissions (course_id, user_id, seq, file_name, file_path, file_size, extracted_text,
      course_snapshot, outline_requirement_id, status, verdict, result_json, created_at, finished_at)
      VALUES (?, ?, 1, 'same.docx', 'uploads/fixture.docx', ?, 'Original text', ?, ?, ?, ?, ?, ?, ?)`)
      .run(course, userId, original.length, JSON.stringify(snapshot), task, status, verdict, status === 'done' ? JSON.stringify(result) : null, date, date).lastInsertRowid);
  }
  const own = seed(users.alice.id, '附件课程', cs, taskA);
  const old = seed(users.alice.id, '附件课程', cs, taskA, 2025, 'failed', '2026-11-10 10:00:00');
  database.prepare("UPDATE submissions SET confirmed_at = '2026-11-10 11:00:00' WHERE id = ?").run(old);
  const other = seed(users.bob.id, '另一课程', ai, taskB, 2024);
  const outside = seed(users.bob.id, '名单外', ai, null, 2026);
  const legacy = seed(users.alice.id, '旧版附件', cs, null);
  const failed = seed(users.alice.id, '附件课程', cs, taskA, 2025, null, '2026-11-12 10:00:00', 'failed');
  const { request: alice } = users.alice, { request: leader } = users.leader, { request: head } = users.head, { request: teaching } = users.teaching;
  const endpoint = '/api/submissions/batch-download';
  await t.test('exact filters, combined filters, pagination and legacy course-group matching', async () => {
    for (const [request, route] of [[admin, '/api/admin/submissions?'], [teaching, '/api/submissions?scope=college&']]) {
      const result = await request(`${route}${new URLSearchParams({ major: cs, studentGrade: '2025', courseGroup: groupA, status: 'done', verdict: 'passed', confirmation: 'pending', from: '2026-11-11', to: '2026-11-11', pageSize: '1' })}`);
      assert.equal(result.status, 200);
      assert.equal(result.data.total, 2);
      assert.deepEqual(result.data.rows.map((r) => r.id), [legacy]);
      const page2 = await request(`${route}${new URLSearchParams({ major: cs, studentGrade: '2025', courseGroup: groupA, status: 'done', verdict: 'passed', confirmation: 'pending', from: '2026-11-11', to: '2026-11-11', pageSize: '1', page: '2' })}`);
      assert.deepEqual(page2.data.rows.map((r) => r.id), [own]);
      assert.equal((await request(`${route}studentGrade=2023`)).data.total, 0);
      assert.deepEqual((await request(`${route}confirmation=confirmed`)).data.rows.map((r) => r.id), [old]);
    }
    assert.deepEqual((await alice(`/api/submissions?major=${encodeURIComponent(ai)}`)).data.rows, []);
    assert.equal((await alice('/api/submissions?scope=college')).status, 403);
  });
  await t.test('ZIP content preserves duplicate names and Word reports; all role boundaries are enforced', async () => {
    for (const request of [admin, teaching, leader, head, alice]) {
      const response = await request(endpoint, { ids: [own, old, own], kind: 'files' });
      assert.equal(response.status, 200);
      assert.match(response.headers.get('content-type'), /application\/zip/);
      const zip = await JSZip.loadAsync(response.data);
      assert.deepEqual(Object.keys(zip.files).sort(), [`${own}-same.docx`, `${old}-same.docx`].sort());
      assert.deepEqual(await zip.file(`${own}-same.docx`).async('nodebuffer'), original);
      const reports = await request(endpoint, { ids: [own, old], kind: 'reports' });
      assert.equal(reports.status, 200);
      const archive = await JSZip.loadAsync(reports.data);
      assert.equal(Object.keys(archive.files).length, 2);
      const word = await JSZip.loadAsync(await archive.file(Object.keys(archive.files)[0]).async('nodebuffer'));
      assert.match(await word.file('word/document.xml').async('string'), /《附件课程》教学大纲检查结果/);
    }
    for (const request of [leader, head, alice]) {
      assert.equal((await request(endpoint, { ids: [own, other], kind: 'files' })).status, 404);
      assert.equal((await request(endpoint, { ids: [outside], kind: 'reports' })).status, 404);
    }
    for (const request of [admin, teaching]) {
      assert.equal((await request(endpoint, { ids: [outside, other], kind: 'files' })).status, 200);
    }
    assert.equal((await client()(endpoint, { ids: [own], kind: 'files' })).status, 401);
    assert.equal((await admin(endpoint, { ids: [999999], kind: 'files' })).status, 404);
    assert.equal((await admin(endpoint, { ids: [], kind: 'files' })).status, 400);
    assert.equal((await admin(endpoint, { ids: Array(101).fill(own), kind: 'files' })).status, 400);
    assert.equal((await admin(endpoint, { ids: [own], kind: 'unknown' })).status, 400);
    assert.equal((await admin(endpoint, { ids: [own, failed], kind: 'reports' })).status, 400);
    assert.equal((await admin(endpoint, { ids: [failed], kind: 'files' })).status, 200);
    assert.equal((await configure('leader', {})).status, 200);
    assert.equal((await leader(endpoint, { ids: [own], kind: 'files' })).status, 404);
    assert.equal((await configure('head', {})).status, 200);
    assert.equal((await head(endpoint, { ids: [own], kind: 'files' })).status, 404);
    database.prepare("UPDATE submissions SET file_path = 'uploads/missing.docx' WHERE id = ?").run(old);
    assert.equal((await admin(endpoint, { ids: [own, old], kind: 'files' })).status, 404);
  });
});
