import type { MaterialPage, TextBox } from './materialExtract.js';

export const GRADE_TYPES = ['课程成绩单', '平时考核记录表', '实验成绩记录表（单独设置时）'];
export type GradeRow = { location: string; line: number; ocr: boolean; cells: Record<string, string>; uncertain: string[] };
export type Weights = Record<string, number>;
export type GradeEdit = { location: string; line: number; column: string; value: string };

export function gradeHeader(text: string) {
  const key = text.normalize('NFKC').replace(/\s+/g, '').replace(/\([^)]*\d+%[^)]*\)|[:：]?\d+(?:\.\d+)?%$/g, '');
  if (/^(序号|学号|姓名|学习性质|性质|备注|状态|考试状态)$/.test(key)) return key;
  const grade = /^(平时|期中|实验[\/／]?(?:实践|实|践)?|实践|期末|卷面|总评)(?:成绩|分数|分)?$/.exec(key)?.[1];
  return grade?.startsWith('实验') || grade === '实践' ? '实验' : grade === '卷面' ? '期末' : grade ?? '';
}

export function readWeights(text: string): Weights {
  const values = new Map<string, Set<number>>();
  for (const m of text.normalize('NFKC').matchAll(/(平时|期中|实验(?:[\/(]实?践\)?)?|实践|期末|卷面)(?:成绩|考核)?[\s|:：占比为(=*]{0,15}(\d{1,3}(?:\.\d{1,4})?)\s*%/g)) {
    const key = gradeHeader(m[1]);
    const n = Number(m[2]);
    if (key && n <= 100) {
      if (!values.has(key)) values.set(key, new Set());
      values.get(key)!.add(n);
    }
  }
  return Object.fromEntries([...values].flatMap(([key, set]) => set.size === 1 ? [[key, [...set][0]]] : []));
}

export function materialWeights(pages: MaterialPage[]): Weights {
  const tables = pages.flatMap((p) => (p.rows ?? []).flatMap((row, i, rows) => {
    if (!i || !row.some((cell) => /^(总评)?(?:成绩)?(?:比例|权重)[：:]?$/.test(cell))) return [];
    return row.flatMap((value, j) => {
      const column = gradeHeader(rows[i - 1][j] ?? '');
      const n = Number(value);
      if (!aliases.includes(column) || !value.trim()) return [];
      if (/^\d+(?:\.\d+)?[%％]$/.test(value)) return [`${column}: ${value}`];
      return n >= 0 && n <= 1 ? [`${column}: ${Number((n * 100).toFixed(6))}%`] : [];
    });
  }));
  return readWeights([...pages.map((p) => p.text), ...tables].join('\n'));
}

function boxedRows(page: MaterialPage): GradeRow[] {
  const boxes = page.boxes!;
  const header = boxes.find((b) => ['序号', '学号'].includes(gradeHeader(b.text)) && b.confidence >= 0.9);
  if (!header) return [];
  const bands = boxes.filter((b) => b.y >= header.y - 6 && b.y <= header.y + (
    Math.max(...boxes.map((box) => box.y)) - Math.min(...boxes.map((box) => box.y))) * 0.045
      && gradeHeader(b.text) && b.confidence >= 0.9).sort((a, b) => a.x - b.x);
  const columns = new Map<string, TextBox>();
  for (const b of bands) {
    const key = gradeHeader(b.text);
    if (!columns.has(key)) columns.set(key, b);
    else if (Math.abs(b.x - columns.get(key)!.x) > 5) return [];
  }
  if (!columns.has('总评') && aliases.filter((key) => columns.has(key)).length < 1) return [];
  const anchor = columns.get('序号') ?? columns.get('学号')!;
  const xGap = Math.min(...[...columns.values()].slice(1).map((b, i) => b.x - [...columns.values()][i].x));
  if (!Number.isFinite(xGap) || xGap <= 0) return [];
  const seq = columns.has('序号');
  const anchors = boxes.filter((b) => b.y > Math.max(...bands.map((h) => h.y)) &&
    Math.abs(b.x - anchor.x) < xGap * 0.45 && (seq ? /^\d{1,4}$/ : /^\d{5,20}$/).test(b.text) && b.confidence >= 0.9)
    .sort((a, b) => a.y - b.y);
  if (anchors.length < 2) return [];
  const gaps = anchors.slice(1).map((b, i) => b.y - anchors[i].y).sort((a, b) => a - b);
  const gap = gaps[Math.floor(gaps.length / 2)];
  if (gap <= 0) return [];
  const nature = columns.get('学习性质') ?? columns.get('性质');
  const rows: GradeRow[] = [];
  for (const [i, row] of anchors.entries()) {
    const cells: Record<string, string> = { [seq ? '序号' : '学号']: row.text };
    const uncertain: string[] = [];
    const nearby = nature ? boxes.filter((b) => /^(必修|选修|限选)$/.test(b.text) &&
      Math.abs(b.x - nature.x) < xGap * 0.45 && Math.abs(b.y - row.y) < gap * 0.42) : [];
    const slope = nearby.length === 1 ? (nearby[0].y - row.y) / (nearby[0].x - row.x) : 0;
    for (const [key, column] of columns) {
      if (key in cells || ['学习性质', '性质'].includes(key)) continue;
      const list = [...columns.values()];
      const j = list.indexOf(column);
      const width = Math.min(column.x - (list[j - 1]?.x ?? -Infinity), (list[j + 1]?.x ?? Infinity) - column.x);
      const matches = boxes.filter((b) => Math.abs(b.x - column.x) < width * 0.43
        && Math.abs(b.y - row.y - slope * (b.x - row.x)) < gap * (nearby.length === 1 ? 0.37 : 0.32));
      cells[key] = matches.map((b) => /^[一—–−-]$/.test(b.text) && aliases.includes(key) ? '—' : b.text).join(' ');
      if (matches.length !== 1 || matches[0].confidence < 0.94 || (!nearby.length && page.ocr)) uncertain.push(key);
    }
    rows.push({ location: page.location, line: seq ? Number(row.text) : i + 1, ocr: !!page.ocr, cells, uncertain });
  }
  // A gap, duplicated sequence, or overlapping crops is not proof that the page is complete.
  if (seq && rows.some((row, i) => i > 0 && row.line !== rows[i - 1].line + 1)) {
    for (const row of rows) row.uncertain.push(...Object.keys(row.cells));
  }
  return rows;
}

const aliases = ['平时', '期中', '实验', '期末'];
export const gradeNumber = (value?: string) => value && /^\d+(?:\.\d+)?$/.test(value) && Number(value) <= 100 ? Number(value) : undefined;
export const studentId = (value?: string) => value && /^[a-z\d-]*\d[a-z\d-]*$/i.test(value) && value.length >= 5 ? value : undefined;

export function extractGradeRows(pages: MaterialPage[], edits: GradeEdit[] = []) {
  const rows: GradeRow[] = [];
  for (const page of pages) {
    if (page.boxes) rows.push(...boxedRows(page));
    if (!page.rows) continue;
    let headers: string[] = [];
    for (const [i, cells] of page.rows.entries()) {
      const possible = cells.map(gradeHeader);
      if ((possible.includes('序号') || possible.includes('学号')) &&
        (possible.includes('总评') || aliases.some((key) => possible.includes(key)))) {
        headers = possible.filter(Boolean).length === new Set(possible.filter(Boolean)).size ? possible : [];
        continue;
      }
      if (!headers.length) continue;
      if (!/^\d{1,4}$/.test(cells[headers.indexOf('序号')] ?? '') && !studentId(cells[headers.indexOf('学号')])) continue;
      rows.push({ location: page.location, line: i + 1, ocr: false, uncertain: [],
        cells: Object.fromEntries(headers.flatMap((h, j) => h ? [[h, cells[j] ?? '']] : [])) });
    }
  }
  for (const edit of edits) {
    const row = rows.find((r) => r.location === edit.location && r.line === edit.line);
    if (row && edit.column in row.cells) {
      row.cells[edit.column] = edit.value;
      row.uncertain = row.uncertain.filter((key) => key !== edit.column);
    }
  }
  return rows;
}

export function scoreStats(rows: GradeRow[], column: '总评' | '期末') {
  const eligible = rows.filter((row) => !/缺考|旷考|缓考|作弊|违纪|免考/.test(
    [row.cells.状态, row.cells.考试状态, row.cells.备注, row.cells[column]].join(' ')));
  const scores = eligible.flatMap((row) => row.uncertain.includes(column) ? [] : gradeNumber(row.cells[column]) ?? []);
  const bands = [0, 0, 0, 0, 0];
  for (const score of scores) bands[score < 60 ? 0 : Math.min(4, 1 + Math.floor((score - 60) / 10))]++;
  return { column, rows: rows.length, count: scores.length, excluded: rows.length - eligible.length, unreadable: eligible.length - scores.length,
    mean: scores.length ? scores.reduce((a, b) => a + b, 0) / scores.length : null, bands };
}
