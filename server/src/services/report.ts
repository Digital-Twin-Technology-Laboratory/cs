import {
  AlignmentType,
  BorderStyle,
  Document,
  Packer,
  Paragraph,
  Table,
  TableCell,
  TableRow,
  TextRun,
  WidthType,
} from 'docx';
import type { CheckResult } from './ai/schema.js';
import type { CourseSnapshot } from './checkQueue.js';

export interface ReportInput {
  course: CourseSnapshot;
  planName: string | null;
  seq: number;
  checkedAt: string;
  verdict: 'passed' | 'failed';
  result: CheckResult;
}

const verdictText = (v: ReportInput['verdict']) => (v === 'passed' ? '检查通过' : '未通过，需按清单修改后重新提交');

function planLabel(r: ReportInput) {
  return r.planName || `${r.course.planGrade}级${r.course.major}（${r.course.trainingType}）人才培养方案`;
}

function split(r: CheckResult) {
  return {
    major: r.issues.filter((i) => i.nature !== '建议修改'),
    suggest: r.issues.filter((i) => i.nature === '建议修改'),
  };
}

/** 纯文本修改清单（可复制）。不含内部条目编号、原文摘录、处理顺序。 */
export function reportText(r: ReportInput): string {
  const { major, suggest } = split(r.result);
  const L: string[] = [];
  L.push(`《${r.course.name}》教学大纲修改清单`);
  L.push('');
  L.push(`课程名称：${r.course.name}`);
  L.push(`专业：${r.course.major}　培养类型：${r.course.trainingType}　学生年级：${r.course.studentGrade}级`);
  L.push(`对照方案：${planLabel(r)}`);
  if (r.course.adjustNote) L.push(`对照方案调整说明：${r.course.adjustNote}`);
  L.push(`检查次数：第${r.seq}次　检查时间：${r.checkedAt}`);
  L.push(`检查结论：${verdictText(r.verdict)}`);
  L.push('');
  L.push(`一、明确问题及重大问题（共${major.length}项）`);
  if (!major.length) L.push('无。');
  major.forEach((i, n) => {
    L.push(`问题${n + 1}【${i.nature}】${i.title}`);
    L.push(`所在位置：${i.location}`);
    L.push(`当前问题：${i.problem}`);
    L.push(`整改意见：${i.advice}`);
    L.push('');
  });
  if (!major.length) L.push('');
  L.push(`二、建议修改（共${suggest.length}项）`);
  if (!suggest.length) L.push('无。');
  suggest.forEach((i, n) => {
    L.push(`建议${n + 1} ${i.title}`);
    L.push(`所在位置：${i.location}`);
    L.push(`当前问题：${i.problem}`);
    L.push(`整改意见：${i.advice}`);
    L.push('');
  });
  if (r.result.toVerify.length) {
    if (!suggest.length) L.push('');
    L.push('附：需核实事项（不属于已确认问题，请结合相关材料核实）');
    r.result.toVerify.forEach((v, n) => L.push(`${n + 1}. ${v.location ? `${v.location}：` : ''}${v.content}`));
    L.push('');
  }
  L.push('注：本清单由 AI 依据教学大纲检查清单生成，供修改参考；问题编号仅用于识别和引用，不代表整改顺序。');
  return L.join('\n');
}

// ---------- Word ----------
const BODY = '宋体';
const HEAD = '黑体';

const run = (text: string, o: { bold?: boolean; font?: string; size?: number; color?: string } = {}) =>
  new TextRun({ text, bold: o.bold, size: o.size ?? 24, color: o.color, font: { name: o.font ?? BODY, eastAsia: o.font ?? BODY } });

const para = (children: TextRun[], o: { before?: number; after?: number; indent?: number; align?: (typeof AlignmentType)[keyof typeof AlignmentType] } = {}) =>
  new Paragraph({
    children,
    alignment: o.align,
    spacing: { before: o.before ?? 0, after: o.after ?? 60, line: 360 },
    indent: o.indent ? { left: o.indent } : undefined,
  });

