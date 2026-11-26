import type { Finding, MaterialResult } from './materialReview.js';

type Issue = {
  title: string;
  detail: string;
  action?: string;
  locations: string[];
  materials: string[];
  checks: { code: string; title: string }[];
  history?: string;
};

function compactLocations(location: string): string[] {
  if (!location) return [];
  const sources = new Map<string, Set<string>>();
  for (const [, source, line] of location.matchAll(/(?:^|」\r?\n)([^\r\n]+?) · 提取文本第 (\d+) 行：「/g)) {
    if (!sources.has(source)) sources.set(source, new Set());
    sources.get(source)!.add(line);
  }
  return sources.size ? [...sources].map(([source, lines]) => `${source} · 提取文本第 ${[...lines].sort((a, b) => Number(a) - Number(b)).join('、')} 行`) : [location];
}

export function materialIssueReport(result: MaterialResult) {
  const uploaded = new Set(result.files.map((file) => file.type));
  const [confirmed, suggestions, missing, toVerify] = (['需整改', '建议完善', '待补', '需核实'] as const).map((status) => {
    const issues = new Map<string, Issue>();
    function record(detail: string, locations: string[], rule?: MaterialResult['rules'][number],
      { headline, action, history }: Pick<Finding, 'headline' | 'action'> & { history?: string } = {}) {
      const key = JSON.stringify([detail, [...locations].sort(), action, history]);
      const issue = issues.get(key) ?? { title: headline || rule?.title || (history ? '往期问题复查' : detail),
        detail, action, locations, materials: [], checks: [], history };
      const sources = locations.flatMap((location) => location.split(' ↔ ')).flatMap((source) => {
        const matched = result.files.find((f) => f.id && source.startsWith(`${f.name}（附件 #${f.id}）`));
        return matched ? [matched.type] : result.files.filter((f) =>
          source === f.name || source.startsWith(`${f.name} · `) || source.startsWith(`${f.name}（`)).map((f) => f.type);
      });
      const materials = sources.length ? sources : (rule?.materials ?? []).filter((type) => uploaded.has(type));
      issue.materials = [...new Set([...issue.materials, ...materials])];
      if (rule && !issue.checks.some((check) => check.code === rule.code)) issue.checks.push({ code: rule.code, title: rule.title });
      issues.set(key, issue);
    }
    for (const rule of result.rules) {
      const missing = rule.findings.some((f) => f.status === '待补');
      if (status === '待补') {
        if (missing) for (const type of rule.materials.filter((type) => !uploaded.has(type))) record(type, []);
        continue;
      }
      // Signing and other manual checks on entirely missing material can wait until it is submitted.
      if (status === '需核实' && missing && !rule.materials.some((type) => uploaded.has(type))) continue;
      for (const finding of rule.findings.filter((f) => f.status === status)) {
        record(finding.detail.trim(), compactLocations(finding.location), rule, finding);
      }
    }
    for (const row of result.history ?? []) {
      if (row.status !== status) continue;
      if (status === '待补') for (const type of row.missing) record(type, []);
      else record(row.detail.trim(), [...new Set(row.locations.map((loc) =>
        `${loc.file}${loc.fileId ? `（附件 #${loc.fileId}）` : ''} · ${loc.position}`))], undefined, { history: row.issue.text.trim() });
    }
    return [...issues.values()];
  });
  const byMaterial = new Map<string, { confirmed: Issue[]; suggestions: Issue[] }>();
  for (const [category, issues] of [['confirmed', confirmed], ['suggestions', suggestions]] as const) {
    for (const issue of issues) {
      const material = issue.materials.length === 1 ? issue.materials[0] : issue.materials.length > 1 ? '跨材料核对' : '待定位材料';
      const bucket = byMaterial.get(material) ?? { confirmed: [], suggestions: [] };
      bucket[category].push(issue);
      byMaterial.set(material, bucket);
    }
  }
  const materials = [...byMaterial].map(([material, bucket]) => {
    const files = result.files.filter((file) => file.type === material);
    const file = files.length === 1 ? files[0] : undefined;
    const source = file && (file.id ? `${file.name}（附件 #${file.id}）` : file.name);
    const sections = ([['重大及明确问题', bucket.confirmed], ['建议修改', bucket.suggestions]] as const)
      .filter(([, issues]) => issues.length).map(([label, issues]) => ({ label, issues: issues.map((issue) => {
        if (!file || !source) return issue;
        const locations = issue.locations.filter((location) => location !== source && location !== file.name)
          .map((location) => location.startsWith(`${source} · `) ? location.slice(source.length + 3) : location);
        return { ...issue, locations };
      }) }));
    return { material, source, sections };
  });
  return { materials, missing: missing.map((issue) => issue.title), toVerify };
}
