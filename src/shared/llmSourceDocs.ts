/**
 * llmSourceDocs.ts — 每个模型来源「去哪儿装 / 去哪儿申请 Key」的唯一资料表
 *
 * 引导页（OnboardingWizard）与 设置 → 模型 → 来源（LlmSettings）共用这一份：
 * 同一来源在两边显示的官网地址与说明必须一致，避免两处各写一套文案。
 *
 * 约定：
 * - `kind`：local = 需要本地安装并运行的服务；cloud = 需要官网申请 API Key；
 *   gateway = 兼容协议的第三方网关 / 中转站（没有唯一官网）。
 * - `siteUrl` 为空表示没有单一官网（自定义网关），此时只显示说明。
 */

export type LlmSourceKind = 'local' | 'cloud' | 'gateway'

export interface LlmSourceDoc {
  /** 与 store.AIconfig.llm.type / LlmSettings 的查看来源一致（deepseek-responses 归一到 deepseek） */
  id: string
  kind: LlmSourceKind
  nameZh: string
  nameEn: string
  /** 本地部署软件的官网 / 申请 API Key 的网站 */
  siteUrl: string
  siteLabelZh: string
  siteLabelEn: string
  /** 可选：官方文档 / 模型库 */
  docsUrl?: string
  docsLabelZh?: string
  docsLabelEn?: string
  /** 一句话说明「要先做什么」 */
  hintZh: string
  hintEn: string
}

