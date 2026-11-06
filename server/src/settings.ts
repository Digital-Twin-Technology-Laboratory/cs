import { db } from './db.js';

export type RegistrationMode = 'open' | 'approval' | 'closed';
export type Provider = 'openai' | 'anthropic';

export interface SiteSettings {
  siteName: string;
  registrationMode: RegistrationMode;
  maxUploadMB: number;
  trainingTypes: string[];
}

export interface AiSettings {
  provider: Provider;
  baseUrl: string;
  apiKeyEnc: string;
  model: string;
  temperature: number; // 仅 OpenAI 兼容接口使用
  maxTokens: number;
  timeoutSec: number;
  concurrency: number;
  effort: 'low' | 'medium' | 'high' | 'xhigh' | 'max'; // 仅 Anthropic
  anthropicFallback: boolean; // Anthropic 服务端拒绝回退
  jsonMode: boolean; // OpenAI 兼容接口 response_format: json_object
  systemPrompt: string; // 空 = 使用默认提示词
}

const DEFAULTS = {
  site: {
    siteName: '教学材料检查系统',
    registrationMode: 'open',
    maxUploadMB: 20,
    trainingTypes: ['普通本科', '专转本'],
  } as SiteSettings,
  ai: {
    provider: 'openai',
    baseUrl: '',
    apiKeyEnc: '',
    model: '',
    temperature: 0.2,
    maxTokens: 16000,
    timeoutSec: 600,
    concurrency: 2,
    effort: 'high',
    anthropicFallback: true,
    jsonMode: true,
    systemPrompt: '',
  } as AiSettings,
};

type Key = keyof typeof DEFAULTS;

export const DEFAULT_AI_SETTINGS = DEFAULTS.ai;

export function getSettings<K extends Key>(key: K): (typeof DEFAULTS)[K] {
  if (key === 'ai') {
    const active = db.prepare('SELECT settings_json FROM ai_profiles WHERE is_active = 1').get() as { settings_json: string } | undefined;
    if (active) return { ...DEFAULTS.ai, ...JSON.parse(active.settings_json) };
  }
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined;
  const stored = row ? JSON.parse(row.value) : {};
  return { ...DEFAULTS[key], ...stored };
}

export function saveSettings<K extends Key>(key: K, patch: Partial<(typeof DEFAULTS)[K]>) {
  const next = { ...getSettings(key), ...patch };
  if (key === 'ai') {
    const updated = db.prepare('UPDATE ai_profiles SET settings_json = ? WHERE is_active = 1').run(JSON.stringify(next));
    if (!updated.changes) {
      db.prepare('INSERT INTO ai_profiles (name, settings_json, is_active) VALUES (?, ?, 1)').run('默认配置', JSON.stringify(next));
    }
    return next;
  }
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(
    key,
    JSON.stringify(next),
  );
  return next;
}
