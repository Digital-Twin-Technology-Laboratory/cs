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
import XLSX from 'xlsx';
import { callAnthropic } from '../server/src/services/ai/anthropic.ts';
import { materialIssueReport } from '../server/src/services/materialIssues.ts';

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

function xls(rows) {
  const book = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet(rows), '反馈明细');
  return XLSX.write(book, { bookType: 'biff8', type: 'buffer' });
}

test('material report puts confirmed issues before suggestions within each material', () => {
  const at = (line, quote) => `大纲.docx（附件 #1） · 文档正文 · 提取文本第 ${line} 行：「${quote}」`;
  const shared = { status: '需整改', location: `${at(8, '长摘录\n第二行')}\n${at(12, '另一段摘录')}`, detail: '学时小计不一致，请重新合计。' };
  const cross = { status: '需整改', headline: '进度表比大纲少排 4 学时', detail: '大纲 68 学时，进度表实排 64 学时。',
    action: '核对进度表并补排 4 学时。', location: `${at(8, '课程学时 68')}\n进度.xlsx（附件 #2） · 工作表 Sheet3 · 提取文本第 7 行：「排课 64 学时」` };
  const missing = { status: '待补', location: '实验报告、实践报告', detail: '本次未提供适用的材料' };
  const verify = { status: '需核实', location: '', detail: '请人工核实。' };
  const rule = (code, findings, materials = ['课程教学大纲']) => ({ code, title: code, materials, status: findings[0].status, findings });
  const types = ['课程教学大纲', '教学进度表（教学日历）'];
  const result = { files: [{ id: 1, name: '大纲.docx', type: types[0] }, { id: 2, name: '进度.xlsx', type: types[1] }], rules: [
    rule('C001', [shared, { ...shared, location: at(21, '另一处') }]),
    rule('C002', [{ ...shared, location: `${at(12, '另一段摘录')}\n${at(8, '同一行的另一段')}` }], types),
    rule('C016', [cross], types),
    rule('C003', [missing, verify], [missing.location]),
    rule('C004', [missing, verify], ['课程教学大纲', missing.location]),
    rule('C005', [{ ...verify, status: '未发现问题' }]),
    rule('S001', [{ ...verify, status: '建议完善', detail: '建议标明适用年级。' }]),
  ], history: [
    { status: '待补', missing: ['实验报告、实践报告'] },
    { status: '需核实', issue: { text: '未注明课程负责人。' }, detail: '请核实签字栏。', locations: [{ file: '大纲.docx', position: '封面' }] },
  ] };
  const report = materialIssueReport(result);
  assert.deepEqual(report.materials.map(({ material, sections }) => [material, sections.map(({ label, issues }) => [label, issues.length])]), [
    ['课程教学大纲', [['重大及明确问题', 2], ['建议修改', 1]]], ['跨材料核对', [['重大及明确问题', 1]]],
  ]);
  const [outline, comparison] = report.materials;
  assert.equal(outline.source, '大纲.docx（附件 #1）');
  const original = outline.sections[0].issues[0];
  assert.deepEqual(original.checks.map(({ code }) => code), ['C001', 'C002']);
  assert.deepEqual(original.locations, ['文档正文 · 提取文本第 8、12 行']);
  const multi = materialIssueReport({ ...result, files: [...result.files, { id: 3, name: '另一份大纲.docx', type: types[0] }] });
  assert.equal(multi.materials[0].source, undefined);
  assert.deepEqual(multi.materials[0].sections[0].issues[0].locations, ['大纲.docx（附件 #1） · 文档正文 · 提取文本第 8、12 行']);
  const joint = comparison.sections[0].issues[0];
  assert.deepEqual(joint.materials, types);
  assert.equal(joint.title, cross.headline);
  assert.equal(joint.action, cross.action);
  assert.deepEqual(report.missing, ['实验报告、实践报告']);
  const review = report.toVerify;
  assert.deepEqual(review[0].checks.map(({ code }) => code), ['C004']);
  assert.equal(review[1].history, '未注明课程负责人。');
  assert.deepEqual(review[1].locations, ['大纲.docx · 封面']);
});