const DOCS: LlmSourceDoc[] = [
  {
    id: 'ollama', kind: 'local', nameZh: 'Ollama（本地）', nameEn: 'Ollama (local)',
    siteUrl: 'https://ollama.com', siteLabelZh: 'ollama.com 下载安装', siteLabelEn: 'Download at ollama.com',
    docsUrl: 'https://ollama.com/library', docsLabelZh: '模型库', docsLabelEn: 'Model library',
    hintZh: '本地运行：先安装 Ollama 并拉一个模型（例如 ollama pull qwen2.5），保持后台运行后回来点「测试连接」。',
    hintEn: 'Runs locally: install Ollama, pull a model (e.g. ollama pull qwen2.5), keep it running, then Test connection.',
  },
  {
    id: 'lmstudio', kind: 'local', nameZh: 'LM Studio（本地）', nameEn: 'LM Studio (local)',
    siteUrl: 'https://lmstudio.ai', siteLabelZh: 'lmstudio.ai 下载安装', siteLabelEn: 'Download at lmstudio.ai',
    hintZh: '本地运行：安装 LM Studio，加载一个模型并开启 Local Server（默认 1234 端口），再回来测试。',
    hintEn: 'Runs locally: install LM Studio, load a model and start the Local Server (port 1234 by default), then test.',
  },
  {
    id: 'deepseek', kind: 'cloud', nameZh: 'DeepSeek', nameEn: 'DeepSeek',
    siteUrl: 'https://platform.deepseek.com', siteLabelZh: 'platform.deepseek.com 申请 Key', siteLabelEn: 'Get a key at platform.deepseek.com',
    docsUrl: 'https://api-docs.deepseek.com', docsLabelZh: 'API 文档', docsLabelEn: 'API docs',
    hintZh: '云端 API：注册开放平台后在「API Keys」里创建 Key，填到下面。',
    hintEn: 'Cloud API: sign up on the platform, create a key under API Keys, and paste it below.',
  },
  {
    id: 'openai', kind: 'cloud', nameZh: 'OpenAI', nameEn: 'OpenAI',
    siteUrl: 'https://platform.openai.com/api-keys', siteLabelZh: 'platform.openai.com 申请 Key', siteLabelEn: 'Get a key at platform.openai.com',
    hintZh: '云端 API：登录 OpenAI 平台后创建 API Key，填到下面（地址已预填官方网关）。',
    hintEn: 'Cloud API: sign in to the OpenAI platform, create an API key and paste it below (the endpoint is prefilled).',
  },
  {
    id: 'anthropic', kind: 'cloud', nameZh: 'Anthropic Claude', nameEn: 'Anthropic Claude',
    siteUrl: 'https://console.anthropic.com', siteLabelZh: 'console.anthropic.com 申请 Key', siteLabelEn: 'Get a key at console.anthropic.com',
    hintZh: '云端 API：注册 Anthropic Console 后创建 API Key，填到下面。',
    hintEn: 'Cloud API: sign up for the Anthropic Console, create an API key and paste it below.',
  },
  {
    id: 'google', kind: 'cloud', nameZh: 'Google Gemini', nameEn: 'Google Gemini',
    siteUrl: 'https://aistudio.google.com/app/apikey', siteLabelZh: 'aistudio.google.com 申请 Key', siteLabelEn: 'Get a key at aistudio.google.com',
    hintZh: '云端 API：在 Google AI Studio 里创建 API Key，填到下面。',
    hintEn: 'Cloud API: create an API key in Google AI Studio and paste it below.',
  },
  {
    id: 'azure', kind: 'cloud', nameZh: 'Azure OpenAI', nameEn: 'Azure OpenAI',
    siteUrl: 'https://portal.azure.com', siteLabelZh: 'portal.azure.com 创建资源', siteLabelEn: 'Create a resource at portal.azure.com',
    hintZh: '云端 API：在 Azure 门户创建 OpenAI 资源，填 endpoint / deployment / Key 三项。',
    hintEn: 'Cloud API: create an OpenAI resource in the Azure portal, then fill endpoint / deployment / key.',
  },
  {
    id: 'glm', kind: 'cloud', nameZh: 'GLM（智谱）', nameEn: 'GLM (Zhipu)',
    siteUrl: 'https://open.bigmodel.cn', siteLabelZh: 'open.bigmodel.cn 申请 Key', siteLabelEn: 'Get a key at open.bigmodel.cn',
    docsUrl: 'https://docs.bigmodel.cn', docsLabelZh: '开放平台文档', docsLabelEn: 'Platform docs',
    hintZh: '互联网 API：在智谱开放平台创建 API Key；地址已预填官方 OpenAI 兼容端点（/api/paas/v4），点「测试连接」可自动拉模型。',
    hintEn: 'Cloud API: create a key on the Zhipu platform; the official OpenAI-compatible endpoint (/api/paas/v4) is prefilled and Test can fetch models.',
  },
  {
    id: 'kimi', kind: 'cloud', nameZh: 'Kimi（Moonshot）', nameEn: 'Kimi (Moonshot)',
    siteUrl: 'https://platform.moonshot.cn', siteLabelZh: 'platform.moonshot.cn 申请 Key', siteLabelEn: 'Get a key at platform.moonshot.cn',
    docsUrl: 'https://platform.moonshot.cn/docs', docsLabelZh: 'API 文档', docsLabelEn: 'API docs',
    hintZh: '互联网 API：在 Moonshot 开放平台创建 API Key；地址已预填官方 OpenAI 兼容端点（/v1）。',
    hintEn: 'Cloud API: create a key on the Moonshot platform; the official OpenAI-compatible endpoint (/v1) is prefilled.',
  },
  {
    id: 'mimo', kind: 'cloud', nameZh: 'MiMo（小米）', nameEn: 'MiMo (Xiaomi)',
    siteUrl: 'https://platform.xiaomimimo.com/console/api-keys', siteLabelZh: 'platform.xiaomimimo.com 申请 Key', siteLabelEn: 'Get a key at platform.xiaomimimo.com',
    docsUrl: 'https://platform.xiaomimimo.com/docs', docsLabelZh: 'MiMo 文档', docsLabelEn: 'MiMo docs',
    hintZh: '互联网 API：在 MiMo 开放平台创建 API Key；地址已预填 https://api.xiaomimimo.com/v1，模型可用 mimo-v2.6-pro / mimo-v2.6-flash。',
    hintEn: 'Cloud API: create a key on the MiMo platform; the endpoint https://api.xiaomimimo.com/v1 is prefilled; models include mimo-v2.6-pro / mimo-v2.6-flash.',
  },
  {
    id: 'gpustack', kind: 'local', nameZh: 'GPUStack', nameEn: 'GPUStack',
    siteUrl: 'https://gpustack.ai', siteLabelZh: 'gpustack.ai 下载部署', siteLabelEn: 'Deploy from gpustack.ai',
    docsUrl: 'https://docs.gpustack.ai', docsLabelZh: '部署文档', docsLabelEn: 'Deployment docs',
    hintZh: '自托管推理服务：先按官网文档部署 GPUStack，再填服务地址与已部署的模型名。',
    hintEn: 'Self-hosted inference: deploy GPUStack following the docs, then fill the service address and a deployed model.',
  },
  {
    id: 'custom', kind: 'gateway', nameZh: '自定义来源', nameEn: 'Custom source',
    siteUrl: '', siteLabelZh: '', siteLabelEn: '',
    hintZh: '兼容 OpenAI / Anthropic 协议的地址都行（中转站、自建网关、局域网服务）：填地址、Key（可留空）与模型名。',
    hintEn: 'Any OpenAI / Anthropic compatible endpoint works (proxy, self-hosted gateway, LAN service): fill address, key (optional) and model.',
  },
]

/** 来源 id 归一：历史 'deepseek-responses' 合并到 deepseek（与 store 的口径一致） */
export const normalizeLlmSourceId = (id: string): string =>
  String(id || '') === 'deepseek-responses' ? 'deepseek' : String(id || '')

export const LLM_SOURCE_DOCS: Record<string, LlmSourceDoc> = Object.fromEntries(
  DOCS.map((d) => [d.id, d]),
)

/** 取某个来源的资料（未知来源返回 undefined） */
export const llmSourceDoc = (id: string): LlmSourceDoc | undefined =>
  LLM_SOURCE_DOCS[normalizeLlmSourceId(id)]

/** 引导页里列出的来源顺序（本地 → 云端 → 自定义） */
export const ONBOARDING_SOURCE_IDS = ['ollama', 'lmstudio', 'gpustack', 'deepseek', 'glm', 'kimi', 'mimo', 'openai', 'anthropic', 'google', 'azure', 'custom']
