import type { StructuredTextItem } from 'unpdf';

type TextItem = Pick<StructuredTextItem, 'str' | 'x' | 'y' | 'width' | 'height' | 'hasEOL'>;
type Column = { code: string; x: number };

/** Keep PDF reading order, but label matrix strengths before empty columns are lost. */
export function pdfPageToStructuredText(items: readonly TextItem[]): string {
  const original = items.map((item) => item.str + (item.hasEOL ? '\n' : '')).join('');
  if (!original.includes('毕业要求') || !original.includes('课程')) return original;

  const headerRows: { y: number; columns: Column[] }[] = [];
  for (const item of items) {
    if (!/^\d+\.\d+(?:\s+\d+\.\d+)*$/.test(item.str.trim())) continue;
    let row = headerRows.find((candidate) => Math.abs(candidate.y - item.y) <= Math.max(1, item.height / 4));
    if (!row) {
      row = { y: item.y, columns: [] };
      headerRows.push(row);
    }
    // PDF.js can combine several adjacent numbered headers into one text item.
    for (const match of item.str.matchAll(/\d+\.\d+/g)) {
      row.columns.push({ code: match[0], x: item.x + item.width * (match.index + match[0].length / 2) / item.str.length });
    }
  }
  for (const row of headerRows) row.columns.sort((a, b) => a.x - b.x);

  // A subsequent matrix title or incomplete header ends the preceding mapping.
  const boundaries = [
    ...headerRows,
    ...items.filter((item) => item.str.includes('毕业要求')).map((item) => ({ y: item.y, columns: [] as Column[] })),
  ].sort((a, b) => a.y - b.y);
  let mapped = false;
  let uncertain = false;
  const text = items.map((item) => {
    let value = item.str;
    if (/\b[HML]\b/.test(value)) {
      const header = boundaries.find((row) => row.y > item.y + Math.max(1, item.height / 4));
      const columns = header?.columns ?? [];
      const strength = value.trim();
      if (!/^[HML]$/.test(strength) || columns.length < 3 || new Set(columns.map((column) => column.code)).size !== columns.length) {
        uncertain = true;
      } else {
        const x = item.x + item.width / 2;
        const column = columns.find((current, index) => {
          // Do not stretch a column across a missing neighboring header.
          const halfWidth = Math.min(
            index ? current.x - columns[index - 1].x : Infinity,
            index < columns.length - 1 ? columns[index + 1].x - current.x : Infinity,
          ) / 2;
          const left = current.x - halfWidth;
          const right = current.x + halfWidth;
          return x >= left && x < right && item.x >= left && item.x + item.width <= right;
        });
        if (column) {
          value = value.replace(strength, `${column.code}=${strength}`);
          mapped = true;
        } else {
          uncertain = true;
        }
      }
    }
    return value + (item.hasEOL ? '\n' : '');
  }).join('');

  return (mapped ? '【PDF矩阵列定位】下文“指标编号=H/M/L”由本页表头与单元格坐标对应还原，空列不顺移。\n' : '') + text
    + (uncertain ? '\n【PDF矩阵列定位需核实】部分支撑矩阵的表头或单元格列位置无法可靠识别，相关H/M/L保留原文，不得按出现顺序推断指标编号；请对照原文件核实。' : '');
}
