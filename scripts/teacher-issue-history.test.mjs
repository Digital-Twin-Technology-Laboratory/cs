import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

test('teacher issue history preserves findings and enforces teaching-only access', { timeout: 45000 }, async (t) => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const dataDir = mkdtempSync(path.join(root, '.tmp-teacher-history-test-'));
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
    assert.match(path.basename(dataDir), /^\.tmp-teacher-history-test-/);
    rmSync(dataDir, { recursive: true, force: true });
  });
  for (let i = 0; !output.includes('\u7cfb\u7edf\u5df2\u542f\u52a8'); i++) {
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
      return { status: response.status, data: await response.json() };
    };
  }
  const admin = client();
  assert.equal((await admin('/api/auth/register', { username: 'history-root', name: 'Root', password: 'admin12345' })).status, 200);
  const users = {};
  for (const username of ['alice', 'bob', 'empty', 'leader', 'head', 'manager', 'teaching']) {
    const created = await admin('/api/admin/users', {
      username, name: ['alice', 'bob'].includes(username) ? 'Same teacher' : username, password: 'teacher12345',
    });
    assert.equal(created.status, 200);
    const request = client();
    assert.equal((await request('/api/auth/login', { username, password: 'teacher12345' })).status, 200);
    users[username] = { id: created.data.id, request };
  }
  database = new DatabaseSync(path.join(dataDir, 'app.db'));
  database.exec('PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  const { groups, programs } = (await admin('/api/supervision-management')).data;
  const configure = (username, patch) => admin(`/api/supervision-management/users/${users[username].id}`, {
    college_role: 'none', led_groups: [], program_scopes: [], ...patch,
  }, 'PUT');
  assert.equal((await configure('leader', { led_groups: [groups[0]] })).status, 200);
  assert.equal((await configure('head', { college_role: 'program', program_scopes: [programs[0]] })).status, 200);
  assert.equal((await configure('manager', { supervision_manager: 1 })).status, 200);
  assert.equal((await configure('teaching', { college_role: 'teaching' })).status, 200);

  const severe = {
    summary: 'Historical finding', itemResults: [], toVerify: [],
    issues: [{ nature: '\u91cd\u5927\u95ee\u9898', itemCodes: ['A01'], title: 'Assessment mismatch', location: 'Section 3', problem: 'Weights total 120%', advice: 'Correct the weights', evidence: '60% + 60%' }],
  };
  const suggestion = { ...severe, issues: [{ ...severe.issues[0], nature: '\u5efa\u8bae\u4fee\u6539', title: 'Clarify wording' }] };
  const verification = { summary: 'Verification needed', itemResults: [], issues: [], toVerify: [{ itemCodes: ['A02'], location: 'Section 2', content: 'Verify the programme mapping' }] };
  const clean = { summary: 'No findings', itemResults: [], issues: [], toVerify: [] };
  const courseIds = new Map();
  function seed(username, result, status = 'done', verdict = 'failed') {
    const userId = users[username].id;
    if (!courseIds.has(userId)) {
      const courseId = Number(database.prepare('INSERT INTO courses (user_id, name, major, training_type, student_grade, plan_grade) VALUES (?, ?, ?, ?, 2025, 2025)')
        .run(userId, 'Current course title', programs[0], 'regular').lastInsertRowid);
      courseIds.set(userId, courseId);
    }
    const snapshot = { name: 'Historical course title', major: programs[0], trainingType: 'regular', studentGrade: 2025, planGrade: 2025, adjustNote: '' };
    return Number(database.prepare(`INSERT INTO submissions (course_id, user_id, seq, file_name, file_path, file_size,
      course_snapshot, status, verdict, result_json, created_at, finished_at)
      VALUES (?, ?, 1, 'history.docx', 'uploads/history.docx', 100, ?, ?, ?, ?, '2026-11-01 10:00:00', '2026-11-01 10:01:00')`)
      .run(courseIds.get(userId), userId, JSON.stringify(snapshot), status, verdict, result === null ? null : JSON.stringify(result)).lastInsertRowid);
  }
  const old = seed('alice', severe);
  database.prepare("UPDATE submissions SET withdrawn_at = '2026-11-02 12:00:00' WHERE id = ?").run(old);
  const edited = seed('alice', suggestion, 'done', 'passed');
  database.prepare("UPDATE submissions SET verdict_edited_at = '2026-11-02 11:00:00', verdict_edited_by = 'Root' WHERE id = ?").run(edited);
  const other = seed('bob', severe);
  const verify = seed('alice', verification);
  seed('alice', clean, 'done', 'passed');
  seed('alice', severe, 'failed', null);
  seed('alice', null, 'queued', null);
  seed('alice', null, 'running', null);
  const current = seed('alice', severe);
  const later = seed('alice', severe);
  seed('empty', clean, 'done', 'passed');
  const endpoint = '/api/supervision/issue-history';
  const teachersEndpoint = `${endpoint}/teachers`;
  const history = `${endpoint}?teacherId=${users.alice.id}`;

  await t.test('only administrators and teaching staff can access either endpoint', async () => {
    for (const url of [teachersEndpoint, history]) {
      assert.equal((await client()(url)).status, 401);
      for (const username of ['alice', 'leader', 'head', 'manager']) {
        assert.equal((await users[username].request(url)).status, 403, username);
      }
    }
  });

  await t.test('teacher IDs isolate duplicate names and historical findings survive verdict edits and withdrawal', async () => {
    for (const request of [admin, users.teaching.request]) {
      const listed = await request(teachersEndpoint);
      assert.equal(listed.status, 200);
      assert.deepEqual(listed.data.teachers.map((teacher) => teacher.id).sort((a, b) => a - b), [users.alice.id, users.bob.id, users.empty.id].sort((a, b) => a - b));
      const namesakes = listed.data.teachers.filter((teacher) => teacher.name === 'Same teacher');
      assert.equal(namesakes.length, 2);
      assert.deepEqual(namesakes.map((teacher) => teacher.username).sort(), ['alice', 'bob']);
      const response = await request(history);
      assert.equal(response.status, 200);
      assert.equal(response.data.teacher.id, users.alice.id);
      assert.equal(response.data.teacher.username, 'alice');
      assert.equal(response.data.total, 5);
      assert.deepEqual(response.data.rows.map((row) => row.id), [later, current, verify, edited, old]);
      assert.deepEqual(response.data.rows.at(-1).result, severe);
      assert.equal(response.data.rows.at(-1).course.name, 'Historical course title');
      assert.deepEqual(response.data.rows.find((row) => row.id === verify).result.toVerify, verification.toVerify);
      const manuallyPassed = response.data.rows.find((row) => row.id === edited);
      assert.equal(manuallyPassed.verdict, 'passed');
      assert.equal(manuallyPassed.verdict_edited_by, 'Root');
      assert.equal(manuallyPassed.verdict_edited_at, '2026-11-02 11:00:00');
      assert.deepEqual(manuallyPassed.result.issues, suggestion.issues);
      const bob = await request(`${endpoint}?teacherId=${users.bob.id}`);
      assert.deepEqual(bob.data.rows.map((row) => row.id), [other]);
    }
  });

  await t.test('pagination and beforeId show only earlier problem records, including verification and suggestions', async () => {
    const earlier = await admin(`${history}&beforeId=${current}`);
    assert.equal(earlier.status, 200);
    assert.equal(earlier.data.total, 3);
    assert.deepEqual(earlier.data.rows.map((row) => row.id), [verify, edited, old]);
    const first = await admin(`${history}&beforeId=${current}&page=1&pageSize=1`);
    assert.equal(first.data.total, 3);
    assert.deepEqual(first.data.rows.map((row) => row.id), [verify]);
    const second = await admin(`${history}&beforeId=${current}&page=2&pageSize=1`);
    assert.deepEqual(second.data.rows.map((row) => row.id), [edited]);
    const emptyPage = await admin(`${history}&beforeId=${current}&page=4&pageSize=1`);
    assert.equal(emptyPage.data.total, 3);
    assert.deepEqual(emptyPage.data.rows, []);
    for (const url of [`${history}&beforeId=${old}`, `${endpoint}?teacherId=${users.empty.id}`]) {
      const response = await admin(url);
      assert.equal(response.status, 200);
      assert.equal(response.data.total, 0);
      assert.deepEqual(response.data.rows, []);
    }
  });

  await t.test('invalid input and unrelated anchors are rejected', async () => {
    for (const query of ['', '?teacherId=0', '?teacherId=abc', `?teacherId=${users.alice.id}&beforeId=0`, `?teacherId=${users.alice.id}&page=0`, `?teacherId=${users.alice.id}&pageSize=0`, `?teacherId=${users.alice.id}&pageSize=51`]) {
      assert.equal((await admin(`${endpoint}${query}`)).status, 400, query);
    }
    assert.equal((await admin(`${endpoint}?teacherId=999999`)).status, 404);
    assert.equal((await admin(`${history}&beforeId=999999`)).status, 404);
    assert.equal((await admin(`${history}&beforeId=${other}`)).status, 404);
  });

  await t.test('revoking teaching access applies to an existing session immediately', async () => {
    assert.equal((await configure('teaching', {})).status, 200);
    assert.equal((await users.teaching.request(teachersEndpoint)).status, 403);
    assert.equal((await users.teaching.request(history)).status, 403);
  });
});
