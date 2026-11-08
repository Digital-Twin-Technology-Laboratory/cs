// Run: node --disable-warning=ExperimentalWarning --import tsx --test scripts/user-flows.test.mjs
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
    aiRequests.push({ model: request.model, authorization: req.headers.authorization });
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

  await t.test('initial passwords require a change; password login accepts ID and unique name', async () => {
    assert.equal((await teacher('/api/auth/login', { username: 'teacher001' })).status, 400);
    assert.equal((await teacher('/api/auth/login', { username: 'teacher001', name: 'Wrong Name' })).status, 400);
    const first = await teacher('/api/auth/login', { username: 'teacher001', password: '12345678' });
    assert.equal(first.status, 200);
    assert.equal(first.data.user.must_change_password, 1);
    assert.equal((await teacher('/api/options')).status, 403);
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
    assert.equal(resetLogin.data.user.must_change_password, 1);
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
    for (const content of ['教学大纲检查结果', '一 明确问题及重大问题', 'A01 考核权重不符', '二 建议修改项', 'B01 细化评价标准', '位置：第六部分', '问题：分项合计为90%', '整改意见：', '附 需核实事项']) assert.ok(text.includes(content), content);
    assert.doesNotMatch(text, /修改清单|C01|M03|Do not export/);
    const downloaded = await teacher(`/api/submissions/${id}/report.docx`);
    assert.equal(downloaded.status, 200);
    assert.ok(decodeURIComponent(downloaded.headers.get('content-disposition')).includes('检查结果'));
    const extracted = await mammoth.extractRawText({ buffer: downloaded.data });
    assert.match(extracted.value, /A01 考核权重不符/);
    assert.match(extracted.value, /B01 细化评价标准/);
    const converted = await mammoth.convertToHtml({ buffer: downloaded.data });
    assert.doesNotMatch(converted.value, /<table/);
    assert.match(converted.value, /<h1>一 明确问题及重大问题<\/h1>/);
    assert.match(converted.value, /<h2>A01 考核权重不符<\/h2>/);
    assert.equal((await client()(`/api/submissions/${id}/report.docx`)).status, 401);
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
