import fs from 'node:fs/promises';
import { inflateSync } from 'node:zlib';
import { CsvError, parse } from 'csv-parse/sync';
import readXlsxFile, { InvalidInputError, InvalidSpreadsheetError, SheetNotFoundError } from 'read-excel-file/node';
import { RosterImportError } from './rosterImport.js';
import { GROUP_PRESETS } from './supervisionRoles.js';

export interface OutlineImportRow {
  source_key: string;
  course_name: string;
  course_group: string;
  professional: string;
  teacher_names: string;
  writer_name: string;
  writer_identifier: string;
}

const clean = (value: unknown) => String(value ?? '').trim();
const names = (value: string) => value.split(/[、,，;；\n]/).map((name) => name.trim()).filter(Boolean);
const headerName = (value: unknown) => clean(value).replace(/\s/g, '');

function importTable(table: unknown[][], name: string) {
  const required = ['课程名称', '课程组', '审核专业', '大纲执笔人'];
  const headerIndex = table.findIndex((row) => required.every((column) => row.map(headerName).includes(column)));
  if (headerIndex < 0) throw new RosterImportError('课程清单必须包含“课程名称、课程组、审核专业、大纲执笔人”列，请从腾讯云文档导出原表');
  const header = table[headerIndex].map(headerName);
  if (required.some((column) => header.filter((cell) => cell === column).length !== 1)) {
    throw new RosterImportError('课程清单的必需列名不能重复');
  }
  const courses = new Map<string, OutlineImportRow[]>();
  const warnings = new Set<string>();
  for (let index = headerIndex + 1; index < table.length; index++) {
    const cells = table[index];
    if (!cells.some((cell) => clean(cell))) continue;
    const value = (column: string) => clean(cells[header.indexOf(column)]);
    const course_name = value('课程名称');
    if (!course_name) throw new RosterImportError(`第 ${index + 1} 行课程名称为空，请核对原始清单`);
    const rawGroup = value('课程组').replace(/\s/g, '');
    const course_group = GROUP_PRESETS.find((preset) => preset.group.toLowerCase() === rawGroup.toLowerCase())?.group ?? '';
    const professional = value('审核专业');
    const writer_name = value('大纲执笔人');
    const writer_identifier = value('大纲执笔人工号') || value('执笔人工号');
    if (names(writer_name).length > 1 || names(writer_identifier).length > 1) {
      throw new RosterImportError(`第 ${index + 1} 行 ${course_name} 有多位执笔人，请明确一位最终上传责任人`);
    }
    if (!course_group) warnings.add(`${course_name}：课程组${rawGroup ? `填写为“${rawGroup}”，需核实` : '未填写'}，保留总应交数，暂不开放给课程组长`);
    if (!professional) warnings.add(`${course_name}：审核专业未填写，保留总应交数，暂不归入专业负责人范围`);
    const source_key = JSON.stringify([course_name.toLowerCase(), professional, course_group]);
    const parallel = courses.get(source_key) ?? [];
    const existing = parallel.find((row) => row.writer_identifier && writer_identifier
      ? row.writer_identifier === writer_identifier
      : row.writer_name === writer_name && (!!writer_name || row.writer_identifier === writer_identifier));
    if (existing) {
      existing.writer_name ||= writer_name;
      existing.writer_identifier ||= writer_identifier;
      existing.teacher_names = [...new Set([...names(existing.teacher_names), ...names(value('教师名称'))])].join('、');
    } else {
      parallel.push({ source_key, course_name, course_group, professional, teacher_names: [...new Set(names(value('教师名称')))].join('、'), writer_name, writer_identifier });
    }
    courses.set(source_key, parallel);
  }
  const rows: OutlineImportRow[] = [];
  for (const parallel of courses.values()) {
    const unassignedIndex = parallel.findIndex((row) => !row.writer_name && !row.writer_identifier);
    if (parallel.length === 2 && unassignedIndex >= 0) {
      const [unassigned] = parallel.splice(unassignedIndex, 1);
      parallel[0].teacher_names = [...new Set([...names(parallel[0].teacher_names), ...names(unassigned.teacher_names)])].join('、');
    }
    for (const row of parallel) {
      row.source_key = JSON.stringify([...JSON.parse(row.source_key), row.writer_identifier ? 'identifier' : 'name', row.writer_identifier || row.writer_name]);
      rows.push(row);
    }
  }
  if (!rows.length) throw new RosterImportError('课程清单中没有应交课程');
  return { rows, warnings: [...warnings], name };
}

