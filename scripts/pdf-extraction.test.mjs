// Run: node --import tsx --test scripts/pdf-extraction.test.mjs
// Set PDF_FIXTURE_PATH to also validate the supplied curriculum PDF.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { test } from 'node:test';
import { extractTextItems, getDocumentProxy } from 'unpdf';
import { extractFile } from '../server/src/services/extract.ts';
import { pdfPageToStructuredText } from '../server/src/services/pdfText.ts';

const item = (str, x, y, width = str.length * 4, hasEOL = false) => ({ str, x, y, width, height: 9, hasEOL });
const context = () => [item('毕业要求 / 课程名称', 20, 520, 100, true)];
const codes = ['1.1', '1.2', '1.3', '1.4', '2.1', '2.2', '2.3', '2.4', '3.1', '3.2', '3.3', '3.4', '4.1', '4.2', '4.3', '4.4', '5.1', '5.2', '5.3', '6.1', '6.2', '7.1', '7.2', '7.3', '7.4', '8.1', '8.2', '9.1', '9.2', '9.3', '10.1', '10.2', '10.3', '11.1', '11.2'];

test('sparse 35-column matrix retains target codes, including combined numbered headers', () => {
  const headers = codes.slice(0, 29).map((code, index) => item(code, 165 + index * 18, 460, 11));
  headers.push(item(codes.slice(29).join(' '), 165 + 29 * 18, 460, 102.8));
  const text = pdfPageToStructuredText([
    ...context(), ...headers,
    item('算法设计与分析 ', 49, 406, 60),
    item('H ', 258, 406, 7), item('M ', 402, 406, 8), item('M', 438, 406, 8, true),
    item('文献阅读与科技论文写作 ', 49, 380, 100), item('H', 782, 380, 7, true),
  ]);
  assert.match(text, /算法设计与分析 2\.2=H 4\.2=M 4\.4=M/);
  assert.match(text, /文献阅读与科技论文写作 11\.2=H/);
  assert.doesNotMatch(text, /需核实/);
});

test('course names split across lines keep original order around vertically centered strengths', () => {
  const text = pdfPageToStructuredText([
    ...context(), item('2.2', 200, 460, 11), item('4.2', 300, 460, 11), item('4.4', 400, 460, 11),
    item('毛泽东思想和中国特色社会主', 49, 428, 110, true),
    item('义理论体系概论 ', 49, 416, 60), item('M', 300, 422, 8, true),
    item('习近平新时代中国特色社会主', 49, 404, 110, true),
    item('义思想概论 ', 49, 393, 40), item('M', 400, 399, 8, true),
  ]);
  assert.match(text, /毛泽东思想和中国特色社会主\n义理论体系概论 4\.2=M\n习近平新时代中国特色社会主\n义思想概论 4\.4=M/);
});

test('ordinary text is unchanged and missing or ambiguous matrix columns are explicit', () => {
  const ordinary = [item('普通正文', 20, 500, 40, true), item('1.1 基础知识 H', 20, 480)];
  assert.equal(pdfPageToStructuredText(ordinary), '普通正文\n1.1 基础知识 H');
  const missing = pdfPageToStructuredText([...context(), item('算法设计与分析 H M M', 20, 400, 140)]);
  assert.match(missing, /算法设计与分析 H M M/);
  assert.match(missing, /无法可靠识别/);
  assert.doesNotMatch(missing, /\d+\.\d+=[HML]/);
  const merged = pdfPageToStructuredText([
    ...context(), item('2.2', 200, 460, 11), item('4.2', 300, 460, 11), item('4.4', 400, 460, 11),
    item('算法设计与分析 ', 20, 400), item('H M', 200, 400, 110, true),
  ]);
  assert.match(merged, /算法设计与分析 H M/);
  assert.match(merged, /无法可靠识别/);
  assert.doesNotMatch(merged, /\d+\.\d+=[HML]/);
});

