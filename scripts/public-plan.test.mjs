// Run: node --disable-warning=ExperimentalWarning --import tsx --test scripts/public-plan.test.mjs
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
import JSZip from 'jszip';
import { extractFile } from '../server/src/services/extract.ts';
import { identifyPlanMajor } from '../server/src/services/planIdentification.ts';
import { parsePublicPlanMatch, splitPublicPlan } from '../server/src/services/publicPlan.ts';

const planText = `【第1页】
学校本科培养方案目录，含人工智能、新闻学，不是专业标题。
【第18页】
汉语言文学 专业人才培养方案（2025 级）
毕业要求：文学专属指标。课程设置：公共基础。课程支撑矩阵：文学独有矩阵。
【第451页】
计算机科学与技术 专业人才培养方案（2025 级）
毕业要求：计算机专属指标。课程设置：公共基础。课程支撑矩阵：计算机独有矩阵。
【第487页】
物联网工程 专业人才培养方案（2025 级）
毕业要求：物联网专属指标。课程设置：公共基础。课程支撑矩阵：物联网独有矩阵。`;

test('public plan chapters are bounded by real titles, not the table of contents or body references', () => {
  const sections = splitPublicPlan(planText);
  assert.deepEqual(sections.map((section) => section.major), ['汉语言文学', '计算机科学与技术', '物联网工程']);
  assert.match(sections[1].text, /^【第451页】/);
  assert.match(sections[1].text, /计算机独有矩阵/);
  assert.doesNotMatch(sections[1].text, /文学独有矩阵|物联网独有矩阵|第487页/);
  assert.equal(identifyPlanMajor('苏州城市学院本科人才培养方案（2025级）.pdf', planText).major, '公共');
  assert.deepEqual(splitPublicPlan('本方案参照人工智能专业人才培养方案设置课程。'), []);
});

test('AI major matches must reference available chapters and quote actual syllabus evidence', () => {
  const syllabus = '适用专业：计算机科学与技术、物联网工程。';
  const majors = ['计算机科学与技术', '物联网工程'];
  const selected = { matches: majors.map((major) => ({ major, evidence: syllabus })), unresolved: [] };
  assert.deepEqual(parsePublicPlanMatch(JSON.stringify(selected), majors, syllabus), selected);
  assert.throws(() => parsePublicPlanMatch(JSON.stringify({ matches: [{ major: '新闻学', evidence: syllabus }], unresolved: [] }), majors, syllabus));
  assert.throws(() => parsePublicPlanMatch(JSON.stringify({ matches: [{ major: majors[0], evidence: '编造的依据' }], unresolved: [] }), majors, syllabus), /不是大纲原文/);
  assert.equal(parsePublicPlanMatch('{"matches":[],"unresolved":[]}', majors, syllabus).unresolved.length, 1);
});

test('supplied school PDF splits all 42 majors without mixing adjacent requirements or matrix pages', { skip: !process.env.PUBLIC_PLAN_FIXTURE_PATH }, async () => {
  const text = await extractFile(process.env.PUBLIC_PLAN_FIXTURE_PATH, '全校.pdf');
  const sections = splitPublicPlan(text);
  assert.equal(sections.length, 42);
  assert.equal(new Set(sections.map((section) => section.major)).size, 42);
  const iot = sections.find((section) => section.major === '物联网工程');
  assert.match(iot.text, /^【第487页】/);
  assert.match(iot.text, /毕业要求/);
  assert.match(iot.text, /【PDF矩阵列定位】/);
  assert.doesNotMatch(iot.text, /人工智能 专业人才培养方案|微电子科学与工程 专业人才培养方案|【第505页】/);
  assert.equal(identifyPlanMajor('全校.pdf', text).major, '公共');
});

