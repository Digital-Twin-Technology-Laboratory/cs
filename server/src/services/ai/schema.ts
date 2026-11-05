import { z } from 'zod';

export const ITEM_RESULTS = ['未发现问题', '存在问题', '需核实', '不适用'] as const;
export const NATURES = ['重大问题', '明确问题', '建议修改'] as const;

export const ResultSchema = z.object({
  summary: z.string().default(''),
  itemResults: z.array(
    z.object({
      code: z.string(),
      result: z.enum(ITEM_RESULTS),
      note: z.string().default(''),
    }),
  ),
  issues: z
    .array(
      z.object({
        nature: z.enum(NATURES),
        itemCodes: z.array(z.string()).default([]),
        title: z.string(),
        location: z.string(),
        problem: z.string(),
        advice: z.string(),
        evidence: z.string().default(''),
      }),
    )
    .default([]),
  toVerify: z
    .array(
      z.object({
        itemCodes: z.array(z.string()).default([]),
        location: z.string().default(''),
        content: z.string(),
      }),
    )
    .default([]),
});

export type CheckResult = z.infer<typeof ResultSchema>;

/** 供 Anthropic 结构化输出使用的 JSON Schema */
export const RESULT_JSON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['summary', 'itemResults', 'issues', 'toVerify'],
  properties: {
    summary: { type: 'string' },
    itemResults: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['code', 'result', 'note'],
        properties: {
          code: { type: 'string' },
          result: { type: 'string', enum: [...ITEM_RESULTS] },
          note: { type: 'string' },
        },
      },
    },
    issues: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['nature', 'itemCodes', 'title', 'location', 'problem', 'advice', 'evidence'],
        properties: {
          nature: { type: 'string', enum: [...NATURES] },
          itemCodes: { type: 'array', items: { type: 'string' } },
          title: { type: 'string' },
          location: { type: 'string' },
          problem: { type: 'string' },
          advice: { type: 'string' },
          evidence: { type: 'string' },
        },
      },
    },
    toVerify: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['itemCodes', 'location', 'content'],
        properties: {
          itemCodes: { type: 'array', items: { type: 'string' } },
          location: { type: 'string' },
          content: { type: 'string' },
        },
      },
    },
  },
} as const;

export class ResultFormatError extends Error {}

/** 从模型输出文本中取出 JSON 对象 */
export function extractJson(text: string): unknown {
  let t = text.trim();
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) t = fence[1].trim();
  const start = t.indexOf('{');
  const end = t.lastIndexOf('}');
  if (start < 0 || end <= start) throw new ResultFormatError('AI 输出中未找到 JSON 结果');
  try {
    return JSON.parse(t.slice(start, end + 1));
  } catch {
    throw new ResultFormatError('AI 输出的 JSON 无法解析');
  }
}

/**
 * 校验并规范化检查结果。
 * strict=true 时缺少清单条目视为格式错误（触发重试）；strict=false 时补为“需核实”。
 */
export function normalizeResult(raw: unknown, codes: string[], strict: boolean): CheckResult {
  const parsed = ResultSchema.safeParse(raw);
  if (!parsed.success) {
    throw new ResultFormatError('AI 输出结构不符合要求：' + parsed.error.issues.slice(0, 3).map((i) => `${i.path.join('.')} ${i.message}`).join('；'));
  }
  const r = parsed.data;
  const known = new Set(codes);
  const byCode = new Map<string, CheckResult['itemResults'][number]>();
  for (const it of r.itemResults) {
    const code = it.code.trim().toUpperCase();
    if (known.has(code) && !byCode.has(code)) byCode.set(code, { ...it, code });
  }
  const missing = codes.filter((c) => !byCode.has(c));
  if (missing.length && strict) {
    throw new ResultFormatError(`AI 未给出以下条目的检查结果：${missing.join('、')}`);
  }
  for (const c of missing) byCode.set(c, { code: c, result: '需核实', note: 'AI 未给出该项结果，请人工核实。' });

  const issues = r.issues.map((i) => ({
    ...i,
    itemCodes: [...new Set(i.itemCodes.map((c) => c.trim().toUpperCase()).filter((c) => known.has(c)))],
  }));
  const toVerify = r.toVerify.map((v) => ({
    ...v,
    itemCodes: [...new Set(v.itemCodes.map((c) => c.trim().toUpperCase()).filter((c) => known.has(c)))],
  }));
  // 有问题关联的条目，结果统一为“存在问题”
  for (const i of issues) {
    for (const c of i.itemCodes) {
      const it = byCode.get(c)!;
      if (it.result !== '存在问题') byCode.set(c, { ...it, result: '存在问题' });
    }
  }
  // 重大问题排在明确问题之前只为阅读分组，编号不代表整改顺序
  const order = { 重大问题: 0, 明确问题: 1, 建议修改: 2 } as const;
  issues.sort((a, b) => order[a.nature] - order[b.nature]);

  return {
    summary: r.summary,
    itemResults: codes.map((c) => byCode.get(c)!),
    issues,
    toVerify,
  };
}

export function computeVerdict(r: CheckResult): 'passed' | 'failed' {
  return r.issues.some((i) => i.nature === '重大问题' || i.nature === '明确问题') ? 'failed' : 'passed';
}
