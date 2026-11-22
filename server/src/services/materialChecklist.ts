import { z } from 'zod';
import checklist from '../seed/materialChecklist.json' with { type: 'json' };

export const materialVersion = checklist.version;
export type MaterialRule = typeof checklist.items[number];
export const materialTypes = [...new Set(checklist.items.flatMap((r) => r.materials.map((m) => m.name)))];
export const planMaterial = '人才培养方案及支撑矩阵';
export const flags = {
  ongoing: '在授课程',
  currentNotice: '本轮要求随堂备查',
  coTeaching: '多人授课',
  adjusted: '有假期或调课',
  textbook: '使用教材／实验指导书',
  attendance: '有考勤评分',
  coursework: '设平时考核',
  oral: '课堂提问计分',
  labHours: '独立实践另含实验学时',
  separateLab: '另设实验成绩表',
  fiveReports: '本课程安排五次实验报告',
  twoPapers: '须配置 A/B 卷',
  paperAnswers: '纸质答卷',
  archived: '已归档或本次检查归档',
  internship: '实习',
  thesis: '毕业论文（设计）',
  historical: '历史课程',
  originalCases: '原四门课历史个案回查',
  labReview: '本轮适用实验抽查表',
  mockProgram: '本轮使用模拟评估专业口径',
  examReview2024: '2024 年度试卷互查专项',
} as const;
export type MaterialFlag = keyof typeof flags;
const label = z.string().trim().min(1).max(120);
export const materialScopeSchema = z.object({
  level: z.enum(['course', 'program', 'group', 'college']),
  title: label,
  term: label,
  section: z.string().trim().max(120).default(''),
  major: z.string().trim().max(120).default(''),
  group: z.string().trim().max(120).default(''),
  planGrade: z.coerce.number().int().min(2000).max(2100).default(2025),
  teaching: z.enum(['theory', 'mixed', 'practice']).default('theory'),
  assessments: z.array(z.enum(['written', 'computer', 'project', 'report', 'other'])).max(5).default([]),
  flags: z.array(z.enum(Object.keys(flags) as MaterialFlag[])).default([]),
  rounding: z.enum(['unknown', 'integer', 'oneDecimal', 'exact']).default('unknown'),
}).superRefine((v, ctx) => {
  if (v.level === 'course' && (!v.section || !v.major || !v.assessments.length))
    ctx.addIssue({ code: 'custom', message: '请选择专业和考核形式，并填写教学班' });
  if (v.level === 'program' && !v.major) ctx.addIssue({ code: 'custom', message: '请选择复核专业' });
  if (v.level === 'group' && !v.group) ctx.addIssue({ code: 'custom', message: '请选择复核课程组' });
});

export type MaterialScope = z.infer<typeof materialScopeSchema>;

const byLevel: Record<MaterialScope['level'], string[]> = {
  course: [],
  program: ['C086', 'C087', 'C088', 'C089', 'C094'],
  group: ['C090', 'C091', 'C092', 'C093', 'C094'],
  college: ['C093', 'C094', 'C095', 'C096'],
};

