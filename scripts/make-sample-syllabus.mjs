// 生成一份测试用教学大纲 docx（考核方式表故意写错合计），仅用于开发测试。
// 用法：node scripts/make-sample-syllabus.mjs 输出路径
import fs from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(new URL('../server/package.json', import.meta.url));
const { Document, Packer, Paragraph, Table, TableRow, TableCell, TextRun, HeadingLevel } = require('docx');

const out = process.argv[2] || 'sample-syllabus.docx';
const p = (t) => new Paragraph({ children: [new TextRun(t)] });
const h = (t) => new Paragraph({ heading: HeadingLevel.HEADING_2, children: [new TextRun(t)] });
const table = (rows) =>
  new Table({ rows: rows.map((r) => new TableRow({ children: r.map((c) => new TableCell({ children: [p(c)] })) })) });

const doc = new Document({
  sections: [
    {
      children: [
        new Paragraph({ heading: HeadingLevel.HEADING_1, children: [new TextRun('《数据库原理与设计》课程教学大纲')] }),
        h('一、课程基本信息'),
        table([
          ['课程代码', 'CS2031', '课程名称', '数据库原理与设计'],
          ['学分', '3', '总学时', '48（理论32，实验16）'],
          ['适用专业', '计算机科学与技术', '开课学期', '第4学期'],
        ]),
        h('二、课程目标'),
        p('课程目标1：掌握关系数据库的基本原理，能够运用关系代数和SQL表达数据查询需求。（支撑毕业要求1.2）'),
        p('课程目标2：能够针对具体应用进行数据库概念设计与逻辑设计。（支撑毕业要求3.2）'),
        p('课程目标3：能够使用主流数据库管理系统完成数据库实现与维护。（支撑毕业要求5.1）'),
        h('三、教学内容与学时分配'),
        table([
          ['章节', '内容', '学时'],
          ['第1章', '数据库系统概述', '4'],
          ['第2章', '关系模型与关系代数', '8'],
          ['第3章', 'SQL语言', '10'],
          ['第4章', '数据库设计', '10'],
          ['实验1-4', 'SQL与数据库设计实验', '16'],
        ]),
        h('六、考核方式'),
        p('（一）考核方式表'),
        table([
          ['课程目标', '平时', '实验', '期末', '合计'],
          ['目标1', '5%', '5%', '30%', '40%'],
          ['目标2', '5%', '5%', '5%', '15%'],
          ['目标3', '5%', '15%', '5%', '25%'],
          ['合计', '15%', '25%', '50%', '90%'],
        ]),
        p('平时成绩由考勤和作业构成。期末考试按照试卷评分标准考核。'),
        h('七、教材'),
        p('王珊，萨师煊.《数据库系统概论》（第6版）. 高等教育出版社.'),
        p('审核人：            日期：'),
      ],
    },
  ],
});
fs.writeFileSync(out, await Packer.toBuffer(doc));
console.log('written', out);