export async function readOutlineFile(file: Express.Multer.File) {
  const contents = await fs.readFile(file.path);
  try {
    if (file.originalname.toLowerCase().endsWith('.csv')) {
      return importTable(parse(contents, { bom: true, trim: true, skip_empty_lines: true }), file.originalname);
    }
    const sheets = await readXlsxFile(contents, { parseNumber: (value) => value });
    const sheet = sheets.find((candidate) => candidate.data.some((row) => ['课程名称', '课程组', '审核专业', '大纲执笔人'].every((column) => row.map(headerName).includes(column))));
    if (!sheet) throw new RosterImportError('Excel中未找到含课程名称、课程组、审核专业、大纲执笔人的工作表');
    return importTable(sheet.data, file.originalname);
  } catch (e) {
    if (e instanceof CsvError || e instanceof InvalidInputError || e instanceof InvalidSpreadsheetError || e instanceof SheetNotFoundError) {
      throw new RosterImportError(`课程清单解析失败：${e.message}`);
    }
    throw e;
  }
}

type WireValue = number | Buffer;
type Message = Map<number, WireValue[]>;

// Tencent sheet blocks use a zlib-compressed protobuf cell table and a shared-string pool.
function protobuf(bytes: Buffer): Message {
  let cursor = 0;
  const fields: Message = new Map();
  const integer = () => {
    let value = 0;
    for (let shift = 0; shift < 63; shift += 7) {
      if (cursor >= bytes.length) throw new RosterImportError('腾讯表格单元格数据不完整，请导出Excel后上传');
      const byte = bytes[cursor++];
      value += (byte & 127) * 2 ** shift;
      if (!(byte & 128)) return value;
    }
    throw new RosterImportError('腾讯表格数字编码无法识别，请导出Excel后上传');
  };
  while (cursor < bytes.length) {
    const key = integer();
    const field = Math.floor(key / 8), wire = key % 8;
    let value: WireValue;
    if (!field) throw new RosterImportError('腾讯表格数据格式已变化，请导出Excel后上传');
    if (wire === 0) value = integer();
    else if (wire === 1 || wire === 2 || wire === 5) {
      const length = wire === 2 ? integer() : wire === 1 ? 8 : 4;
      if (cursor + length > bytes.length) throw new RosterImportError('腾讯表格单元格数据不完整，请导出Excel后上传');
      value = bytes.subarray(cursor, cursor + length);
      cursor += length;
    } else throw new RosterImportError('腾讯表格编码无法识别，请导出Excel后上传');
    if (!fields.has(field)) fields.set(field, []);
    fields.get(field)!.push(value);
  }
  return fields;
}

const nested = (message: Message, field: number) => {
  const value = message.get(field)?.[0];
  if (!Buffer.isBuffer(value)) throw new RosterImportError('腾讯表格数据结构已变化，请导出Excel后上传');
  return protobuf(value);
};
const numeric = (message: Message, field: number) => (message.get(field)?.[0] as number | undefined) ?? 0;

function readBlock(encoded: string, table: string[][]) {
  const root = nested(protobuf(inflateSync(Buffer.from(encoded, 'base64'), { maxOutputLength: 16 * 1024 * 1024 })), 1);
  const operations = (root.get(5) ?? []).map((value) => protobuf(value as Buffer));
  let found = false;
  for (const operation of operations.filter((value) => numeric(value, 1) === 18)) {
    found = true;
    const cells = nested(operation, 19);
    const strings = (nested(cells, 5).get(1) ?? []).map((entry) => (protobuf(entry as Buffer).get(1)![0] as Buffer).toString('utf8'));
    for (const bytes of cells.get(6) ?? []) {
      const cell = protobuf(bytes as Buffer), row = numeric(cell, 1), column = numeric(cell, 2);
      const value = nested(cell, 3);
      table[row] ??= [];
      table[row][column] = numeric(value, 1) === 4 ? strings[numeric(nested(value, 2), 1)] : '';
    }
  }
  if (!found) throw new RosterImportError('腾讯表格未返回课程单元格，请导出Excel后上传');
}

