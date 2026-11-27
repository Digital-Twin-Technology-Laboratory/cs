import { inflateSync } from 'node:zlib';

export class TencentSheetError extends Error {}

type WireValue = number | Buffer;
type Message = Map<number, WireValue[]>;

function protobuf(bytes: Buffer): Message {
  let cursor = 0;
  const fields: Message = new Map();
  const integer = () => {
    let value = 0;
    for (let shift = 0; shift < 63; shift += 7) {
      if (cursor >= bytes.length) throw new TencentSheetError('腾讯表格单元格数据不完整，请导出 Excel 后上传');
      const byte = bytes[cursor++];
      value += (byte & 127) * 2 ** shift;
      if (!(byte & 128)) return value;
    }
    throw new TencentSheetError('腾讯表格数字编码无法识别，请导出 Excel 后上传');
  };
  while (cursor < bytes.length) {
    const key = integer();
    const field = Math.floor(key / 8);
    const wire = key % 8;
    let value: WireValue;
    if (!field) throw new TencentSheetError('腾讯表格数据格式已变化，请导出 Excel 后上传');
    if (wire === 0) value = integer();
    else if (wire === 1 || wire === 2 || wire === 5) {
      const length = wire === 2 ? integer() : wire === 1 ? 8 : 4;
      if (cursor + length > bytes.length) throw new TencentSheetError('腾讯表格单元格数据不完整，请导出 Excel 后上传');
      value = bytes.subarray(cursor, cursor + length);
      cursor += length;
    } else throw new TencentSheetError('腾讯表格编码无法识别，请导出 Excel 后上传');
    if (!fields.has(field)) fields.set(field, []);
    fields.get(field)!.push(value);
  }
  return fields;
}

const nested = (message: Message, field: number) => {
  const value = message.get(field)?.[0];
  if (!Buffer.isBuffer(value)) throw new TencentSheetError('腾讯表格数据结构已变化，请导出 Excel 后上传');
  return protobuf(value);
};

const numeric = (message: Message, field: number) => {
  const value = message.get(field)?.[0];
  return typeof value === 'number' ? value : 0;
};

function extractRichText(entryBytes: Buffer): string {
  const rich = protobuf(entryBytes);
  const runs = rich.get(3) ?? [];
  const parts: string[] = [];
  for (const runBytes of runs) {
    if (!Buffer.isBuffer(runBytes)) continue;
    const run = protobuf(runBytes);
    const textWrap = run.get(3)?.[0];
    if (Buffer.isBuffer(textWrap)) {
      const textMsg = protobuf(textWrap);
      const raw = textMsg.get(1)?.[0];
      if (Buffer.isBuffer(raw)) parts.push(raw.toString('utf8'));
    }
  }
  return parts.join('');
}

function decodeCellValue(valueMsg: Message, strings: string[], richTexts: string[], floats: number[]): string {
  const type = numeric(valueMsg, 1);
  if (type === 4) {
    const idx = numeric(nested(valueMsg, 2), 1);
    return strings[idx] ?? '';
  }
  if (type === 6) {
    const payload = valueMsg.get(2)?.[0];
    const idx = Buffer.isBuffer(payload) ? numeric(protobuf(payload), 1) : 0;
    return richTexts[idx] ?? '';
  }
  if (type === 2 || type === 3) {
    const payload = valueMsg.get(2)?.[0];
    if (Buffer.isBuffer(payload)) {
      const inner = protobuf(payload);
      const raw = inner.get(1)?.[0];
      if (typeof raw === 'number') {
        if (type === 3 && raw >= 0 && raw < floats.length) return String(floats[raw]);
        return String(raw);
      }
      if (Buffer.isBuffer(raw) && raw.length === 8) {
        const num = raw.readDoubleLE(0);
        return Number.isFinite(num) ? String(num) : '';
      }
      const raw2 = inner.get(2)?.[0];
      if (Buffer.isBuffer(raw2) && raw2.length === 8) {
        const num = raw2.readDoubleLE(0);
        return Number.isFinite(num) ? String(num) : '';
      }
    }
    return '';
  }
  if (type === 1) {
    const raw = valueMsg.get(2)?.[0];
    return typeof raw === 'number' ? String(raw) : '';
  }
  return '';
}

