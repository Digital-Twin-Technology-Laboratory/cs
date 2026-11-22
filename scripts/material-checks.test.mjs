import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import { Document, Packer, Paragraph, Table, TableCell, TableRow } from 'docx';
import JSZip from 'jszip';

const scope = { level: 'course', title: '程序设计', term: '2026-2027 第1学期', section: '1班',
  major: '计算机科学与技术', teaching: 'theory', assessments: ['other'], flags: [], rounding: 'integer' };

const word = (paragraphs, rows) => Packer.toBuffer(new Document({ sections: [{ children: [
  ...paragraphs.map((text) => new Paragraph(text)),
  ...(rows ? [new Table({ rows: rows.map((row) => new TableRow({ children: row.map((s) => new TableCell({ children: [new Paragraph(s)] })) })) })] : []),
] }] }));

function xlsx(rows) {
  const zip = new JSZip();
  const sheet = rows.map((cells, i) => `<row r="${i + 1}">${cells.map((cell, j) =>
    `<c r="${String.fromCharCode(65 + j)}${i + 1}" t="inlineStr"><is><t xml:space="preserve">${cell}</t></is></c>`).join('')}</row>`);
  zip.file('xl/worksheets/sheet1.xml', `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${sheet.join('')}</sheetData></worksheet>`);
  zip.file('xl/workbook.xml', '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="反馈明细" sheetId="1" r:id="rId1"/></sheets></workbook>');
  zip.file('xl/_rels/workbook.xml.rels', '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>');
  return zip.generateAsync({ type: 'nodebuffer' });
}

