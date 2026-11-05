import fs from 'node:fs/promises';
import path from 'node:path';
import mammoth from 'mammoth';
import { parse, HTMLElement, Node, NodeType } from 'node-html-parser';
import { extractText, getDocumentProxy } from 'unpdf';

export class ExtractError extends Error {}

export const SUPPORTED_DOC_EXT = ['.docx', '.pdf'];

function clean(s: string) {
  return s.replace(/ /g, ' ').replace(/[ \t]+/g, ' ').trim();
}

function cellText(el: HTMLElement): string {
  // 单元格内多段落用 / 分隔，避免破坏 Markdown 表格
  const parts: string[] = [];
  const walk = (n: Node) => {
    if (n.nodeType === NodeType.TEXT_NODE) {
      parts.push(n.rawText);
      return;
    }
    const e = n as HTMLElement;
    const tag = e.tagName?.toLowerCase();
    if (tag === 'p' || tag === 'li' || tag === 'br' || tag === 'tr') parts.push('\n');
    e.childNodes.forEach(walk);
  };
  walk(el);
  return clean(
    parts
      .join('')
      .split('\n')
      .map(clean)
      .filter(Boolean)
      .join(' / '),
  ).replace(/\|/g, '｜');
}

function tableToMarkdown(table: HTMLElement): string {
  const rows = table.querySelectorAll('tr').filter((tr) => {
    // 只取直接属于本表的行（嵌套表格单独展开意义不大，按文本并入单元格）
    let p = tr.parentNode as HTMLElement | null;
    while (p && p.tagName?.toLowerCase() !== 'table') p = p.parentNode as HTMLElement | null;
    return p === table;
  });
  if (!rows.length) return '';
  const matrix = rows.map((tr) =>
    tr.childNodes
      .filter((c) => c.nodeType === NodeType.ELEMENT_NODE && ['td', 'th'].includes((c as HTMLElement).tagName.toLowerCase()))
      .flatMap((c) => {
        const el = c as HTMLElement;
        const span = Math.max(1, Number(el.getAttribute('colspan') || 1));
        const t = cellText(el);
        return [t, ...Array(span - 1).fill('〃')];
      }),
  );
  const cols = Math.max(...matrix.map((r) => r.length));
  const lines = matrix.map((r) => `| ${[...r, ...Array(cols - r.length).fill('')].join(' | ')} |`);
  lines.splice(1, 0, `| ${Array(cols).fill('---').join(' | ')} |`);
  return lines.join('\n');
}

/** 将 mammoth 生成的 HTML 转为保留标题、列表和表格结构的纯文本 */
export function htmlToStructuredText(html: string): string {
  const root = parse(html);
  const out: string[] = [];
  const walk = (n: Node) => {
    if (n.nodeType === NodeType.TEXT_NODE) {
      const t = clean(n.rawText);
      if (t) out.push(t);
      return;
    }
    const e = n as HTMLElement;
    const tag = e.tagName?.toLowerCase();
    if (tag === 'table') {
      out.push('\n【表格】\n' + tableToMarkdown(e) + '\n');
      return;
    }
    if (tag && /^h[1-6]$/.test(tag)) {
      const t = clean(e.textContent);
      if (t) out.push(`\n${'#'.repeat(Number(tag[1]))} ${t}`);
      return;
    }
    if (tag === 'p') {
      const t = clean(e.textContent);
      if (t) out.push(t);
      return;
    }
    if (tag === 'li') {
      const t = clean(e.textContent);
      if (t) out.push(`- ${t}`);
      return;
    }
    e.childNodes.forEach(walk);
  };
  root.childNodes.forEach(walk);
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

export async function docxToHtml(filePath: string): Promise<string> {
  const { value } = await mammoth.convertToHtml({ path: filePath });
  return value;
}

export async function extractFile(filePath: string, originalName: string): Promise<string> {
  const ext = path.extname(originalName).toLowerCase();
  let text = '';
  if (ext === '.docx') {
    try {
      text = htmlToStructuredText(await docxToHtml(filePath));
    } catch {
      throw new ExtractError('无法读取该 Word 文件，请确认文件未损坏且为 .docx 格式');
    }
  } else if (ext === '.pdf') {
    try {
      const buf = await fs.readFile(filePath);
      const pdf = await getDocumentProxy(new Uint8Array(buf));
      const { text: pages } = await extractText(pdf, { mergePages: false });
      text = (pages as string[]).map((p, i) => `【第${i + 1}页】\n${p.trim()}`).join('\n\n');
    } catch {
      throw new ExtractError('无法读取该 PDF 文件');
    }
  } else if (ext === '.txt' || ext === '.md') {
    text = (await fs.readFile(filePath, 'utf8')).trim();
  } else if (ext === '.doc') {
    throw new ExtractError('暂不支持旧版 .doc 格式，请在 Word 中“另存为” .docx 后上传');
  } else {
    throw new ExtractError('不支持的文件类型，请上传 .docx 或 .pdf');
  }
  const meaningful = text.replace(/【第\d+页】|\s|[|\-]/g, '');
  if (meaningful.length < 50) {
    throw new ExtractError('未能从文件中提取到有效文字（可能是扫描件或图片），请上传可复制文字的 .docx 或 PDF');
  }
  return text;
}