test('course and college material checks preserve scope, quantified differences, reports and quota', { timeout: 45000 }, async (t) => {
  const dataDir = mkdtempSync(path.join(os.tmpdir(), 'cs-material-tests-'));
  const modelRequests = [];
  const visionRequests = [];
  const visionRow = '数据库系统的基本原理 | 2 | 2 | 4';
  const visionText = ['| 教学内容 | 理论学时 | 实践学时 | 合计 |', '| --- | ---: | ---: | ---: |', visionRow].join('\n');
  const gradeVision = {
    weights: '平时40%，期末60%',
    columns: ['序号', '学号', '平时', '期末', '总评'],
    rows: [['1', '001234567', '80', '90', '86'], ['2', '001234568', '0', '60', '36'], ['3', '001234569', '', '—', '']],
  };
  let rejectImage = false;
  let imageReviewAttempts = 0;
  let invalidReview = false;
  const model = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const payload = JSON.parse(Buffer.concat(chunks).toString());
    if (req.url === '/v1/messages') {
      visionRequests.push(payload);
      res.setHeader('Content-Type', 'text/event-stream');
      const events = [
        { type: 'message_start', message: { id: 'msg_1', type: 'message', role: 'assistant', model: 'mock', content: [],
          stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 0 } } },
        { type: 'content_block_start', index: 0, content_block: { type: 'text', text: visionText } },
        { type: 'content_block_stop', index: 0 },
        { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 8 } },
        { type: 'message_stop' },
      ];
      res.end(events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''));
      return;
    }
    if (Array.isArray(payload.messages.at(-1).content)) {
      visionRequests.push(payload);
      res.setHeader('Content-Type', 'application/json');
      if (rejectImage) {
        res.statusCode = 400;
        res.end(JSON.stringify({ error: { message: payload.messages.at(-1).content[1].image_url.url } }));
        return;
      }
      const text = payload.messages.at(-1).content[0].text.includes('成绩表') ? JSON.stringify(gradeVision) : visionText;
      res.end(JSON.stringify({ choices: [{ message: { content: text }, finish_reason: 'stop' }], model: 'mock' }));
      return;
    }
    const input = JSON.parse(payload.messages[1].content);
    modelRequests.push(input);
    const items = input.issues ? input.issues.map((issue) => ({
      id: issue.id, status: '未发现问题', detail: '本次表格已明确考核比例。',
      evidence: [{ source: issue.sources[0], quote: '平时40%，期末60%' }],
    })) : input.rules.map((rule) => ({
      code: rule.code, status: rule.code === 'C095' ? '需整改' : '未发现问题',
      detail: rule.code === 'C095' ? '汇报声称覆盖全部课程，支撑材料仅覆盖一个教学班。' : '已核对所引原文。',
      ...(rule.code === 'C095' ? { headline: '汇报与支撑材料覆盖范围不一致', action: '更正汇报的覆盖范围，或补齐其他课程的档案。' } : {}),
      evidence: rule.sources.slice(0, 1).map((key) => {
        const source = input.sources.find((s) => s.key === key);
        return { source: key, quote: source.location.includes('API 识图') ? visionRow : source.text.split('\n')[0] };
      }),
    }));
    if (input.rules?.some((rule) => rule.code === 'C001') && input.sources.some((s) => s.location.includes('API 识图'))) {
      imageReviewAttempts++;
      items.find((item) => item.code === 'C002').evidence = null;
      items.find((item) => item.code === (imageReviewAttempts === 1 ? 'C003' : 'C001')).status = '格式不符';
    }
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ items: invalidReview ? null : items }) }, finish_reason: 'stop' }], model: 'mock' }));
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
  async function check(request, endpoint, options = {}, expected = 'done') {
    const run = await request(`${endpoint}/runs`, options);
    assert.equal(run.status, 201, JSON.stringify(run.data));
    for (let i = 0; i < 140; i++) {
      const { data } = await request(`${endpoint}/runs/${run.data.id}`);
      if (data.status === 'done' || data.status === 'failed') {
        assert.equal(data.status, expected, JSON.stringify(data));
        return data;
      }
      await delay(50);
    }
    assert.fail(output);
  }
  const grade = xls([
    ['成绩比例：平时：40%，期末：60%'],
    ['序号', '学号', '姓名', null, '平时成绩', '期末成绩', '总评成绩', '备注'],
    [1, '202600101', '隐私样例', null, 80, 90, 86, ''],
    [2, '202600102', '隐私样例二', null, 0, 60, 36, ''],
  ]);
  const newCase = await teacher(base, { ...scope, assessments: [] });
  assert.equal(newCase.status, 201);
  const course = `${base}/${newCase.data.id}`;
  const draft = (await teacher(course)).data;
  assert.equal(draft.scopeLocked, false);
  assert.ok(!draft.expected.includes('命题双向细目表'));
  assert.ok(draft.optional.includes('命题双向细目表'));
  const gradeId = await add(teacher, course, '课程成绩单', grade, '正式成绩.xls');
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
  const teachingHours = [
    ['教学内容', '理论', '实验/实践', '小计', '教学方法', '支撑 / 课程目标'],
    ['1.数据库系统的基本原理', '2', '2', '2（2）', '讲授法', '目标1'],
    ['合计', '2', '2', '2（2）', '', ''],
  ];
  await add(teacher, course, '课程教学大纲',
    await word(['课程教学大纲：程序设计', '总评成绩比例：平时：30%，期末：70%'], teachingHours), '大纲.docx');
  await add(teacher, course, '课程教学大纲',
    await word(['误归类的成绩明细', '样例甲 | 92 | 89'], teachingHours), '误归类的成绩明细.docx');
  await add(teacher, course, '课程教学大纲',
    await word(['含学号的学时表'], [...teachingHours, ['202600111', '2', '2', '2（2）', '', '']]), '含学号的学时表.docx');
  const second = await check(teacher, course);
  assert.ok(second.result.rules.find((rule) => rule.code === 'C003').findings.some((finding) =>
    finding.location.includes('提取文本第') && finding.location.includes('大纲.docx')));
  assert.ok(modelRequests.some((request) => request.sources.some((source) => source.text.includes('数据库系统的基本原理 | 2 | 2'))));
  assert.doesNotMatch(JSON.stringify(modelRequests), /样例甲|202600111|误归类的成绩明细|含学号的学时表/);
  const discrepancy = second.result.rules.find((r) => r.code === 'C023');
  assert.equal(second.result.verdict, 'failed');
  assert.equal(discrepancy.status, '需整改');
  assert.ok(discrepancy.findings.some((f) => /30% 与 40%/.test(f.detail) && /大纲\.docx.*正式成绩\.xls/.test(f.location)));
  const firstAgain = await teacher(`${course}/runs/${first.id}`);
  assert.deepEqual(firstAgain.data.result, first.result);
  const oldReport = await teacher(`${course}/runs/${first.id}/report.docx`);
  const oldXml = await (await JSZip.loadAsync(oldReport.data)).file('word/document.xml').async('string');
  assert.doesNotMatch(oldXml, /已编辑/);
  const docx = await teacher(`${course}/runs/${second.id}/report.docx`);
  const xml = await (await JSZip.loadAsync(docx.data)).file('word/document.xml').async('string');
  assert.match(xml, /教学材料问题汇总/);
  assert.match(xml, /跨材料核对.*重大及明确问题.*30% 与 40%.*附 待补材料.*附 需核实事项/s);
  assert.equal((xml.match(/30% 与 40%/g) ?? []).length, 1);
  assert.doesNotMatch(xml, /按材料查|按问题查|成绩统计|不适用|已核对所引原文|：「/);
  assert.ok(second.result.issueReport.materials.some(({ material, sections }) => material === '跨材料核对' && sections.some(({ issues }) =>
    issues.some((issue) => /30% 与 40%/.test(issue.detail) && issue.locations.some((loc) => loc.includes('大纲.docx'))))));
  assert.doesNotMatch(xml, /202600101|隐私样例/);
  const change = await teacher(`${course}/files/${gradeId}/grades`, {
    edits: gradeTable.rows.map((row, i) => ({ location: row.location, line: row.line, column: '总评', value: ['87', '42'][i] })),
    weights: { 平时: 30, 期末: 70 }, weightsVerified: true,
  }, 'PUT');
  assert.equal(change.status, 200);
  assert.ok((await teacher(`${course}/files/${gradeId}/original`)).data.equals(grade));
  const corrected = await check(teacher, course);
  assert.deepEqual(corrected.result.stats[0].weights, { 平时: 30, 期末: 70 });
  assert.equal(corrected.result.rules.find((r) => r.code === 'C032').status, '需核实');
  assert.equal(corrected.result.verdict, 'partial');
  assert.deepEqual((await teacher(`${course}/runs/${second.id}`)).data.result, second.result);

  const mixedRow = await teacher(base, { ...scope, section: '2班', teaching: 'mixed', flags: ['separateLab'] });
  const mixed = `${base}/${mixedRow.data.id}`;
  await add(teacher, mixed, '课程成绩单', grade, '正式成绩.xls');
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
  assert.ok(review.result.issueReport.materials.flatMap(({ sections }) => sections.flatMap(({ issues }) => issues)).some((issue) =>
    issue.title === '汇报与支撑材料覆盖范围不一致' && issue.action === '更正汇报的覆盖范围，或补齐其他课程的档案。'));
  assert.equal(review.result.rules.find((r) => r.code === 'C025').status, '不适用');
  assert.equal((await teacher(college)).status, 404);
  assert.equal((await teacher(college, undefined, 'DELETE')).status, 404);
  assert.equal((await teacher(`${college}/files/${privateId}/original`)).status, 404);
  assert.equal((await teacher(`${college}/runs/${review.id}/report.docx`)).status, 404);
  assert.ok(modelRequests.length > 0);
  assert.doesNotMatch(JSON.stringify(modelRequests), /隐私样例|20260010[12]|正式成绩\.docx/);
  const list = (await teacher(base)).data;
  const listedCase = list.find((r) => r.id === newCase.data.id);
  assert.ok(listedCase && listedCase.editable && listedCase.scopeLocked);
  assert.equal(listedCase.owner.username, 'materials-teacher');
  assert.equal(listedCase.owner.name, 'Materials Teacher');
  assert.equal(listedCase.fileCount, 4);
  assert.equal(listedCase.runCount, 3);
  assert.equal(listedCase.latest.runner.username, 'materials-teacher');
  const detailData = (await teacher(course)).data;
  assert.equal(detailData.owner.username, 'materials-teacher');
  assert.equal(detailData.runs[0].runner.username, 'materials-teacher');
  assert.equal((await teacher(course, undefined, 'DELETE')).status, 200);
  assert.equal((await teacher(course)).status, 404);
  assert.equal((await teacher(`${course}/files/${gradeId}/original`)).status, 404);
  assert.equal((await teacher(`${course}/runs/${first.id}/report.docx`)).status, 404);
  assert.equal((await teacher('/api/auth/me')).data.checkQuota.used, originalQuota.used + 4);

  await t.test('whole-sheet preview, co-teacher lookup and optional evidence-backed recheck', async () => {
    const draft = { level: 'course', title: '复查测试课', courseCode: 'COURSE-01', major: scope.major };
    const created = await admin(base, { ...draft, section: '第12教学班' });
    assert.equal(created.status, 201, JSON.stringify(created.data));
    assert.equal((await admin(base, { ...draft, section: '第3教学班' })).status, 201);
    assert.equal((await admin(base, { ...draft, section: '第3教学班' })).status, 201);
    assert.equal((await admin(base, { ...draft, courseCode: 'COURSE-02', major: '人工智能' })).status, 201);
    const visible = (await admin(`${base}/options`)).data.teachingClasses.filter((row) => row.code === draft.courseCode);
    assert.deepEqual(visible.map((row) => [row.section, row.name]), [['第3教学班', draft.title], ['第12教学班', draft.title]]);
    assert.ok(!(await teacher(`${base}/options`)).data.teachingClasses.some((row) => row.code === draft.courseCode));
    const endpoint = `${base}/${created.data.id}`;
    const history = `${base}/history`;
    const feedback = '教学大纲只写了权重范围。\n应明确平时与期末比例。';
    const feedbackRows = [
      ['课程', '课程代码', '任课教师', '教师工号', '学期', '具体反馈', '原表位置'],
      ['旧名称', 'COURSE-01', 'Materials Teacher', 'materials-teacher', '2025-2026-1', feedback, '大纲!C2'],
      ['旧名称', 'COURSE-01', '共同教师', '000123', '2025-2026-1', feedback, '大纲!C3'],
      ['复查测试课', '', 'Materials Teacher', '', '2025-2026-1', '学生答卷改分未签字。', '试卷!C4'],
      ['往期独立课程', '', '共同教师', '', '2025-2026-2', '教学进度表少排4课时。', '进度!C5'],
      ['另一门未匹配课程', '', '', '', '', '请核实教学大纲。', '大纲!C6'],
    ];
    const workbook = xls(feedbackRows);
    const workbookForm = (choices) => {
      const form = new FormData();
      form.set('file', new Blob([workbook]), '反馈.xls');
      if (choices) form.set('choices', JSON.stringify(choices));
      return form;
    };
    assert.equal((await teacher(`${history}/preview`, workbookForm())).status, 403);
    const preview = await admin(`${history}/preview`, workbookForm());
    assert.equal(preview.status, 200, JSON.stringify(preview.data));
    const rows = preview.data.rows;
    const modern = new FormData();
    modern.set('file', new Blob([await xlsx(feedbackRows)]), '反馈.xlsx');
    const modernPreview = await admin(`${history}/preview`, modern);
    assert.equal(modernPreview.status, 200, JSON.stringify(modernPreview.data));
    assert.deepEqual(modernPreview.data.rows.map(({ source, ...row }) => row), rows.map(({ source, ...row }) => row));
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

    const fileId = await add(admin, endpoint, '课程教学大纲', xls([
      [], ['考核项目', '权重'], ['总评', '平时40%，期末60%'],
    ]), '本次大纲.xls');
    assert.equal((await admin(`${endpoint}/runs`, {})).status, 400);
    const reviewed = await check(admin, endpoint, { term: '2026-2027 第1学期' });
    assert.equal(reviewed.result.rules.length, 104);
    const found = reviewed.result.history.find((row) => row.issue.text === feedback);
    assert.equal(found.status, '未发现问题');
    assert.deepEqual(found.locations, [{ fileId, file: '本次大纲.xls', position: '工作表 反馈明细 · 第 3 行' }]);
    const missing = reviewed.result.history.find((row) => row.issue.text.includes('学生答卷'));
    assert.equal(missing.status, '待补');
    assert.deepEqual(missing.missing, ['学生答卷']);
    const report = await admin(`${endpoint}/runs/${reviewed.id}/report.docx`);
    const reportText = await (await JSZip.loadAsync(report.data)).file('word/document.xml').async('string');
    assert.match(reportText, /待补材料/);
    assert.match(reportText, /学生答卷/);
    assert.doesNotMatch(reportText, /本次表格已明确考核比例/);
    const skipped = await check(admin, endpoint, { reviewHistory: false });
    assert.deepEqual(skipped.result.rules, reviewed.result.rules);
    assert.equal(skipped.result.history, undefined);
    assert.equal((await admin(endpoint)).data.scope.term, '2026-2027 第1学期');
    assert.equal((await admin(endpoint)).data.scope.section, '第12教学班');
  });

  await t.test('ordinary images reach the AI API and unrecognized pages require review', async () => {
    const created = await admin(base, { ...scope, title: '图片识别测试' });
    assert.equal(created.status, 201);
    const endpoint = `${base}/${created.data.id}`;
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aFMcAAAAASUVORK5CYII=', 'base64');
    const outlineId = await add(admin, endpoint, '课程教学大纲', png, '大纲截图.PNG');
    const gradeId = await add(admin, endpoint, '课程成绩单', png, '成绩单.png');
    const checked = await check(admin, endpoint);
    assert.equal(visionRequests.length, 2);
    const request = visionRequests[0];
    assert.equal(request.response_format, undefined);
    assert.deepEqual(request.messages.at(-1).content[1], { type: 'image_url', image_url: { url: `data:image/png;base64,${png.toString('base64')}` } });
    assert.deepEqual(checked.result.files.find((f) => f.id === outlineId).warnings, []);
    assert.deepEqual(checked.result.files.find((f) => f.id === gradeId).warnings, []);
    const { data: gradeImage } = await admin(`${endpoint}/files/${gradeId}/grades`);
    assert.equal(gradeImage.scanned, true);
    assert.deepEqual(gradeImage.weights, { 平时: 40, 期末: 60 });
    assert.deepEqual(gradeImage.rows.map(({ cells }) => [cells.学号, cells.平时, cells.期末]), [
      ['001234567', '80', '90'], ['001234568', '0', '60'], ['001234569', '', '—'],
    ]);
    assert.ok(gradeImage.rows.every((row) => row.ocr));
    assert.equal(checked.result.stats.find((s) => s.id === gradeId).stats[0].count, 2);
    assert.doesNotMatch(JSON.stringify(modelRequests), /00123456[789]/);
    const [{ location, line }] = gradeImage.rows;
    assert.equal((await admin(`${endpoint}/files/${gradeId}/grades`,
      { edits: [{ location, line, column: '总评', value: '88' }], weightsVerified: true }, 'PUT')).status, 200);
    assert.ok(modelRequests.some((r) => r.sources.some((s) => s.location.includes('API 识图') && s.text === visionText)));
    assert.equal(imageReviewAttempts, 2);
    for (const code of ['C001', 'C003']) {
      assert.ok(checked.result.rules.find((r) => r.code === code).findings.some((f) =>
        f.location.includes('API 识图') && f.location.includes(visionRow)));
    }
    assert.ok(checked.result.rules.find((r) => r.code === 'C002').findings.some((f) =>
      f.status === '需核实' && f.detail.includes('格式')));

    invalidReview = true;
    const failed = await check(admin, endpoint, {}, 'failed');
    assert.match(failed.error, /重试后仍未返回有效检查结果/);
    invalidReview = false;

    rejectImage = true;
    // Page 1 has a short text layer; page 2 has no text.
    const pdf = Buffer.from([
      '%PDF-1.4',
      '1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj',
      '2 0 obj\n<< /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 >>\nendobj',
      '3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 180 80] /Resources << /Font << /F1 5 0 R >> >> /Contents 6 0 R >>\nendobj',
      '4 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 180 80] >>\nendobj',
      '5 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj',
      '6 0 obj\n<< /Length 48 >>\nstream\nBT /F1 12 Tf 10 40 Td (Text layer example) Tj ET\nendstream\nendobj',
      'xref\n0 7\n0000000000 65535 f ',
      ...[9, 58, 121, 246, 316, 386].map((offset) => `${String(offset).padStart(10, '0')} 00000 n `),
      'trailer\n<< /Size 7 /Root 1 0 R >>\nstartxref\n484\n%%EOF\n',
    ].join('\n'));
    const pdfId = await add(admin, endpoint, '教学进度表（教学日历）', pdf, '教学日历.pdf');
    const reviewed = await check(admin, endpoint);
    assert.equal(visionRequests.length, 4);
    assert.equal(reviewed.result.stats.find((s) => s.id === gradeId).stats[0].mean, 62);
    const warning = reviewed.result.files.find((f) => f.id === outlineId).warnings[0];
    assert.match(warning, /支持图片输入/);
    assert.doesNotMatch(warning, /base64|本地/);
    const pdfWarnings = reviewed.result.files.find((f) => f.id === pdfId).warnings;
    assert.equal(pdfWarnings.length, 1);
    assert.match(pdfWarnings[0], /第 2 页.*没有可提取的文字/);
    assert.ok(modelRequests.some((r) => r.sources.some((s) => s.text.includes('Text layer example'))));
  });

  await t.test('Anthropic sends an image as a base64 content block', async () => {
    const image = { mediaType: 'image/jpeg', data: '/9j/4AAQSkZJRgABAQAAAQABAAD/' };
    const response = await callAnthropic({ apiKey: 'mock-key', baseUrl: `http://127.0.0.1:${model.address().port}`,
      model: 'mock', maxTokens: 512, timeoutSec: 5, effort: 'low', anthropicFallback: true, structured: false,
      system: 'Transcribe image', user: 'Transcribe image', image });
    assert.deepEqual(visionRequests.at(-1).messages[0].content, [
      { type: 'text', text: 'Transcribe image' },
      { type: 'image', source: { type: 'base64', media_type: image.mediaType, data: image.data } },
    ]);
    assert.equal(visionRequests.at(-1).thinking, undefined);
    assert.equal(response.text, visionText);
  });
});
