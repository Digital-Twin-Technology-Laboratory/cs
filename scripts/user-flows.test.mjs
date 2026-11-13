// Run: node --disable-warning=ExperimentalWarning --import tsx --test scripts/user-flows.test.mjs
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { Document, Packer, Paragraph } from 'docx';
import mammoth from 'mammoth';
import JSZip from 'jszip';

test('account activation, daily check quota and checklist download', { timeout: 45000 }, async (t) => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const dataDir = mkdtempSync(path.join(root, '.tmp-user-flows-'));
  const legacyDatabase = new DatabaseSync(path.join(dataDir, 'app.db'));
  legacyDatabase.exec('CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
  legacyDatabase.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run('ai', JSON.stringify({ provider: 'openai', model: 'legacy-model' }));
  legacyDatabase.close();
  let database;
  let hold = null;
  let release;
  let failAi = false;
  let aiCalls = 0;
  const aiRequests = [];
  const mock = http.createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    if (req.method === 'GET') {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ data: [{ id: 'mock' }, { id: 'mock-second' }] }));
      return;
    }
    const request = JSON.parse(body);
    aiRequests.push({ model: request.model, authorization: req.headers.authorization, messages: request.messages });
    aiCalls++;
    if (hold) await hold;
    res.setHeader('Content-Type', 'application/json');
    if (failAi) {
      res.writeHead(503).end(JSON.stringify({ error: { message: 'Simulated provider failure' } }));
      return;
    }
    const items = database.prepare('SELECT code FROM checklist_items WHERE version_id = (SELECT id FROM checklist_versions WHERE is_active = 1 ORDER BY id DESC LIMIT 1)').all();
    const result = { summary: 'Test result', itemResults: items.map(({ code }) => ({ code, result: '未发现问题', note: '' })), issues: [], toVerify: [] };
    res.end(JSON.stringify({ model: request.model, choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: JSON.stringify(result) } }] }));
  });
  mock.listen(0, '127.0.0.1');
  await once(mock, 'listening');
  const reservation = http.createServer();
  reservation.listen(0, '127.0.0.1');
  await once(reservation, 'listening');
  const port = reservation.address().port;
  await new Promise((resolve) => reservation.close(resolve));
  const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', '--import', 'tsx', 'server/src/index.ts'], {
    cwd: root, env: { ...process.env, DATA_DIR: dataDir, HOST: '127.0.0.1', PORT: String(port) }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (chunk) => { output += chunk; });
  child.stderr.on('data', (chunk) => { output += chunk; });
  t.after(async () => {
    release?.();
    if (child.exitCode === null) {
      child.kill();
      await once(child, 'exit');
    }
    database?.close();
    await new Promise((resolve) => mock.close(resolve));
    assert.equal(path.dirname(dataDir), root);
    assert.match(path.basename(dataDir), /^\.tmp-user-flows-/);
    rmSync(dataDir, { recursive: true, force: true });
  });
  async function waitFor(predicate) {
    for (let i = 0; i < 100; i++) {
      if (predicate()) return;
      assert.equal(child.exitCode, null, output);
      await delay(50);
    }
    assert.fail(`Timed out waiting for server state.\n${output}`);
  }
  await waitFor(() => output.includes('系统已启动'));
  database = new DatabaseSync(path.join(dataDir, 'app.db'));
  database.exec('PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  const migrated = database.prepare('SELECT * FROM ai_profiles WHERE is_active = 1').get();
  assert.equal(migrated.name, '默认配置');
  assert.equal(JSON.parse(migrated.settings_json).model, 'legacy-model');
  const base = `http://127.0.0.1:${port}`;
  function client() {
    let cookie = '';
    return async (url, body, method = body === undefined ? 'GET' : 'POST') => {
      const form = body instanceof FormData;
      const response = await fetch(base + url, {
        method, headers: { Cookie: cookie, ...(!form && body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
        body: body === undefined ? undefined : form ? body : JSON.stringify(body),
      });
      const setCookie = response.headers.get('set-cookie');
      if (setCookie) cookie = setCookie.split(';')[0];
      const data = response.headers.get('content-type')?.includes('application/json')
        ? await response.json() : Buffer.from(await response.arrayBuffer());
      return { status: response.status, data, headers: response.headers };
    };
  }
  const admin = client();
  const teacher = client();
  const adminRegistration = await admin('/api/auth/register', { username: 'testadmin', password: 'admin12345', name: 'Test Admin' });
  assert.equal(adminRegistration.status, 200);
  assert.equal(adminRegistration.data.user.role, 'admin');
  const config = { provider: 'openai', baseUrl: `http://127.0.0.1:${mock.address().port}/v1`, apiKey: 'test-only', model: 'mock', concurrency: 3 };
  assert.equal((await admin('/api/admin/ai', config, 'PUT')).status, 200);
  const roster = new FormData();
  roster.append('file', new Blob(['姓名,工号\n测试教师,teacher001\n同名教师,teacher002\n同名教师,teacher003\n旧版教师,teacher004\n重置教师,teacher005']), 'teachers.csv');
  assert.equal((await admin('/api/admin/users/import', roster)).data.imported, 5);
  const teacherId = database.prepare("SELECT id FROM users WHERE username = 'teacher001'").get().id;
  database.prepare("UPDATE users SET last_login_at = datetime('now','localtime','-1 day') WHERE id = ?").run(teacherId);

  await t.test('administrators can log in by name; duplicate names across roles still require employee ID', async () => {
    assert.equal((await client()('/api/auth/login', { username: 'Test Admin', password: 'admin12345' })).status, 200);
    const created = await admin('/api/admin/users', { username: 'promoted-teacher', name: 'Promoted Teacher', password: 'promoted12345' });
    assert.equal((await admin(`/api/admin/users/${created.data.id}`, { role: 'admin' }, 'PUT')).status, 200);
    assert.equal((await client()('/api/auth/login', { username: 'Promoted Teacher', password: 'promoted12345' })).status, 200);
    const duplicate = await admin('/api/admin/users', { username: 'duplicate-admin-name', name: 'Test Admin', password: 'duplicate12345' });
    const byName = await client()('/api/auth/login', { username: 'Test Admin', password: 'admin12345' });
    assert.equal(byName.status, 400);
    assert.match(byName.data.error, /同名/);
    assert.equal((await client()('/api/auth/login', { username: 'testadmin', password: 'admin12345' })).status, 200);
    assert.equal((await admin(`/api/admin/users/${duplicate.data.id}`, undefined, 'DELETE')).status, 200);
  });

  await t.test('initial passwords allow direct access; password login accepts ID and unique name', async () => {
    assert.equal((await teacher('/api/auth/login', { username: 'teacher001' })).status, 400);
    assert.equal((await teacher('/api/auth/login', { username: 'teacher001', name: 'Wrong Name' })).status, 400);
    const first = await teacher('/api/auth/login', { username: 'teacher001', password: '12345678' });
    assert.equal(first.status, 200);
    assert.equal(first.data.user.must_change_password, 0);
    assert.equal((await teacher('/api/options')).status, 200);
    assert.equal((await teacher('/api/auth/password', { oldPassword: '12345678', newPassword: 'changed12345' }, 'PUT')).status, 200);
    assert.equal((await teacher('/api/auth/login', { username: 'teacher001', name: '测试教师' })).status, 400);
    await teacher('/api/auth/logout', {});
    assert.equal((await teacher('/api/auth/login', { username: 'teacher001', password: '12345678' })).status, 400);
    const byId = await teacher('/api/auth/login', { username: 'teacher001', password: 'changed12345' });
    assert.equal(byId.status, 200);
    assert.equal(byId.data.user.must_change_password, 0);
    await teacher('/api/auth/logout', {});
    assert.equal((await teacher('/api/auth/login', { username: '测试教师', password: 'changed12345' })).status, 200);
    const duplicate = await client()('/api/auth/login', { username: '同名教师', password: '12345678' });
    assert.equal(duplicate.status, 400);
    assert.match(duplicate.data.error, /同名/);
    const resetId = database.prepare("SELECT id FROM users WHERE username = 'teacher005'").get().id;
    assert.equal((await admin(`/api/admin/users/${resetId}/reset-password`, { password: 'reset12345' })).status, 200);
    const resetUser = client();
    assert.equal((await resetUser('/api/auth/login', { username: 'teacher005', name: '重置教师' })).status, 400);
    const resetLogin = await resetUser('/api/auth/login', { username: 'teacher005', password: 'reset12345' });
    assert.equal(resetLogin.status, 200);
    assert.equal(resetLogin.data.user.must_change_password, 0);
    assert.equal((await resetUser('/api/auth/password', { oldPassword: 'reset12345', newPassword: 'reset-changed12345' }, 'PUT')).status, 200);
  });

  await t.test('old passwordless sessions no longer authorize requests', async () => {
    const legacy = client();
    const first = await legacy('/api/auth/login', { username: 'teacher004', password: '12345678' });
    assert.equal(first.status, 200);
    assert.equal((await legacy('/api/auth/password', { oldPassword: '12345678', newPassword: 'legacy12345' }, 'PUT')).status, 200);
    database.prepare("UPDATE sessions SET sess = json_set(sess, '$.passwordless', json('true')) WHERE json_extract(sess, '$.userId') = ?").run(first.data.user.id);
    assert.equal((await legacy('/api/options')).status, 401);
    assert.equal((await legacy('/api/auth/me')).data.user, null);
  });

  const snapshot = JSON.stringify({ name: 'Test Course', major: '人工智能', trainingType: '普通本科', studentGrade: 2025, planGrade: 2025, adjustNote: '' });
  const checklistId = database.prepare('SELECT id FROM checklist_versions WHERE is_active = 1').get().id;
  const syllabus = await Packer.toBuffer(new Document({ sections: [{ children: [new Paragraph('Course goals, teaching content, assessment weights and graduation requirements. '.repeat(10))] }] }));
  function uploadForm(buffer = syllabus) {
    const form = new FormData();
    for (const [key, value] of Object.entries(JSON.parse(snapshot))) form.append(key, String(value));
    form.append('file', new Blob([buffer]), 'syllabus.docx');
    return form;
  }
  function seedCourse(userId, name = 'Test Course') {
    return Number(database.prepare("INSERT INTO courses (user_id, name, major, training_type, student_grade) VALUES (?, ?, '人工智能', '普通本科', 2025)").run(userId, name).lastInsertRowid);
  }
  function seedSubmission(courseId, userId, status, finishedAt, verdict = null) {
    return Number(database.prepare(`INSERT INTO submissions (course_id, user_id, seq, file_name, file_path, file_size, extracted_text, checklist_version_id, course_snapshot, status, finished_at, verdict)
      VALUES (?, ?, 1, 'seed.docx', '', 0, 'Seed syllabus content', ?, ?, ?, ?, ?)`).run(courseId, userId, checklistId, snapshot, status, finishedAt, verdict).lastInsertRowid);
  }
  const today = database.prepare("SELECT datetime('now','localtime') AS now, datetime('now','localtime','-1 day') AS yesterday").get();

  await t.test('only completed checks count; concurrent upload and admin retries cannot exceed five', async () => {
    const courseId = seedCourse(teacherId);
    for (let i = 0; i < 4; i++) seedSubmission(courseId, teacherId, 'done', today.now, i % 2 ? 'failed' : 'passed');
    seedSubmission(courseId, teacherId, 'done', today.yesterday, 'passed');
    const failedId = seedSubmission(courseId, teacherId, 'failed', today.now);
    let quota = (await teacher('/api/auth/me')).data.checkQuota;
    assert.equal(quota.used, 4);
    assert.equal(quota.remaining, 1);
    hold = new Promise((resolve) => { release = resolve; });
    const responses = await Promise.all([teacher('/api/submissions', uploadForm()), teacher('/api/submissions', uploadForm())]);
    assert.deepEqual(responses.map((r) => r.status).sort(), [200, 429]);
    const acceptedId = responses.find((r) => r.status === 200).data.submissionId;
    quota = (await teacher('/api/auth/me')).data.checkQuota;
    assert.equal(quota.used, 4);
    assert.equal(quota.pending, 1);
    assert.equal(quota.remaining, 0);
    assert.equal((await teacher(`/api/submissions/${failedId}/recheck`, {})).status, 429);
    assert.equal((await admin(`/api/submissions/${failedId}/recheck`, {})).status, 429);
    assert.equal(database.prepare('SELECT COUNT(*) AS n FROM courses WHERE user_id = ?').get(teacherId).n, 2);
    release();
    hold = null;
    await waitFor(() => database.prepare('SELECT status FROM submissions WHERE id = ?').get(acceptedId).status === 'done');
    quota = (await teacher('/api/auth/me')).data.checkQuota;
    assert.equal(quota.used, 5);
    assert.equal(quota.pending, 0);
    const blocked = await teacher('/api/submissions', uploadForm());
    assert.equal(blocked.status, 429);
    assert.match(blocked.data.error, /联系管理员/);
    database.prepare("UPDATE submissions SET finished_at = datetime('now','localtime','-1 day') WHERE user_id = ? AND status = 'done'").run(teacherId);
    assert.equal((await teacher('/api/auth/me')).data.checkQuota.remaining, 5);
  });

  await t.test('document and provider failures release quota; a failed check can be retried', async () => {
    await admin('/api/admin/users', { username: 'retryuser', name: 'Retry Teacher', password: 'retry12345' });
    const retry = client();
    const login = await retry('/api/auth/login', { username: 'retryuser', password: 'retry12345' });
    const retryId = login.data.user.id;
    assert.equal((await retry('/api/auth/password', { oldPassword: 'retry12345', newPassword: 'retry-changed12345' }, 'PUT')).status, 200);
    assert.equal((await retry('/api/submissions', uploadForm(Buffer.from('broken docx')))).status, 400);
    assert.equal(database.prepare('SELECT COUNT(*) AS n FROM courses WHERE user_id = ?').get(retryId).n, 0);
    failAi = true;
    const uploaded = await retry('/api/submissions', uploadForm());
    assert.equal(uploaded.status, 200);
    const id = uploaded.data.submissionId;
    await waitFor(() => database.prepare('SELECT status FROM submissions WHERE id = ?').get(id).status === 'failed');
    assert.equal((await retry('/api/auth/me')).data.checkQuota.remaining, 5);
    failAi = false;
    assert.equal((await retry(`/api/submissions/${id}/recheck`, {})).status, 200);
    await waitFor(() => database.prepare('SELECT status FROM submissions WHERE id = ?').get(id).status === 'done');
    const quota = (await retry('/api/auth/me')).data.checkQuota;
    assert.equal(quota.used, 1);
    assert.equal(quota.remaining, 4);
  });

  await t.test('queue enforces the limit even for a pre-existing backlog', async () => {
    const userId = database.prepare("SELECT id FROM users WHERE username = 'teacher003'").get().id;
    const courseId = seedCourse(userId);
    for (let i = 0; i < 4; i++) seedSubmission(courseId, userId, 'done', today.now, 'passed');
    for (let i = 0; i < 3; i++) seedSubmission(courseId, userId, 'queued', null);
    const before = aiCalls;
    await admin('/api/admin/ai', config, 'PUT');
    await waitFor(() => database.prepare("SELECT COUNT(*) AS n FROM submissions WHERE user_id = ? AND status IN ('queued', 'running')").get(userId).n === 0);
    assert.equal(database.prepare("SELECT COUNT(*) AS n FROM submissions WHERE user_id = ? AND status = 'done'").get(userId).n, 5);
    assert.equal(aiCalls - before, 1);
  });

  await t.test('admins grant additive same-day quota; users cannot grant and yesterday does not carry over', async () => {
    database.prepare("UPDATE submissions SET finished_at = datetime('now','localtime') WHERE id IN (SELECT id FROM submissions WHERE user_id = ? AND status = 'done' ORDER BY id LIMIT 5)").run(teacherId);
    assert.equal((await teacher('/api/auth/me')).data.checkQuota.remaining, 0);
    assert.equal((await teacher(`/api/admin/users/${teacherId}/check-quota`, { amount: 3 })).status, 403);
    for (const amount of [0, -1, 1.5, 1001, '5']) {
      assert.equal((await admin(`/api/admin/users/${teacherId}/check-quota`, { amount })).status, 400);
    }
    assert.equal((await admin('/api/admin/users/999999/check-quota', { amount: 1 })).status, 404);
    let response = await admin(`/api/admin/users/${teacherId}/check-quota`, { amount: 2 });
    assert.equal(response.status, 200);
    assert.equal(response.data.checkQuota.limit, 7);
    assert.equal(response.data.checkQuota.remaining, 2);
    response = await admin(`/api/admin/users/${teacherId}/check-quota`, { amount: 1 });
    assert.equal(response.data.checkQuota.bonus, 3);
    const listed = await admin('/api/admin/users?q=teacher001');
    assert.equal(listed.data.rows[0].checkQuota.remaining, 3);
    hold = new Promise((resolve) => { release = resolve; });
    const uploaded = await teacher('/api/submissions', uploadForm());
    assert.equal(uploaded.status, 200);
    assert.equal((await teacher('/api/auth/me')).data.checkQuota.remaining, 2);
    release();
    hold = null;
    await waitFor(() => database.prepare('SELECT status FROM submissions WHERE id = ?').get(uploaded.data.submissionId).status === 'done');
    assert.equal((await teacher('/api/auth/me')).data.checkQuota.used, 6);
    database.prepare("UPDATE check_quota_grants SET quota_date = date('now','localtime','-1 day') WHERE user_id = ?").run(teacherId);
    database.prepare("UPDATE submissions SET finished_at = datetime('now','localtime','-1 day') WHERE user_id = ? AND status = 'done'").run(teacherId);
    const reset = (await teacher('/api/auth/me')).data.checkQuota;
    assert.equal(reset.limit, 5);
    assert.equal(reset.bonus, 0);
    assert.equal(reset.remaining, 5);
  });

  await t.test('AI profiles keep independent encrypted keys and prompts; activation controls real checks', async () => {
    const initial = (await admin('/api/admin/ai/profiles')).data;
    assert.equal(initial.profiles.length, 1);
    const original = initial.profiles[0];
    assert.equal(original.isActive, true);
    assert.equal(original.hasKey, true);
    assert.equal(original.apiKeyEnc, undefined);
    assert.equal((await teacher('/api/admin/ai/profiles')).status, 403);
    const created = await admin('/api/admin/ai/profiles', { ...config, name: 'Second provider', apiKey: 'second-secret', model: 'mock-second', systemPrompt: 'Custom check prompt' });
    assert.equal(created.status, 200);
    const second = created.data;
    assert.equal(second.isActive, false);
    assert.equal(second.apiKeyEnc, undefined);
    assert.equal((await admin('/api/admin/ai')).data.model, 'mock');
    const stored = database.prepare('SELECT settings_json FROM ai_profiles WHERE id = ?').get(second.id).settings_json;
    assert.ok(!stored.includes('second-secret'));
    const updated = await admin(`/api/admin/ai/profiles/${second.id}`, { ...config, apiKey: '', name: 'Second renamed', model: 'mock-second', systemPrompt: 'Updated prompt' }, 'PUT');
    assert.equal(updated.data.hasKey, true);
    assert.equal(updated.data.systemPrompt, 'Updated prompt');
    const models = await admin('/api/admin/ai/models', { provider: 'openai', baseUrl: config.baseUrl, profileId: second.id });
    assert.deepEqual(models.data.models, ['mock', 'mock-second']);
    assert.equal((await admin('/api/admin/ai/test', { ...config, apiKey: '', profileId: second.id, model: 'mock-second' })).status, 200);
    assert.equal(aiRequests.at(-1).authorization, 'Bearer second-secret');
    assert.equal((await admin('/api/admin/ai/test', { ...config, apiKey: '', model: 'mock-second' })).status, 400);
    assert.equal((await admin('/api/admin/ai/profiles', { ...config, apiKey: '', name: 'Missing key' })).status, 400);
    assert.equal((await admin(`/api/admin/ai/profiles/${second.id}/activate`, {})).status, 200);
    assert.equal((await admin('/api/admin/ai')).data.model, 'mock-second');
    assert.equal((await admin(`/api/admin/ai/profiles/${second.id}`, undefined, 'DELETE')).status, 400);
    const uploaded = await teacher('/api/submissions', uploadForm());
    assert.equal(uploaded.status, 200);
    await waitFor(() => database.prepare('SELECT status FROM submissions WHERE id = ?').get(uploaded.data.submissionId).status === 'done');
    assert.equal(aiRequests.at(-1).model, 'mock-second');
    assert.equal(aiRequests.at(-1).authorization, 'Bearer second-secret');
    assert.equal((await teacher(`/api/submissions/${uploaded.data.submissionId}`)).data.submission.ai_model, 'mock-second');
    assert.match(aiRequests.at(-1).messages[0].content, /Updated prompt/);
    assert.match(aiRequests.at(-1).messages[0].content, /不检查教学进度表/);
    assert.match(aiRequests.at(-1).messages[1].content, /跨材料条目在 itemResults 中记为“不适用”/);
    assert.equal((await admin(`/api/admin/ai/profiles/${original.id}/activate`, {})).status, 200);
    assert.equal((await admin('/api/admin/ai/test', { ...config, apiKey: '', profileId: original.id })).status, 200);
    assert.equal(aiRequests.at(-1).authorization, 'Bearer test-only');
    assert.equal((await admin(`/api/admin/ai/profiles/${second.id}`, undefined, 'DELETE')).status, 200);
    assert.equal((await admin('/api/admin/ai/profiles')).data.profiles.length, 1);
  });

  await t.test('check result downloads use the reference paragraph layout and A/B numbering', async () => {
    const courseId = seedCourse(teacherId);
    const id = seedSubmission(courseId, teacherId, 'done', today.now, 'failed');
    const issue = { nature: '明确问题', itemCodes: ['C01'], title: '考核权重不符', location: '第六部分', problem: '分项合计为90%。', advice: '核对并修正为100%。\n保留成绩依据。', evidence: 'Do not export this quote' };
    database.prepare('UPDATE submissions SET result_json = ? WHERE id = ?').run(JSON.stringify({ summary: 'Result summary', itemResults: [], issues: [issue, { ...issue, nature: '建议修改', title: '细化评价标准' }], toVerify: [{ itemCodes: ['M03'], location: '签字页', content: '请核实归档材料。' }] }), id);
    const text = (await teacher(`/api/submissions/${id}/report.txt`)).data.text;
    for (const content of ['教学大纲检查结果', '一 明确问题及重大问题', 'A01 考核权重不符', '二 建议完善项', 'B01 细化评价标准', '位置：第六部分', '问题：分项合计为90%', '整改意见：', '附 需核实事项', '可能存在遗漏或判断不准确', '自主判断是否采纳意见', '相关材料一致性提醒']) assert.ok(text.includes(content), content);
    assert.doesNotMatch(text, /修改清单|C01|M03|Do not export/);
    const downloaded = await teacher(`/api/submissions/${id}/report.docx`);
    assert.equal(downloaded.status, 200);
    assert.ok(decodeURIComponent(downloaded.headers.get('content-disposition')).includes('检查结果'));
    const extracted = await mammoth.extractRawText({ buffer: downloaded.data });
    assert.match(extracted.value, /A01 考核权重不符/);
    assert.match(extracted.value, /B01 细化评价标准/);
    assert.ok(extracted.value.indexOf('可能存在遗漏或判断不准确') < extracted.value.indexOf('检查对象：'));
    assert.ok(extracted.value.indexOf('相关材料一致性提醒') > extracted.value.indexOf('二 建议完善项'));
    const converted = await mammoth.convertToHtml({ buffer: downloaded.data });
    assert.doesNotMatch(converted.value, /<table/);
    assert.match(converted.value, /<h1>一 明确问题及重大问题<\/h1>/);
    assert.match(converted.value, /<h2>A01 考核权重不符<\/h2>/);
    assert.equal((await client()(`/api/submissions/${id}/report.docx`)).status, 401);
  });

  await t.test('teachers can preview and download the original syllabus template; login is required', async () => {
    const url = '/api/syllabus-template.docx';
    assert.equal((await client()(url)).status, 401);
    const response = await teacher(url);
    assert.equal(response.status, 200);
    assert.match(decodeURIComponent(response.headers.get('content-disposition')), /教学大纲模板\.docx/);
    assert.deepEqual(response.data, readFileSync(path.join(root, 'server/assets/syllabus-template.docx')));
    const extracted = (await mammoth.extractRawText({ buffer: response.data })).value;
    for (const type of ['课程教学大纲', '课程设计', '实习/实训/社会实践', '毕业论文（设计）']) assert.ok(extracted.includes(type), type);
    const previewUrl = '/api/syllabus-template/preview';
    assert.equal((await client()(previewUrl)).status, 401);
    const preview = await teacher(previewUrl);
    assert.equal(preview.status, 200);
    assert.match(preview.headers.get('content-type'), /text\/html/);
    assert.match(preview.headers.get('content-security-policy'), /default-src 'none'.*sandbox/);
    const html = preview.data.toString();
    for (const type of ['课程教学大纲', '课程设计', '实习/实训/社会实践', '毕业论文（设计）']) assert.ok(html.includes(type), type);
    assert.match(html, /<table>/);
  });

  await t.test('upload sequences follow course identity instead of a newly created course ID', async () => {
    const uploader = client();
    const registered = await uploader('/api/auth/register', { username: 'history-teacher', name: 'History Teacher', password: 'history12345' });
    const userId = registered.data.user.id;
    assert.equal((await admin(`/api/admin/users/${userId}/check-quota`, { amount: 5 })).status, 200);
    const expected = [];
    const upload = async (patch, sequence) => {
      const form = uploadForm();
      form.set('name', 'Revision Course');
      for (const [key, value] of Object.entries(patch)) form.set(key, String(value));
      form.set('file', new Blob([syllabus]), `revision-${expected.length}.docx`);
      const result = await uploader('/api/submissions', form);
      assert.equal(result.status, 200, JSON.stringify(result.data));
      const id = result.data.submissionId;
      await waitFor(() => database.prepare('SELECT status FROM submissions WHERE id = ?').get(id).status === 'done');
      assert.equal((await uploader(`/api/submissions/${id}`)).data.submission.seq, sequence);
      expected.push({ id, seq: sequence });
    };
    await upload({}, 1);
    await upload({}, 2);
    await upload({}, 3);
    await upload({ name: 'revision course', planGrade: 2024 }, 4);
    await upload({ studentGrade: 2024 }, 1);
    await upload({ major: '物联网工程' }, 1);
    const requirementIds = ['group-a', 'group-b'].map((group) => Number(database.prepare(
      "INSERT INTO outline_requirements (source_key, course_name, course_group, professional) VALUES (?, 'Bound Revision', ?, '人工智能')",
    ).run(`history-${group}`, group).lastInsertRowid));
    await upload({ name: 'Bound Revision', outlineRequirementId: requirementIds[0] }, 1);
    await upload({ name: 'Bound Revision', outlineRequirementId: requirementIds[0] }, 2);
    await upload({ name: 'Bound Revision', outlineRequirementId: requirementIds[1] }, 1);
    const rows = (await uploader('/api/submissions')).data.rows;
    assert.deepEqual(rows.map(({ id, seq }) => ({ id, seq })), [...expected].reverse());
    const other = client();
    await other('/api/auth/register', { username: 'history-other', name: 'History Other', password: 'history12345' });
    const form = uploadForm();
    form.set('name', 'Revision Course');
    const result = await other('/api/submissions', form);
    assert.equal(result.status, 200);
    await waitFor(() => database.prepare('SELECT status FROM submissions WHERE id = ?').get(result.data.submissionId).status === 'done');
    assert.equal((await other(`/api/submissions/${result.data.submissionId}`)).data.submission.seq, 1);
    const before = database.prepare('SELECT verdict, result_json, file_path FROM submissions WHERE user_id = ? ORDER BY id').all(userId);
    database.prepare('UPDATE submissions SET seq = 1 WHERE user_id = ?').run(userId);
    database.prepare("DELETE FROM settings WHERE key = 'submission_sequences_initialized'").run();
    const migrated = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', '--import', 'tsx', 'server/src/db.ts'], {
      cwd: root, env: { ...process.env, DATA_DIR: dataDir }, encoding: 'utf8', timeout: 10000,
    });
    assert.equal(migrated.status, 0, migrated.stderr);
    assert.deepEqual(database.prepare('SELECT id, seq FROM submissions WHERE user_id = ? ORDER BY id').all(userId).map((r) => ({ ...r })), expected);
    assert.deepEqual(database.prepare('SELECT verdict, result_json, file_path FROM submissions WHERE user_id = ? ORDER BY id').all(userId), before);
  });

  await t.test('manual numbers persist with admin-only writes and do not alter upload results', async () => {
    const statistic = { scope: 'college', name: JSON.stringify(['', '', '', 'summary', 'uploaded']), value: 9 };
    const id = database.prepare("SELECT id FROM submissions WHERE user_id = ? AND status = 'done' AND result_json IS NOT NULL LIMIT 1").get(teacherId).id;
    const before = database.prepare('SELECT verdict, result_json, confirmed_at FROM submissions WHERE id = ?').get(id);
    assert.equal((await client()('/api/statistic-overrides')).status, 401);
    assert.equal((await client()('/api/statistic-overrides', statistic, 'PUT')).status, 401);
    assert.equal((await teacher('/api/statistic-overrides', statistic, 'PUT')).status, 403);
    for (const [username, name] of [['number-tang', '汤家华'], ['number-liu', '柳宝华']]) {
      await admin('/api/admin/users', { username, name, password: 'number12345' });
      const request = client();
      const login = await request('/api/auth/login', { username, password: 'number12345' });
      const userId = login.data.user.id;
      await request('/api/auth/password', { oldPassword: 'number12345', newPassword: 'number-changed12345' }, 'PUT');
      assert.equal((await admin(`/api/admin/users/${userId}`, { college_role: 'teaching' }, 'PUT')).status, 200);
      if (!database.prepare('PRAGMA table_info(users)').all().some((column) => column.name === 'demo_editor')) {
        database.exec('ALTER TABLE users ADD COLUMN demo_editor INTEGER NOT NULL DEFAULT 0');
      }
      database.prepare('UPDATE users SET demo_editor = 1 WHERE id = ?').run(userId);
      assert.equal((await request('/api/auth/me')).data.user.demo_editor, undefined);
      assert.equal((await request('/api/statistic-overrides', statistic, 'PUT')).status, 403);
      if (username === 'number-tang') {
        assert.equal((await admin(`/api/admin/users/${userId}`, { role: 'admin' }, 'PUT')).status, 200);
        assert.equal((await request('/api/statistic-overrides', statistic, 'PUT')).status, 200);
        assert.equal((await admin(`/api/admin/users/${userId}`, { role: 'user' }, 'PUT')).status, 200);
        assert.equal((await request('/api/statistic-overrides', statistic, 'PUT')).status, 403);
      }
    }
    assert.equal((await admin('/api/statistic-overrides', statistic, 'PUT')).status, 200);
    assert.equal(database.prepare('SELECT value FROM statistic_overrides WHERE scope = ? AND name = ?').get(statistic.scope, statistic.name).value, 9);
    assert.ok((await admin('/api/statistic-overrides')).data.rows.some((row) => row.scope === 'college' && row.value === 9));
    assert.ok(!(await teacher('/api/statistic-overrides')).data.rows.some((row) => row.scope === 'college'));
    const personal = { scope: `personal:${teacherId}`, name: 'uploaded', value: 3 };
    assert.equal((await admin('/api/statistic-overrides', personal, 'PUT')).status, 200);
    assert.deepEqual((await teacher('/api/statistic-overrides')).data.rows, [personal]);
    for (const value of [-1, 1.5, '9']) {
      assert.equal((await admin('/api/statistic-overrides', { ...statistic, value }, 'PUT')).status, 400);
    }
    const reopened = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', '--import', 'tsx', 'server/src/db.ts'], {
      cwd: root, env: { ...process.env, DATA_DIR: dataDir }, encoding: 'utf8', timeout: 10000,
    });
    assert.equal(reopened.status, 0, reopened.stderr);
    assert.ok((await teacher('/api/statistic-overrides')).data.rows.some((row) => row.value === 3));
    assert.deepEqual(database.prepare('SELECT verdict, result_json, confirmed_at FROM submissions WHERE id = ?').get(id), before);
    assert.equal((await admin('/api/statistic-overrides', { ...statistic, value: null }, 'PUT')).status, 200);
    assert.ok(!(await admin('/api/statistic-overrides')).data.rows.some((row) => row.scope === 'college'));
    assert.ok(database.prepare("SELECT 1 FROM audit_logs WHERE action = '修改统计数字'").get());
  });

  await t.test('admins and college teaching staff can persist record edits, with reports and progress following the saved verdict', async () => {
    const teaching = client();
    const editor = (await teaching('/api/auth/register', { username: 'record-editor', name: 'Record Editor', password: 'editor12345' })).data.user;
    assert.equal(editor.role, 'user');
    assert.equal((await admin(`/api/admin/users/${editor.id}`, { college_role: 'teaching' }, 'PUT')).status, 200);
    const requirementId = Number(database.prepare("INSERT INTO outline_requirements (source_key, course_name, professional, writer_user_id) VALUES ('record-edit', 'Editable Course', '人工智能', ?)").run(teacherId).lastInsertRowid);
    const form = uploadForm();
    form.set('name', 'Editable Course');
    form.set('outlineRequirementId', String(requirementId));
    const uploaded = await teacher('/api/submissions', form);
    assert.equal(uploaded.status, 200);
    const id = uploaded.data.submissionId;
    await waitFor(() => database.prepare('SELECT status FROM submissions WHERE id = ?').get(id).status === 'done');
    const result = { summary: 'Original AI summary', itemResults: [], issues: [{ nature: '明确问题', itemCodes: [], title: 'Original issue', location: 'Section 1', problem: 'Original problem', advice: 'Original advice' }], toVerify: [] };
    database.prepare("UPDATE submissions SET verdict = 'failed', result_json = ? WHERE id = ?").run(JSON.stringify(result), id);
    assert.equal((await teacher(`/api/submissions/${id}/confirm`, {})).status, 200);
    const before = database.prepare('SELECT * FROM submissions WHERE id = ?').get(id);
    const transferPlanId = Number(database.prepare("INSERT INTO training_plans (major, training_type, grade, name) VALUES ('计算机科学与技术（专转本）', '专转本', 2025, 'Transfer Plan')").run().lastInsertRowid);
    const url = `/api/submissions/${id}`;
    assert.equal((await client()(url, { verdict: 'passed' }, 'PUT')).status, 401);
    assert.equal((await teacher(url, { verdict: 'passed' }, 'PUT')).status, 403);
    assert.equal((await teacher(`${url}/sequence`, { seq: 5 }, 'PUT')).status, 403);
    assert.equal((await admin(`/api/admin/submissions/${id}/sequence`, { seq: 5 }, 'PUT')).status, 404);
    for (const body of [{}, { verdict: 'invalid' }, { major: 'invalid' }, { student_grade: 2030 }, { file_name: ' ' }, { course_name: '' }, { result_json: '{}' }, { status: 'done' }]) {
      assert.equal((await teaching(url, body, 'PUT')).status, 400);
    }
    assert.equal((await teaching('/api/submissions/999999', { verdict: 'passed' }, 'PUT')).status, 404);
    for (const status of ['queued', 'running', 'failed']) {
      database.prepare('UPDATE submissions SET status = ? WHERE id = ?').run(status, id);
      assert.equal((await teaching(url, { verdict: 'passed' }, 'PUT')).status, status === 'failed' ? 400 : 409);
    }
    database.prepare("UPDATE submissions SET status = 'done' WHERE id = ?").run(id);
    const edit = { course_name: 'Edited Course', major: '计算机科学与技术（专转本）', student_grade: 2024, file_name: 'edited.docx', verdict: 'passed' };
    assert.equal((await teaching(url, edit, 'PUT')).status, 200);
    assert.equal((await teaching(`${url}/sequence`, { seq: 0 }, 'PUT')).status, 400);
    assert.equal((await teaching('/api/submissions/999999/sequence', { seq: 5 }, 'PUT')).status, 404);
    assert.equal((await teaching(`${url}/sequence`, { seq: 5 }, 'PUT')).status, 200);
    const saved = database.prepare('SELECT * FROM submissions WHERE id = ?').get(id);
    for (const key of ['result_json', 'file_path', 'file_size', 'extracted_text', 'confirmed_at', 'confirmed_by', 'outline_requirement_id', 'status']) assert.equal(saved[key], before[key], key);
    assert.equal(saved.plan_id, transferPlanId);
    assert.equal(saved.plan_name, 'Transfer Plan');
    assert.ok(saved.verdict_edited_at);
    assert.equal(saved.verdict_edited_by, 'Record Editor（record-editor）');
    const detail = (await teacher(url)).data.submission;
    assert.equal(detail.verdict, 'passed');
    assert.equal(detail.seq, 5);
    assert.equal(detail.course.name, edit.course_name);
    assert.equal(detail.course.major, edit.major);
    assert.equal(detail.course.trainingType, '专转本');
    assert.equal(detail.course.studentGrade, 2024);
    assert.equal(detail.file_name, edit.file_name);
    assert.deepEqual(detail.result, result);
    assert.equal((await teacher('/api/progress')).data.courses.find((course) => course.id === requirementId).verdict, 'passed');
    const course = (await teacher(`/api/courses/${before.course_id}`)).data.course;
    assert.equal(course.name, edit.course_name);
    assert.equal(course.major, edit.major);
    assert.equal(course.student_grade, 2024);
    assert.equal(course.training_type, '专转本');
    const text = (await teacher(`${url}/report.txt`)).data.text;
    const word = await teacher(`${url}/report.docx`);
    assert.equal(word.status, 200);
    const extracted = (await mammoth.extractRawText({ buffer: word.data })).value;
    for (const report of [text, extracted]) {
      for (const content of ['Edited Course', 'Transfer Plan', '检查结论：检查通过', '检查次数：第5次', 'Record Editor（record-editor）', '手工修改', 'Original issue', 'Original problem']) assert.ok(report.includes(content), content);
    }
    assert.deepEqual((await teacher(`${url}/file`)).data, syllabus);
    const audit = database.prepare("SELECT detail FROM audit_logs WHERE action = '修改上传记录' AND target = ? ORDER BY id DESC LIMIT 1").get(`记录#${id}`);
    assert.equal(JSON.parse(audit.detail).before.verdict, 'failed');
    assert.equal(JSON.parse(audit.detail).after.verdict, 'passed');
    assert.ok(database.prepare("SELECT 1 FROM audit_logs WHERE action = '修改上传次数' AND target = ?").get(`记录#${id}`));
    assert.equal((await teaching(url, { major: '人工智能', verdict: 'failed' }, 'PUT')).status, 200);
    assert.equal((await teacher(url)).data.submission.course.trainingType, '普通本科');
    assert.equal((await teacher('/api/progress')).data.courses.find((course) => course.id === requirementId).verdict, 'failed');
    assert.equal((await admin(`/api/admin/users/${editor.id}`, { college_role: 'program' }, 'PUT')).status, 200);
    assert.equal((await teaching(url, { verdict: 'passed' }, 'PUT')).status, 403);
    assert.equal((await teaching(`${url}/sequence`, { seq: 6 }, 'PUT')).status, 403);
    assert.equal((await admin(url, { verdict: 'passed' }, 'PUT')).status, 200);
    assert.equal((await admin(`${url}/sequence`, { seq: 6 }, 'PUT')).status, 200);
    const adminEdit = (await teacher(url)).data.submission;
    assert.equal(adminEdit.verdict, 'passed');
    assert.equal(adminEdit.seq, 6);
    assert.equal(adminEdit.verdict_edited_by, 'Test Admin（testadmin）');
  });

  await t.test('download includes all active checklist content and follows version changes', async () => {
    assert.equal((await client()('/api/checklist.docx')).status, 401);
    const { checklist } = (await teacher('/api/checklist')).data;
    const response = await teacher('/api/checklist.docx');
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type'), /wordprocessingml/);
    assert.match(response.headers.get('content-disposition'), /attachment/);
    const { value } = await mammoth.extractRawText({ buffer: response.data });
    const normalized = value.replace(/\s/g, '');
    for (const text of [checklist.name, checklist.intro, checklist.rules, ...checklist.items.flatMap((item) => [item.code, item.title, item.content]), ...Object.values(checklist.notes).flatMap((note) => [note.before, note.after])]) {
      assert.ok(normalized.includes(text.replace(/\s/g, '')), `Missing checklist text: ${text}`);
    }
    database.exec('UPDATE checklist_versions SET is_active = 0');
    database.prepare("INSERT INTO checklist_versions (name, intro, rules, is_active) VALUES ('Updated checklist', 'New active version', 'Updated rules', 1)").run();
    const latest = await teacher('/api/checklist.docx');
    const updated = await mammoth.extractRawText({ buffer: latest.data });
    assert.match(updated.value, /Updated checklist/);
    assert.match(updated.value, /Updated rules/);
    assert.equal((await teacher('/api/options')).data.checklist.name, 'Updated checklist');
  });

  await t.test('user supervision dropdown assignments preserve dual identities and update role filters', async () => {
    const settings = (await admin('/api/admin/supervision-roles')).data;
    const groups = settings.groups.slice(0, 2).map((g) => g.group);
    const first = (await admin('/api/admin/users', { username: 'dropdown-first', name: 'Dropdown First', password: 'dropdown12345' })).data.id;
    const second = (await admin('/api/admin/users', { username: 'dropdown-second', name: 'Dropdown Second', password: 'dropdown12345' })).data.id;
    const assigned = await admin(`/api/admin/users/${first}`, { college_role: 'program', led_groups: groups }, 'PUT');
    assert.equal(assigned.status, 200);
    assert.equal(assigned.data.user.role, 'user');
    assert.equal(assigned.data.user.college_role, 'program');
    assert.deepEqual(assigned.data.user.led_groups, [...groups].sort());
    assert.deepEqual((await admin('/api/admin/users?q=dropdown-first')).data.rows[0].led_groups, [...groups].sort());
    for (const role of ['program', 'group_leader']) {
      const result = (await admin(`/api/admin/users?q=dropdown-&role=${role}`)).data;
      assert.equal(result.total, 1);
      assert.equal(result.rows[0].id, first);
    }
    assert.equal((await admin('/api/admin/users?q=dropdown-first&role=user')).data.total, 0);
    for (const led_groups of [['未知组'], [groups[0], groups[0]]]) {
      assert.equal((await admin(`/api/admin/users/${first}`, { college_role: 'none', led_groups }, 'PUT')).status, 400);
    }
    const regular = client();
    assert.equal((await regular('/api/auth/login', { username: 'dropdown-second', password: 'dropdown12345' })).status, 200);
    assert.equal((await regular('/api/auth/password', { oldPassword: 'dropdown12345', newPassword: 'dropdown-changed12345' }, 'PUT')).status, 200);
    assert.equal((await regular(`/api/admin/users/${second}`, { led_groups: groups }, 'PUT')).status, 403);
    const transferred = await admin(`/api/admin/users/${second}`, { led_groups: [groups[0]] }, 'PUT');
    assert.equal(transferred.status, 200);
    const firstRow = (await admin('/api/admin/users?q=dropdown-first')).data.rows[0];
    assert.equal(firstRow.college_role, 'program');
    assert.deepEqual(firstRow.led_groups, [groups[1]]);
    assert.equal((await admin('/api/admin/users?q=dropdown-&role=group_leader')).data.total, 2);
    assert.equal((await admin(`/api/admin/users/${first}`, { led_groups: [] }, 'PUT')).data.user.college_role, 'program');
    const cleared = await admin(`/api/admin/users/${second}`, { college_role: 'none', led_groups: [] }, 'PUT');
    assert.deepEqual(cleared.data.user.led_groups, []);
    assert.equal((await admin('/api/admin/users?q=dropdown-&role=group_leader')).data.total, 0);
    assert.equal((await admin('/api/admin/users?q=dropdown-second&role=user')).data.total, 1);
  });

});