test('mappings do not carry over to other pages or a new incomplete matrix', () => {
  const text = pdfPageToStructuredText([
    ...context(), item('2.2', 200, 460, 11), item('4.2', 300, 460, 11), item('4.4', 400, 460, 11),
    item('甲课程 ', 20, 440), item('H', 200, 440, 7, true),
    item('毕业要求 / 其他课程', 20, 420, 100, true),
    item('乙课程 ', 20, 400), item('M', 300, 400, 8, true),
  ]);
  assert.match(text, /甲课程 2\.2=H/);
  assert.match(text, /乙课程 M/);
  assert.doesNotMatch(text, /乙课程 4\.2=M/);
  assert.match(text, /无法可靠识别/);
  const nextPage = pdfPageToStructuredText([...context(), item('另一页课程 ', 20, 400), item('M', 300, 400, 8)]);
  assert.doesNotMatch(nextPage, /4\.2=M/);
  assert.match(nextPage, /无法可靠识别/);
});

test('another matrix uses its own header and out-of-column strengths remain uncertain', () => {
  const text = pdfPageToStructuredText([
    ...context(), item('2.2', 200, 460, 11), item('4.2', 300, 460, 11), item('4.4', 400, 460, 11),
    item('甲课程 ', 20, 440), item('H', 200, 440, 7, true),
    item('毕业要求 / 其他课程', 20, 420, 100, true),
    item('1.1', 200, 400, 11), item('1.2', 300, 400, 11), item('1.3', 400, 400, 11),
    item('乙课程 ', 20, 380), item('M', 300, 380, 8, true),
    item('越界项 ', 20, 360), item('L', 800, 360, 8, true),
    item('跨列项 ', 20, 340), item('M', 253, 340, 8, true),
  ]);
  assert.match(text, /甲课程 2\.2=H/);
  assert.match(text, /乙课程 1\.2=M/);
  assert.match(text, /越界项 L/);
  assert.match(text, /跨列项 M/);
  assert.match(text, /无法可靠识别/);
});

test('a missing middle header does not expand the neighboring columns into its cells', () => {
  const text = pdfPageToStructuredText([
    ...context(),
    item('1.1', 200, 460, 11), item('1.2', 220, 460, 11),
    item('1.4', 260, 460, 11), item('1.5', 280, 460, 11),
    item('缺失列课程 ', 20, 400), item('H', 240, 400, 7, true),
  ]);
  assert.match(text, /缺失列课程 H/);
  assert.match(text, /无法可靠识别/);
  assert.doesNotMatch(text, /\d+\.\d+=H/);
});

test('supplied curriculum: five repeated matrix pages and algorithm row preserve support codes', { skip: !process.env.PDF_FIXTURE_PATH }, async () => {
  const file = process.env.PDF_FIXTURE_PATH;
  const pdf = await getDocumentProxy(new Uint8Array(await fs.readFile(file)));
  const { items: pages } = await extractTextItems(pdf);
  const matrixPages = pages.map(pdfPageToStructuredText).filter((text) => text.startsWith('【PDF矩阵列定位】'));
  assert.equal(matrixPages.length, 5);
  for (const text of matrixPages) {
    assert.doesNotMatch(text, /无法可靠识别/);
    assert.doesNotMatch(text, /(?<![=A-Za-z/])[HML](?![A-Za-z/])/g);
  }
  assert.equal(matrixPages.reduce((total, text) => total + [...text.matchAll(/\d+\.\d+=[HML]/g)].length, 0), 288);
  const extracted = await extractFile(file, 'curriculum.pdf');
  assert.match(extracted, /算法设计与分析 2\.2=H 4\.2=M 4\.4=M/);
  assert.match(extracted, /2\.2 问题分析：能够识别和表达复杂工程问题的关键环节和参数/);
  assert.match(extracted, /4\.2 方案设计：能够根据对象和问题的特征/);
});
