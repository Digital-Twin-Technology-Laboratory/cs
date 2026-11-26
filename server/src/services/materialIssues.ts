import type { MaterialResult } from './materialReview.js';

const sections = [
  ['需整改', '需整改'], ['待补', '待补材料'], ['需核实', '需核实'], ['建议完善', '建议完善'],
] as const;
type Issue = {
  detail: string;
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

export function materialIssueGroups(result: MaterialResult) {
  const uploaded = new Set(result.files.map((file) => file.type));
  return sections.flatMap(([status, label]) => {
    const issues = new Map<string, Issue>();
    function record(detail: string, locations: string[], rule?: MaterialResult['rules'][number], history?: string) {
      const key = JSON.stringify([detail, [...locations].sort(), history]);
      const issue = issues.get(key) ?? { detail, locations, materials: [], checks: [], history };
      if (rule && !issue.checks.some((check) => check.code === rule.code)) {
        issue.checks.push({ code: rule.code, title: rule.title });
        if (!locations.length) {
          issue.materials = [...new Set([...issue.materials, ...rule.materials.filter((type) => uploaded.has(type))])];
        }
      }
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
        record(finding.detail.trim(), compactLocations(finding.location), rule);
      }
    }
    for (const row of result.history ?? []) {
      if (row.status !== status) continue;
      if (status === '待补') for (const type of row.missing) record(type, []);
      else record(row.detail.trim(), [...new Set(row.locations.map((loc) => `${loc.file} · ${loc.position}`))], undefined, row.issue.text.trim());
    }
    return issues.size ? [{ status, label, issues: [...issues.values()] }] : [];
  });
}
