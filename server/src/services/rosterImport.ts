import fs from 'node:fs/promises';
import { CsvError, parse } from 'csv-parse/sync';
import { InvalidInputError, InvalidSpreadsheetError, readSheet, SheetNotFoundError } from 'read-excel-file/node';
import { z } from 'zod';

export class RosterImportError extends Error {}

export async function readRoster(file: Express.Multer.File) {
  const contents = await fs.readFile(file.path);
  let rows: unknown[][];
  try {
    rows = file.originalname.toLowerCase().endsWith('.xlsx')
      ? await readSheet(contents, { parseNumber: (value) => value })
      : parse(contents, { bom: true, trim: true, skip_empty_lines: true });
  } catch (e) {
    if (e instanceof CsvError || e instanceof InvalidInputError || e instanceof InvalidSpreadsheetError || e instanceof SheetNotFoundError) {
      throw new RosterImportError(`名单文件解析失败，请检查文件格式：${e.message}`);
    }
    throw e;
  }

  const headers = (rows[0] ?? []).map((cell) => String(cell ?? '').trim());
  if (headers.filter((cell) => cell === '姓名').length !== 1 || headers.filter((cell) => cell === '工号').length !== 1) {
    throw new RosterImportError('名单首行必须包含“姓名”和“工号”两列，且列名不能重复');
  }
  const nameColumn = headers.indexOf('姓名');
  const numberColumn = headers.indexOf('工号');
  const entrySchema = z.object({
    name: z.string().min(1, '姓名不能为空').max(50, '姓名最多50个字符'),
    username: z.string().min(1, '工号不能为空').max(32, '工号最多32个字符').regex(/^[A-Za-z0-9_.@-]+$/, '工号只能包含字母、数字及 _ . @ -'),
  });
  const entries: { name: string; username: string }[] = [];
  const seen = new Set<string>();
  for (const [index, row] of rows.entries()) {
    if (index === 0 || row.every((cell) => !String(cell ?? '').trim())) continue;
    const entry = entrySchema.safeParse({
      name: String(row[nameColumn] ?? '').trim(),
      username: String(row[numberColumn] ?? '').trim(),
    });
    if (!entry.success) throw new RosterImportError(`第 ${index + 1} 行：${entry.error.issues.map((issue) => issue.message).join('；')}`);
    const key = entry.data.username.toLowerCase();
    if (seen.has(key)) throw new RosterImportError(`第 ${index + 1} 行：工号 ${entry.data.username} 在名单中重复`);
    seen.add(key);
    entries.push(entry.data);
  }
  if (!entries.length) throw new RosterImportError('名单中没有教工数据');
  return { entries };
}
