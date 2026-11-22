import { readSheet } from 'read-excel-file/node';
import { writeFile } from 'node:fs/promises';

const [, , workbook, version] = process.argv;
if (!workbook || !version) throw new Error('Usage: node scripts/generate-material-checklist.mjs <workbook.xlsx> <version>');
const [problemRows, materialRows] = await Promise.all([
  readSheet(workbook, '按问题查'),
  readSheet(workbook, '按材料查'),
]);
const items = problemRows.filter(([code]) => /^[CS]\d{3}$/.test(code)).map(([code, group, title, nature, scope, requirement, , , reference]) => ({
  code, group, title, nature, scope, requirement, reference,
  materials: materialRows.filter(([, id]) => id === code).map(([name, , , , , check, compare]) => ({ name, check, compare })),
}));
if (items.length !== 104 || items.some((item) => !item.materials.length)) throw new Error('Unexpected checklist structure');
await writeFile(new URL('../server/src/seed/materialChecklist.json', import.meta.url),
  `{\n  "version": ${JSON.stringify(version)},\n  "items": [\n${items.map((item) => '    ' + JSON.stringify(item)).join(',\n')}\n  ]\n}\n`);
