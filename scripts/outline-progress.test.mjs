// Run: node --disable-warning=ExperimentalWarning --import tsx --test scripts/outline-progress.test.mjs
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { Document, Packer, Paragraph } from 'docx';

test('outline writers, scoped supervision and manual mappings use the course source only', { timeout: 60000 }, async (t) => {
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
    ['head', '龚兰兰'], ['head-ai', '刘正涛'], ['head-iot', '薛亮'],
    ['empty-head', '未配专业负责人'], ['dual', '兼任监督者'], ['tang', '汤家华'],
    ['preset-code', '王辉'], ['preset-algorithm', '张文哲'], ['preset-database', '尼洪涛'],
    ['preset-hardware', '曹金华'], ['preset-network', '唐灯平'], ['preset-ai', '纪其进'],
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
  for (const username of ['head', 'head-ai', 'head-iot']) {
    const me = (await users[username].request('/api/auth/me')).data.user;
    assert.equal(me.college_role, 'program');
    assert.deepEqual(me.program_scopes, []);
    const overview = await users[username].request('/api/supervision/progress');
    assert.equal(overview.status, 200);
    assert.equal(overview.data.view, 'program');
    assert.deepEqual(overview.data.views, username === 'head-ai' ? ['program', 'group'] : ['program']);
    assert.equal(overview.data.summary.required, 0);
    assert.deepEqual(overview.data.rows, []);
    assert.equal((await users[username].request('/api/supervision/progress?view=college')).status, 403);
  }
  database.prepare("UPDATE users SET college_role = 'none' WHERE id = ?").run(users.head.id);
  database.prepare('DELETE FROM program_leader_scopes WHERE user_id = ?').run(users.head.id);
  database.prepare('INSERT INTO program_leader_scopes (user_id,professional) VALUES (?,?)').run(users['head-ai'].id, '计算机公共教学');
  database.prepare("DELETE FROM settings WHERE key = 'professional_views_initialized'").run();
  const migrated = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', '--import', 'tsx', 'server/src/db.ts'], {
    cwd: root, env: { ...process.env, DATA_DIR: dataDir }, encoding: 'utf8', timeout: 10000,
  });
  assert.equal(migrated.status, 0, migrated.stderr);
  const upgraded = (await head('/api/auth/me')).data.user;
  assert.equal(upgraded.college_role, 'program');
  assert.deepEqual(upgraded.program_scopes, []);
  assert.deepEqual((await users['head-ai'].request('/api/auth/me')).data.user.program_scopes, ['计算机公共教学']);
  const groupRoster = new FormData();
  groupRoster.append('file', new Blob(['姓名,工号\n李婷婷,preset-public']), 'group-leaders.csv');
  assert.equal((await admin('/api/admin/users/import', groupRoster)).data.imported, 1);
  const presetNames = ['刘正涛', '王辉', '张文哲', '尼洪涛', '曹金华', '唐灯平', '纪其进', '李婷婷'];
  const defaultGroups = (await admin('/api/supervision-management')).data;
  for (let i = 0; i < presetNames.length; i++) {
    assert.deepEqual(defaultGroups.users.find((user) => user.name === presetNames[i]).led_groups, [settings.groups[i]]);
  }
  database.exec('DELETE FROM course_group_leaders');
  database.prepare('INSERT INTO course_group_leaders (course_group,user_id) VALUES (?,?)').run(groupA, aliceId);
  database.prepare('INSERT INTO course_group_leaders (course_group,user_id) VALUES (?,?)').run(settings.groups[4], users['preset-code'].id);
  database.prepare("DELETE FROM settings WHERE key = 'course_group_views_initialized'").run();
  const groupMigrated = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', '--import', 'tsx', 'server/src/db.ts'], {
    cwd: root, env: { ...process.env, DATA_DIR: dataDir }, encoding: 'utf8', timeout: 10000,
  });
  assert.equal(groupMigrated.status, 0, groupMigrated.stderr);
  const upgradedGroups = (await admin('/api/supervision-management')).data;
  assert.deepEqual(upgradedGroups.users.find((user) => user.id === aliceId).led_groups, [groupA], 'Upgrade preserves a group manually assigned to another account');
  assert.deepEqual(upgradedGroups.users.find((user) => user.id === users['preset-code'].id).led_groups, [settings.groups[4]], 'Upgrade preserves a preset leader\'s manually selected scope');
  assert.deepEqual(upgradedGroups.users.find((user) => user.id === users['head-ai'].id).led_groups, []);
  assert.deepEqual(upgradedGroups.users.find((user) => user.id === users['preset-algorithm'].id).led_groups, [settings.groups[2]]);
  for (const index of [3, 5, 6, 7]) {
    assert.deepEqual(upgradedGroups.users.find((user) => user.name === presetNames[index]).led_groups, [settings.groups[index]]);
  }
  assert.equal((await admin(`/api/supervision-management/users/${users['preset-algorithm'].id}`, {
    college_role: 'none', led_groups: [], program_scopes: [],
  }, 'PUT')).status, 200);
  const restarted = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', '--import', 'tsx', 'server/src/db.ts'], {
    cwd: root, env: { ...process.env, DATA_DIR: dataDir }, encoding: 'utf8', timeout: 10000,
  });
  assert.equal(restarted.status, 0, restarted.stderr);
  assert.deepEqual((await users['preset-algorithm'].request('/api/auth/me')).data.user.led_groups, [], 'Restart does not restore a revoked default course group');
  const configure = (request, username, patch) => request(`/api/supervision-management/users/${users[username].id}`, {
    college_role: 'none', led_groups: [], program_scopes: [], ...patch,
  }, 'PUT');
  assert.equal((await configure(admin, 'alice', {})).status, 200);
  assert.equal((await configure(admin, 'tang', { college_role: 'teaching', supervision_manager: 1 })).status, 200);
  assert.equal((await tang('/api/supervision-management')).status, 200);
  assert.equal((await tang('/api/admin/users')).status, 403);
  assert.equal((await tang('/api/admin/ai')).status, 403);
  assert.equal((await configure(tang, 'leader', { led_groups: [groupA] })).status, 200);
  assert.equal((await configure(tang, 'other-leader', { led_groups: [groupB] })).status, 200);
  assert.equal((await configure(tang, 'head', { college_role: 'program', program_scopes: [cs] })).status, 200);
  assert.equal((await configure(admin, 'head-ai', { college_role: 'program', program_scopes: [ai] })).status, 200);
  assert.equal((await configure(admin, 'head-iot', { college_role: 'program', program_scopes: [iot] })).status, 200);
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
  for (const [username, professional, required] of [['head', cs, 2], ['head-ai', ai, 3], ['head-iot', iot, 1]]) {
    const overview = await users[username].request('/api/supervision/progress');
    assert.equal(overview.status, 200);
    assert.equal(overview.data.summary.required, required);
    assert.ok(overview.data.rows.every((row) => row.professional === professional));
  }
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
  function seed(userId, courseName, major, verdict = 'passed', requirementId = null) {
    const courseId = Number(database.prepare("INSERT INTO courses (user_id,name,major,training_type,student_grade) VALUES (?,?,?,'普通本科',2025)").run(userId, courseName, major).lastInsertRowid);
    const snapshot = JSON.stringify({ name: courseName, major, trainingType: '普通本科', studentGrade: 2025, planGrade: 2025, adjustNote: '' });
    return Number(database.prepare(`INSERT INTO submissions
      (course_id,user_id,seq,file_name,file_path,file_size,extracted_text,checklist_version_id,course_snapshot,status,verdict,result_json,finished_at,outline_requirement_id)
      VALUES (?,?,1,'seed.docx','seed.docx',?,'Syllabus test fixture',?,?,'done',?,?,datetime('now','localtime'),?)`)
      .run(courseId, userId, file.length, checklistId, snapshot, verdict, JSON.stringify({ summary: 'Reviewable', itemResults: [], issues: [], toVerify: [] }), requirementId).lastInsertRowid);
  }
  const first = seed(aliceId, '计算机基础', cs);
  const outside = seed(bobId, '人工智能导论', ai);
  const sameTitleAI = seed(bobId, '计算机基础', ai);
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
  const legacyOtherUploader = seed(bobId, '数据结构', cs);
  const legacyWriterCourse = (await alice('/api/progress')).data.courses.find((course) => course.course_name === '数据结构');
  assert.equal(legacyWriterCourse.latest_id, legacyOtherUploader, 'A unique legacy course is credited regardless of who uploaded it');
  assert.equal(legacyWriterCourse.uploader_id, bobId);
  assert.equal((await alice(`/api/submissions/${legacyOtherUploader}`)).status, 200);
  assert.equal((await alice(`/api/submissions/${legacyOtherUploader}/confirm`, {})).status, 403, 'Being the assigned writer alone does not grant confirmation permission');
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
  assert.equal((await alice(`/api/submissions/${first}/confirm`, {})).status, 200);
  assert.equal((await alice('/api/progress')).data.confirmed, 0, 'Confirming an uploader\'s historical result does not confirm the latest course version');
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
  assert.deepEqual([reassigned.required, reassigned.uploaded], [3, 3]);
  const reassignedCourse = reassigned.courses.find((course) => course.id === foundation.id);
  assert.equal(reassignedCourse.latest_id, latest, 'Reassigning the writer keeps the uploaded course and its history');
  assert.equal(reassignedCourse.uploader_id, aliceId);
  assert.equal(reassigned.courses.find((course) => course.course_name === '计算机基础' && course.professional === ai).latest_id, sameTitleAI);
  assert.equal((await leader(`/api/submissions/${latest}`)).status, 200);
  assert.equal((await bob(`/api/submissions/${latest}`)).status, 200);
  assert.equal((await bob(`/api/submissions/${latest}/confirm`, {})).status, 403);
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
  const mock = http.createServer(async (req, res) => {
    for await (const _chunk of req) { /* Drain the provider request. */ }
    const items = database.prepare('SELECT code FROM checklist_items WHERE version_id = ?').all(checklistId);
    const result = { summary: 'Course upload test', itemResults: items.map(({ code }) => ({ code, result: '未发现问题', note: '' })), issues: [], toVerify: [] };
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ model: 'mock', choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: JSON.stringify(result) } }] }));
  });
  mock.listen(0, '127.0.0.1');
  await once(mock, 'listening');
  t.after(() => new Promise((resolve) => mock.close(resolve)));
  assert.equal((await admin('/api/admin/ai', { provider: 'openai', baseUrl: `http://127.0.0.1:${mock.address().port}/v1`, apiKey: 'test-only', model: 'mock' }, 'PUT')).status, 200);
  const syllabus = await Packer.toBuffer(new Document({ sections: [{ children: [new Paragraph('Course objectives, teaching content and assessment rules. '.repeat(12))] }] }));
  const upload = (request, name, major, requirementId, trainingType, planGrade = 2025) => {
    const form = new FormData();
    for (const [key, value] of Object.entries({ name, major, trainingType, studentGrade: 2025, planGrade })) {
      if (value !== undefined) form.append(key, String(value));
    }
    if (requirementId !== undefined) form.append('outlineRequirementId', String(requirementId));
    form.append('file', new Blob([syllabus]), 'course-outline.docx');
    return request('/api/submissions', form);
  };
  const finish = async (submissionId) => {
    for (let i = 0; i < 150; i++) {
      const row = database.prepare('SELECT status,error FROM submissions WHERE id = ?').get(submissionId);
      if (row.status === 'done') return;
      assert.notEqual(row.status, 'failed', row.error);
      await delay(20);
    }
    assert.fail(`Submission ${submissionId} did not complete`);
  };
  const beforeUnassigned = (await alice('/api/progress')).data;
  const firstUnassigned = await upload(alice, '机器学习', ai);
  assert.equal(firstUnassigned.status, 200);
  await finish(firstUnassigned.data.submissionId);
  assert.equal(database.prepare('SELECT outline_requirement_id FROM submissions WHERE id = ?').get(firstUnassigned.data.submissionId).outline_requirement_id, unassigned.id, 'An unambiguous course automatically binds without requiring a writer');
  const firstUnassignedRow = (await otherLeader('/api/supervision/progress?view=group')).data.rows.find((row) => row.id === unassigned.id);
  assert.equal(firstUnassignedRow.user_id, null);
  assert.equal(firstUnassignedRow.uploader_id, aliceId);
  assert.equal(firstUnassignedRow.latest_id, firstUnassigned.data.submissionId);
  assert.deepEqual((await alice('/api/progress')).data, beforeUnassigned, 'Uploading an unassigned course does not create a personal writer assignment');
  assert.equal((await otherLeader(`/api/submissions/${firstUnassigned.data.submissionId}`)).status, 200);
  assert.equal((await otherLeader(`/api/submissions/${firstUnassigned.data.submissionId}/confirm`, {})).status, 200);
  assert.equal((await leader(`/api/submissions/${firstUnassigned.data.submissionId}`)).status, 404);
  const uploadedBeforeRevision = (await admin('/api/admin/progress')).data.summary.uploadedOutlines;
  const revisedUnassigned = await upload(bob, '机器学习', ai, unassigned.id);
  assert.equal(revisedUnassigned.status, 200);
  await finish(revisedUnassigned.data.submissionId);
  const revisedRow = (await otherLeader('/api/supervision/progress?view=group')).data.rows.find((row) => row.id === unassigned.id);
  assert.equal(revisedRow.latest_id, revisedUnassigned.data.submissionId);
  assert.equal(revisedRow.uploader_id, bobId);
  assert.equal(revisedRow.confirmed_at, null);
  assert.equal((await admin('/api/admin/progress')).data.summary.uploadedOutlines, uploadedBeforeRevision, 'A new uploader/version does not count the course twice');
  assert.equal((await otherLeader(`/api/submissions/${firstUnassigned.data.submissionId}/confirm`, {})).status, 403);
  assert.equal((await otherLeader(`/api/submissions/${revisedUnassigned.data.submissionId}/confirm`, {})).status, 200);
  const ambiguousCsv = `${csv}\n交叉课程,${groupA},${cs},,\n交叉课程,${groupB},${cs},,`;
  assert.equal((await importSource(admin, ambiguousCsv)).status, 200);
  managed = (await admin('/api/supervision-management')).data;
  const ambiguous = managed.requirements.filter((row) => row.course_name === '交叉课程');
  assert.equal(ambiguous.length, 2);
  const legacyAmbiguous = seed(aliceId, '交叉课程', cs);
  assert.ok((await admin('/api/supervision-management')).data.requirements.filter((row) => row.course_name === '交叉课程').every((row) => row.latest_id === null), 'An ambiguous legacy upload is not credited to either course group');
  assert.equal((await leader(`/api/submissions/${legacyAmbiguous}`)).status, 404);
  assert.equal((await upload(admin, '交叉课程', cs)).status, 400);
  const selectedCourse = ambiguous.find((row) => row.course_group === groupA);
  assert.equal((await upload(admin, '其他课程', cs, selectedCourse.id)).status, 400);
  assert.equal((await upload(admin, '交叉课程', ai, selectedCourse.id)).status, 400);
  const options = (await admin('/api/options')).data.outlineCourses;
  assert.equal(options.length, 8);
  assert.equal(options.filter((course) => course.name === '交叉课程').length, 2);
  const bound = await upload(admin, '交叉课程', cs, selectedCourse.id);
  assert.equal(bound.status, 200);
  await finish(bound.data.submissionId);
  const boundRows = (await admin('/api/supervision-management')).data.requirements.filter((row) => row.course_name === '交叉课程');
  assert.equal(boundRows.find((row) => row.id === selectedCourse.id).latest_id, bound.data.submissionId);
  assert.equal(boundRows.find((row) => row.id !== selectedCourse.id).latest_id, null);
  assert.equal((await leader(`/api/submissions/${bound.data.submissionId}/confirm`, {})).status, 200);
  assert.equal((await otherLeader(`/api/submissions/${bound.data.submissionId}`)).status, 404);
  const beforeOutside = (await admin('/api/admin/progress')).data.summary.uploadedOutlines;
  const outsideSource = await upload(admin, '不在应交名单的课程', ai);
  assert.equal(outsideSource.status, 200);
  await finish(outsideSource.data.submissionId);
  assert.equal(database.prepare('SELECT outline_requirement_id FROM submissions WHERE id = ?').get(outsideSource.data.submissionId).outline_requirement_id, null);
  assert.equal((await admin('/api/admin/progress')).data.summary.uploadedOutlines, beforeOutside);
  managed = (await admin('/api/supervision-management')).data;
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
  assert.equal((await configure(admin, 'head', {})).status, 200);
  const professionalRestart = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', '--import', 'tsx', 'server/src/db.ts'], {
    cwd: root, env: { ...process.env, DATA_DIR: dataDir }, encoding: 'utf8', timeout: 10000,
  });
  assert.equal(professionalRestart.status, 0, professionalRestart.stderr);
  const revokedProfessional = (await head('/api/auth/me')).data.user;
  assert.equal(revokedProfessional.college_role, 'none', 'Restart does not restore a revoked default professional identity');
  assert.deepEqual(revokedProfessional.program_scopes, []);
  assert.equal((await head('/api/supervision/progress?view=program')).status, 403);

  await t.test('four upload majors use the selected 2023-2026 plan without a training-type selector', async () => {
    const transferMajor = '计算机科学与技术（专转本）';
    const options = (await admin('/api/options')).data;
    assert.deepEqual(options.majors, [cs, transferMajor, iot, ai]);
    assert.deepEqual(options.studentGrades, [2023, 2024, 2025, 2026]);
    assert.ok((await admin('/api/supervision-management')).data.programs.includes(transferMajor));
    for (const grade of options.studentGrades) {
      for (const type of ['普通本科', '专转本']) {
        database.prepare('INSERT INTO training_plans (major,training_type,grade,name,extracted_text) VALUES (?,?,?,?,?)')
          .run(cs, type, grade, `${grade}-${type}`, 'Training plan test fixture');
      }
      for (const [major, type] of [[cs, '普通本科'], [transferMajor, '专转本']]) {
        const query = new URLSearchParams({ major, trainingType: '普通本科', grade: String(grade) });
        const matched = await admin(`/api/plan-match?${query}`);
        assert.equal(matched.status, 200);
        assert.equal(matched.data.plan.name, `${grade}-${type}`);
      }
    }
    const requirementId = Number(database.prepare('INSERT INTO outline_requirements (source_key,course_name,course_group,professional) VALUES (?,?,?,?)')
      .run('legacy-transfer-course', '专转本课程', groupA, '专转本').lastInsertRowid);
    const uploaded = await upload(admin, '专转本课程', transferMajor, undefined, undefined, 2024);
    assert.equal(uploaded.status, 200);
    assert.equal(uploaded.data.planFound, true);
    await finish(uploaded.data.submissionId);
    const detail = (await admin(`/api/submissions/${uploaded.data.submissionId}`)).data.submission;
    assert.equal(detail.course.major, transferMajor);
    assert.equal(detail.course.trainingType, '专转本');
    assert.equal(detail.course.planGrade, 2024);
    assert.equal(detail.course.adjustNote, '');
    assert.equal(detail.plan_name, '2024-专转本');
    assert.equal(database.prepare('SELECT outline_requirement_id FROM submissions WHERE id = ?').get(detail.id).outline_requirement_id, requirementId);
    database.prepare('UPDATE courses SET adjust_note = ? WHERE id = ?').run('Historical plan note', uploaded.data.courseId);
    for (const planGrade of options.studentGrades) {
      assert.equal((await admin(`/api/courses/${uploaded.data.courseId}`, {
        name: '专转本课程', major: transferMajor, studentGrade: 2025, planGrade,
      }, 'PUT')).status, 200);
      const current = (await admin(`/api/courses/${uploaded.data.courseId}`)).data;
      assert.equal(current.plan.name, `${planGrade}-专转本`);
      assert.equal(current.course.adjust_note, 'Historical plan note');
    }
    for (const planGrade of [2022, 2027]) {
      assert.equal((await admin(`/api/courses/${uploaded.data.courseId}`, {
        name: '专转本课程', major: transferMajor, studentGrade: 2025, planGrade,
      }, 'PUT')).status, 400);
    }
    const ordinary = await upload(admin, '普通本科课程', cs, undefined, undefined, 2024);
    assert.equal(ordinary.status, 200);
    await finish(ordinary.data.submissionId);
    const ordinaryDetail = (await admin(`/api/submissions/${ordinary.data.submissionId}`)).data.submission;
    assert.equal(ordinaryDetail.course.trainingType, '普通本科');
    assert.equal(ordinaryDetail.plan_name, '2024-普通本科');
  });

  await t.test('teaching staff can read all results, including uploads outside the cloud course list', async () => {
    assert.equal((await client()('/api/submissions?scope=college')).status, 401);
    for (const request of [bob, emptyHead, otherLeader]) {
      assert.equal((await request('/api/submissions?scope=college')).status, 403);
    }
    assert.equal((await admin(`/api/admin/users/${bobId}`, { college_role: 'teaching' }, 'PUT')).status, 200);
    assert.equal((await bob('/api/auth/me')).data.user.college_role, 'teaching');
    const allIds = database.prepare('SELECT id FROM submissions ORDER BY id DESC').all().map((row) => row.id);
    const ownIds = database.prepare('SELECT id FROM submissions WHERE user_id = ? ORDER BY id DESC').all(bobId).map((row) => row.id);
    assert.deepEqual((await bob('/api/submissions?pageSize=200')).data.rows.map((row) => row.id), ownIds);
    for (const request of [admin, bob]) {
      const result = await request('/api/submissions?scope=college&pageSize=200');
      assert.equal(result.status, 200);
      assert.equal(result.data.total, allIds.length);
      assert.deepEqual(result.data.rows.map((row) => row.id), allIds);
      const outsideRow = result.data.rows.find((row) => row.id === outsideSource.data.submissionId);
      assert.equal(outsideRow.username, 'root');
      assert.equal(outsideRow.user_name, 'Root');
    }
    const secondPage = (await bob('/api/submissions?scope=college&pageSize=1&page=2')).data;
    assert.equal(secondPage.total, allIds.length);
    assert.deepEqual(secondPage.rows.map((row) => row.id), [allIds[1]]);
    const search = (await bob(`/api/submissions?scope=college&q=${encodeURIComponent('不在应交名单')}&status=done&confirmation=pending`)).data;
    assert.deepEqual(search.rows.map((row) => row.id), [outsideSource.data.submissionId]);
    const ownerSearch = (await bob('/api/submissions?scope=college&q=alice&pageSize=200')).data;
    assert.deepEqual(ownerSearch.rows.map((row) => row.id), database.prepare('SELECT id FROM submissions WHERE user_id = ? ORDER BY id DESC').all(aliceId).map((row) => row.id));
    for (const suffix of ['', '/file', '/report.txt', '/report.docx']) {
      assert.equal((await bob(`/api/submissions/${outsideSource.data.submissionId}${suffix}`)).status, 200);
    }
    assert.equal((await bob(`/api/submissions/${outsideSource.data.submissionId}`)).data.submission.canConfirm, false);
    assert.equal((await bob(`/api/submissions/${outsideSource.data.submissionId}/confirm`, {})).status, 403);
    assert.equal((await bob(`/api/submissions/${outsideSource.data.submissionId}/recheck`, {})).status, 403);
    assert.equal((await bob('/api/admin/submissions')).status, 403);
    assert.equal((await admin(`/api/admin/users/${bobId}`, { college_role: 'none' }, 'PUT')).status, 200);
    assert.equal((await bob('/api/submissions?scope=college')).status, 403);
    for (const suffix of ['', '/file', '/report.txt', '/report.docx']) {
      assert.equal((await bob(`/api/submissions/${outsideSource.data.submissionId}${suffix}`)).status, 404);
    }
  });
});
