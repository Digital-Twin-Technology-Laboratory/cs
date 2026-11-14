import path from 'node:path';
import { splitPublicPlan } from './publicPlan.js';

export const PLAN_MAJORS = ['计算机科学与技术', '计算机科学与技术（专转本）', '物联网工程', '物联网工程（中外合作）', '人工智能', '公共'] as const;

export function identifyPlanMajor(fileName: string, text: string) {
  const sections = splitPublicPlan(text);
  if (sections.length > 1) {
    return { major: '公共', trainingType: '普通本科', ambiguous: false, evidence: [`全校合订方案：识别到 ${sections.length} 个专业章节（${sections.map((section) => section.major).join('、')}）`] };
  }
  const titleLines = text.slice(0, 1500).split(/\r?\n/).map((line) => line.replace(/^#+\s*/, '').replace(/\s/g, '')).filter(Boolean).slice(0, 12);
  const sources = [
    { label: '文件名', value: path.basename(fileName, path.extname(fileName)) },
    ...titleLines.filter((line) => !line.includes('|') && line.length <= 100 && (
      /^专业(?:名称)?[:：]/.test(line)
      || /^(?:20\d{2}(?:级|年)?)?(?:计算机科学与技术|物联网工程|人工智能)(?:专业)?(?:[（(](?:专转本|普通本科)[）)])?(?:专业)?(?:本科)?(?:(?:人才)?培养方案)?(?:[（(]20\d{2}(?:年|级|版)?[）)])?$/.test(line)
    )).map((line) => {
      const index = titleLines.indexOf(line);
      const transfer = /^[(（]?专转本[)）]?$/.test(titleLines[index + 1] ?? '');
      return { label: '正文标题', value: line + (transfer ? ` ${titleLines[index + 1]}` : '') };
    }),
  ];
  const matches = new Set<string>();
  const evidence: string[] = [];
  for (const source of sources) {
    const value = source.value.replace(/\s/g, '');
    const majors = ['计算机科学与技术', '物联网工程', '人工智能'].filter((major) => value.includes(major));
    if (!majors.length) continue;
    if (!evidence.includes(`${source.label}：${source.value}`)) evidence.push(`${source.label}：${source.value}`);
    for (const major of majors) matches.add(major === '计算机科学与技术' && value.includes('专转本') ? PLAN_MAJORS[1] : major);
  }
  const major = matches.size === 1 ? [...matches][0] : null;
  return { major, trainingType: major ? (major === PLAN_MAJORS[1] ? '专转本' : '普通本科') : null, ambiguous: matches.size > 1, evidence };
}
