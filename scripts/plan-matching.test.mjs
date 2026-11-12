// Run: node --disable-warning=ExperimentalWarning --import tsx --test scripts/plan-matching.test.mjs
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { identifyPlanMajor } from '../server/src/services/planIdentification.ts';

test('plan majors require unambiguous file-name or title evidence', () => {
  const body = '课程设置和毕业要求支撑矩阵中包含人工智能、物联网工程等课程。';
  assert.equal(identifyPlanMajor('2025计算机科学与技术人才培养方案.docx', body).major, '计算机科学与技术');
  assert.equal(identifyPlanMajor('2025计算机科学与技术(专转本)人才培养方案.pdf', body).trainingType, '专转本');
  assert.equal(identifyPlanMajor('plan.txt', '学校名称\n2025级物联网工程人才培养方案\n' + body).major, '物联网工程');
  assert.equal(identifyPlanMajor('plan.txt', '专业名称：人工智能\n' + body).major, '人工智能');
  assert.equal(identifyPlanMajor('plan.txt', '计算机科学与技术\n（专转本）\n人才培养方案\n' + body).major, '计算机科学与技术（专转本）');
  assert.equal(identifyPlanMajor('plan.txt', '计算机科学与技术（专转本）专业人才培养方案\n' + body).major, '计算机科学与技术（专转本）');
  assert.equal(identifyPlanMajor('plan.txt', body).major, null, 'Body course names are not major evidence');
  assert.equal(identifyPlanMajor('plan.txt', '本方案参照人工智能人才培养方案设置课程。').major, null, 'A body reference is not a title');
  assert.equal(identifyPlanMajor('plan.txt', '课程设置\n| 人工智能 | 人才培养方案 |\n' + body).major, null);
  const conflict = identifyPlanMajor('人工智能培养方案.docx', '物联网工程人才培养方案\n' + body);
  assert.equal(conflict.major, null);
  assert.equal(conflict.ambiguous, true);
  assert.equal(conflict.evidence.length, 2);
  assert.equal(identifyPlanMajor('人工智能与物联网工程培养方案.pdf', '').ambiguous, true);
});