interface TencentData {
  clientVars: {
    title: string;
    collab_client_vars: { maxRow: number; initialAttributedText: { text: { block_datas: { related_sheet: string }[] }[] } };
  };
}

async function fetchTencent(url: URL, headers?: Record<string, string>) {
  try {
    return await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(15000), headers });
  } catch (error) {
    if (error instanceof TypeError || error instanceof DOMException) throw new RosterImportError(`腾讯文档网络读取失败：${error.message}，可导出Excel后上传`);
    throw error;
  }
}

export async function readTencentOutline(input: string) {
  let source: URL;
  try { source = new URL(input); }
  catch { throw new RosterImportError('请输入腾讯文档表格的完整https链接'); }
  if (source.protocol !== 'https:' || source.hostname !== 'docs.qq.com' || source.port || source.username || source.password || !/^\/sheet\/D[A-Za-z0-9]+$/.test(source.pathname)) {
    throw new RosterImportError('仅支持https://docs.qq.com/sheet/开头的腾讯表格链接');
  }
  const tab = source.searchParams.get('tab') ?? '000001';
  if (!/^[A-Za-z0-9]+$/.test(tab)) throw new RosterImportError('腾讯表格工作表编号不正确');
  source.search = new URLSearchParams({ tab }).toString();
  const page = await fetchTencent(source);
  if (!page.ok) throw new RosterImportError(`腾讯文档读取失败（HTTP ${page.status}），可导出Excel后上传`);
  const html = await page.text();
  const preload = html.match(/href="([^"]*\/dop-api\/opendoc\?[^"]*)"/);
  if (!preload) throw new RosterImportError('未找到腾讯表格数据，请检查分享权限或导出Excel后上传');
  const endpoint = new URL(preload[1].replaceAll('&amp;', '&'), source);
  if (endpoint.origin !== source.origin || endpoint.pathname !== '/dop-api/opendoc') throw new RosterImportError('腾讯表格数据地址无法识别');
  const cookies = page.headers.getSetCookie().map((cookie) => cookie.split(';')[0]).join('; ');
  const table: string[][] = [];
  let maxRow = 1, name = '';
  for (let start = 0; start < maxRow; start += 256) {
    endpoint.searchParams.set('block_start_row', String(start));
    endpoint.searchParams.set('block_end_row', String(start + 255));
    endpoint.searchParams.set('startrow', String(start));
    endpoint.searchParams.set('endrow', String(start + 255));
    const response = await fetchTencent(endpoint, { Referer: source.href, Cookie: cookies, 'User-Agent': 'Mozilla/5.0' });
    if (!response.ok) throw new RosterImportError(`腾讯表格数据读取失败（HTTP ${response.status}）`);
    const body = await response.text();
    if (!body.startsWith('clientVarsCallback(')) throw new RosterImportError('腾讯表格未开放读取，请检查分享权限或导出Excel后上传');
    const data = JSON.parse(body.slice(body.indexOf('(') + 1, body.lastIndexOf(')'))) as TencentData;
    const collab = data.clientVars?.collab_client_vars;
    if (!collab || !Number.isInteger(collab.maxRow) || collab.maxRow < 1 || collab.maxRow > 5000) throw new RosterImportError('腾讯表格行数无法识别或超过5000行，请导出Excel后上传');
    maxRow = collab.maxRow;
    name = data.clientVars.title;
    const blocks = collab.initialAttributedText?.text?.flatMap((entry) => entry.block_datas ?? []) ?? [];
    if (!blocks.length) throw new RosterImportError('腾讯表格未返回当前范围数据，请导出Excel后上传');
    for (const block of blocks) readBlock(block.related_sheet, table);
  }
  if (table.length < maxRow) throw new RosterImportError('腾讯表格数据不完整，未导入，请导出Excel后上传');
  return importTable(table, name);
}
