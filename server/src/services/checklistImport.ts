import path from 'node:path';
import fs from 'node:fs/promises';
import { parse, HTMLElement, NodeType } from 'node-html-parser';
import { docxToHtml, ExtractError } from './extract.js';
import type { Section } from '../seed/checklist.js';
import { callAi } from './ai/provider.js';
import { extractJson } from './ai/schema.js';

export interface ChecklistDraft {
  name: string;
  intro: string;
  notes: Record<Section, { before: string; after: string }>;
  rules: string;
  items: { code: string; section: Section; title: string; content: string }[];
}

const PREFIX: Record<Section, string> = { main: 'C', matrix: 'M', suggest: 'S' };
const CODE_RE = /^[A-Z]{1,2}\d{1,3}$/;

function detectSection(text: string): Section | null {
  if (/矩阵|毕业要求与课程/.test(text)) return 'matrix';
  if (/建议完善|完善项目|建议修改/.test(text)) return 'suggest';
  if (/主要检查|检查项目/.test(text)) return 'main';
  return null;
}

const emptyNotes = (): ChecklistDraft['notes'] => ({
  main: { before: '', after: '' },
  matrix: { before: '', after: '' },
  suggest: { before: '', after: '' },
});

function rowsToItems(rows: string[][], section: Section, draft: ChecklistDraft) {
  let start = 0;
  // 跳过表头行
  if (rows[0] && rows[0].some((c) => /编号|检查项目|核查内容|项目|检查内容|完善方向/.test(c)) && !CODE_RE.test(rows[0][0])) start = 1;
  for (const r of rows.slice(start)) {
    const cells = r.map((c) => c.trim()).filter((c, i) => c || i > 0);
    if (cells.length < 2) continue;
    let code = '';
    let title: string;
    let content: string;
    if (CODE_RE.test(cells[0]) && cells.length >= 3) {
      [code, title] = cells;
      content = cells.slice(2).join(' ');
    } else {
      [title] = cells;
      content = cells.slice(1).join(' ');
    }
    if (!title || !content) continue;
    const n = draft.items.filter((i) => i.section === section).length + 1;
    draft.items.push({ code: code || `${PREFIX[section]}${String(n).padStart(2, '0')}`, section, title, content });
  }
}

/** 解析 Word：表格按顺序对应各部分，表格之间的段落作为说明 */
function parseDocxHtml(html: string, fileName: string): ChecklistDraft {
  const root = parse(html);
  const draft: ChecklistDraft = { name: path.basename(fileName, path.extname(fileName)), intro: '', notes: emptyNotes(), rules: '', items: [] };
  let current: Section | null = null;
  let titleTaken = false;
  const introParts: string[] = [];
  const pending: string[] = []; // 表格之前的段落
  const order: Section[] = ['main', 'matrix', 'suggest'];
  let tableIdx = 0;

  for (const n of root.childNodes) {
    if (n.nodeType !== NodeType.ELEMENT_NODE) continue;
    const e = n as HTMLElement;
    const tag = e.tagName.toLowerCase();
    if (tag === 'table') {
      const sec: Section = current ?? order[Math.min(tableIdx, 2)];
      if (pending.length) draft.notes[sec].before = pending.splice(0).join('\n\n');
      const rows = e.querySelectorAll('tr').map((tr) =>
        tr.childNodes
          .filter((c) => c.nodeType === NodeType.ELEMENT_NODE && ['td', 'th'].includes((c as HTMLElement).tagName.toLowerCase()))
          .map((c) => (c as HTMLElement).textContent.replace(/\s+/g, ' ').trim()),
      );
      rowsToItems(rows, sec, draft);
      tableIdx++;
      current = sec;
      continue;
    }
    const text = e.textContent.replace(/\s+/g, ' ').trim();
    if (!text) continue;
    if (!titleTaken && /清单/.test(text) && text.length < 40) {
      draft.name = text;
      titleTaken = true;
      continue;
    }
    const sec = text.length < 30 ? detectSection(text) : null;
    if (sec && /^[一二三四五六七八九十\d]/.test(text)) {
      // 新部分标题：此前积累的段落归入上一部分的表后说明
      if (pending.length && current) draft.notes[current].after = pending.splice(0).join('\n\n');
      current = sec;
      continue;
    }
    if (!draft.items.length && !current) introParts.push(text);
    else pending.push(text);
  }
  if (pending.length && current) draft.notes[current].after = pending.join('\n\n');
  draft.intro = introParts.join('\n\n');
  return draft;
}

