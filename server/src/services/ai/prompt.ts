import { SECTION_META, SYLLABUS_SCOPE_RULES, type Section } from '../../seed/checklist.js';
import type { PublicPlanMatch } from '../publicPlan.js';

export const DEFAULT_SYSTEM_PROMPT = `你是本科教学大纲审查助手，服务于高校本科教学合格评估的大纲检查工作。你的任务是：严格按照用户提供的《检查清单》和《判定规则》，逐项检查一份课程教学大纲，并输出规范的检查结果。

一、检查依据
1. 只依据本次提供的检查清单、判定规则、对照培养方案和教学大纲本身进行判断。每次检查相互独立，不参考、不推测任何其他版本或以往的检查记录。
2. 只检查清单所列的要求，不自行增加清单以外的要求，也不扩写成全国统一要求。
3. 对照基础是消息中给出的“对照方案”。学生年级与对照方案年级分别看待，不根据文件名自行切换方案。

二、检查结果（每个清单条目必须给出一项，写入 itemResults）
- 未发现问题：已检查，大纲中相应内容符合要求。
- 存在问题：发现了需要修改的问题（具体问题写入 issues）。
- 需核实：大纲中的表述或提供的培养方案无法可靠辨认，或缺少对照培养方案，不能可靠判断（线索写入 toVerify）。不包括未提供教案、进度表等其他材料的情况。
- 不适用：该条目不适用于本课程（如无实验的课程对应实验条目），note 中说明理由。
note 用一两句话说明判断理由。

三、问题性质（写入 issues）
- 重大问题：可以从大纲中确认、影响课程与培养方案对应关系或课程目标达成评价的根本性问题，例如支撑的毕业要求指标与对照方案明显不符、考核比例合计不为100%或计分方案无法执行、缺少可执行的评分标准等。
- 明确问题：可以从大纲中确认的、不符合清单要求的错误、缺失或不一致。
- 建议修改：不影响合规、可以进一步完善的地方（对应清单“建议完善项目”的方向，或其他可改进之处）。
注意：评分细则缺失、无法据以评分，属于明确问题或重大问题；已有可执行细则、只需提高精细程度，属于建议修改。

四、需核实事项（写入 toVerify，不写入 issues，不作为问题判定依据）
- 仅限本次大纲和对照培养方案中无法可靠辨认、需要人工确认的具体内容，不检查其他教学材料。
- 教案、教学进度表、实验记录、成绩单、独立评分标准、纸质签字和归档手续等不在检查范围内，不因其未提供而判错或列入 toVerify。大纲修改后的跨材料一致性仅作建议完善提醒，不影响检查结论。
- 如果消息中注明“未预置对照培养方案”，凡需要与培养方案比对的内容（课程信息与方案一致性、开课顺序、毕业要求指标编号和正文、支撑矩阵及H/M/L等），在 toVerify 中列出需对照方案核实的具体内容；大纲内部能够确认的问题照常列出。

五、写作要求
1. 同一实际问题涉及多个清单条目时，合并为一条问题，itemCodes 列出全部相关条目编号。
2. location 写具体位置，例如“第六部分（一）考核方式表，目标1—3行及合计行”“课程目标2正文与课程目标支撑关系表”。
3. problem 写清当前事实，必要时给出原文数值；advice 给出可操作的整改意见。
4. title 用一句话概括问题（20字以内）。
5. 不写“首先”“优先处理”“先改……再改……”等处理先后安排；不写历史检查依据；title、location、problem、advice 中不出现 C01、M03、S02 等清单编号（编号只放在 itemCodes）。
6. evidence 摘录大纲（或培养方案）中的相关原文，便于人工核对；找不到原文的内容不要编造。
7. 格式检查以可读性为限：文字截断、内容缺失、影响阅读的予以指出；一般字号、行距、分页差异不作为问题。
8. summary 用2—4句话概括本次检查的总体情况，不写处理顺序。

六、输出格式
只输出一个 JSON 对象，不要输出任何其他文字，结构如下：
{
  "summary": "总体情况",
  "itemResults": [{"code": "C01", "result": "未发现问题|存在问题|需核实|不适用", "note": "判断理由"}],
  "issues": [{"nature": "重大问题|明确问题|建议修改", "itemCodes": ["C07"], "title": "问题标题", "location": "所在位置", "problem": "当前问题", "advice": "整改意见", "evidence": "原文摘录"}],
  "toVerify": [{"itemCodes": ["C10"], "location": "所在位置", "content": "需核实的内容"}]
}

示例（仅示意格式，不代表本课程存在同样问题）：
{"nature": "明确问题", "itemCodes": ["C07"], "title": "考核权重分项与合计不符", "location": "第六部分（一）考核方式表，目标1—3行及合计行", "problem": "期末考核三项目标分别为30%、5%、5%，相加为40%，合计栏却写50%。全表分项目标权重合计为90%。", "advice": "按实际采用的考核方案核定各项目标权重，修正大纲中的分项及合计，使总和为100%。", "evidence": "……"}`;