test('course and college material checks preserve scope, quantified differences, reports and quota', { timeout: 45000 }, async (t) => {
  const dataDir = mkdtempSync(path.join(os.tmpdir(), 'cs-material-tests-'));
  const modelRequests = [];
  const model = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const payload = JSON.parse(Buffer.concat(chunks).toString());
    const input = JSON.parse(payload.messages[1].content);
    modelRequests.push(input);
    const items = input.issues ? input.issues.map((issue) => ({
      id: issue.id, status: '未发现问题', detail: '本次表格已明确考核比例。',
      evidence: [{ source: issue.sources[0], quote: '平时40%，期末60%' }],
    })) : input.rules.map((rule) => ({
      code: rule.code, status: rule.code === 'C095' ? '需整改' : '未发现问题',
      detail: rule.code === 'C095' ? '汇报声称覆盖全部课程，支撑材料仅覆盖一个教学班。' : '已核对所引原文。',
      evidence: rule.sources.slice(0, 1).map((key) => ({ source: key, quote: input.sources.find((s) => s.key === key).text.split('\n')[0] })),
    }));
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ items }) }, finish_reason: 'stop' }], model: 'mock' }));
  });
  model.listen(0, '127.0.0.1');
  await once(model, 'listening');
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
  child.stdout.on('data', (c) => { output += c; });
  child.stderr.on('data', (c) => { output += c; });
  t.after(async () => {
    if (child.exitCode === null) { child.kill(); await once(child, 'exit'); }
    await new Promise((resolve) => model.close(resolve));
    assert.match(path.basename(dataDir), /^cs-material-tests-/);
    assert.equal(path.dirname(dataDir), path.resolve(os.tmpdir()));
    rmSync(dataDir, { recursive: true, force: true });
  });
  for (let i = 0; !output.includes('系统已启动'); i++) {
    assert.equal(child.exitCode, null, output);
    assert.ok(i < 140, output);
    await delay(50);
  }
  function client() {
    let cookie = '';
    return async (url, body, method = body === undefined ? 'GET' : 'POST') => {
      const form = body instanceof FormData;
      const res = await fetch(`http://127.0.0.1:${port}${url}`, { method,
        headers: { Cookie: cookie, ...(!form && body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
        body: body === undefined ? undefined : form ? body : JSON.stringify(body) });
      if (res.headers.get('set-cookie')) cookie = res.headers.get('set-cookie').split(';')[0];
      return { status: res.status, data: res.headers.get('content-type')?.includes('application/json') ?
        await res.json() : Buffer.from(await res.arrayBuffer()) };
    };
  }
  const admin = client(), teacher = client(), unauthenticated = client();
  const base = '/api/materials';
  assert.equal((await unauthenticated(base)).status, 401);
  assert.equal((await admin('/api/auth/register', { username: 'materials-root', name: 'Materials Root', password: 'admin12345' })).status, 200);
  assert.equal((await admin('/api/admin/users', { username: 'materials-teacher', name: 'Materials Teacher', password: 'teacher12345' })).status, 200);
  assert.equal((await teacher('/api/auth/login', { username: 'materials-teacher', password: 'teacher12345' })).status, 200);
  const ai = await admin('/api/admin/ai', { name: 'Mock', provider: 'openai', baseUrl: `http://127.0.0.1:${model.address().port}/v1`, apiKey: 'mock-key', model: 'mock' }, 'PUT');
  assert.equal(ai.status, 200, JSON.stringify(ai.data));
  assert.equal((await teacher(base, { ...scope, level: 'college' })).status, 403);
  const originalProgress = (await teacher('/api/progress')).data;
  const originalQuota = (await teacher('/api/auth/me')).data.checkQuota;

  async function add(request, endpoint, type, buffer, name = '材料.docx') {
    const form = new FormData();
    form.set('type', type); form.set('file', new Blob([buffer]), name);
    const r = await request(`${endpoint}/files`, form);
    assert.equal(r.status, 201, JSON.stringify(r.data));
    return r.data.id;
  }
  async function check(request, endpoint, options = {}) {
    const run = await request(`${endpoint}/runs`, options);
    assert.equal(run.status, 201, JSON.stringify(run.data));
    for (let i = 0; i < 140; i++) {
      const { data } = await request(`${endpoint}/runs/${run.data.id}`);
      if (data.status === 'done') return data;
      assert.notEqual(data.status, 'failed', JSON.stringify(data));
      await delay(50);
    }
    assert.fail(output);
  }
  const grade = await word(['成绩比例：平时：40%，期末：60%'], [
    ['序号', '学号', '姓名', '平时成绩', '期末成绩', '总评成绩', '备注'],
    ['1', '202600101', '隐私样例', '80', '90', '86', ''],
    ['2', '202600102', '隐私样例二', '0', '60', '36', ''],
  ]);
  const newCase = await teacher(base, { ...scope, assessments: [] });
  assert.equal(newCase.status, 201);
  const course = `${base}/${newCase.data.id}`;
  const draft = (await teacher(course)).data;
  assert.equal(draft.scopeLocked, false);
  assert.ok(!draft.expected.includes('命题双向细目表'));
  assert.ok(draft.optional.includes('命题双向细目表'));
  const gradeId = await add(teacher, course, '课程成绩单', grade, '正式成绩.docx');
  const first = await check(teacher, course);
  assert.equal(first.result.rules.length, 104);
  assert.deepEqual(first.result.history, []);
  assert.equal(first.result.verdict, 'partial');
  assert.equal(first.result.rules.find((r) => r.code === 'C025').status, '不适用');
  assert.equal(first.result.rules.find((r) => r.code === 'C053').status, '需核实');
  assert.deepEqual(first.result.stats[0].stats[0].bands, [1, 0, 0, 1, 0]);
  const { data: gradeTable } = await teacher(`${course}/files/${gradeId}/grades`);
  assert.equal(gradeTable.rows[1].cells.平时, '0');
  assert.equal(gradeTable.rows[0].cells.学号, '202600101');

  assert.equal((await teacher(course, { ...scope, major: '人工智能' }, 'PUT')).status, 409);
  assert.equal((await teacher(course, { ...scope, title: '程序设计（已编辑）' }, 'PUT')).status, 200);
  assert.equal((await teacher(course)).data.scope.title, '程序设计（已编辑）');
  await add(teacher, course, '课程教学大纲', await word(['课程教学大纲：程序设计', '总评成绩比例：平时：30%，期末：70%']), '大纲.docx');
  const second = await check(teacher, course);
  const discrepancy = second.result.rules.find((r) => r.code === 'C023');
  assert.equal(second.result.verdict, 'failed');
  assert.equal(discrepancy.status, '需整改');
  assert.ok(discrepancy.findings.some((f) => /30% 与 40%/.test(f.detail) && /大纲\.docx.*正式成绩\.docx/.test(f.location)));
  const firstAgain = await teacher(`${course}/runs/${first.id}`);
  assert.deepEqual(firstAgain.data.result, first.result);
  const oldReport = await teacher(`${course}/runs/${first.id}/report.docx`);
  const oldXml = await (await JSZip.loadAsync(oldReport.data)).file('word/document.xml').async('string');
  assert.doesNotMatch(oldXml, /已编辑/);
  const docx = await teacher(`${course}/runs/${second.id}/report.docx`);
  const xml = await (await JSZip.loadAsync(docx.data)).file('word/document.xml').async('string');
  assert.match(xml, /按材料查/);
  assert.match(xml, /按问题查/);
  assert.match(xml, /30% 与 40%/);
  assert.doesNotMatch(xml, /202600101|隐私样例/);
  const change = await teacher(`${course}/files/${gradeId}/grades`, {
    edits: gradeTable.rows.map((row, i) => ({ location: row.location, line: row.line, column: '总评', value: ['87', '42'][i] })),
    weights: { 平时: 30, 期末: 70 }, weightsVerified: true,
  }, 'PUT');
  assert.equal(change.status, 200);
  assert.deepEqual((await teacher(`${course}/files/${gradeId}/original`)).data, grade);
  const corrected = await check(teacher, course);
  assert.deepEqual(corrected.result.stats[0].weights, { 平时: 30, 期末: 70 });
  assert.equal(corrected.result.rules.find((r) => r.code === 'C032').status, '需核实');
  assert.equal(corrected.result.verdict, 'partial');
  assert.deepEqual((await teacher(`${course}/runs/${second.id}`)).data.result, second.result);

  const mixedRow = await teacher(base, { ...scope, section: '2班', teaching: 'mixed', flags: ['separateLab'] });
  const mixed = `${base}/${mixedRow.data.id}`;
  await add(teacher, mixed, '课程成绩单', grade);
  const partial = await check(teacher, mixed);
  assert.equal(partial.result.verdict, 'partial');
  assert.equal(partial.result.rules.find((r) => r.code === 'C043').status, '待补');
  assert.deepEqual((await teacher('/api/progress')).data, originalProgress);
  assert.equal((await teacher('/api/auth/me')).data.checkQuota.used, originalQuota.used + 4);

  const collegeRow = await admin(base, { level: 'college', title: '学院年度材料复核', term: '2026 年' });
  const college = `${base}/${collegeRow.data.id}`;
  const privateId = await add(admin, college, '学院检查、整改及复核台账', await word(['帮助新进教师完善档案，记录了复核意见。']));
  await add(admin, college, '学院汇报及支撑目录', await word(['汇报写覆盖全部课程，附件目录仅提供一个教学班的档案。']));
  const review = await check(admin, college);
  assert.equal(review.result.rules.find((r) => r.code === 'C095').status, '需整改');
  assert.equal(review.result.rules.find((r) => r.code === 'C025').status, '不适用');
  assert.equal((await teacher(college)).status, 404);
  assert.equal((await teacher(college, undefined, 'DELETE')).status, 404);
  assert.equal((await teacher(`${college}/files/${privateId}/original`)).status, 404);
  assert.equal((await teacher(`${college}/runs/${review.id}/report.docx`)).status, 404);
  assert.ok(modelRequests.length > 0);
  assert.doesNotMatch(JSON.stringify(modelRequests), /隐私样例|20260010[12]|正式成绩\.docx/);
  const list = (await teacher(base)).data;
  assert.ok(list.some((r) => r.id === newCase.data.id && r.editable && r.scopeLocked));
  assert.equal((await teacher(course, undefined, 'DELETE')).status, 200);
  assert.equal((await teacher(course)).status, 404);
  assert.equal((await teacher(`${course}/files/${gradeId}/original`)).status, 404);
  assert.equal((await teacher(`${course}/runs/${first.id}/report.docx`)).status, 404);
  assert.equal((await teacher('/api/auth/me')).data.checkQuota.used, originalQuota.used + 4);

  await t.test('whole-sheet preview, co-teacher lookup and optional evidence-backed recheck', async () => {
    const draft = { level: 'course', title: '复查测试课', courseCode: 'COURSE-01', major: scope.major };
    const created = await admin(base, draft);
    assert.equal(created.status, 201, JSON.stringify(created.data));
    assert.equal((await admin(base, { ...draft, courseCode: 'COURSE-02', major: '人工智能' })).status, 201);
    const endpoint = `${base}/${created.data.id}`;
    const history = `${base}/history`;
    const feedback = '教学大纲只写了权重范围。\n应明确平时与期末比例。';
    const workbook = await xlsx([
      ['课程', '课程代码', '任课教师', '教师工号', '学期', '具体反馈', '原表位置'],
      ['旧名称', 'COURSE-01', 'Materials Teacher', 'materials-teacher', '2025-2026-1', feedback, '大纲!C2'],
      ['旧名称', 'COURSE-01', '共同教师', '000123', '2025-2026-1', feedback, '大纲!C3'],
      ['复查测试课', '', 'Materials Teacher', '', '2025-2026-1', '学生答卷改分未签字。', '试卷!C4'],
      ['往期独立课程', '', '共同教师', '', '2025-2026-2', '教学进度表少排4课时。', '进度!C5'],
      ['另一门未匹配课程', '', '', '', '', '请核实教学大纲。', '大纲!C6'],
    ]);
    const workbookForm = (choices) => {
      const form = new FormData();
      form.set('file', new Blob([workbook]), '反馈.xlsx');
      if (choices) form.set('choices', JSON.stringify(choices));
      return form;
    };
    assert.equal((await teacher(`${history}/preview`, workbookForm())).status, 403);
    const preview = await admin(`${history}/preview`, workbookForm());
    assert.equal(preview.status, 200, JSON.stringify(preview.data));
    const rows = preview.data.rows;
    assert.deepEqual(rows.map((row) => row.status), ['matched', 'matched', 'ambiguous', 'unmatched', 'unmatched']);
    assert.equal(rows[0].candidates[0].name, draft.title);
    const codeKey = rows[0].candidates[0].key;
    assert.equal((await admin(`${history}?course=COURSE-01`)).data.total, 0);
    const choices = { [rows[0].key]: codeKey, [rows[1].key]: codeKey, [rows[2].key]: codeKey, [rows[3].key]: 'original' };
    assert.deepEqual((await admin(`${history}/import`, workbookForm(choices))).data, { added: 3, duplicates: 1, skipped: 1 });
    const repeated = { ...choices, [rows[3].key]: JSON.stringify(['往期独立课程', '']) };
    assert.deepEqual((await admin(`${history}/import`, workbookForm(repeated))).data, { added: 0, duplicates: 4, skipped: 1 });
    const query = (request, course, teacher) => request(`${history}?${new URLSearchParams({ course, teacher })}`);
    const byId = (await query(admin, 'course-01', '000123')).data;
    assert.equal(byId.total, 1);
    assert.deepEqual(byId.rows[0].teachers.map((entry) => entry.staffNo), ['materials-teacher', '000123']);
    assert.equal(byId.rows[0].text, feedback);
    assert.match(byId.rows[0].uploader, /materials-root/);
    assert.equal((await query(admin, '', 'materials-root')).data.total, 0);
    assert.equal((await query(admin, '', '共同教师')).data.total, 2);
    assert.equal((await query(teacher, '复查测试课', 'Materials Teacher')).data.total, 2);
    assert.equal((await query(teacher, '往期独立课程', '')).data.total, 0);

    const fileId = await add(admin, endpoint, '课程教学大纲', await xlsx([
      ['考核项目', '权重'], ['总评', '平时40%，期末60%'],
    ]), '本次大纲.xlsx');
    assert.equal((await admin(`${endpoint}/runs`, {})).status, 400);
    const reviewed = await check(admin, endpoint, { term: '2026-2027 第1学期' });
    assert.equal(reviewed.result.rules.length, 104);
    const found = reviewed.result.history.find((row) => row.issue.text === feedback);
    assert.equal(found.status, '未发现问题');
    assert.deepEqual(found.locations, [{ fileId, file: '本次大纲.xlsx', position: '工作表 反馈明细 · 第 2 行' }]);
    const missing = reviewed.result.history.find((row) => row.issue.text.includes('学生答卷'));
    assert.equal(missing.status, '待补');
    assert.deepEqual(missing.missing, ['学生答卷']);
    const report = await admin(`${endpoint}/runs/${reviewed.id}/report.docx`);
    const reportText = await (await JSZip.loadAsync(report.data)).file('word/document.xml').async('string');
    assert.match(reportText, /历史问题复查/);
    assert.match(reportText, /学生答卷改分未签字/);
    assert.match(reportText, /本次大纲\.xlsx · 工作表 反馈明细 · 第 2 行/);
    const skipped = await check(admin, endpoint, { reviewHistory: false });
    assert.deepEqual(skipped.result.rules, reviewed.result.rules);
    assert.equal(skipped.result.history, undefined);
    assert.equal((await admin(endpoint)).data.scope.term, '2026-2027 第1学期');
  });
});

