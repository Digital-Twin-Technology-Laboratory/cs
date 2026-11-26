import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import JSZip from 'jszip';
import { parse } from 'node-html-parser';
import readXlsxFile from 'read-excel-file/node';
import { extractTextItems, getDocumentProxy } from 'unpdf';
import { ROOT_DIR } from '../config.js';
import { docxToHtml, htmlToStructuredText } from './extract.js';
import { pdfPageToStructuredText } from './pdfText.js';
import { EXCEL_EXTENSIONS, readXlsWorkbook } from './xlsWorkbook.js';

export const MATERIAL_EXTENSIONS = ['.docx', ...EXCEL_EXTENSIONS, '.pptx', '.pdf', '.jpg', '.jpeg', '.png'];
const exec = promisify(execFile);
const win = process.platform === 'win32';
const projectPython = path.join(ROOT_DIR, '.venv-material-ocr', win ? 'Scripts/python.exe' : 'bin/python');
export type TextBox = { x: number; y: number; text: string; confidence: number };
export type MaterialPage = { location: string; text: string; rows?: string[][]; boxes?: TextBox[]; ocr?: true; vision?: true; warning?: string };

async function recognize(file: string, ext: string, pages: number[]): Promise<Map<number, MaterialPage>> {
  const python = process.env.MATERIAL_OCR_PYTHON || (existsSync(projectPython) ? projectPython : win ? 'python' : 'python3');
  try {
    const { stdout } = await exec(python, [path.join(ROOT_DIR, 'scripts', 'material-ocr.py'), file, ext, JSON.stringify(pages)],
      { timeout: 300_000, maxBuffer: 32 * 1024 * 1024, windowsHide: true });
    const output = JSON.parse(stdout) as { page: number; boxes: TextBox[] }[];
    return new Map(output.map(({ page, boxes }) => [page, {
      location: `第 ${page} 页`, text: boxes.map((box) => box.text).join('\n'), boxes, ocr: true,
      ...(boxes.length ? {} : { warning: '图像没有可辨文字，请核对原件' }),
    }]));
  } catch (error) {
    const e = error as { code?: string; stderr?: string; killed?: boolean };
    const warning = e.code === 'ENOENT' || e.stderr?.includes('ModuleNotFoundError')
      ? '本地 AI 图像识别未安装，请联系管理员'
      : e.killed ? '本地 AI 图像识别超时，请拆分扫描件后重试'
        : '本地 AI 无法读取图像，请核对原文件';
    return new Map((ext === '.pdf' ? pages : [1]).map((page) => [page, { location: `第 ${page} 页`, text: '', warning }]));
  }
}

export async function extractMaterial(file: string, name: string, gradeTable = false): Promise<MaterialPage[]> {
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
      const scans = items.flatMap((page, i) => {
        const text = page.map(({ str }) => str).join('');
        return text.replace(/\s/g, '').length < 20 || (gradeTable && !/[\u4e00-\u9fff]+\s*成绩/.test(text)) ? [i + 1] : [];
      });
      const ocr = scans.length ? await recognize(file, ext, scans) : new Map<number, MaterialPage>();
      return items.map((page, i) => ocr.get(i + 1) ?? ({
        location: `第 ${i + 1} 页`, text: pdfPageToStructuredText(page), boxes: page.filter(({ str }) => str.trim()).map(
          ({ x, y, width, height, str }) => ({ x: x + width / 2, y: -y - height / 2, text: str, confidence: 1 })),
      }));
    } finally {
      await pdf.loadingTask.destroy();
    }
  }
  return [...(await recognize(file, ext, [])).values()];
}
