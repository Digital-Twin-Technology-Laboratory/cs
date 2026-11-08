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

test('unified login forces an initial password change before business access', async (t) => {
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
  function client() {
    let cookie = '';
    return async (url, body, method = body === undefined ? 'GET' : 'POST') => {
      const form = body instanceof FormData;
      const response = await fetch(`http://127.0.0.1:${port}${url}`, {
        method, headers: { Cookie: cookie, ...(!form && body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
        body: body === undefined ? undefined : form ? body : JSON.stringify(body),
      });
      if (response.headers.get('set-cookie')) cookie = response.headers.get('set-cookie').split(';')[0];
      return { status: response.status, data: await response.json() };
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
  assert.equal(first.data.user.must_change_password, 1);
  assert.equal((await teacher('/api/auth/me')).data.user.must_change_password, 1);
  assert.equal((await teacher('/api/progress')).status, 403);
  assert.equal((await teacher('/api/auth/profile', { name: 'Changed' }, 'PUT')).status, 403);
  assert.equal((await teacher('/api/auth/password', { oldPassword: 'incorrect', newPassword: 'changed12345' }, 'PUT')).status, 400);
  assert.equal((await teacher('/api/auth/password', { oldPassword: '12345678', newPassword: '12345678' }, 'PUT')).status, 400);
  const changed = await teacher('/api/auth/password', { oldPassword: '12345678', newPassword: 'changed12345' }, 'PUT');
  assert.equal(changed.status, 200);
  assert.equal(changed.data.user.must_change_password, 0);
  assert.equal((await teacher('/api/progress')).status, 200);
  assert.equal((await client()('/api/auth/login', { username: 'first001', password: '12345678' })).status, 400);
  assert.equal((await client()('/api/auth/login', { username: 'First Teacher', password: 'changed12345' })).status, 200);
  const named = client();
  assert.equal((await named('/api/auth/login', { username: 'Name Teacher', password: '12345678' })).data.user.must_change_password, 1);
  database.prepare("UPDATE users SET must_change_password = 0 WHERE username = 'name001'").run();
  assert.equal((await named('/api/auth/login', { username: 'Name Teacher', password: '12345678' })).data.user.must_change_password, 1, 'Legacy default passwords still force a change');
  assert.equal((await client()('/api/auth/login', { username: 'Duplicate Teacher', password: '12345678' })).status, 400);
  assert.equal((await client()('/api/auth/login', { username: 'duplicate001', password: '12345678' })).status, 200);
  const created = await admin('/api/admin/users', { username: 'created-admin', name: 'Created Admin', password: 'temporary12345', role: 'admin' });
  assert.equal(created.status, 200);
  const createdAdmin = client();
  assert.equal((await createdAdmin('/api/auth/login', { username: 'created-admin', password: 'temporary12345' })).data.user.must_change_password, 1);
  assert.equal((await createdAdmin('/api/admin/stats')).status, 403);
  assert.equal((await createdAdmin('/api/auth/password', { oldPassword: 'temporary12345', newPassword: 'permanent12345' }, 'PUT')).status, 200);
  assert.equal((await createdAdmin('/api/admin/stats')).status, 200);
  assert.equal((await admin(`/api/admin/users/${created.data.id}/reset-password`, { password: 'reset12345' })).status, 200);
  assert.equal((await createdAdmin('/api/admin/stats')).status, 403, 'A reset immediately forces existing sessions to change the password');
});
