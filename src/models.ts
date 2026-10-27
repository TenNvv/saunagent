import type { Model } from '@earendil-works/pi-ai';
import type { Models } from '@earendil-works/pi-ai/models';
import type { ModelRuntime } from '@earendil-works/pi-coding-agent';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createModels, createProvider } from '@earendil-works/pi-ai/models';
import { openaiProvider } from '@earendil-works/pi-ai/providers/openai';
import { anthropicProvider } from '@earendil-works/pi-ai/providers/anthropic';
import { openAICompletionsApi } from '@earendil-works/pi-ai/api/openai-completions.lazy';
import { openAIResponsesApi } from '@earendil-works/pi-ai/api/openai-responses.lazy';
import { anthropicMessagesApi } from '@earendil-works/pi-ai/api/anthropic-messages.lazy';
import type { Config, CustomProvider, ModelChoice } from './types.js';

type Api = NonNullable<CustomProvider['api']>;
const supported = ['openai-completions', 'openai-responses', 'anthropic-messages'] as const;

export function endpoint(input: CustomProvider): CustomProvider & { api: Api } {
  let url: URL;
  try { url = new URL(input.baseUrl); } catch { throw new Error('Provider baseUrl must be an absolute HTTP(S) URL.'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error('Provider baseUrl must be HTTP(S), without embedded credentials, query, or fragment.');
  }
  const suffixes: [string, Api][] = [['/chat/completions', 'openai-completions'], ['/responses', 'openai-responses'], ['/v1/messages', 'anthropic-messages']];
  url.pathname = url.pathname.replace(/\/+$/, '');
  const suffix = suffixes.find(([path]) => url.pathname.endsWith(path));
  if (suffix && input.api && input.api !== suffix[1]) throw new Error('Provider api does not match the URL endpoint.');
  const api = input.api ?? suffix?.[1] ?? 'openai-completions';
  if (!supported.includes(api)) throw new Error('Unsupported provider api; use openai-completions, openai-responses, or anthropic-messages.');
  if (suffix) url.pathname = url.pathname.slice(0, -suffix[0].length);
  for (const field of ['contextWindow', 'maxTokens'] as const) {
    if (input[field] !== undefined && (!Number.isInteger(input[field]) || input[field]! < 1)) throw new Error(`Provider ${field} must be a positive integer.`);
  }
  if (input.contextWindow && input.maxTokens && input.maxTokens > input.contextWindow) throw new Error('Provider maxTokens must not exceed contextWindow.');
  if (input.apiKeyEnv !== undefined && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(input.apiKeyEnv)) throw new Error('Provider apiKeyEnv must be an environment variable name.');
  if (input.models !== undefined && (!Array.isArray(input.models) || input.models.some(id => typeof id !== 'string' || !id.trim()))) throw new Error('Provider models must be non-empty model IDs.');
  return { ...input, api, baseUrl: url.toString().replace(/\/+$/, '') };
}

export class ModelCatalog {
  private base;
  private runtime?: ModelRuntime;
  private fileProviders = new Set<string>();
  private secrets = new Set<string>();
  get models(): Models { return this.runtime ?? this.base; }
  private custom = new Map<string, CustomProvider & { api: Api }>();
  private known = new Map<string, Map<string, Model<Api>>>();
  constructor(readonly config: Config, readonly env: NodeJS.ProcessEnv = process.env) {
    for (const [name, value] of Object.entries(env)) {
      if (/(?:API_KEY|AUTH_TOKEN|ACCESS_TOKEN|REFRESH_TOKEN)$/.test(name) && value && value.length > 6) this.secrets.add(value);
    }
    this.base = createModels({ authContext: {
      env: async name => env[name], fileExists: async () => false,
    } });
    this.base.setProvider(openaiProvider()); this.base.setProvider(anthropicProvider());
    if (config.providers === null || typeof config.providers !== 'object' || Array.isArray(config.providers)) throw new Error('providers must be an object keyed by provider ID.');
    const providers = { ...config.providers };
    if (env.OPENAI_BASE_URL) {
      providers.openai = { ...providers.openai, baseUrl: env.OPENAI_BASE_URL,
        api: (env.OPENAI_API_TYPE || providers.openai?.api || 'openai-completions') as Api,
        apiKeyEnv: providers.openai?.apiKeyEnv ?? 'OPENAI_API_KEY',
      };
    }
    for (const [id, input] of Object.entries(providers)) {
      if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(id)) throw new Error('Invalid custom provider ID.');
      const options = endpoint(input);
      this.custom.set(id, options); this.known.set(id, new Map());
      // Retain built-in model IDs when overriding their endpoint/protocol.
      const ids = new Set([...this.models.getModels(id).map(model => model.id), ...(options.models ?? []),
        ...[config.model, config.supervisorModel].filter(model => model.provider === id).map(model => model.modelId)]);
      for (const modelId of ids) this.add(id, modelId);
      this.register(id);
    }
  }
  async openFiles(directory: string, files: { modelsPath?: string; authPath?: string } = {}) {
    const modelsPath = resolve(files.modelsPath ?? join(directory, 'models.json'));
    const authPath = resolve(files.authPath ?? join(directory, 'auth.json'));
    for (const path of [files.modelsPath, files.authPath]) if (path && !existsSync(path)) throw new Error(`Configuration file not found: ${path}`);
    if (!existsSync(modelsPath) && !existsSync(authPath)) return;
    if (existsSync(authPath)) {
      try {
        const parsed = JSON.parse(readFileSync(authPath, 'utf8').replace(/^\uFEFF/, ''));
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error();
        for (const credential of Object.values(parsed)) {
          if (!credential || typeof credential !== 'object') continue;
          for (const [name, value] of Object.entries(credential)) {
            if (['key', 'access', 'refresh'].includes(name) && typeof value === 'string' && value.length > 6) this.secrets.add(value);
          }
        }
      } catch { throw new Error(`Invalid JSON credential object in ${authPath}.`); }
    }
    if (existsSync(modelsPath)) {
      // Error messages must never include raw JSON, which may contain credentials.
      let parsed;
      try { parsed = JSON.parse(readFileSync(modelsPath, 'utf8').replace(/^\uFEFF/, '')); }
      catch { throw new Error(`Invalid JSON in ${modelsPath}.`); }
      this.fileProviders = new Set(Object.keys(parsed.providers ?? {}));
    }
    const { ModelRuntime } = await import('@earendil-works/pi-coding-agent');
    const runtime = await ModelRuntime.create({
      modelsPath, authPath, modelsStorePath: join(directory, 'models-store.json'),
      allowModelNetwork: false, refreshOnCreate: false,
    });
    if (runtime.getError()) throw new Error(`Invalid models configuration in ${modelsPath}; check the Pi models.json schema.`);
    this.runtime = runtime;
    // Explicit Pi provider definitions are authoritative; legacy config only fills missing providers.
    for (const id of this.custom.keys()) {
      if (!this.fileProviders.has(id)) runtime.registerNativeProvider(this.base.getProvider(id)!);
    }
  }
  redact(text: string) {
    for (const secret of this.secrets) text = text.split(secret).join('[REDACTED]');
    return text.replace(/(Bearer\s+)[^\s"\\]+/gi, '$1[REDACTED]').replace(/\bsk-[A-Za-z0-9_-]+/g, '[REDACTED]').slice(0, 2000);
  }
  configuredModels() {
    const providers = new Set([...this.fileProviders, ...this.custom.keys()]);
    return this.models.getModels().filter(model => providers.has(model.provider));
  }
  private add(provider: string, id: string) {
    const options = this.custom.get(provider)!;
    const original = this.models.getModel(provider, id);
    this.known.get(provider)!.set(id, {
      id, name: id, provider, api: options.api, baseUrl: options.baseUrl,
      reasoning: original?.reasoning ?? false, input: ['text'],
      // A custom gateway's price is unknown; do not report invented cost estimates.
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: options.contextWindow ?? original?.contextWindow ?? 128000,
      maxTokens: options.maxTokens ?? Math.min(8192, options.contextWindow ?? original?.contextWindow ?? 128000),
      ...(options.api === 'openai-completions' ? { compat: {
        supportsStore: false, supportsDeveloperRole: false, supportsReasoningEffort: false,
        supportsUsageInStreaming: false, maxTokensField: 'max_tokens' as const,
      } } : {}),
    });
  }
  private register(id: string) {
    const options = this.custom.get(id)!;
    const variable = options.apiKeyEnv ?? (id === 'openai' ? 'OPENAI_API_KEY' : id === 'anthropic' ? 'ANTHROPIC_API_KEY' : 'LLM_API_KEY');
    const api = options.api === 'openai-completions' ? openAICompletionsApi() : options.api === 'openai-responses' ? openAIResponsesApi() : anthropicMessagesApi();
    const provider = createProvider({ id, baseUrl: options.baseUrl, models: [...this.known.get(id)!.values()], api,
      auth: { apiKey: { name: `${id} API key`, resolve: async ({ credential }) => {
        const apiKey = credential?.type === 'api_key' && credential.key ? credential.key : this.env[variable];
        if (!apiKey) throw new Error(`Configure auth.json or set ${variable} before using provider ${id}.`);
        return { auth: { apiKey }, source: credential?.key ? 'auth.json' : variable };
      } } },
    });
    this.base.setProvider(provider);
    if (this.runtime && !this.fileProviders.has(id)) this.runtime.registerNativeProvider(provider);
  }
  resolve(choice: ModelChoice, role?: 'default' | 'supervisor'): ModelChoice {
    const provider = role === 'supervisor' ? this.env.SUPERVISOR_PROVIDER || this.env.PROVIDER || choice.provider :
      role === 'default' ? this.env.PROVIDER || choice.provider : choice.provider;
    const modelId = role === 'supervisor' ? this.env.SUPERVISOR_MODEL || this.env.MODEL || choice.modelId :
      role === 'default' ? this.env.MODEL || choice.modelId : choice.modelId;
    if (!modelId.trim()) throw new Error('Model ID must not be empty.');
    if (this.custom.has(provider) && !this.fileProviders.has(provider) && !this.models.getModel(provider, modelId)) { this.add(provider, modelId); this.register(provider); }
    if (!this.models.getModel(provider, modelId)) throw new Error(`Unknown model ${provider}/${modelId}. Configure the provider URL or choose a supported model.`);
    return { provider, modelId };
  }
}
