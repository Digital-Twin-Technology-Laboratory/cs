import { Alert, App, AutoComplete, Button, Card, Col, Form, Input, InputNumber, Popconfirm, Radio, Row, Select, Space, Switch, Tag } from 'antd';
import { ApiOutlined, PlusOutlined, ReloadOutlined } from '@ant-design/icons';
import { useEffect, useState } from 'react';
import { api } from '../../api';

interface AiSettings {
  id?: number;
  name?: string;
  isActive?: boolean;
  provider: 'openai' | 'anthropic';
  baseUrl: string;
  model: string;
  temperature: number;
  maxTokens: number;
  timeoutSec: number;
  concurrency: number;
  effort: string;
  anthropicFallback: boolean;
  jsonMode: boolean;
  systemPrompt: string;
  apiKeyMasked: string;
  hasKey: boolean;
  defaultSystemPrompt: string;
}

// 常见 OpenAI 兼容服务的接口地址（模型名称以服务商控制台为准）
const PRESETS = [
  { label: 'DeepSeek', baseUrl: 'https://api.deepseek.com/v1' },
  { label: '通义千问（阿里云百炼）', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1' },
  { label: 'Kimi（月之暗面）', baseUrl: 'https://api.moonshot.cn/v1' },
  { label: '智谱 GLM', baseUrl: 'https://open.bigmodel.cn/api/paas/v4' },
  { label: 'OpenAI', baseUrl: 'https://api.openai.com/v1' },
];

export default function AiConfig() {
  const { message, modal } = App.useApp();
  const [form] = Form.useForm();
  const [s, setS] = useState<AiSettings | null>(null);
  const [profiles, setProfiles] = useState<AiSettings[]>([]);
  const [defaults, setDefaults] = useState<AiSettings | null>(null);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [fetchingModels, setFetchingModels] = useState(false);
  const [models, setModels] = useState<string[]>([]);
  const [modelsError, setModelsError] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<{ ok: boolean; text: string } | null>(null);
  const provider = Form.useWatch('provider', form);
  const active = profiles.find((p) => p.isActive);

  useEffect(() => {
    api.get<{ profiles: AiSettings[]; defaults: AiSettings }>('/api/admin/ai/profiles').then((r) => {
      setProfiles(r.profiles);
      setDefaults(r.defaults);
      const selected = r.profiles.find((p) => p.isActive) ?? r.defaults;
      setS(selected);
      form.setFieldsValue({ ...selected, apiKey: '', systemPrompt: selected.systemPrompt || selected.defaultSystemPrompt });
    }).catch((e) => message.error(e.message));
  }, [form, message]);

  const select = (next: AiSettings) => {
    const change = () => {
      setS(next);
      form.resetFields();
      form.setFieldsValue({ ...next, apiKey: '', systemPrompt: next.systemPrompt || next.defaultSystemPrompt });
      setDirty(false);
      setModels([]);
      setModelsError(null);
      setTestResult(null);
    };
    if (dirty) modal.confirm({ title: '放弃尚未保存的更改？', content: '切换后不会保存当前表单的修改。', okText: '放弃并切换', onOk: change });
    else change();
  };

  const activate = async () => {
    setSaving(true);
    try {
      await api.post(`/api/admin/ai/profiles/${s!.id}/activate`);
      setProfiles((rows) => rows.map((p) => ({ ...p, isActive: p.id === s!.id })));
      setS((prev) => ({ ...prev!, isActive: true }));
      message.success(`已切换到“${s!.name}”，后续检查使用此配置`);
    } catch (e) {
      message.error((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const remove = async () => {
    setSaving(true);
    try {
      await api.del(`/api/admin/ai/profiles/${s!.id}`);
      const next = profiles.filter((p) => p.id !== s!.id);
      setProfiles(next);
      const selected = next.find((p) => p.isActive)!;
      setS(selected);
      form.resetFields();
      form.setFieldsValue({ ...selected, apiKey: '', systemPrompt: selected.systemPrompt || selected.defaultSystemPrompt });
      setDirty(false);
      setModels([]);
      setModelsError(null);
      setTestResult(null);
      message.success('配置已删除');
    } catch (e) {
      message.error((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const values = async (fields?: string[]) => {
    const v = await form.validateFields(fields).catch(({ errorFields }: { errorFields: { errors: string[] }[] }) => {
      throw new Error(errorFields.flatMap((field) => field.errors).join('；'));
    });
    return { ...v, profileId: s?.id, apiKey: v.apiKey?.trim() || undefined };
  };

  const fetchModels = async () => {
    setFetchingModels(true);
    setModelsError(null);
    try {
      const v = await values(['provider', 'baseUrl', 'apiKey']);
      const r = await api.post<{ models: string[] }>('/api/admin/ai/models', v);
      setModels(r.models);
      if (!r.models.length) setModelsError('接口未返回可用模型，请手动填写模型名称，或检查 API Key 的模型访问权限。');
      else message.success(`已获取 ${r.models.length} 个模型，请搜索选择`);
    } catch (e) {
      setModelsError((e as Error).message);
    } finally {
      setFetchingModels(false);
    }
  };

  const save = async () => {
    setSaving(true);
    try {
      const v = await values();
      const r = s?.id
        ? await api.put<AiSettings>(`/api/admin/ai/profiles/${s.id}`, v)
        : await api.post<AiSettings>('/api/admin/ai/profiles', v);
      setS(r);
      setProfiles((rows) => rows.some((p) => p.id === r.id) ? rows.map((p) => p.id === r.id ? r : p) : [...rows, r]);
      form.setFieldsValue({ apiKey: '' });
      setDirty(false);
      message.success('AI 配置已保存');
    } catch (e) {
      message.error((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const test = async () => {
    setTesting(true);
    setTestResult(null);
    try {
      const v = await values();
      const r = await api.post<{ reply: string; model: string; ms: number }>('/api/admin/ai/test', v);
      setTestResult({ ok: true, text: `连接成功（${r.model}，${(r.ms / 1000).toFixed(1)} 秒）：${r.reply}` });
    } catch (e) {
      setTestResult({ ok: false, text: (e as Error).message });
    } finally {
      setTesting(false);
    }
  };

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>AI 配置</h1>
          <div className="sub">分别保存不同服务商、API Key、模型和参数，随时选择配置并切换使用。API Key 加密保存。</div>
        </div>
        <Space wrap>
          <Button icon={<PlusOutlined />} disabled={!defaults || saving || testing || fetchingModels} onClick={() => select({ ...defaults!, name: '' })}>新增配置</Button>
          <Button icon={<ApiOutlined />} loading={testing} disabled={!s || saving || fetchingModels} onClick={test}>
            测试连接
          </Button>
          <Button type="primary" loading={saving} disabled={!s || testing || fetchingModels} onClick={save}>
            保存配置
          </Button>
        </Space>
      </div>
      <Card className="ai-profile-picker">
        <div className="profile-current">
          <b>当前使用</b>
          {active ? <><Tag color="blue">{active.name}</Tag><span className="muted">{active.model}</span></> : <span className="muted">尚未保存配置</span>}
        </div>
        <div className="profile-controls">
          <Select
            aria-label="选择已保存的 AI 配置"
            value={s?.id}
            placeholder="正在新增配置"
            disabled={saving || testing || fetchingModels}
            options={profiles.map((p) => ({ value: p.id, label: `${p.name}${p.isActive ? '（当前使用）' : ''}` }))}
            onChange={(id) => select(profiles.find((p) => p.id === id)!)}
          />
          <Button type="primary" ghost disabled={!s?.id || s.isActive || dirty || testing || fetchingModels} loading={saving} onClick={activate}>使用此配置</Button>
          {s?.id && !s.isActive && <Popconfirm title="删除此配置？" description="只删除这套配置，不影响已有检查结果。" onConfirm={remove}><Button danger disabled={saving || testing || fetchingModels}>删除配置</Button></Popconfirm>}
        </div>
        <p className="muted small">选择配置可查看或编辑；点击“使用此配置”才会切换。更改请先保存，正在进行的检查不受切换影响。</p>
      </Card>
      {testResult && <Alert type={testResult.ok ? 'success' : 'error'} showIcon title={testResult.text} style={{ marginBottom: 16 }} closable onClose={() => setTestResult(null)} />}
      <Form
        form={form}
        layout="vertical"
        disabled={!s || saving || testing || fetchingModels}
        onValuesChange={(changed) => {
          setDirty(true);
          setTestResult(null);
          if (['provider', 'baseUrl', 'apiKey'].some((key) => key in changed)) {
            setModels([]);
            setModelsError(null);
          }
        }}
      >
        <Space orientation="vertical" size={16} style={{ width: '100%' }}>
          <Card title="模型接口">
            <Form.Item label="配置名称" name="name" rules={[{ required: true, whitespace: true, message: '请填写配置名称' }, { max: 80 }]}>
              <Input placeholder="例如：DeepSeek 日常检查、Claude 详细检查" maxLength={80} />
            </Form.Item>
            <Form.Item label="接口类型" name="provider">
              <Radio.Group
                onChange={() => form.setFieldsValue({ baseUrl: '', model: '' })}
                options={[
                  { value: 'openai', label: 'OpenAI 兼容接口（DeepSeek、通义千问、Kimi、智谱等）' },
                  { value: 'anthropic', label: 'Anthropic Claude' },
                ]}
              />
            </Form.Item>
            <Row gutter={16}>
              <Col xs={24} md={14}>
                <Form.Item
                  label="接口地址（Base URL）"
                  name="baseUrl"
                  rules={[{ required: provider === 'openai', message: '请填写接口地址' }]}
                  extra={provider === 'anthropic' ? '使用官方接口时留空；使用代理或企业网关时填写其地址' : '通常以 /v1 结尾'}
                >
                  <Input placeholder={provider === 'anthropic' ? 'https://api.anthropic.com（默认）' : 'https://…/v1'} />
                </Form.Item>
              </Col>
              {provider === 'openai' && (
                <Col xs={24} md={10}>
                  <Form.Item label="快速填入">
                    <Select
                      placeholder="选择服务商填入接口地址"
                      options={PRESETS.map((p) => ({ value: p.baseUrl, label: p.label }))}
                      onChange={(v) => {
                        form.setFieldsValue({ baseUrl: v, model: '' });
                        setDirty(true);
                        setModels([]);
                        setModelsError(null);
                        setTestResult(null);
                      }}
                    />
                  </Form.Item>
                </Col>
              )}
            </Row>
            <Row gutter={16}>
              <Col xs={24} md={12}>
                <Form.Item
                  label={
                    <>
                      API Key {s?.hasKey ? <Tag style={{ marginLeft: 8 }}>已保存：{s.apiKeyMasked}</Tag> : <Tag color="warning" style={{ marginLeft: 8 }}>未配置</Tag>}
                    </>
                  }
                  name="apiKey"
                  rules={[{ required: !s?.hasKey, whitespace: true, message: '请填写 API Key' }]}
                  extra={s?.hasKey ? '留空表示不修改' : undefined}
                >
                  <Input.Password placeholder={s?.hasKey ? '输入新的 Key 以替换' : '请输入 API Key'} autoComplete="off" />
                </Form.Item>
              </Col>
              <Col xs={24} md={12}>
                <Form.Item
                  label="模型名称"
                  required
                  extra={models.length ? `已获取 ${models.length} 个模型，可搜索选择或手动输入。可用性以测试连接为准。` : '先获取模型列表再选择，也可直接填写服务商提供的模型名称。'}
                >
                  <Space.Compact style={{ width: '100%' }}>
                    <Form.Item name="model" noStyle rules={[{ required: true, whitespace: true, message: '请选择或填写模型名称' }]}>
                      <AutoComplete
                        style={{ flex: 1, minWidth: 0 }}
                        options={models.map((model) => ({ value: model }))}
                        filterOption={(input, option) => option!.value.toLowerCase().includes(input.toLowerCase())}
                        placeholder="搜索或输入模型名称"
                        allowClear
                      />
                    </Form.Item>
                    <Button icon={<ReloadOutlined />} loading={fetchingModels} onClick={fetchModels}>
                      获取模型
                    </Button>
                  </Space.Compact>
                </Form.Item>
              </Col>
            </Row>
            {modelsError && <Alert type="warning" showIcon title={modelsError} description="获取列表失败不影响手动填写模型；填写后可点击「测试连接」验证。" />}
          </Card>

          <Card title="参数">
            <Row gutter={16}>
              <Col xs={12} md={6}>
                <Form.Item label="最大输出 token" name="maxTokens" extra="结果被截断时调大">
                  <InputNumber min={256} max={128000} step={1000} style={{ width: '100%' }} />
                </Form.Item>
              </Col>
              <Col xs={12} md={6}>
                <Form.Item label="超时（秒）" name="timeoutSec">
                  <InputNumber min={30} max={3600} style={{ width: '100%' }} />
                </Form.Item>
              </Col>
              <Col xs={12} md={6}>
                <Form.Item label="同时检查数" name="concurrency" extra="同时处理的大纲数">
                  <InputNumber min={1} max={10} style={{ width: '100%' }} />
                </Form.Item>
              </Col>
              {provider === 'openai' ? (
                <Col xs={12} md={6}>
                  <Form.Item label="温度" name="temperature" extra="建议 0–0.3，结果更稳定">
                    <InputNumber min={0} max={2} step={0.1} style={{ width: '100%' }} />
                  </Form.Item>
                </Col>
              ) : (
                <Col xs={12} md={6}>
                  <Form.Item label="思考强度（effort）" name="effort">
                    <Select
                      options={[
                        { value: 'low', label: 'low' },
                        { value: 'medium', label: 'medium' },
                        { value: 'high', label: 'high（推荐）' },
                        { value: 'xhigh', label: 'xhigh' },
                        { value: 'max', label: 'max' },
                      ]}
                    />
                  </Form.Item>
                </Col>
              )}
            </Row>
            {provider === 'openai' ? (
              <Form.Item label="JSON 输出模式" name="jsonMode" valuePropName="checked" extra="要求模型以 JSON 格式输出（response_format）。如服务商不支持该参数导致报错，可关闭。">
                <Switch />
              </Form.Item>
            ) : (
              <Form.Item
                label="拒绝时自动回退"
                name="anthropicFallback"
                valuePropName="checked"
                extra="模型因安全策略拒绝请求时，由服务端自动改用合适的模型重试（fallbacks）。使用不支持该参数的代理网关时请关闭。"
              >
                <Switch />
              </Form.Item>
            )}
          </Card>

          <Card
            title="检查提示词"
            extra={
              <Button size="small" onClick={() => { form.setFieldsValue({ systemPrompt: s?.defaultSystemPrompt }); setDirty(true); }}>
                恢复默认
              </Button>
            }
          >
            <Alert
              type="info"
              showIcon
              style={{ marginBottom: 12 }}
              title="检查清单、判定规则、课程信息、培养方案和大纲内容由系统自动附加，这里只需维护检查的总体要求和输出格式。修改输出格式中的字段名会导致结果无法解析。"
            />
            <Form.Item name="systemPrompt" noStyle>
              <Input.TextArea className="text-preview" autoSize={{ minRows: 16 }} onChange={() => setDirty(true)} />
            </Form.Item>
          </Card>
        </Space>
      </Form>
    </div>
  );
}
