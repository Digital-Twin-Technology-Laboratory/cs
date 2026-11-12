// Run: node --disable-warning=ExperimentalWarning --import tsx --test scripts/plan-matching.test.mjs
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import http from 'node:http';
import path from 'node:path';
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
  child.stdout.on('data', (chunk) => { output += chunk; });
  child.stderr.on('data', (chunk) => { output += chunk; });
  t.after(async () => {
    if (child.exitCode === null) { child.kill(); await once(child, 'exit'); }
    assert.equal(path.dirname(dataDir), root);
    assert.match(path.basename(dataDir), /^\.tmp-plan-matching-/);
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
});
