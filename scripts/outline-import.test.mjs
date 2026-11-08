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
  await writeFile(file.path, header + '课程A,AI基础及应用类课程组,人工智能,张老师,张老师,\n课程A,AI基础及应用类课程组,人工智能,李老师,李老师,\n');
  await assert.rejects(readOutlineFile(file), /平行班执笔人不一致/);
  await writeFile(file.path, header + '课程A,AI基础及应用类课程组,人工智能,张老师、李老师,张老师,\n');
  await assert.rejects(readOutlineFile(file), /多位执笔人/);
  await writeFile(file.path, '姓名,工号\n张老师,001\n');
  await assert.rejects(readOutlineFile(file), /课程清单必须包含/);
});

test('Tencent import accepts only public sheet URLs on the exact HTTPS host', async () => {
  for (const url of ['http://docs.qq.com/sheet/Dabc', 'https://docs.qq.com.example.com/sheet/Dabc', 'https://docs.qq.com:123/sheet/Dabc', 'https://user:password@docs.qq.com/sheet/Dabc', 'https://docs.qq.com/doc/Dabc', 'https://127.0.0.1/sheet/Dabc', 'not-a-url']) {
    await assert.rejects(readTencentOutline(url));
  }
});
