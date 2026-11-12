// Run: node --disable-warning=ExperimentalWarning --import tsx --test scripts/first-login.test.mjs
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

test('initial passwords allow direct access without a forced password change', async (t) => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const dataDir = mkdtempSync(path.join(root, '.tmp-first-login-'));
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
    assert.match(path.basename(dataDir), /^\.tmp-first-login-/);
    rmSync(dataDir, { recursive: true, force: true });
  });
  for (let i = 0; !output.includes('系统已启动'); i++) {
    assert.equal(child.exitCode, null, output);
    assert.ok(i < 100, output);
    await delay(50);
  }
  database = new DatabaseSync(path.join(dataDir, 'app.db'));
  database.exec('PRAGMA busy_timeout = 5000');
  function client() {
    let cookie = '';
    return async (url, body, method = body === undefined ? 'GET' : 'POST') => {
      const form = body instanceof FormData;
      const response = await fetch(`http://127.0.0.1:${port}${url}`, {
        method, headers: { Cookie: cookie, ...(!form && body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
        body: body === undefined ? undefined : form ? body : JSON.stringify(body),
      });
      if (response.headers.get('set-cookie')) cookie = response.headers.get('set-cookie').split(';')[0];
      const data = response.headers.get('content-type')?.includes('application/json')
        ? await response.json() : Buffer.from(await response.arrayBuffer());
      return { status: response.status, data, headers: response.headers };
    };
  }
  const admin = client();
  const registered = await admin('/api/auth/register', { username: 'root-test', name: 'Test Admin', password: 'admin12345' });
  assert.equal(registered.status, 200);
  assert.equal(registered.data.user.must_change_password, 0);
  const roster = new FormData();
  roster.append('file', new Blob(['姓名,工号\nFirst Teacher,first001\nName Teacher,name001\nDuplicate Teacher,duplicate001\nDuplicate Teacher,duplicate002']), 'teachers.csv');
  assert.equal((await admin('/api/admin/users/import', roster)).status, 200);
  const teacher = client();
  assert.equal((await teacher('/api/auth/login', { username: 'first001', name: 'First Teacher' })).status, 400);
  const first = await teacher('/api/auth/login', { username: 'first001', password: '12345678' });
  assert.equal(first.status, 200);
  assert.equal(first.data.user.must_change_password, 0);
  assert.equal((await teacher('/api/auth/me')).data.user.must_change_password, 0);
  assert.equal((await teacher('/api/progress')).status, 200);
  assert.equal((await teacher('/api/auth/profile', { department: 'Updated', name: 'First Teacher' }, 'PUT')).status, 200);
  assert.equal((await teacher('/api/auth/password', { oldPassword: 'incorrect', newPassword: 'changed12345' }, 'PUT')).status, 400);
  assert.equal((await teacher('/api/auth/password', { oldPassword: '12345678', newPassword: '12345678' }, 'PUT')).status, 400);
  const changed = await teacher('/api/auth/password', { oldPassword: '12345678', newPassword: 'changed12345' }, 'PUT');
  assert.equal(changed.status, 200);
  assert.equal(changed.data.user.must_change_password, 0);
  assert.equal((await teacher('/api/progress')).status, 200);
  assert.equal((await client()('/api/auth/login', { username: 'first001', password: '12345678' })).status, 400);
  assert.equal((await client()('/api/auth/login', { username: 'First Teacher', password: 'changed12345' })).status, 200);
  const named = client();
  assert.equal((await named('/api/auth/login', { username: 'Name Teacher', password: '12345678' })).data.user.must_change_password, 0);
  database.prepare("UPDATE users SET must_change_password = 1 WHERE username = 'name001'").run();
  assert.equal((await named('/api/progress')).status, 200, 'Legacy flags do not block existing sessions');
  assert.equal((await named('/api/auth/login', { username: 'Name Teacher', password: '12345678' })).data.user.must_change_password, 0, 'Login clears legacy forced-change flags');
  assert.equal((await client()('/api/auth/login', { username: 'Duplicate Teacher', password: '12345678' })).status, 400);
  assert.equal((await client()('/api/auth/login', { username: 'duplicate001', password: '12345678' })).status, 200);
  const created = await admin('/api/admin/users', { username: 'created-admin', name: 'Created Admin', password: 'temporary12345', role: 'admin' });
  assert.equal(created.status, 200);
  const createdAdmin = client();
  assert.equal((await createdAdmin('/api/auth/login', { username: 'created-admin', password: 'temporary12345' })).data.user.must_change_password, 0);
  database.prepare('UPDATE users SET must_change_password = 1 WHERE id = ?').run(created.data.id);
  assert.equal((await createdAdmin('/api/admin/stats')).status, 200, 'Legacy flags do not block administrators');
  assert.equal((await createdAdmin('/api/auth/password', { oldPassword: 'temporary12345', newPassword: 'permanent12345' }, 'PUT')).status, 200);
  assert.equal((await createdAdmin('/api/admin/stats')).status, 200);
  assert.equal((await admin(`/api/admin/users/${created.data.id}/reset-password`, { password: 'reset12345' })).status, 200);
  assert.equal((await createdAdmin('/api/admin/stats')).status, 200, 'Password resets do not force a password change');
  const resetLogin = await client()('/api/auth/login', { username: 'created-admin', password: 'reset12345' });
  assert.equal(resetLogin.status, 200);
  assert.equal(resetLogin.data.user.must_change_password, 0);

  const planText = '2025 training plan: course goals and graduation requirements.';
  const upload = new FormData();
  upload.append('major', '人工智能');
  upload.append('trainingType', '普通本科');
  upload.append('grade', '2025');
  upload.append('file', new Blob([planText]), '2025-plan.txt');
  const plan = await admin('/api/admin/plans', upload);
  assert.equal(plan.status, 200);
  const plans = (await named('/api/options')).data.plans;
  const listed = plans.find((row) => row.id === plan.data.id);
  assert.equal(listed.grade, 2025);
  assert.equal(listed.downloadable, 1);
  const downloadUrl = `/api/plans/${plan.data.id}/file`;
  assert.equal((await client()(downloadUrl)).status, 401);
  const downloaded = await named(downloadUrl);
  assert.equal(downloaded.status, 200);
  assert.match(downloaded.headers.get('content-disposition'), /attachment;.*2025-plan\.txt/);
  assert.equal(downloaded.data.toString(), planText);
  database.prepare('UPDATE training_plans SET enabled = 0 WHERE id = ?').run(plan.data.id);
  assert.equal((await named(downloadUrl)).status, 404);
  assert.ok(!(await named('/api/options')).data.plans.some((row) => row.id === plan.data.id));
  assert.equal((await named('/api/plans/999999/file')).status, 404);
  assert.equal((await named('/api/plans/invalid/file')).status, 400);
});
