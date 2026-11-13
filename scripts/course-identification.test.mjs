// Run: node --disable-warning=ExperimentalWarning --import tsx --test scripts/course-identification.test.mjs
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { Document, Packer, Paragraph, Table, TableCell, TableRow } from 'docx';
import { identifyCourse } from '../server/src/services/courseIdentification.ts';

const courses = ['数据库原理与设计', '计算机网络', '计算机网络课程设计', '高等数学（一）'];

test('file names match canonical courses without retaining teacher, dates or report suffixes', () => {
  for (const name of [
    '数据库原理与设计教学大纲问题及整改意见_20261103.docx',
    '汤家华-2024-1学期-《数据库原理与设计》教学大纲.docx',
  ]) {
    const result = identifyCourse(name, '', courses);
    assert.equal(result.name, '数据库原理与设计');
    assert.equal(result.source, '文件名');
    assert.equal(result.matched, true);
  }
  assert.equal(identifyCourse('计算机网络课程设计大纲.pdf', '', courses).name, '计算机网络课程设计');
  assert.equal(identifyCourse('高等数学(一) 教学大纲.pdf', '', courses).name, '高等数学（一）');
});

test('explicit course fields and titles take precedence over the file name and body references', () => {
  for (const text of [
    '课程名称：数据库原理与设计\n先修课程：计算机网络',
    '| 课程名称 | 数据库原理与设计 | 课程代码 | CS101 |',
    '课程名称\n数据库原理与设计',
    '# 《数据库原理与设计》课程教学大纲',
    '数据库原理与设计\n教学大纲',
  ]) {
    assert.equal(identifyCourse('计算机网络.docx', text, courses).name, '数据库原理与设计', text);
  }
  const unknown = identifyCourse('计算机网络.docx', '课程名称：新课程', courses);
  assert.equal(unknown.name, '新课程');
  assert.equal(unknown.matched, false);
  assert.equal(identifyCourse('file.pdf', '本课程以计算机网络为先修课，介绍数据库原理与设计。', courses).name, null);
  for (const text of ['课程教学大纲', '本科课程教学大纲', '某大学\n课程教学大纲']) {
    assert.equal(identifyCourse('数据库原理与设计教学大纲.docx', text, courses).name, '数据库原理与设计', 'Generic document headings are not course names');
  }
});

test('ambiguous or missing evidence requires manual selection instead of guessing', () => {
  const ambiguous = identifyCourse('数据库原理与设计-计算机网络.docx', '', courses);
  assert.equal(ambiguous.name, null);
  assert.deepEqual(ambiguous.candidates, ['数据库原理与设计', '计算机网络']);
  assert.equal(identifyCourse('大纲20261103.docx', '', courses).name, null);
  const quoted = identifyCourse('教师-《新课程》教学大纲.docx', '', courses);
  assert.equal(quoted.name, '新课程');
  assert.equal(quoted.matched, false);
  assert.equal(identifyCourse('file.pdf', '课程名称：计算机网络\n课程名称：数据库原理与设计', courses).name, null);
});

test('course preview extracts DOCX text without creating records, spending quota or requiring AI', async (t) => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const dataDir = mkdtempSync(path.join(root, '.tmp-course-identification-'));
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
    assert.match(path.basename(dataDir), /^\.tmp-course-identification-/);
    rmSync(dataDir, { recursive: true, force: true });
  });
  for (let i = 0; !output.includes('系统已启动'); i++) {
    assert.equal(child.exitCode, null, output);
    assert.ok(i < 100, output);
    await delay(50);
  }
  const base = `http://127.0.0.1:${port}`;
  const endpoint = `${base}/api/submissions/identify-course`;
  assert.equal((await fetch(endpoint, { method: 'POST', body: new FormData() })).status, 401);
  const registered = await fetch(`${base}/api/auth/register`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'courseadmin', name: 'Course Admin', password: 'admin12345' }),
  });
  assert.equal(registered.status, 200);
  const headers = { Cookie: registered.headers.get('set-cookie').split(';')[0] };
  database = new DatabaseSync(path.join(dataDir, 'app.db'));
  database.prepare('INSERT INTO outline_requirements (source_key, course_name) VALUES (?, ?)').run('course-preview', courses[0]);
  const quotaBefore = (await (await fetch(`${base}/api/auth/me`, { headers })).json()).checkQuota;
  const file = await Packer.toBuffer(new Document({ sections: [{ children: [
    new Table({ rows: [new TableRow({ children: ['课程名称', courses[0]].map((text) => new TableCell({ children: [new Paragraph(text)] })) })] }),
    new Paragraph('教学内容、课程目标与毕业要求的对应关系，以及学时和考核比例。'.repeat(5)),
  ] }] }));
  const form = new FormData();
  form.append('file', new Blob([file]), '教师-2024-计算机网络教学大纲.docx');
  const preview = await fetch(endpoint, { method: 'POST', headers, body: form });
  assert.equal(preview.status, 200);
  const result = await preview.json();
  assert.equal(result.name, courses[0]);
  assert.equal(result.source, '正文课程名称');
  assert.equal(result.matched, true);
  assert.equal(database.prepare('SELECT COUNT(*) AS n FROM courses').get().n, 0);
  assert.equal(database.prepare('SELECT COUNT(*) AS n FROM submissions').get().n, 0);
  assert.deepEqual((await (await fetch(`${base}/api/auth/me`, { headers })).json()).checkQuota, quotaBefore);
  assert.equal((await fetch(endpoint, { method: 'POST', headers, body: new FormData() })).status, 400);
  const broken = new FormData();
  broken.append('file', new Blob(['broken']), 'broken.docx');
  const failure = await fetch(endpoint, { method: 'POST', headers, body: broken });
  assert.equal(failure.status, 400);
  assert.match((await failure.json()).error, /无法读取/);
  await delay(50);
  assert.deepEqual(readdirSync(path.join(dataDir, 'tmp')), [], 'Preview files are removed on success and failure');
});
