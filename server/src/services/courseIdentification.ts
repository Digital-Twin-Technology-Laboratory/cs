import path from 'node:path';

function normalize(value: string) {
  return value.normalize('NFKC').replace(/[\s《》“”「」"']/g, '').toLowerCase();
}

export function identifyCourse(fileName: string, text: string, courseNames: string[]) {
  const courses = [...new Map(courseNames.map((name) => [normalize(name), name])).values()];
  const lines = text.slice(0, 6000).split(/\r?\n/).map((line) => line.replace(/^#+\s*/, '').trim()).filter(Boolean);
  const fields: string[] = [];
  const titles: string[] = [];
  for (const [index, line] of lines.entries()) {
    const field = line.match(/^(?:\|\s*)?(?:(?:中文)?课程(?:中文)?名称|课程名)(?:\s*[:：|]\s*|\s+|$)([^|]*)/);
    if (field) {
      const value = (field[1].trim() || lines[index + 1] || '')
        .split(/\s+(?:\/|课程代码|课程编号|课程性质|学分|英文名称)/)[0].trim();
      if (value && value.length <= 100 && !/^[|\-]+$/.test(value)) fields.push(value);
    }
    if (/^(?:本科)?(?:课程)?(?:教学大纲|课程大纲)$/.test(line)) continue;
    const title = line.match(/^(?:《([^》]+)》|[“"]([^”"]+)[”"]|(.+?))\s*(?:课程)?(?:教学大纲|课程大纲)(?:[（(].*)?$/);
    if (title) titles.push((title[1] || title[2] || title[3]).trim());
    if (/^(?:本科)?(?:课程)?教学大纲$/.test(lines[index + 1] ?? '') && line.length <= 100
      && (/^[《“"]/.test(line) || courses.some((name) => normalize(name) === normalize(line)))) {
      titles.push(line.replace(/^[《“"]|[》”"]$/g, ''));
    }
  }
  const stem = path.basename(fileName, path.extname(fileName));
  const sources = [
    { source: '正文课程名称', values: fields, partial: false },
    { source: '正文标题', values: titles, partial: true },
    { source: '文件名', values: [stem], partial: true },
  ];
  for (const { source, values, partial } of sources) {
    if (!values.length) continue;
    const exact = courses.filter((name) => values.some((value) => normalize(value) === normalize(name)));
    const contained = partial ? courses.filter((name) => values.some((value) => normalize(value).includes(normalize(name)))) : [];
    // “计算机网络”不应抢占更完整的“计算机网络课程设计”。
    const candidates = exact.length ? exact : contained.filter((name) => !contained.some((other) => other !== name && normalize(other).includes(normalize(name))));
    if (candidates.length) {
      return { name: candidates.length === 1 ? candidates[0] : null, source, matched: candidates.length === 1, candidates };
    }
    const extracted = source === '文件名'
      ? [...stem.matchAll(/《([^》]+)》|“([^”]+)”/g)].map((match) => match[1] || match[2])
      : values;
    const names = [...new Set(extracted.map((value) => value.replace(/^[《“"]|[》”"]$/g, '').trim()))];
    if (names.length) return { name: names.length === 1 ? names[0] : null, source, matched: false, candidates: names };
  }
  return { name: null, source: null, matched: false, candidates: [] as string[] };
}