test('public uploads locate majors first, check only selected chapters and persist evidence in reports', { timeout: 30000 }, async (t) => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const dataDir = mkdtempSync(path.join(root, '.tmp-public-plan-'));
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
  let matchResult;
  const checks = [];
  const mock = http.createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    const request = JSON.parse(body);
    const locating = request.messages[0].content.includes('公共课程适用专业定位助手');
    const codes = database.prepare('SELECT code FROM checklist_items WHERE version_id = (SELECT id FROM checklist_versions WHERE is_active = 1)').all();
    const result = locating ? matchResult : {
      summary: '模拟检查完成', itemResults: codes.map(({ code }) => ({ code, result: '未发现问题', note: '模拟结果' })), issues: [], toVerify: [],
    };
    checks.push({ locating, prompt: request.messages[1].content });
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ model: 'mock-public', choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(result) } }] }));
  });
  mock.listen(0, '127.0.0.1');
  await once(mock, 'listening');
  child.stdout.on('data', (chunk) => { output += chunk; });
  child.stderr.on('data', (chunk) => { output += chunk; });
  t.after(async () => {
    if (child.exitCode === null) { child.kill(); await once(child, 'exit'); }
    await new Promise((resolve) => mock.close(resolve));
    database?.close();
    assert.equal(path.dirname(dataDir), root);
    assert.match(path.basename(dataDir), /^\.tmp-public-plan-/);
    rmSync(dataDir, { recursive: true, force: true });
  });
  for (let i = 0; !output.includes('系统已启动'); i++) {
    assert.equal(child.exitCode, null, output);
    assert.ok(i < 100, output);
    await delay(50);
  }
  database = new DatabaseSync(path.join(dataDir, 'app.db'));
  database.exec('PRAGMA busy_timeout = 5000;');
  let cookie = '';
  const request = async (url, body, method = body === undefined ? 'GET' : 'POST') => {
    const form = body instanceof FormData;
    const res = await fetch(`http://127.0.0.1:${port}${url}`, {
      method, headers: { Cookie: cookie, ...(!form && body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
      body: body === undefined ? undefined : form ? body : JSON.stringify(body),
    });
    if (res.headers.get('set-cookie')) cookie = res.headers.get('set-cookie').split(';')[0];
    return { status: res.status, data: res.headers.get('content-type')?.includes('application/json') ? await res.json() : await res.text() };
  };
  assert.equal((await request('/api/auth/register', { username: 'publicadmin', name: 'Public Admin', password: 'admin12345' })).status, 200);
  assert.equal((await request('/api/admin/ai', {
    provider: 'openai', baseUrl: `http://127.0.0.1:${mock.address().port}/v1`, apiKey: 'test-only', model: 'mock-public',
  }, 'PUT')).status, 200);
  assert.ok((await request('/api/options')).data.majors.includes('公共'));
  const bad = new FormData();
  bad.append('major', '公共'); bad.append('trainingType', '普通本科');
  bad.append('file', new Blob(['没有专业章节标题的文本'.repeat(10)]), 'bad.txt');
  assert.equal((await request('/api/admin/plans', bad)).status, 400);
  const file = new FormData();
  file.append('major', '公共'); file.append('trainingType', '普通本科'); file.append('grade', '2025');
  file.append('file', new Blob([planText]), '全校培养方案.txt');
  const saved = await request('/api/admin/plans', file);
  assert.equal(saved.status, 200);
  const query = new URLSearchParams({ major: '公共', trainingType: '普通本科', grade: '2025' });
  assert.equal((await request(`/api/plan-match?${query}`)).data.plan.id, saved.data.id);
  query.set('grade', '2024');
  assert.equal((await request(`/api/plan-match?${query}`)).data.plan, null);
  database.prepare("INSERT INTO outline_requirements (source_key, course_name, professional) VALUES ('public-course', '公共基础', '计算机公共教学')").run();

  const upload = async (scope, major = '公共') => {
    const doc = await Packer.toBuffer(new Document({ sections: [{ children: [
      new Paragraph(`课程名称：公共基础\n${scope}`), new Paragraph('课程目标、教学内容、课时及考核方式。'.repeat(8)),
    ] }] }));
    const form = new FormData();
    for (const [key, value] of Object.entries({ name: '公共基础', major, studentGrade: '2024', planGrade: '2025' })) form.append(key, value);
    form.append('file', new Blob([doc]), '公共基础.docx');
    const response = await request('/api/submissions', form);
    assert.equal(response.status, 200);
    for (let i = 0; i < 150; i++) {
      const sub = (await request(`/api/submissions/${response.data.submissionId}`)).data.submission;
      if (sub.status === 'done' || sub.status === 'failed') return sub;
      await delay(50);
    }
    assert.fail('Public course did not finish');
  };
  const evidence = '适用专业：计算机科学与技术、物联网工程。';
  matchResult = { matches: ['计算机科学与技术', '物联网工程'].map((major) => ({ major, evidence })), unresolved: [] };
  const sub = await upload(evidence);
  assert.equal(sub.status, 'done', sub.error);
  assert.equal(sub.course.major, '公共', 'AI selection must not rewrite the progress major');
  assert.deepEqual(sub.course.publicPlanMatch, matchResult);
  assert.deepEqual(checks.map((check) => check.locating), [true, false]);
  assert.match(checks[1].prompt, /计算机独有矩阵/);
  assert.match(checks[1].prompt, /物联网独有矩阵/);
  assert.doesNotMatch(checks[1].prompt, /文学独有矩阵/);
  assert.ok(database.prepare('SELECT outline_requirement_id FROM submissions WHERE id = ?').get(sub.id).outline_requirement_id);
  assert.match((await request(`/api/submissions/${sub.id}/report.txt`)).data.text, /公共课程适用专业定位：[\s\S]*物联网工程；依据：适用专业/);
  const word = await fetch(`http://127.0.0.1:${port}/api/submissions/${sub.id}/report.docx`, { headers: { Cookie: cookie } });
  assert.equal(word.status, 200);
  const report = await JSZip.loadAsync(await word.arrayBuffer());
  assert.match(await report.file('word/document.xml').async('string'), /公共课程适用专业定位/);
  assert.match(await report.file('word/document.xml').async('string'), /物联网工程；依据：适用专业/);
  const quota = (await request('/api/auth/me')).data.checkQuota;
  assert.equal(quota.used, 1, 'The locating call does not consume a separate check allowance');

  checks.length = 0;
  matchResult = { matches: [], unresolved: ['大纲未提供明确适用专业。'] };
  const unknown = await upload('适用专业未填写。');
  assert.equal(unknown.status, 'done', unknown.error);
  assert.match(checks[1].prompt, /未预置对照培养方案/);
  assert.doesNotMatch(checks[1].prompt, /计算机独有矩阵|物联网独有矩阵|文学独有矩阵/);
  assert.ok(unknown.result.toVerify.some((item) => item.content === matchResult.unresolved[0]));

  checks.length = 0;
  matchResult = { matches: [{ major: '物联网工程', evidence: '不在大纲中的伪造适用范围' }], unresolved: [] };
  const forged = await upload(evidence);
  assert.equal(forged.status, 'failed');
  assert.match(forged.error, /不是大纲原文/);
  assert.equal(checks.length, 1, 'Unsupported evidence never reaches the checking stage');
  assert.equal((await request('/api/auth/me')).data.checkQuota.used, 2, 'A failed locating stage spends no allowance');

  checks.length = 0;
  const ordinary = await upload('适用专业：人工智能。', '人工智能');
  assert.equal(ordinary.status, 'done', ordinary.error);
  assert.deepEqual(checks.map((check) => check.locating), [false], 'Ordinary courses retain the one-stage flow');
  assert.equal(ordinary.course.publicPlanMatch, undefined);
});
