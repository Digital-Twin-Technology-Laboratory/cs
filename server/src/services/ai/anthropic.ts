import Anthropic from '@anthropic-ai/sdk';
import type { AiCallOptions, AiCallResult } from './provider.js';
import { RESULT_JSON_SCHEMA } from './schema.js';

/**
 * Anthropic Claude：流式请求（长输入/长输出不易超时）+ 结构化 JSON 输出。
 * 启用 anthropicFallback 时附带服务端拒绝回退（fallbacks: "default"）。
 */
export async function callAnthropic(o: AiCallOptions & { structured: boolean }): Promise<AiCallResult> {
  const client = new Anthropic({
    apiKey: o.apiKey,
    baseURL: o.baseUrl || undefined,
    timeout: o.timeoutSec * 1000,
    maxRetries: 2,
  });

  const params = {
    model: o.model,
    max_tokens: o.maxTokens,
    thinking: { type: 'adaptive' as const },
    system: o.system,
    messages: [{ role: 'user' as const, content: o.user }],
    output_config: {
      effort: o.effort,
      ...(o.structured ? { format: { type: 'json_schema' as const, schema: RESULT_JSON_SCHEMA } } : {}),
    },
  };

  const message = o.anthropicFallback
    ? await client.beta.messages
        .stream({
          ...params,
          betas: ['server-side-fallback-2026-07-01'],
          // 服务端按拒绝类别自动回退到合适的模型
          ...({ fallbacks: 'default' } as Record<string, unknown>),
        } as Parameters<typeof client.beta.messages.stream>[0])
        .finalMessage()
    : await client.messages.stream(params as Parameters<typeof client.messages.stream>[0]).finalMessage();

  if (message.stop_reason === 'refusal') {
    throw new Error('模型拒绝了本次请求（refusal），请检查文件内容或更换模型后重试');
  }
  const blocks = message.content as { type: string; text?: string }[];
  const text = blocks
    .filter((b) => b.type === 'text')
    .map((b) => b.text ?? '')
    .join('');
  return {
    text,
    truncated: message.stop_reason === 'max_tokens',
    model: message.model,
    usage: { input: message.usage.input_tokens, output: message.usage.output_tokens },
  };
}

export function describeAnthropicError(e: unknown): string | null {
  if (e instanceof Anthropic.AuthenticationError) return 'API Key 无效或无权限';
  if (e instanceof Anthropic.PermissionDeniedError) return '当前 API Key 无权使用该模型或功能';
  if (e instanceof Anthropic.NotFoundError) return '模型名称或接口地址不存在';
  if (e instanceof Anthropic.RateLimitError) return '接口限流，请稍后重试';
  if (e instanceof Anthropic.BadRequestError) return `请求被拒绝：${e.message}`;
  if (e instanceof Anthropic.APIConnectionTimeoutError) return '请求超时';
  if (e instanceof Anthropic.APIConnectionError) return '无法连接到接口地址';
  if (e instanceof Anthropic.APIError) return `接口错误 ${e.status ?? ''}：${e.message}`;
  return null;
}
