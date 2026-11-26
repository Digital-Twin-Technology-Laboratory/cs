import fs from 'node:fs/promises';
import path from 'node:path';
import JSZip from 'jszip';
import { parse } from 'node-html-parser';
import readXlsxFile from 'read-excel-file/node';
import { extractTextItems, getDocumentProxy } from 'unpdf';
import { docxToHtml, htmlToStructuredText } from './extract.js';
import { pdfPageToStructuredText } from './pdfText.js';
import { EXCEL_EXTENSIONS, readXlsWorkbook } from './xlsWorkbook.js';

export const MATERIAL_EXTENSIONS = ['.docx', ...EXCEL_EXTENSIONS, '.pptx', '.pdf', '.jpg', '.jpeg', '.png'];
export type TextBox = { x: number; y: number; text: string; confidence: number };
export type MaterialPage = { location: string; text: string; rows?: string[][]; boxes?: TextBox[]; ocr?: true; vision?: true; warning?: string };

export async function extractMaterial(file: string, name: string): Promise<MaterialPage[]> {
  const ext = path.extname(name).toLowerCase();
  if (ext === '.docx') {
    const html = await docxToHtml(file);
    return [{ location: '文档正文', text: htmlToStructuredText(html), rows: parse(html).querySelectorAll('tr').map(
      (row) => row.querySelectorAll('td, th').map((cell) => cell.textContent.trim())) }];
  }
  if (EXCEL_EXTENSIONS.includes(ext)) {
    const sheets = ext === '.xls' ? await readXlsWorkbook(file) : await readXlsxFile(file, { parseNumber: (value) => value });
    return sheets.map(({ sheet, data }) => {
      const rows = data.map((row) => Array.from<unknown, string>(row, (cell) => String(cell ?? '').trim()));
      return { location: `工作表 ${sheet}`, text: rows.map((row, i) => `${i + 1}: ${row.join(' | ')}`).join('\n'), rows };
    });
  }
  if (ext === '.pptx') {
    const zip = await JSZip.loadAsync(await fs.readFile(file));
    const slides = Object.keys(zip.files).flatMap((key) => {
      const match = /^ppt\/slides\/slide(\d+)\.xml$/.exec(key);
      return match ? [{ key, number: Number(match[1]) }] : [];
    }).sort((a, b) => a.number - b.number);
    return Promise.all(slides.map(async ({ key, number }) => ({
      location: `幻灯片 ${number}`,
      text: parse(await zip.file(key)!.async('string')).querySelectorAll('a\\:t').map((node) => node.textContent).join('\n'),
    })));
  }
  if (ext === '.pdf') {
    const pdf = await getDocumentProxy(new Uint8Array(await fs.readFile(file)));
    try {
      const { items } = await extractTextItems(pdf);
      return items.map((page, i) => {
        const location = `第 ${i + 1} 页`;
        const text = pdfPageToStructuredText(page);
        if (!text.trim()) return { location, text, warning: 'PDF 此页没有可提取的文字，请核对原件或上传含文字的版本' };
        return { location, text, boxes: page.filter(({ str }) => str.trim()).map(
          ({ x, y, width, height, str }) => ({ x: x + width / 2, y: -y - height / 2, text: str, confidence: 1 })) };
      });
    } finally {
      await pdf.loadingTask.destroy();
    }
  }
  return [{ location: '第 1 页', text: '', warning: '此图片未进行 AI 识图，请核对原件' }];
}