function readBlock(encoded: string, table: string[][]) {
  const root = nested(protobuf(inflateSync(Buffer.from(encoded, 'base64'), { maxOutputLength: 16 * 1024 * 1024 })), 1);
  const operations = (root.get(5) ?? []).map((value) => protobuf(value as Buffer));
  let found = false;
  for (const operation of operations.filter((value) => numeric(value, 1) === 18)) {
    found = true;
    const cells = nested(operation, 19);
    const pool = nested(cells, 5);
    const strings = (pool.get(1) ?? []).map((entry) => {
      const buf = protobuf(entry as Buffer).get(1)?.[0];
      return Buffer.isBuffer(buf) ? buf.toString('utf8') : '';
    });
    const richTexts = (pool.get(2) ?? []).map((entry) =>
      Buffer.isBuffer(entry) ? extractRichText(entry) : '',
    );
    const floats = (pool.get(3) ?? []).map((entry) => {
      if (!Buffer.isBuffer(entry)) return NaN;
      const buf = protobuf(entry).get(1)?.[0];
      return Buffer.isBuffer(buf) && buf.length === 8 ? buf.readDoubleLE(0) : NaN;
    });
    for (const bytes of cells.get(6) ?? []) {
      const cell = protobuf(bytes as Buffer);
      const row = numeric(cell, 1);
      const column = numeric(cell, 2);
      const valueBytes = cell.get(3)?.[0];
      if (!Buffer.isBuffer(valueBytes)) continue;
      const value = protobuf(valueBytes);
      table[row] ??= [];
      table[row][column] = decodeCellValue(value, strings, richTexts, floats);
    }
  }
  return found;
}

interface TencentTabMeta {
  id?: string;
  name?: string;
  hidden?: boolean;
  type?: string;
}

interface TencentData {
  clientVars?: {
    title?: string;
    collab_client_vars?: {
      maxRow?: number;
      header?: { d?: TencentTabMeta[] }[];
      initialAttributedText?: { text?: { block_datas?: { related_sheet?: string }[] }[] };
    };
  };
}

async function fetchTencent(url: URL, headers?: Record<string, string>) {
  try {
    return await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(15000), headers });
  } catch (error) {
    if (error instanceof TypeError || error instanceof DOMException) {
      throw new TencentSheetError(`腾讯文档网络读取失败：${error.message}，可导出 Excel 后上传`);
    }
    throw error;
  }
}

export function validateTencentSheetUrl(input: string): { url: URL; explicitTab: string | null } {
  let source: URL;
  try {
    source = new URL(input.trim());
  } catch {
    throw new TencentSheetError('请输入腾讯文档表格的完整 https 链接');
  }
  if (
    source.protocol !== 'https:'
    || source.hostname !== 'docs.qq.com'
    || source.port
    || source.username
    || source.password
    || !/^\/sheet\/D[A-Za-z0-9]+$/.test(source.pathname)
  ) {
    throw new TencentSheetError('仅支持 https://docs.qq.com/sheet/ 开头的腾讯文档表格链接');
  }
  const explicitTab = source.searchParams.get('tab');
  if (explicitTab !== null && !/^[A-Za-z0-9]+$/.test(explicitTab)) {
    throw new TencentSheetError('腾讯表格工作表编号不正确');
  }
  return { url: source, explicitTab };
}