test('plan identification, manual override and matching downloads', async (t) => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const dataDir = mkdtempSync(path.join(root, '.tmp-plan-matching-'));
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
    assert.match(path.basename(dataDir), /^\.tmp-plan-matching-/);
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
      return { status: response.status, data: response.headers.get('content-type')?.includes('application/json') ? await response.json() : Buffer.from(await response.arrayBuffer()) };
    };
  }
  const admin = client();
  assert.equal((await admin('/api/auth/register', { username: 'root-plan', name: 'Plan Admin', password: 'admin12345' })).status, 200);
  const text = '物联网工程人才培养方案\n' + '毕业要求、课程设置和支撑矩阵。'.repeat(8);
  const identify = new FormData();
  identify.append('file', new Blob([text]), '2025物联网工程培养方案.txt');
  const identified = await admin('/api/admin/plans/identify', identify);
  assert.equal(identified.status, 200);
  assert.equal(identified.data.major, '物联网工程');
  assert.equal(identified.data.trainingType, '普通本科');
  assert.equal((await client()('/api/admin/plans/identify', identify)).status, 401);
  assert.equal((await admin('/api/admin/plans/identify', new FormData())).status, 400);
  assert.equal((await admin('/api/admin/plans')).data.rows.length, 0, 'Identification does not persist a plan');

  const upload = new FormData();
  upload.append('major', '计算机科学与技术（专转本）');
  upload.append('trainingType', '普通本科');
  upload.append('grade', '2024');
  upload.append('file', new Blob([text]), '2025物联网工程培养方案.txt');
  const saved = await admin('/api/admin/plans', upload);
  assert.equal(saved.status, 200, 'Explicitly chosen metadata overrides recognition');
  const row = (await admin(`/api/admin/plans/${saved.data.id}`)).data.plan;
  assert.equal(row.major, '计算机科学与技术（专转本）');
  assert.equal(row.training_type, '专转本');
  const query = new URLSearchParams({ major: row.major, trainingType: '普通本科', grade: '2024' });
  const matched = (await admin(`/api/plan-match?${query}`)).data.plan;
  assert.equal(matched.id, row.id);
  assert.equal(matched.downloadable, true);
  assert.equal((await admin(`/api/plans/${matched.id}/file`)).data.toString(), text);
  query.set('grade', '2025');
  assert.equal((await admin(`/api/plan-match?${query}`)).data.plan, null);
  query.set('grade', '2024');
  query.set('major', '人工智能');
  assert.equal((await admin(`/api/plan-match?${query}`)).data.plan, null);
  assert.equal((await admin(`/api/admin/plans/${row.id}`, {
    major: row.major, trainingType: '普通本科', grade: 2024, name: row.name, extractedText: text, enabled: false,
  }, 'PUT')).status, 200);
  query.set('major', row.major);
  assert.equal((await admin(`/api/plan-match?${query}`)).data.plan, null);
  assert.equal((await admin(`/api/plans/${row.id}/file`)).status, 404);

  await t.test('only admins can reextract an existing source; metadata, file and historical results stay unchanged', async () => {
    const endpoint = `/api/admin/plans/${row.id}/reextract`;
    assert.equal((await client()(endpoint, {})).status, 401);
    assert.equal((await admin('/api/admin/users', { username: 'plan-teacher', name: 'Teacher', password: 'teacher12345' })).status, 200);
    const teacher = client();
    assert.equal((await teacher('/api/auth/login', { username: 'plan-teacher', password: 'teacher12345' })).status, 200);
    assert.equal((await teacher(endpoint, {})).status, 403);
    assert.equal((await admin('/api/admin/plans/999999/reextract', {})).status, 404);

    const manualText = '人工修订后的方案文本。'.repeat(10);
    assert.equal((await admin(`/api/admin/plans/${row.id}`, {
      major: row.major, trainingType: row.training_type, grade: row.grade, name: '手工命名的停用方案', extractedText: manualText, enabled: false,
    }, 'PUT')).status, 200);
    database.prepare("UPDATE training_plans SET updated_at = '2000-01-01 00:00:00' WHERE id = ?").run(row.id);
    const before = (await admin(`/api/admin/plans/${row.id}`)).data.plan;
    const originalBytes = readFileSync(path.join(dataDir, before.file_path));
    const adminId = database.prepare("SELECT id FROM users WHERE username = 'root-plan'").get().id;
    const courseId = Number(database.prepare(`INSERT INTO courses (user_id,name,major,training_type,student_grade)
      VALUES (?,'历史课程',?,'专转本',2024)`).run(adminId, row.major).lastInsertRowid);
    const submissionId = Number(database.prepare(`INSERT INTO submissions
      (course_id,user_id,seq,file_name,file_path,file_size,plan_id,status,verdict,result_json)
      VALUES (?,?,1,'historical.docx','uploads/historical.docx',100,?,'done','failed','{"summary":"历史结果"}')`)
      .run(courseId, adminId, row.id).lastInsertRowid);
    const historical = database.prepare('SELECT * FROM submissions WHERE id = ?').get(submissionId);
    assert.equal((await admin(endpoint, {})).status, 200);
    const after = (await admin(`/api/admin/plans/${row.id}`)).data.plan;
    assert.equal(after.extracted_text, text, 'Reextract uses the stored source, not manually edited text');
    assert.notEqual(after.updated_at, before.updated_at);
    for (const field of ['id', 'name', 'major', 'training_type', 'grade', 'enabled', 'file_name', 'file_path', 'created_at']) {
      assert.equal(after[field], before[field], field);
    }
    assert.deepEqual(readFileSync(path.join(dataDir, after.file_path)), originalBytes);
    assert.deepEqual(database.prepare('SELECT * FROM submissions WHERE id = ?').get(submissionId), historical);
    assert.equal((await admin('/api/admin/plans')).data.rows.length, 1, 'No duplicate plan is created');
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM audit_logs WHERE action = '重新提取培养方案'").get().count, 1);
  });

  await t.test('missing or invalid source files never overwrite the existing text', async () => {
    writeFileSync(path.join(dataDir, 'plans', 'invalid.docx'), 'Not a Word document');
    for (const [filePath, fileName, status] of [
      [null, null, 400],
      ['plans/missing.txt', 'missing.txt', 404],
      ['plans/invalid.docx', 'invalid.docx', 400],
    ]) {
      database.prepare('UPDATE training_plans SET file_path = ?, file_name = ?, extracted_text = ? WHERE id = ?')
        .run(filePath, fileName, '必须保留的人工修订', row.id);
      const before = (await admin(`/api/admin/plans/${row.id}`)).data.plan;
      const result = await admin(`/api/admin/plans/${row.id}/reextract`, {});
      assert.equal(result.status, status);
      assert.ok(result.data.error);
      assert.deepEqual((await admin(`/api/admin/plans/${row.id}`)).data.plan, before);
    }
  });

  await t.test('reextracting the supplied PDF repairs an already saved flattened matrix', { skip: !process.env.PDF_FIXTURE_PATH }, async () => {
    const file = new FormData();
    file.append('major', '物联网工程');
    file.append('trainingType', '普通本科');
    file.append('grade', '2025');
    file.append('file', new Blob([readFileSync(process.env.PDF_FIXTURE_PATH)]), '物联网工程培养方案.pdf');
    const uploaded = await admin('/api/admin/plans', file);
    assert.equal(uploaded.status, 200);
    database.prepare('UPDATE training_plans SET extracted_text = ? WHERE id = ?')
      .run('算法设计与分析 H M M', uploaded.data.id);
    assert.equal((await admin(`/api/admin/plans/${uploaded.data.id}/reextract`, {})).status, 200);
    const repaired = (await admin(`/api/admin/plans/${uploaded.data.id}`)).data.plan;
    assert.match(repaired.extracted_text, /算法设计与分析 2\.2=H 4\.2=M 4\.4=M/);
    assert.equal(repaired.major, '物联网工程');
  });
});
