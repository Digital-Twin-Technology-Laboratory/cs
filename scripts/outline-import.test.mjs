import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { readOutlineFile, readTencentOutline } from '../server/src/services/outlineImport.ts';

test('outline import merges parallel classes and keeps unassigned outlines', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'outline-import-'));
  t.after(async () => {
    assert.equal(path.dirname(directory), os.tmpdir());
    assert.match(path.basename(directory), /^outline-import-/);
    await rm(directory, { recursive: true });
  });
  const file = { path: path.join(directory, 'roster.csv'), originalname: 'roster.csv' };
  const header = '课程名称,课程组,审核专业,大纲执笔人,教师名称,执笔人工号\n';
  await writeFile(file.path, header + 'Python程序设计,程序设计与计算机系统类课程组,计算机科学与技术,张老师,张老师,001\npython程序设计,程序设计与计算机系统类课程组,计算机科学与技术,,李老师,\n待分配课程,待确认,人工智能,,王老师,\nPython程序设计,程序设计与计算机系统类课程组,人工智能,,张老师,\n');
  const result = await readOutlineFile(file);
  assert.equal(result.rows.length, 3);
  assert.equal(result.rows[0].teacher_names, '张老师、李老师');
  assert.equal(result.rows[0].writer_name, '张老师');
  assert.equal(result.rows[0].writer_identifier, '001');
  assert.equal(result.rows[1].writer_name, '');
  assert.equal(result.rows[1].course_group, '');
  assert.equal(result.warnings.length, 1);
  const parallelClasses = [
    '课程A,AI基础及应用类课程组,人工智能,张老师,任课教师甲,001',
    '课程A,AI基础及应用类课程组,人工智能,李老师,任课教师乙,002',
    '课程A,AI基础及应用类课程组,人工智能,张老师,任课教师丙,',
  ];
  await writeFile(file.path, header + parallelClasses.join('\n'));
  const separate = await readOutlineFile(file);
  assert.deepEqual(separate.rows.map((row) => [row.writer_name, row.writer_identifier, row.teacher_names]), [
    ['张老师', '001', '任课教师甲、任课教师丙'],
    ['李老师', '002', '任课教师乙'],
  ]);
  assert.notEqual(separate.rows[0].source_key, separate.rows[1].source_key);
  await writeFile(file.path, header + [...parallelClasses].reverse().join('\n'));
  const reordered = await readOutlineFile(file);
  assert.deepEqual(reordered.rows.map((row) => row.source_key).sort(), separate.rows.map((row) => row.source_key).sort());
  await writeFile(file.path, header + '课程A,AI基础及应用类课程组,人工智能,张老师、李老师,张老师,\n');
  await assert.rejects(readOutlineFile(file), /多位执笔人/);
  await writeFile(file.path, '姓名,工号\n张老师,001\n');
  await assert.rejects(readOutlineFile(file), /课程清单必须包含/);
});

test('cloud computing uses the transfer program without changing other course majors', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'outline-import-'));
  t.after(async () => {
    assert.equal(path.dirname(directory), os.tmpdir());
    assert.match(path.basename(directory), /^outline-import-/);
    await rm(directory, { recursive: true });
  });
  const file = { path: path.join(directory, 'roster.csv'), originalname: 'roster.csv' };
  const header = '课程名称,课程组,审核专业,大纲执笔人\n';
  const group = '程序设计与计算机系统类课程组';
  await writeFile(file.path, header + `云计算技术,${group},物联网工程,张老师\n物联网基础,${group},物联网工程,李老师\n`);
  const result = await readOutlineFile(file);
  assert.equal(result.rows[0].professional, '计算机科学与技术（专转本）');
  assert.equal(JSON.parse(result.rows[0].source_key)[1], '计算机科学与技术（专转本）');
  assert.equal(result.rows[1].professional, '物联网工程');
  await writeFile(file.path, header + `云计算技术,${group},计算机科学与技术（专转本）,张老师\n物联网基础,${group},物联网工程,李老师\n`);
  assert.deepEqual((await readOutlineFile(file)).rows, result.rows);
});

test('Tencent import accepts only public sheet URLs on the exact HTTPS host', async () => {
  for (const url of ['http://docs.qq.com/sheet/Dabc', 'https://docs.qq.com.example.com/sheet/Dabc', 'https://docs.qq.com:123/sheet/Dabc', 'https://user:password@docs.qq.com/sheet/Dabc', 'https://docs.qq.com/doc/Dabc', 'https://127.0.0.1/sheet/Dabc', 'not-a-url']) {
    await assert.rejects(readTencentOutline(url));
  }
});
