// Run: node --disable-warning=ExperimentalWarning --import tsx --test scripts/outline-progress.test.mjs
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

test('outline writers, scoped supervision and manual mappings use the course source only', { timeout: 30000 }, async (t) => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const dataDir = mkdtempSync(path.join(root, '.tmp-outline-progress-'));
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
    if (child.exitCode === null) {
      child.kill();
      await once(child, 'exit');
    }
    database?.close();
    assert.equal(path.dirname(dataDir), root);
    assert.match(path.basename(dataDir), /^\.tmp-outline-progress-/);
    rmSync(dataDir, { recursive: true, force: true });
  });
  for (let i = 0; !output.includes('系统已启动'); i++) {
    assert.equal(child.exitCode, null, output);
    assert.ok(i < 100, output);
    await delay(50);
  }
  database = new DatabaseSync(path.join(dataDir, 'app.db'));
  database.exec('PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  function client() {
    let cookie = '';
    return async (url, body, method = body === undefined ? 'GET' : 'POST') => {
      const form = body instanceof FormData;
      const response = await fetch(`http://127.0.0.1:${port}${url}`, {
        method, headers: { Cookie: cookie, ...(!form && body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
        body: body === undefined ? undefined : form ? body : JSON.stringify(body),
      });
      if (response.headers.get('set-cookie')) cookie = response.headers.get('set-cookie').split(';')[0];
      const data = response.headers.get('content-type')?.includes('application/json') ? await response.json() : Buffer.from(await response.arrayBuffer());
      return { status: response.status, data };
    };
  }
  const admin = client();
  assert.equal((await admin('/api/auth/register', { username: 'root', name: 'Root', password: 'admin12345' })).status, 200);
  const users = {};
  for (const [username, name] of [
    ['alice', '执笔人甲'], ['bob', '执笔人乙'], ['leader', '课程组长甲'], ['other-leader', '课程组长乙'],
    ['head', '龚兰兰'], ['empty-head', '未配专业负责人'], ['dual', '兼任监督者'], ['tang', '汤家华'],
  ]) {
    const created = await admin('/api/admin/users', { username, name, password: 'temporary12345' });
    assert.equal(created.status, 200);
    const request = client();
    assert.equal((await request('/api/auth/login', { username, password: 'temporary12345' })).status, 200);
    assert.equal((await request('/api/auth/password', { oldPassword: 'temporary12345', newPassword: 'permanent12345' }, 'PUT')).status, 200);
    users[username] = { id: created.data.id, request };
  }
  const { request: alice, id: aliceId } = users.alice;
  const { request: bob, id: bobId } = users.bob;
  const { request: leader } = users.leader;
  const { request: otherLeader } = users['other-leader'];
  const { request: head } = users.head;
  const { request: emptyHead } = users['empty-head'];
  const { request: dual } = users.dual;
  const { request: tang } = users.tang;
  const settings = (await admin('/api/supervision-management')).data;
  const [groupA, groupB] = settings.groups;
  const cs = '计算机科学与技术', ai = '人工智能', iot = '物联网工程';
  const configure = (request, username, patch) => request(`/api/supervision-management/users/${users[username].id}`, {
    college_role: 'none', led_groups: [], program_scopes: [], ...patch,
  }, 'PUT');
  assert.equal((await configure(admin, 'tang', { college_role: 'teaching', supervision_manager: 1 })).status, 200);
  assert.equal((await tang('/api/supervision-management')).status, 200);
  assert.equal((await tang('/api/admin/users')).status, 403);
  assert.equal((await tang('/api/admin/ai')).status, 403);
  assert.equal((await configure(tang, 'leader', { led_groups: [groupA] })).status, 200);
  assert.equal((await configure(tang, 'other-leader', { led_groups: [groupB] })).status, 200);
  assert.equal((await configure(tang, 'head', { college_role: 'program', program_scopes: [cs] })).status, 200);
  assert.equal((await configure(admin, 'empty-head', { college_role: 'program' })).status, 200);
  assert.equal((await configure(admin, 'dual', { college_role: 'teaching', led_groups: [groupB], program_scopes: [ai] })).status, 200);
  assert.equal((await configure(tang, 'bob', { supervision_manager: 1 })).status, 403);
  assert.equal((await configure(alice, 'bob', { college_role: 'teaching' })).status, 403);
  assert.equal((await alice('/api/supervision-management')).status, 403);
  assert.equal((await client()('/api/supervision-management')).status, 401);
  assert.equal((await alice('/api/supervision/progress')).status, 403);
  const csv = [
    ['课程名称', '课程组', '审核专业', '大纲执笔人', '教师名称'],
    ['计算机基础', groupA, cs, '执笔人甲', '任课教师甲'],
    ['计算机基础', groupA, cs, '执笔人甲', '平行班教师乙'],
    ['数据结构', groupA, cs, '执笔人甲', '任课教师甲'],
    ['人工智能导论', groupB, ai, '执笔人乙', '任课教师乙'],
    ['机器学习', groupB, ai, '', '任课教师乙'],
    ['物联网基础', groupA, iot, '未建号执笔人', '任课教师丙'],
    ['计算机基础', groupA, ai, '执笔人乙', '任课教师乙'],
  ].map((row) => row.join(',')).join('\n');
  const importSource = (request = admin, text = csv) => {
    const form = new FormData();
    form.append('file', new Blob([text]), 'outline-source.csv');
    return request('/api/supervision-management/import', form);
  };
  const imported = await importSource(tang);
  assert.equal(imported.status, 200);
  assert.equal(imported.data.required, 6);
  assert.equal(imported.data.unassigned, 1);
  assert.ok(imported.data.warnings.some((warning) => warning.includes('未建号执笔人')));
  assert.equal((await importSource(alice)).status, 403);
  let managed = (await admin('/api/supervision-management')).data;
  const foundation = managed.requirements.find((r) => r.course_name === '计算机基础' && r.professional === cs);
  const unmatched = managed.requirements.find((r) => r.course_name === '物联网基础');
  const unassigned = managed.requirements.find((r) => r.course_name === '机器学习');
  assert.equal(foundation.user_id, aliceId);
  assert.match(foundation.teacher_names, /任课教师甲/);
  assert.match(foundation.teacher_names, /平行班教师乙/);
  assert.equal(unmatched.user_id, null);
  assert.equal(unassigned.user_id, null);
  assert.equal((await alice('/api/progress')).data.required, 2);
  assert.equal((await bob('/api/progress')).data.required, 2);
  assert.equal((await leader('/api/supervision/progress?view=group')).data.summary.required, 4);
  assert.equal((await head('/api/supervision/progress?view=program')).data.summary.required, 2);
  const empty = await emptyHead('/api/supervision/progress?view=program');
  assert.equal(empty.status, 200);
  assert.deepEqual(empty.data.views, ['program']);
  assert.equal(empty.data.summary.required, 0);
  for (const [view, required] of [['college', 6], ['group', 2], ['program', 3]]) {
    const result = await dual(`/api/supervision/progress?view=${view}`);
    assert.equal(result.status, 200);
    assert.deepEqual(result.data.views, ['college', 'program', 'group']);
    assert.equal(result.data.summary.required, required);
  }
  assert.equal((await leader('/api/supervision/progress?view=college')).status, 403);
  assert.equal((await leader('/api/supervision/progress?view=program')).status, 403);
  assert.equal((await head('/api/supervision/progress?view=college')).status, 403);
  assert.equal((await head('/api/supervision/progress?view=group')).status, 403);
  assert.equal((await configure(tang, 'other-leader', { led_groups: [groupB] })).status, 200);
  const file = Buffer.from('Syllabus test fixture');
  writeFileSync(path.join(dataDir, 'seed.docx'), file);
  const checklistId = database.prepare('SELECT id FROM checklist_versions WHERE is_active = 1').get().id;
  function seed(userId, courseName, major, verdict = 'passed') {
    const courseId = Number(database.prepare("INSERT INTO courses (user_id,name,major,training_type,student_grade) VALUES (?,?,?,'普通本科',2025)").run(userId, courseName, major).lastInsertRowid);
    const snapshot = JSON.stringify({ name: courseName, major, trainingType: '普通本科', studentGrade: 2025, planGrade: 2025, adjustNote: '' });
    return Number(database.prepare(`INSERT INTO submissions
      (course_id,user_id,seq,file_name,file_path,file_size,extracted_text,checklist_version_id,course_snapshot,status,verdict,result_json,finished_at)
      VALUES (?,?,1,'seed.docx','seed.docx',?,'Syllabus test fixture',?,?,'done',?,?,datetime('now','localtime'))`)
      .run(courseId, userId, file.length, checklistId, snapshot, verdict, JSON.stringify({ summary: 'Reviewable', itemResults: [], issues: [], toVerify: [] })).lastInsertRowid);
  }
  const first = seed(aliceId, '计算机基础', cs);
  const outside = seed(bobId, '人工智能导论', ai);
  seed(bobId, '计算机基础', ai);
  let mine = (await alice('/api/progress')).data;
  assert.deepEqual([mine.uploaded, mine.required, mine.passed], [1, 2, 1]);
  assert.deepEqual((await alice(`/api/progress?userId=${bobId}`)).data, mine);
  const group = (await leader('/api/supervision/progress?view=group')).data;
  assert.deepEqual([group.summary.uploaded, group.summary.required], [2, 4]);
  assert.equal(group.rows.filter((row) => row.user_id === aliceId).length, 2);
  let total = (await admin('/api/admin/progress')).data;
  const person = total.rows.find((row) => row.user_id === aliceId);
  assert.deepEqual([person.uploaded_count, person.required_count], [1, 2]);
  assert.deepEqual([total.summary.uploadedOutlines, total.summary.requiredOutlines], [3, 6]);
  assert.equal((await leader(`/api/submissions/${first}`)).status, 200);
  assert.deepEqual((await leader(`/api/submissions/${first}/file`)).data, file);
  assert.equal((await head(`/api/submissions/${first}/report.txt`)).status, 200);
  for (const request of [leader, head]) {
    for (const suffix of ['', '/file', '/report.txt', '/report.docx']) {
      assert.equal((await request(`/api/submissions/${outside}${suffix}`)).status, 404);
    }
    assert.equal((await request(`/api/submissions/${outside}/confirm`, {})).status, 404);
  }
  assert.equal((await head(`/api/submissions/${first}/confirm`, {})).status, 403);
  assert.equal((await tang(`/api/submissions/${first}/confirm`, {})).status, 403);
  seed(aliceId, '数据结构', cs);
  assert.equal((await alice('/api/progress')).data.passed, 2);
  assert.equal((await admin('/api/admin/progress')).data.summary.passed, 2);
  const confirmed = await leader(`/api/submissions/${first}/confirm`, {});
  assert.equal(confirmed.status, 200);
  assert.equal((await alice('/api/progress')).data.confirmed, 1);
  assert.equal((await leader('/api/supervision/progress?view=group')).data.summary.confirmed, 1);
  assert.equal((await admin('/api/admin/progress')).data.summary.confirmedOutlines, 1);
  const latest = seed(aliceId, '计算机基础', cs, 'failed');
  mine = (await alice('/api/progress')).data;
  assert.deepEqual([mine.uploaded, mine.passed, mine.confirmed], [2, 1, 0]);
  const latestGroup = (await leader('/api/supervision/progress?view=group')).data.summary;
  assert.deepEqual([latestGroup.uploaded, latestGroup.passed, latestGroup.confirmed], [3, 2, 0]);
  assert.equal((await admin('/api/admin/progress')).data.summary.confirmedOutlines, 0);
  assert.equal((await leader(`/api/submissions/${first}/confirm`, {})).status, 403);
  assert.equal((await otherLeader(`/api/submissions/${latest}`)).status, 404);
  assert.equal((await leader(`/api/submissions/${latest}/confirm`, {})).status, 200);
  assert.equal((await alice('/api/progress')).data.confirmed, 1);
  assert.equal((await leader('/api/supervision/progress?view=group')).data.summary.confirmed, 1);
  assert.equal((await admin('/api/admin/progress')).data.summary.confirmedOutlines, 1);
  assert.equal((await admin('/api/admin/progress')).data.summary.passed, 1);
  const assignWriter = (request, requirement, userId) => request(`/api/supervision-management/requirements/${requirement.id}`, {
    writer_user_id: userId, writer_name: '', professional: requirement.professional,
  }, 'PUT');
  assert.equal((await assignWriter(alice, foundation, bobId)).status, 403);
  assert.equal((await assignWriter(tang, foundation, bobId)).status, 200);
  mine = (await alice('/api/progress')).data;
  assert.deepEqual([mine.required, mine.uploaded], [1, 1]);
  const reassigned = (await bob('/api/progress')).data;
  assert.deepEqual([reassigned.required, reassigned.uploaded], [3, 2]);
  assert.equal(reassigned.courses.find((course) => course.id === foundation.id).latest_id, null, 'Same course title in another professional cannot satisfy the reassigned outline');
  assert.equal((await leader(`/api/submissions/${latest}`)).status, 404);
  const transferredSubmission = seed(bobId, '计算机基础', cs);
  assert.equal((await head(`/api/submissions/${transferredSubmission}`)).status, 200);
  assert.equal((await bob('/api/progress')).data.uploaded, 3);
  assert.equal((await assignWriter(admin, unmatched, aliceId)).status, 200);
  assert.equal((await alice('/api/progress')).data.required, 2);
  assert.equal((await importSource()).status, 200);
  managed = (await admin('/api/supervision-management')).data;
  assert.equal(managed.requirements.find((r) => r.id === foundation.id).user_id, bobId);
  assert.equal(managed.requirements.find((r) => r.id === unmatched.id).user_id, aliceId);
  assert.equal(managed.requirements.length, 6);
  const beforeLegacy = managed;
  assert.equal((await admin('/api/admin/progress/import', {})).status, 400);
  assert.deepEqual((await admin('/api/supervision-management')).data, beforeLegacy);
  assert.equal((await importSource(admin, '姓名,工号\n甲,001')).status, 400);
  assert.deepEqual((await admin('/api/supervision-management')).data, beforeLegacy);
  assert.equal((await configure(admin, 'leader', {})).status, 200);
  assert.equal((await leader('/api/supervision/progress?view=group')).status, 403);
  assert.equal((await leader(`/api/submissions/${transferredSubmission}`)).status, 404);
  assert.equal((await configure(admin, 'head', { college_role: 'program' })).status, 200);
  assert.equal((await head('/api/supervision/progress?view=program')).data.summary.required, 0);
  assert.equal((await head(`/api/submissions/${transferredSubmission}`)).status, 404);
});
