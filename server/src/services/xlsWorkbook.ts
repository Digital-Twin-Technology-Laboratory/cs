import fs from 'node:fs/promises';
import { InvalidSpreadsheetError } from 'read-excel-file/node';
import XLSX from 'xlsx';

export const EXCEL_EXTENSIONS = ['.xls', '.xlsx'];

const oleSignature = Buffer.from('d0cf11e0a1b11ae1', 'hex');
const biffHeaders = [0x0009, 0x0209, 0x0409, 0x0809];

export async function readXlsWorkbook(input: string | Buffer) {
  const bytes = typeof input === 'string' ? await fs.readFile(input) : input;
  if (!bytes.subarray(0, 8).equals(oleSignature) && !(bytes.length >= 4 && biffHeaders.includes(bytes.readUInt16LE(0)))) {
    throw new InvalidSpreadsheetError('不是有效的 .xls 文件');
  }

  let workbook: XLSX.WorkBook;
  try {
    workbook = XLSX.read(bytes, { cellDates: true, cellFormula: false, cellHTML: false, cellText: false, dense: true });
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    throw new InvalidSpreadsheetError(`无法读取 .xls 文件：${error.message}`);
  }
  if (!workbook.SheetNames.length) throw new InvalidSpreadsheetError('.xls 文件没有工作表');

  return workbook.SheetNames.map((sheet) => ({
    sheet,
    // Start at row 1 so imported feedback and evidence retain the original row numbers.
    data: XLSX.utils.sheet_to_json<(string | number | boolean | Date)[]>(workbook.Sheets[sheet], { header: 1, range: 0 }),
  }));
}