const field = (label: string, value: string) => para([run(`${label}：`, { bold: true }), run(value)], { indent: 420 });

const heading = (text: string) => para([run(text, { font: HEAD, size: 28, bold: true })], { before: 240, after: 120 });

function infoTable(r: ReportInput) {
  const border = { style: BorderStyle.SINGLE, size: 4, color: '999999' };
  const borders = { top: border, bottom: border, left: border, right: border };
  const cell = (text: string, label = false, span = 1) =>
    new TableCell({
      columnSpan: span,
      borders,
      width: { size: label ? 1400 : 3100, type: WidthType.DXA },
      shading: label ? { fill: 'F2F2F2' } : undefined,
      margins: { top: 60, bottom: 60, left: 100, right: 100 },
      children: [new Paragraph({ children: [run(text, { bold: label, size: 21 })] })],
    });
  const rows = [
    [cell('课程名称', true), cell(r.course.name), cell('专业', true), cell(r.course.major)],
    [cell('培养类型', true), cell(r.course.trainingType), cell('学生年级', true), cell(`${r.course.studentGrade}级`)],
    [cell('对照方案', true), cell(planLabel(r) + (r.course.adjustNote ? `（调整说明：${r.course.adjustNote}）` : ''), false, 3)],
    [cell('检查次数', true), cell(`第${r.seq}次`), cell('检查时间', true), cell(r.checkedAt)],
    [cell('检查结论', true), cell(verdictText(r.verdict), false, 3)],
  ];
  return new Table({
    width: { size: 9000, type: WidthType.DXA },
    columnWidths: [1400, 3100, 1400, 3100],
    rows: rows.map((cells) => new TableRow({ children: cells })),
  });
}

export async function reportDocx(r: ReportInput): Promise<Buffer> {
  const { major, suggest } = split(r.result);
  const children: (Paragraph | Table)[] = [];
  children.push(
    para([run(`《${r.course.name}》教学大纲修改清单`, { font: HEAD, size: 36, bold: true })], {
      align: AlignmentType.CENTER,
      after: 240,
    }),
  );
  children.push(infoTable(r));

  children.push(heading(`一、明确问题及重大问题（共${major.length}项）`));
  if (!major.length) children.push(para([run('无。')], { indent: 420 }));
  major.forEach((i, n) => {
    children.push(para([run(`问题${n + 1}　【${i.nature}】${i.title}`, { bold: true })], { before: 120 }));
    children.push(field('所在位置', i.location), field('当前问题', i.problem), field('整改意见', i.advice));
  });

  children.push(heading(`二、建议修改（共${suggest.length}项）`));
  if (!suggest.length) children.push(para([run('无。')], { indent: 420 }));
  suggest.forEach((i, n) => {
    children.push(para([run(`建议${n + 1}　${i.title}`, { bold: true })], { before: 120 }));
    children.push(field('所在位置', i.location), field('当前问题', i.problem), field('整改意见', i.advice));
  });

  if (r.result.toVerify.length) {
    children.push(heading('附：需核实事项'));
    children.push(para([run('以下事项仅凭本次提交的大纲无法确认，不属于已确认问题，请结合相关材料核实。', { size: 21, color: '555555' })]));
    r.result.toVerify.forEach((v, n) =>
      children.push(para([run(`${n + 1}. `), ...(v.location ? [run(`${v.location}：`, { bold: true })] : []), run(v.content)], { indent: 210 })),
    );
  }

  children.push(
    para([run('注：本清单由 AI 依据教学大纲检查清单生成，供修改参考；问题编号仅用于识别和引用，不代表整改顺序。', { size: 18, color: '777777' })], {
      before: 360,
    }),
  );

  const doc = new Document({
    styles: { default: { document: { run: { font: { name: BODY, eastAsia: BODY }, size: 24 } } } },
    sections: [
      {
        properties: { page: { margin: { top: 1440, bottom: 1440, left: 1440, right: 1440 } } },
        children,
      },
    ],
  });
  return Packer.toBuffer(doc);
}