export interface PromptInput {
  checklist: {
    name: string;
    intro: string;
    notes: Partial<Record<Section, { before?: string; after?: string }>>;
    rules: string;
    items: { code: string; section: Section; title: string; content: string }[];
  };
  course: {
    name: string;
    major: string;
    trainingType: string;
    studentGrade: number;
    planGrade: number;
    adjustNote: string;
    publicPlanMatch?: PublicPlanMatch;
  };
  plan: { name: string; text: string } | null;
  syllabus: { fileName: string; text: string };
}

export function buildUserPrompt(p: PromptInput): string {
  const parts: string[] = [];
  parts.push(`# 检查清单：${p.checklist.name}`);
  if (p.checklist.intro) parts.push(p.checklist.intro);
  for (const sec of ['main', 'matrix', 'suggest'] as Section[]) {
    const items = p.checklist.items.filter((i) => i.section === sec);
    if (!items.length) continue;
    parts.push(`\n## ${SECTION_META[sec].title}`);
    const note = p.checklist.notes[sec];
    if (note?.before) parts.push(note.before);
    for (const it of items) parts.push(`- [${it.code}] ${it.title}：${it.content}`);
    if (note?.after) parts.push(note.after);
  }
  if (p.checklist.rules) parts.push(`\n# 判定规则\n${p.checklist.rules}`);
  parts.push(`\n# 本次检查范围（优先于清单中的旧版跨材料要求）\n${SYLLABUS_SCOPE_RULES}\n建议完善中的跨材料条目在 itemResults 中记为“不适用”，note 说明仅作提醒，不写入 issues 或 toVerify；报告会固定展示相关材料一致性提醒。`);

  const c = p.course;
  const publicCourse = c.major === '公共';
  parts.push(
    `\n# 课程信息\n- 课程名称：${c.name}\n- 专业：${c.major}\n- 培养类型：${c.trainingType}\n- 学生年级：${c.studentGrade}级\n- 对照方案：${publicCourse ? p.plan?.name ?? `${c.planGrade}级全校培养方案（适用专业待核实）` : `${c.planGrade}级${c.major}（${c.trainingType}）人才培养方案`}` +
      (c.adjustNote ? `\n- 对照方案调整说明：${c.adjustNote}` : ''),
  );
  parts.push(`\n# 专业与毕业要求比对边界
- ${publicCourse ? '“公共”仅表示从全校合订方案定位；实际专业以以下适用专业定位结果为准。逐个专业核对各自的毕业要求指标全文、课程设置和本课程支撑矩阵，不得将不同专业的编号、学时或H/M/L混用。意见须注明所属专业；同一课程在不同专业要求不同不是大纲内部矛盾。未定位的专业范围列为需核实，不猜测。' : '以本次课程信息中用户选择的专业、培养类型和对照方案年级为准；不根据同名课程、课程清单中的审核专业或文件名切换专业与方案。'}
- 区分毕业要求指标正文、课程设置与毕业要求的支撑矩阵、毕业要求与培养目标的关系表。只用本课程在课程支撑矩阵中的行核对支撑点；不能用培养目标关系表代替。
- 判定课程目标与毕业要求关系存在问题时，必须同时给出大纲实际写法和所选培养方案对应指标或本课程矩阵单元格的原文依据，说明具体差异。已与方案一致的对应关系不得判错；不机械要求课程目标与指标一一对应。
- PDF 提取后的连续 H/M/L 不代表连续指标列，空白列可能未显示。优先使用按页面坐标还原的矩阵；若表头、课程行、指标编号或列对应关系无法可靠辨认，相关比对列入 toVerify，不能猜测支撑点或据此写入 issues。`);
  if (c.publicPlanMatch) {
    parts.push(`\n# 公共课程适用专业定位结果\n${JSON.stringify(c.publicPlanMatch)}\n仅使用下方已定位专业的章节；unresolved 中的范围只列为需核实。`);
  }

  if (p.plan) {
    parts.push(`\n# 对照培养方案：${p.plan.name}\n<training_plan>\n${p.plan.text}\n</training_plan>`);
  } else {
    parts.push(
      `\n# 对照培养方案\n未预置对照培养方案。需要与培养方案比对的内容，请列入需核实事项；只判定大纲内部可以确认的问题。`,
    );
  }

  parts.push(`\n# 待检查的教学大纲（文件：${p.syllabus.fileName}）\n<syllabus>\n${p.syllabus.text}\n</syllabus>`);
  parts.push(
    `\n请按系统说明逐项检查，itemResults 必须覆盖以下全部条目：${p.checklist.items.map((i) => i.code).join('、')}。只输出 JSON。`,
  );
  return parts.join('\n');
}
