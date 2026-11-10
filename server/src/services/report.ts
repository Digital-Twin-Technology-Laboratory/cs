import { AlignmentType, Document, HeadingLevel, LineRuleType, Packer, Paragraph, TextRun } from 'docx';
import type { CheckResult } from './ai/schema.js';
import type { CourseSnapshot } from './checkQueue.js';

export interface ReportInput {
  course: CourseSnapshot;
  planName: string | null;
  seq: number;
  checkedAt: string;
  verdict: 'passed' | 'failed';
  result: CheckResult;
  verdictEdit?: { by: string; at: string } | null;
}

const verdictText = (v: ReportInput['verdict']) => v === 'passed' ? '检查通过' : '未通过，需修改后重新提交';
const planLabel = (r: ReportInput) => r.planName || `${r.course.planGrade}级${r.course.major}（${r.course.trainingType}）人才培养方案（未预置，相关内容需核实）`;
const issueNumber = (prefix: string, n: number) => `${prefix}${String(n + 1).padStart(2, '0')}`;
const reportTitle = (r: ReportInput) => `《${r.course.name}》教学大纲检查结果`;
const reportScope = (r: ReportInput) => `检查对象：${r.course.studentGrade}级《${r.course.name}》教学大纲。对照方案：${planLabel(r)}。`;
const reportMeta = (r: ReportInput) => `专业：${r.course.major}　培养类型：${r.course.trainingType}　检查次数：第${r.seq}次　检查时间：${r.checkedAt}`;
const REPORT_NOTE = '注：本结果由 AI 依据教学大纲检查清单生成，供修改参考；问题编号仅用于识别和引用，不代表整改顺序。';
const verdictEditNote = (r: ReportInput) => r.verdictEdit ? `检查结论由${r.verdictEdit.by}于${r.verdictEdit.at}手工修改；以下保留原 AI 检查意见。` : '';

function split(r: CheckResult) {
  return {
    major: r.issues.filter((i) => i.nature !== '建议修改'),
    suggest: r.issues.filter((i) => i.nature === '建议修改'),
  };
}

export function reportText(r: ReportInput): string {
  const { major, suggest } = split(r.result);
  const lines = [reportTitle(r), '', reportScope(r), reportMeta(r)];
  if (r.course.adjustNote) lines.push(`对照方案调整说明：${r.course.adjustNote}`);
  lines.push(`检查结论：${verdictText(r.verdict)}`, '');
  if (r.verdictEdit) lines.push(verdictEditNote(r), '');
  for (const [title, prefix, issues] of [
    ['一 明确问题及重大问题', 'A', major],
    ['二 建议修改项', 'B', suggest],
  ] as const) {
    lines.push(title);
    if (!issues.length) lines.push('无。', '');
    issues.forEach((issue, n) => lines.push(
      `${issueNumber(prefix, n)} ${issue.title}`,
      `位置：${issue.location}`,
      `问题：${issue.problem}`,
      `整改意见：${issue.advice}`, '',
    ));
  }
  if (r.result.toVerify.length) {
    lines.push('附 需核实事项', '以下事项不属于已确认问题，请结合相关材料核实。');
    r.result.toVerify.forEach((v, n) => lines.push(`${n + 1}. ${v.location ? `${v.location}：` : ''}${v.content}`));
    lines.push('');
  }
  lines.push(REPORT_NOTE);
  return lines.join('\n');
}

const BODY = { ascii: 'Times New Roman', hAnsi: 'Times New Roman', eastAsia: '宋体' };
const HEAD = { ...BODY, eastAsia: '黑体' };

const run = (text: string, bold = false, size = 22) => new TextRun({ text, bold, size, color: '000000', font: BODY });

const field = (label: string, value: string, size = 22, after = 60) => new Paragraph({
  children: [run(`${label}：`, true, size), ...value.split(/\r?\n/).map((text, n) => new TextRun({ text, break: n ? 1 : undefined, size, color: '000000', font: BODY }))],
  spacing: { after, line: size === 20 ? 280 : 320, lineRule: LineRuleType.AT_LEAST },
});

export async function reportDocx(r: ReportInput): Promise<Buffer> {
  const { major, suggest } = split(r.result);
  const children: Paragraph[] = [
    new Paragraph({ text: reportTitle(r), heading: HeadingLevel.TITLE, alignment: AlignmentType.CENTER }),
    new Paragraph({ children: [run(reportScope(r), false, 20)], spacing: { after: 80, line: 280 } }),
    new Paragraph({ children: [run(reportMeta(r), false, 20)] }),
  ];
  if (r.course.adjustNote) children.push(field('对照方案调整说明', r.course.adjustNote, 20));
  children.push(field('检查结论', verdictText(r.verdict), 20, 140));
  if (r.verdictEdit) children.push(new Paragraph({ children: [run(verdictEditNote(r), false, 20)] }));

  for (const [title, prefix, issues] of [
    ['一 明确问题及重大问题', 'A', major],
    ['二 建议修改项', 'B', suggest],
  ] as const) {
    children.push(new Paragraph({ text: title, heading: HeadingLevel.HEADING_1 }));
    if (!issues.length) children.push(new Paragraph({ children: [run('无。')] }));
    issues.forEach((issue, n) => children.push(
      new Paragraph({ text: `${issueNumber(prefix, n)} ${issue.title}`, heading: HeadingLevel.HEADING_2 }),
      field('位置', issue.location, 20),
      field('问题', issue.problem),
      field('整改意见', issue.advice, 22, 140),
    ));
  }
  if (r.result.toVerify.length) {
    children.push(new Paragraph({ text: '附 需核实事项', heading: HeadingLevel.HEADING_1 }));
    children.push(new Paragraph({ children: [run('以下事项仅凭本次提交的大纲无法确认，不属于已确认问题，请结合相关材料核实。', false, 20)] }));
    r.result.toVerify.forEach((v, n) => children.push(new Paragraph({ children: [run(`${n + 1}. ${v.location ? `${v.location}：` : ''}${v.content}`)] })));
  }
  children.push(new Paragraph({ children: [run(REPORT_NOTE, false, 18)], spacing: { before: 160 } }));

  const doc = new Document({
    styles: { default: {
      document: { run: { font: BODY, size: 22, color: '000000' }, paragraph: { spacing: { line: 320, after: 80 } } },
      title: { run: { font: HEAD, size: 38, color: '000000' }, paragraph: { spacing: { line: 480, after: 80 }, keepNext: true } },
      heading1: { run: { font: HEAD, size: 28, bold: true, color: '000000' }, paragraph: { spacing: { before: 160, after: 80, line: 400 }, keepNext: true } },
      heading2: { run: { font: HEAD, size: 24, bold: true, color: '000000' }, paragraph: { spacing: { before: 160, after: 80, line: 340 }, keepNext: true } },
    } },
    sections: [{
      properties: { page: { size: { width: 11906, height: 16838 }, margin: { top: 1020, bottom: 1020, left: 1191, right: 1191 } } },
      children,
    }],
  });
  return Packer.toBuffer(doc);
}
