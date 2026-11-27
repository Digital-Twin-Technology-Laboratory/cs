import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import { Document, Packer, Paragraph, Table, TableCell, TableRow } from 'docx';
import XLSX from 'xlsx';

function makeXlsx(sheets) {
  const wb = XLSX.utils.book_new();
  for (const [name, rows] of sheets) {
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows), name);
  }
  return XLSX.write(wb, { bookType: 'xlsx', type: 'buffer' });
}

test('person issue archive aggregates repeated syllabus checks, imports multi-format history, and updates live', { timeout: 45000 }, async (t) => {
  const dataDir = mkdtempSync(path.join(os.tmpdir(), 'cs-issue-archive-test-'));
  const reservation = http.createServer();
  reservation.listen(0, '127.0.0.1');
  await once(reservation, 'listening');
  const port = reservation.address().port;
  await new Promise((resolve) => reservation.close(resolve));

  const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', '--import', 'tsx', 'server/src/index.ts'], {
    env: { ...process.env, DATA_DIR: dataDir, HOST: '127.0.0.1', PORT: String(port) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  let database;
  child.stdout.on('data', (c) => { output += c; });
  child.stderr.on('data', (c) => { output += c; });
  t.after(async () => {
    if (child.exitCode === null) { child.kill(); await once(child, 'exit'); }
    database?.close();
    assert.match(path.basename(dataDir), /^cs-issue-archive-test-/);
    assert.equal(path.dirname(dataDir), path.resolve(os.tmpdir()));
    rmSync(dataDir, { recursive: true, force: true });
  });

  for (let i = 0; !output.includes('系统已启动'); i++) {
    assert.equal(child.exitCode, null, output);
    assert.ok(i < 120, output);
    await delay(50);
  }

  function client() {
    let cookie = '';
    return async (url, body, method = body === undefined ? 'GET' : 'POST') => {
      const form = body instanceof FormData;
      const res = await fetch(`http://127.0.0.1:${port}${url}`, {
        method,
        headers: { Cookie: cookie, ...(!form && body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
        body: body === undefined ? undefined : form ? body : JSON.stringify(body),
      });
      if (res.headers.get('set-cookie')) cookie = res.headers.get('set-cookie').split(';')[0];
      return { status: res.status, data: await res.json() };
    };
  }

  const admin = client();
  const wang = client();
  const qian = client();

  assert.equal((await admin('/api/auth/register', { username: 'root-admin', name: '管理员', password: 'admin12345' })).status, 200);
  const wangCreated = await admin('/api/admin/users', { username: 'T1001', name: '示例王老师', password: 'teacher12345' });
  const qianCreated = await admin('/api/admin/users', { username: 'T1002', name: '示例钱老师', password: 'teacher12345' });
  assert.equal(wangCreated.status, 200);
  assert.equal(qianCreated.status, 200);
  assert.equal((await wang('/api/auth/login', { username: 'T1001', password: 'teacher12345' })).status, 200);
  assert.equal((await qian('/api/auth/login', { username: 'T1002', password: 'teacher12345' })).status, 200);

  database = new DatabaseSync(path.join(dataDir, 'app.db'));
  database.exec('PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');

  const courseId = Number(database.prepare(
    'INSERT INTO courses (user_id, name, major, training_type, student_grade, plan_grade) VALUES (?, ?, ?, ?, 2025, 2025)',
  ).run(wangCreated.data.id, '示例程序设计', '计算机科学与技术', '普通本科').lastInsertRowid);

  const snapshot = JSON.stringify({
    name: '示例程序设计', major: '计算机科学与技术', trainingType: '普通本科', studentGrade: 2025, planGrade: 2025, adjustNote: '',
  });

  const insertSub = (seq, verdict, result, finishedAt) => Number(database.prepare(`
    INSERT INTO submissions (course_id, user_id, seq, file_name, file_path, file_size,
      course_snapshot, status, verdict, result_json, created_at, finished_at)
    VALUES (?, ?, ?, ?, 'uploads/mock.docx', 100, ?, 'done', ?, ?, ?, ?)
  `).run(courseId, wangCreated.data.id, seq, `v${seq}.docx`, snapshot, verdict, JSON.stringify(result), finishedAt, finishedAt).lastInsertRowid);

  const issueA = {
    nature: '重大问题', itemCodes: ['C01'], title: '总学时与分项学时不一致', location: '第三节学时分配表',
    problem: '理论34+实验34合计应为68，表中写成64。', advice: '将合计修改为68学时。', evidence: '合计：64',
  };
  const issueB = {
    nature: '明确问题', itemCodes: ['C02'], title: '考核比例未明确平时构成', location: '第五节考核方式',
    problem: '平时成绩占比40%，但未列出具体组成。', advice: '补充出勤、作业及实验占比。', evidence: '平时40%',
  };
  const issueC = {
    nature: '建议修改', itemCodes: ['S01'], title: '建议细化实验评分标准', location: '第六节实验环节',
    problem: '实验评分标准偏笼统。', advice: '按步骤列出给分点。', evidence: '实验占30%',
  };

  // 第1次检查：A + B；第2次检查：A + C（B已消除，C新增，A重复出现）
  insertSub(1, 'failed', { summary: '第1次', itemResults: [], issues: [issueA, issueB], toVerify: [] }, '2026-11-01 10:00:00');
  insertSub(2, 'failed', { summary: '第2次', itemResults: [], issues: [issueA, issueC], toVerify: [] }, '2026-11-02 10:00:00');

  const dossierBefore = await admin(`/api/issue-archive/people/user:${wangCreated.data.id}`);
  assert.equal(dossierBefore.status, 200);
  assert.equal(dossierBefore.data.summary.outlineCoursesCount, 1);
  assert.equal(dossierBefore.data.summary.outlineChecksCount, 2);
  assert.equal(dossierBefore.data.summary.outlineDistinctIssues, 3);
  assert.equal(dossierBefore.data.summary.outlineLatestRemaining, 2);
  assert.equal(dossierBefore.data.summary.outlineResolvedInLater, 1);

  const agg = dossierBefore.data.outlineCourses[0].aggregatedIssues;
  // 按 重大问题 -> 明确问题 -> 建议修改 排序（即使明确问题已消，也排在建议修改之前）
  assert.deepEqual(agg.map((i) => i.nature), ['重大问题', '明确问题', '建议修改']);
  const aggA = agg.find((i) => i.title === issueA.title);
  const aggB = agg.find((i) => i.title === issueB.title);
  const aggC = agg.find((i) => i.title === issueC.title);
  assert.deepEqual(aggA.seqs, [1, 2]);
  assert.equal(aggA.occurrenceCount, 2);
  assert.equal(aggA.presentInLatest, true);
  assert.deepEqual(aggB.seqs, [1]);
  assert.equal(aggB.presentInLatest, false);
  assert.deepEqual(aggC.seqs, [2]);
  assert.equal(aggC.presentInLatest, true);

  // 1) 上传含重复表头、空行、存在问题、多人授课与编号要点的 CSV
  const csvContent = [
    '学年,学期,课程代码,课程名称,教师名称,教学班组成,考试方式,存在问题',
    '2025-2026,2,CS101,示例程序设计,示例王老师,25计科1,笔试（闭卷）,"1.缺实验计划表；2.细目表有误。"',
    ',,,,,,,',
    '2025-2026,2,CS102,示例无问题课,示例王老师,25计科1,机考,',
    '学年,学期,课程代码,课程名称,教师名称,教学班组成,考试方式,存在问题',
    '2025-2026,2,CS201,示例联授课程,"示例王老师,示例钱老师",25计科2,大作业,平时成绩表缺表头',
    '2025-2026,2,CS301,示例外聘课程,External Teacher,25中外1,论文,评分标准模糊',
  ].join('\n');

  const csvForm = new FormData();
  csvForm.set('file', new Blob([csvContent], { type: 'text/csv' }), '往期抽查汇总.csv');
  const csvPreview = await admin('/api/materials/history/preview', csvForm);
  assert.equal(csvPreview.status, 200, JSON.stringify(csvPreview.data));
  assert.equal(csvPreview.data.rows.length, 3);
  assert.equal(csvPreview.data.matchedTeachers, 2);
  assert.equal(csvPreview.data.unmatchedTeachers, 1);

  const csvChoices = Object.fromEntries(csvPreview.data.rows.map((r) => [r.key, r.status === 'matched' ? r.candidates[0].key : 'original']));
  const csvImported = await admin('/api/materials/history/import', { previewId: csvPreview.data.previewId, choices: csvChoices });
  assert.equal(csvImported.status, 200, JSON.stringify(csvImported.data));
  assert.deepEqual(csvImported.data, { added: 3, duplicates: 0, skipped: 0 });

  // 2) 上传多行表头核查矩阵表 Excel (.xlsx)
  const matrixXlsx = makeXlsx([[
    '核查表',
    [
      ['课程组核查表'],
      ['', '', '', '', '', '', '教学大纲', '', '平时成绩记录表'],
      ['课程名称', '教师名称', '学年', '学期', '教学班组成', '检查人', '大纲审核人有手写签字', '考核评价标准合理', '平时成绩不少于2种方式'],
      ['示例程序设计', '示例王老师', '2025-2026', '2', '25计科1', '示例钱老师', '无手写签名', '是', '2种'],
      ['示例联授课程', '示例钱老师', '2025-2026', '2', '25计科2', '示例王老师', '✓', '无问题', '否'],
    ],
  ]]);
  const matrixForm = new FormData();
  matrixForm.set('file', new Blob([matrixXlsx]), '课程组核查矩阵.xlsx');
  const matrixPreview = await admin('/api/materials/history/preview', matrixForm);
  assert.equal(matrixPreview.status, 200, JSON.stringify(matrixPreview.data));
  assert.equal(matrixPreview.data.format, 'matrix');
  assert.equal(matrixPreview.data.rows.length, 2);
  assert.equal(matrixPreview.data.rows[0].category, '教学大纲');
  assert.equal(matrixPreview.data.rows[0].checkItem, '大纲审核人有手写签字');
  assert.equal(matrixPreview.data.rows[0].reviewer, '示例钱老师');
  const matrixChoices = Object.fromEntries(matrixPreview.data.rows.map((r) => [r.key, r.status === 'matched' ? r.candidates[0].key : 'original']));
  const matrixImported = await admin('/api/materials/history/import', { previewId: matrixPreview.data.previewId, choices: matrixChoices });
  assert.equal(matrixImported.status, 200);
  assert.deepEqual(matrixImported.data, { added: 2, duplicates: 0, skipped: 0 });

  // 3) 上传含表格的 Word (.docx)
  const docxBuffer = await Packer.toBuffer(new Document({
    sections: [{
      children: [
        new Paragraph('往期问题表'),
        new Table({
          rows: [
            new TableRow({ children: ['课程名称', '教师名称', '存在问题'].map((t) => new TableCell({ children: [new Paragraph(t)] })) }),
            new TableRow({ children: ['示例程序设计', '示例王老师', 'Word 表格中记录的大纲缺页'].map((t) => new TableCell({ children: [new Paragraph(t)] })) }),
          ],
        }),
      ],
    }],
  }));
  const docxForm = new FormData();
  docxForm.set('file', new Blob([docxBuffer]), '历史问题表.docx');
  const docxPreview = await admin('/api/materials/history/preview', docxForm);
  assert.equal(docxPreview.status, 200, JSON.stringify(docxPreview.data));
  assert.equal(docxPreview.data.rows.length, 1);
  const docxChoices = Object.fromEntries(docxPreview.data.rows.map((r) => [r.key, r.status === 'matched' ? r.candidates[0].key : 'original']));
  assert.equal((await admin('/api/materials/history/import', { previewId: docxPreview.data.previewId, choices: docxChoices })).status, 200);

  // 4) 核验人员目录与个人弹出档案（包含历史导入 + 多次大纲汇总 + 未建账号教师）
  const directory = await admin('/api/issue-archive/people?onlyWithIssues=1');
  assert.equal(directory.status, 200);
  const wangRow = directory.data.people.find((p) => p.userId === wangCreated.data.id);
  const extRow = directory.data.people.find((p) => p.name === 'External Teacher');
  assert.ok(wangRow);
  assert.ok(extRow);
  assert.equal(extRow.matchedAccount, false);
  assert.equal(wangRow.outlineDistinctIssues, 3);
  assert.equal(wangRow.historyIssuesCount, 4); // CSV 2条 + Matrix 1条 + DOCX 1条

  const wangDossier = await admin(`/api/issue-archive/people/${encodeURIComponent(wangRow.personKey)}`);
  assert.equal(wangDossier.status, 200);
  assert.equal(wangDossier.data.summary.historyIssuesCount, 4);
  const csvItem = wangDossier.data.historyCourses
    .flatMap((c) => c.groups.flatMap((g) => g.items))
    .find((it) => it.text.includes('缺实验计划表'));
  assert.deepEqual(csvItem.points, ['缺实验计划表', '细目表有误。']);

  // 5) 后续新增第3次检查出现新问题 D，立即体现在该人的问题记录里
  const issueD = {
    nature: '明确问题', itemCodes: ['C05'], title: '毕业要求指标点编号有误', location: '第二节课程目标',
    problem: '指标点 2.3 写成 3.2。', advice: '对照培养方案更正编号。', evidence: '支撑指标点 3.2',
  };
  insertSub(3, 'failed', { summary: '第3次', itemResults: [], issues: [issueD], toVerify: [] }, '2026-11-05 10:00:00');
  const wangAfter = await admin(`/api/issue-archive/people/${encodeURIComponent(wangRow.personKey)}`);
  assert.equal(wangAfter.data.summary.outlineChecksCount, 3);
  assert.equal(wangAfter.data.summary.outlineDistinctIssues, 4);
  assert.equal(wangAfter.data.summary.outlineLatestRemaining, 1);
  assert.equal(wangAfter.data.summary.outlineResolvedInLater, 3);
  assert.ok(wangAfter.data.outlineCourses[0].aggregatedIssues.some((i) => i.title === issueD.title && i.presentInLatest));

  // 6) 权限隔离：普通教师只能看自己，不能看他人，也不能导入或删来源
  const qianList = await qian('/api/issue-archive/people?onlyWithIssues=0');
  assert.equal(qianList.status, 200);
  assert.equal(qianList.data.canImport, false);
  assert.deepEqual(qianList.data.people.map((p) => p.userId), [qianCreated.data.id]);
  assert.equal((await qian(`/api/issue-archive/people/user:${wangCreated.data.id}`)).status, 404);
  assert.equal((await qian('/api/materials/history/preview-url', { url: 'https://docs.qq.com/sheet/Dtest' })).status, 403);
  assert.equal((await qian('/api/issue-archive/imports')).status, 403);

  // 7) 导入来源管理与按来源撤销
  const sources = await admin('/api/issue-archive/imports');
  assert.equal(sources.status, 200);
  assert.equal(sources.data.sources.length, 3);
  const removed = await admin('/api/issue-archive/imports', { source: '历史问题表.docx' }, 'DELETE');
  assert.equal(removed.status, 200);
  assert.equal(removed.data.removed, 1);
});
