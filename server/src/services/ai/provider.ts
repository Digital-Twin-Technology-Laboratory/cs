import OpenAI from 'openai';
import Anthropic from '@anthropic-ai/sdk';
import { getSettings, type AiSettings } from '../../settings.js';
import { decrypt } from '../crypto.js';
import { callOpenAICompatible, describeOpenAIError } from './openai.js';
import { callAnthropic, describeAnthropicError } from './anthropic.js';
import { DEFAULT_SYSTEM_PROMPT } from './prompt.js';
import { SYLLABUS_SCOPE_RULES } from '../../seed/checklist.js';

export interface AiCallOptions {
  apiKey: string;
  baseUrl: string;
  model: string;
  temperature: number;
  maxTokens: number;
  timeoutSec: number;
  effort: AiSettings['effort'];
  anthropicFallback: boolean;
  jsonMode: boolean;
  system: string;
  user: string;
}

export interface AiCallResult {
  text: string;
  truncated: boolean;
  model: string;
  usage?: { input: number; output: number };
}

export class AiConfigError extends Error {}

export function aiReady(s: AiSettings = getSettings('ai')): string | null {
  if (!s.model) return '尚未配置 AI 模型';
  if (!decrypt(s.apiKeyEnc)) return '尚未配置 API Key';
  if (s.provider === 'openai' && !s.baseUrl) return '尚未配置接口地址（Base URL）';
  return null;
}

export function effectiveSystemPrompt(s: AiSettings = getSettings('ai')) {
  return `${s.systemPrompt.trim() || DEFAULT_SYSTEM_PROMPT}\n\n本次检查范围约束（优先于上述旧版跨材料要求）\n${SYLLABUS_SCOPE_RULES}`;
}

export async function listModels(settings: Pick<AiSettings, 'provider' | 'baseUrl'>, apiKey: string): Promise<string[]> {
  try {
    const options = { apiKey, baseURL: settings.baseUrl || undefined, timeout: 30_000, maxRetries: 0 };
    const models = settings.provider === 'anthropic'
      ? new Anthropic(options).models.list()
      : new OpenAI(options).models.list();
    const ids = new Set<string>();
    for await (const model of models) ids.add(model.id);
    return [...ids].sort((a, b) => a.localeCompare(b));
  } catch (e) {
    if (e instanceof OpenAI.NotFoundError || e instanceof Anthropic.NotFoundError) {
      throw new Error('模型列表接口不存在，请检查接口地址；服务商不支持获取模型时，可手动填写模型名称');
    }
    const msg = describeAnthropicError(e) ?? describeOpenAIError(e);
    if (msg) throw new Error(msg);
    throw e;
  }
}

export async function callAi(
  user: string,
  opts: { system?: string; maxTokens?: number; structured?: boolean; settings?: AiSettings; apiKey?: string } = {},
): Promise<AiCallResult> {
  const s = opts.settings ?? getSettings('ai');
  const apiKey = opts.apiKey ?? decrypt(s.apiKeyEnc);
  if (!apiKey) throw new AiConfigError('尚未配置 API Key');
  if (!s.model) throw new AiConfigError('尚未配置 AI 模型');
  if (s.provider === 'openai' && !s.baseUrl) throw new AiConfigError('尚未配置接口地址（Base URL）');

  const o: AiCallOptions = {
    apiKey,
    baseUrl: s.baseUrl,
    model: s.model,
    temperature: s.temperature,
    maxTokens: opts.maxTokens ?? s.maxTokens,
    timeoutSec: s.timeoutSec,
    effort: s.effort,
    anthropicFallback: s.anthropicFallback,
    jsonMode: s.jsonMode,
    system: opts.system ?? effectiveSystemPrompt(s),
    user,
  };
  try {
    return s.provider === 'anthropic'
      ? await callAnthropic({ ...o, structured: opts.structured ?? true })
      : await callOpenAICompatible(o);
  } catch (e) {
    const msg = describeAnthropicError(e) ?? describeOpenAIError(e);
    if (msg) throw new Error(msg);
    throw e;
  }
}

/** 测试连接：发送一个极短请求 */
export async function testConnection(settings: AiSettings, apiKey: string) {
  const started = Date.now();
  const r = await callAi('请只回复“连接正常”四个字。', {
    system: '你是连接测试助手。',
    maxTokens: settings.provider === 'anthropic' ? 1024 : 32,
    structured: false,
    settings: { ...settings, jsonMode: false, effort: 'low' },
    apiKey,
  });
  return { ok: true, reply: r.text.trim().slice(0, 100), model: r.model, ms: Date.now() - started };
}