test('provided phone picture and image-only PDF: rotate without mixing scores, keep zero and dash distinct', {
  skip: !process.env.MATERIAL_OCR_SAMPLE, timeout: 120000,
}, async () => {
  const { extractMaterial } = await import('../server/src/services/materialExtract.ts');
  const { extractGradeRows, materialWeights } = await import('../server/src/services/materialGrades.ts');
  for (const filename of [process.env.MATERIAL_OCR_SAMPLE, process.env.MATERIAL_OCR_PDF_SAMPLE].filter(Boolean)) {
    const pages = await extractMaterial(filename, path.basename(filename), true);
    const rows = extractGradeRows(pages);
    assert.deepEqual(materialWeights(pages), { 平时: 10, 期中: 15, 实验: 15, 期末: 60 });
    assert.deepEqual(rows.map((r) => r.line), Array.from({ length: 26 }, (_, i) => i + 43));
    const expected = [
      '91 27 83 60 62', '96 12 85 67 64', '95 62 90 85 83', '95 58 92 86 84',
      '94 20 90 73 70', '92 62 92 86 84', '95 52 88 85 82', '95 — 87 83 85',
      '95 27 84 69 68', '90 38 86 78 74', '78 20 85 87 76', '91 — 88 70 75',
      '92 39 80 83 77', '82 32 85 83 76', '91 66 90 88 85', '95 48 89 91 85',
      '95 25 0 43 39', '91 30 90 61 64', '90 44 87 85 80', '95 58 94 96 90',
      '82 28 78 66 64', '91 20 75 74 68', '91 35 90 67 68', '86 30 70 74 68',
      '95 39 92 79 77', '93 90 97 91 92',
    ];
    const keys = ['平时', '期中', '实验', '期末', '总评'];
    for (const [i, row] of rows.entries()) {
      assert.ok(!row.cells.学号 || row.uncertain.includes('学号'));
      for (const [j, key] of keys.entries()) {
        assert.ok(row.cells[key] === expected[i].split(' ')[j] || row.uncertain.includes(key), `${row.line} ${key}: ${row.cells[key]}`);
      }
    }
    assert.equal(rows.find((r) => r.line === 59).cells.实验, '0');
    assert.ok(rows.find((r) => r.line === 50).cells.期中 === '—' || rows.find((r) => r.line === 50).uncertain.includes('期中'));
    assert.equal(rows.filter((r) => r.cells.总评 && !r.uncertain.includes('总评')).length, 26);
  }
});
