import OpenAI from 'openai';
import type { AiCallOptions, AiCallResult } from './provider.js';

/** OpenAI 兼容接口（DeepSeek、通义千问、Kimi、智谱等） */
export async function callOpenAICompatible(o: AiCallOptions): Promise<AiCallResult> {
  const client = new OpenAI({
    apiKey: o.apiKey,
    baseURL: o.baseUrl || undefined,
    timeout: o.timeoutSec * 1000,
    maxRetries: 2,
  });
  const res = await client.chat.completions.create({
    model: o.model,
    temperature: o.temperature,
    max_tokens: o.maxTokens,
    messages: [
      { role: 'system', content: o.system },
      { role: 'user', content: o.user },
    ],
    ...(o.jsonMode ? { response_format: { type: 'json_object' as const } } : {}),
  });
  const choice = res.choices[0];
  return {
    text: choice?.message?.content ?? '',
    truncated: choice?.finish_reason === 'length',
    model: res.model || o.model,
    usage: res.usage ? { input: res.usage.prompt_tokens, output: res.usage.completion_tokens } : undefined,
  };
}

export function describeOpenAIError(e: unknown): string | null {
  if (e instanceof OpenAI.AuthenticationError) return 'API Key 无效或无权限';
  if (e instanceof OpenAI.RateLimitError) return '接口限流，请稍后重试';
  if (e instanceof OpenAI.NotFoundError) return '接口地址或模型名称不存在';
  if (e instanceof OpenAI.BadRequestError) return `请求被拒绝：${e.message}`;
  if (e instanceof OpenAI.APIConnectionTimeoutError) return '请求超时';
  if (e instanceof OpenAI.APIConnectionError) return '无法连接到接口地址';
  if (e instanceof OpenAI.APIError) return `接口错误 ${e.status ?? ''}：${e.message}`;
  return null;
}