export function ruleApplies(r: MaterialRule, s: MaterialScope, supplied: Set<string>) {
  const has = (flag: MaterialFlag) => s.flags.includes(flag);
  if (s.level !== 'course') return byLevel[s.level].includes(r.code)
    && (!['C087', 'C089'].includes(r.code) || has('mockProgram'))
    && (r.code !== 'C091' || (has('examReview2024') && /\b2024\b/.test(s.term)));
  if (Object.values(byLevel).some((codes) => codes.includes(r.code))) return false;
  const written = s.assessments.includes('written');
  const exam = written || s.assessments.includes('computer');
  const project = s.assessments.includes('project');
  const report = s.assessments.includes('report');
  const practice = s.teaching !== 'theory';
  const lab = s.teaching === 'mixed' || (s.teaching === 'practice' && has('labHours'));
  const coursework = has('coursework') || supplied.has('平时考核记录表');
  switch (r.code) {
    case 'C004': case 'C026': case 'C027': case 'C028': case 'C029': case 'C035': case 'C036': return coursework;
    case 'C005': case 'C053': case 'C054': case 'C055': case 'C058': case 'C060': case 'C061': case 'C070': return written;
    case 'C006': case 'C038': case 'C043': return practice;
    case 'C025': case 'C039': return lab;
    case 'C007': return has('ongoing') && has('currentNotice');
    case 'C017': case 'C031': return has('coTeaching');
    case 'C019': return has('adjusted');
    case 'C020': return has('textbook');
    case 'C021': return has('ongoing') || supplied.has('教案') || supplied.has('课件');
    case 'C022': return supplied.has('教案');
    case 'C024': return has('attendance');
    case 'C030': return coursework && has('coTeaching');
    case 'C033': return coursework || project || lab;
    case 'C034': return coursework && has('oral');
    case 'C037': return has('historical');
    case 'C040': return lab || project;
    case 'C041': return lab && has('fiveReports');
    case 'C042': return lab && has('separateLab');
    case 'C044': return practice || project || report || has('thesis');
    case 'C045': case 'C047': case 'C048': return practice || project || report;
    case 'C046': return lab && has('labReview');
    case 'C049': return report && /2025\s*[-—–]\s*2026.*(?:第\s*)?2(?:学期|$)/.test(s.term);
    case 'C050': return s.teaching === 'practice' && (project || report);
    case 'C051': return practice || project || has('internship');
    case 'C052': return practice && has('coTeaching');
    case 'C056': case 'C057': return written && has('twoPapers');
    case 'C059': return exam;
    case 'C062': return written || report || lab;
    case 'C063': case 'C064': case 'C065': case 'C066': case 'C067': return written && has('paperAnswers');
    case 'C068': return written || report;
    case 'C069': return exam;
    case 'C075': return has('archived');
    case 'C076': return s.assessments.includes('computer');
    case 'C077': return lab && has('originalCases') && has('historical');
    case 'C078': return written && has('originalCases') && has('historical');
    case 'C079': return has('adjusted') && has('originalCases') && has('historical');
    case 'C080': return s.title.includes('扩散模型') && /2025\s*[-—–]\s*2026.*(?:第\s*)?2(?:学期|$)/.test(s.term);
    case 'C081': return has('internship');
    case 'C082': case 'C083': case 'C084': case 'C085': return has('thesis');
    default: return true;
  }
}

export function ruleMaterials(r: MaterialRule, s: MaterialScope, supplied: Set<string>) {
  const coursework = s.flags.includes('coursework') || supplied.has('平时考核记录表');
  const lab = s.teaching !== 'theory';
  const written = s.assessments.includes('written');
  const project = s.assessments.includes('project');
  const report = s.assessments.includes('report');
  const extra = r.code === 'C099' ? ['教学进度表（教学日历）', '课程成绩单',
    ...(coursework ? ['平时考核记录表'] : []), ...(lab ? ['实验（实践）项目计划表'] : []),
    ...(written ? ['命题双向细目表'] : []), ...(project ? ['项目任务、作品及实践评分表'] : [])]
    : ['C069', 'C070', 'C071'].includes(r.code) ? ['课程成绩单'] : [];
  return [...new Set([...r.materials.map((m) => m.name), ...extra])].filter((type) => {
    if (s.level !== 'course') return true;
    if (supplied.has(type)) return true;
    if (['平时考核记录表', '原始平时考核材料（按实际形式）'].includes(type)) return coursework;
    if (type === '实验成绩记录表（单独设置时）') return lab && s.flags.includes('separateLab');
    if (['实验报告、实践报告', '实验（实践）项目计划表'].includes(type)) return lab;
    if (type === '项目任务、作品及实践评分表') return project || (s.teaching === 'practice' && !report);
    if (type === 'A、B卷样卷') return written;
    if (type === '学生答卷') return written;
    if (type === '课程论文') return report;
    if (type === '实习日志及实习考核档案') return s.flags.includes('internship');
    if (type === '随堂教学资料（按本轮通知）') return s.flags.includes('ongoing');
    if (type === '教材或实验指导书') return s.flags.includes('textbook');
    if (type === '归档目录、封面及材料袋') return s.flags.includes('archived') || ['C005', 'C006', 'C076'].includes(r.code);
    if (type === '课件') return false;
    return true;
  });
}

export function scopeRules(scope: MaterialScope, supplied: Set<string>) {
  return checklist.items.map((rule) => {
    const applies = ruleApplies(rule, scope, supplied);
    return { rule, applies, materials: applies ? ruleMaterials(rule, scope, supplied) : [] };
  });
}

export function availableMaterials(scope: MaterialScope, supplied: Set<string>) {
  return [...new Set(scopeRules(scope, supplied).flatMap((r) => r.materials))];
}

export function optionalMaterials(scope: MaterialScope, required: string[]) {
  if (scope.level !== 'course') return [];
  return availableMaterials(scope, new Set(materialTypes))
    .filter((type) => !required.includes(type) && (scope.teaching !== 'theory' ||
      !['实验成绩记录表（单独设置时）', '实验报告、实践报告', '实验（实践）项目计划表'].includes(type)));
}