/** 解析纯文本/Markdown：支持 Markdown 表格或 “C01 标题：内容” 格式 */
function parsePlainText(text: string, fileName: string): ChecklistDraft {
  const draft: ChecklistDraft = { name: path.basename(fileName, path.extname(fileName)), intro: '', notes: emptyNotes(), rules: '', items: [] };
  let current: Section = 'main';
  const intro: string[] = [];
  let tableRows: string[][] = [];
  const flush = () => {
    if (tableRows.length) rowsToItems(tableRows, current, draft);
    tableRows = [];
  };
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith('|')) {
      if (/^\|[\s\-:|]+\|$/.test(line)) continue;
      tableRows.push(line.replace(/^\||\|$/g, '').split('|').map((c) => c.trim()));
      continue;
    }
    flush();
    const h = line.replace(/^#+\s*/, '');
    if (/^#/.test(line) && /清单/.test(h) && !draft.items.length) {
      draft.name = h;
      continue;
    }
    const sec = h.length < 30 ? detectSection(h) : null;
    if (sec) {
      current = sec;
      continue;
    }
    const m = h.match(/^[-*]?\s*\[?([A-Z]{1,2}\d{1,3})\]?\s*[、.．\s]?\s*([^：:]{1,40})[：:]\s*(.+)$/);
    if (m) {
      draft.items.push({ code: m[1], section: current, title: m[2].trim(), content: m[3].trim() });
      continue;
    }
    if (!draft.items.length) intro.push(h);
    else draft.notes[current].after = [draft.notes[current].after, h].filter(Boolean).join('\n\n');
  }
  flush();
  draft.intro = intro.join('\n\n');
  return draft;
}

export async function parseChecklistFile(filePath: string, originalName: string): Promise<ChecklistDraft> {
  const ext = path.extname(originalName).toLowerCase();
  if (ext === '.docx') return parseDocxHtml(await docxToHtml(filePath), originalName);
  if (ext === '.txt' || ext === '.md') return parsePlainText(await fs.readFile(filePath, 'utf8'), originalName);
  throw new ExtractError('检查清单只支持 .docx、.txt、.md 文件');
}

/** 规则解析不出条目时，可让 AI 把文本整理为结构化清单（管理员预览确认后才保存） */
export async function aiStructureChecklist(text: string, fileName: string): Promise<ChecklistDraft> {
  const system = '你是文档结构整理助手。只做结构整理，逐字保留原文，不改写、不增删内容。只输出 JSON。';
  const user = `把下面的“教学大纲检查清单”整理为 JSON：
{"name":"清单名称","intro":"开头说明","rules":"判定规则（没有则为空）","notes":{"main":{"before":"","after":""},"matrix":{"before":"","after":""},"suggest":{"before":"","after":""}},"items":[{"code":"C01","section":"main|matrix|suggest","title":"项目名称","content":"检查内容"}]}
section 含义：main=主要检查项目，matrix=毕业要求与课程矩阵专项检查，suggest=建议完善项目。原文没有编号时，main 用 C01 起、matrix 用 M01 起、suggest 用 S01 起。

<document>
${text}
</document>`;
  const r = await callAi(user, { system, structured: false });
  const j = extractJson(r.text) as Partial<ChecklistDraft>;
  const items = (j.items ?? [])
    .filter((i) => i && i.title && i.content && ['main', 'matrix', 'suggest'].includes(i.section))
    .map((i) => ({ code: String(i.code || '').toUpperCase(), section: i.section, title: String(i.title), content: String(i.content) }));
  return {
    name: j.name || path.basename(fileName, path.extname(fileName)),
    intro: j.intro || '',
    rules: j.rules || '',
    notes: { ...emptyNotes(), ...(j.notes ?? {}) },
    items,
  };
}