async function fetchTabTable(baseUrl: URL, tabId: string): Promise<{
  title: string;
  sheetName: string;
  tabs: TencentTabMeta[];
  table: string[][];
}> {
  const source = new URL(baseUrl.href);
  source.search = new URLSearchParams({ tab: tabId }).toString();
  const page = await fetchTencent(source);
  if (!page.ok) {
    throw new TencentSheetError(`腾讯文档读取失败（HTTP ${page.status}），请检查分享权限或导出 Excel 后上传`);
  }
  const html = await page.text();
  const preload = html.match(/href="([^"]*\/dop-api\/opendoc\?[^"]*)"/);
  if (!preload) {
    throw new TencentSheetError('未找到腾讯表格数据，请确认文档已开启「任何人可查看」权限，或导出 Excel 后上传');
  }
  const endpoint = new URL(preload[1].replaceAll('&amp;', '&'), source);
  if (endpoint.origin !== source.origin || endpoint.pathname !== '/dop-api/opendoc') {
    throw new TencentSheetError('腾讯表格数据地址无法识别');
  }
  const cookies = page.headers.getSetCookie().map((cookie) => cookie.split(';')[0]).join('; ');
  const table: string[][] = [];
  let maxRow = 1;
  let title = '';
  let tabs: TencentTabMeta[] = [];

  for (let start = 0; start < maxRow; start += 256) {
    endpoint.searchParams.set('block_start_row', String(start));
    endpoint.searchParams.set('block_end_row', String(start + 255));
    endpoint.searchParams.set('startrow', String(start));
    endpoint.searchParams.set('endrow', String(start + 255));
    const response = await fetchTencent(endpoint, { Referer: source.href, Cookie: cookies, 'User-Agent': 'Mozilla/5.0' });
    if (!response.ok) throw new TencentSheetError(`腾讯表格数据读取失败（HTTP ${response.status}）`);
    const body = await response.text();
    if (!body.startsWith('clientVarsCallback(')) {
      throw new TencentSheetError('腾讯表格未开放公开读取，请检查分享权限或导出 Excel 后上传');
    }
    const data = JSON.parse(body.slice(body.indexOf('(') + 1, body.lastIndexOf(')'))) as TencentData;
    const collab = data.clientVars?.collab_client_vars;
    if (!collab || !Number.isInteger(collab.maxRow) || (collab.maxRow ?? 0) < 1 || (collab.maxRow ?? 0) > 5000) {
      throw new TencentSheetError('腾讯表格行数无法识别或超过 5000 行，请导出 Excel 后上传');
    }
    maxRow = collab.maxRow!;
    title = data.clientVars?.title?.trim() || title;
    if (!tabs.length && Array.isArray(collab.header?.[0]?.d)) {
      tabs = collab.header![0].d!;
    }
    const blocks = collab.initialAttributedText?.text?.flatMap((entry) => entry.block_datas ?? []) ?? [];
    if (!blocks.length) {
      if (start === 0) throw new TencentSheetError('腾讯表格未返回当前范围数据，请导出 Excel 后上传');
      break;
    }
    for (const block of blocks) {
      if (block.related_sheet) readBlock(block.related_sheet, table);
    }
  }

  // Normalize sparse rows to dense string arrays
  const dense: string[][] = [];
  for (let i = 0; i < table.length; i++) {
    const row = table[i] ?? [];
    const normalized: string[] = [];
    for (let j = 0; j < row.length; j++) normalized[j] = row[j] ?? '';
    dense.push(normalized);
  }
  const matchedTab = tabs.find((t) => t.id === tabId);
  return {
    title: title || '腾讯文档表格',
    sheetName: matchedTab?.name || tabId,
    tabs,
    table: dense,
  };
}

export async function readTencentSheetWorkbook(input: string): Promise<{
  title: string;
  url: string;
  sheets: { sheet: string; data: string[][] }[];
}> {
  const { url, explicitTab } = validateTencentSheetUrl(input);
  const firstTab = explicitTab ?? 'BB08J2';
  let first;
  try {
    first = await fetchTabTable(url, firstTab);
  } catch (err) {
    if (!explicitTab && firstTab === 'BB08J2') {
      first = await fetchTabTable(url, '000001');
    } else {
      throw err;
    }
  }
  const sheets: { sheet: string; data: string[][] }[] = [{ sheet: first.sheetName, data: first.table }];

  // When no specific tab was pinned in the URL, also load other visible grid tabs (up to 12)
  if (!explicitTab && first.tabs.length > 1) {
    const extraTabs = first.tabs
      .filter((t) => t.id && t.id !== firstTab && !t.hidden && (!t.type || t.type === 'grid'))
      .slice(0, 11);
    for (const tab of extraTabs) {
      try {
        const extra = await fetchTabTable(url, tab.id!);
        if (extra.table.some((row) => row.some((cell) => cell.trim()))) {
          sheets.push({ sheet: extra.sheetName, data: extra.table });
        }
      } catch {
        // Ignore single auxiliary tab failure so primary data still imports
      }
    }
  }

  const canonicalUrl = explicitTab
    ? `${url.origin}${url.pathname}?tab=${explicitTab}`
    : `${url.origin}${url.pathname}`;

  return { title: first.title, url: canonicalUrl, sheets };
}
