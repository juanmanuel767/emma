import { createLogger } from '@emma/shared/logger';
import type { LLMProviderManager, ProviderStatus } from './LLMProviderManager.js';
import { OpenAICompatibleAdapter } from './OpenAICompatibleAdapter.js';
import { ClaudeAdapter } from './ClaudeAdapter.js';
import { OllamaAdapter } from './OllamaAdapter.js';

const logger = createLogger('ModelService');

export const OPENROUTER_BASE_URL = 'https://openrouter.ai';
export const OPENROUTER_PATH_PREFIX = '/api/v1/';

// Estilo opencode: models.dev como catálogo universal de proveedores/modelos
const MODELS_DEV_URL = 'https://models.dev/api.json';

export interface FreeModel {
  id: string;
  name: string;
  contextLength: number;
  supportsTools: boolean;
}

export interface CatalogModel {
  id: string;
  name: string;
  contextLength: number;
  supportsTools: boolean;
  reasoning: boolean;
  /** USD por millón de tokens; null = desconocido */
  costIn: number | null;
  costOut: number | null;
  free: boolean;
}

export interface ProviderCatalog {
  id: string;
  name: string;
  configured: boolean;
  models: CatalogModel[];
}

export interface ModelServiceKeys {
  groq?: string;
  openrouter?: string;
  anthropic?: string;
  openai?: string;
  opencode?: string;
  ollamaBaseUrl?: string;
}

const KNOWN_PROVIDERS = new Set(['groq', 'openrouter', 'anthropic', 'openai', 'opencode', 'ollama']);

// OpenCode Zen: endpoint OpenAI-compatible (mismo truco de apiPathPrefix que OpenRouter)
export const OPENCODE_ZEN_BASE_URL = 'https://opencode.ai';
export const OPENCODE_ZEN_PATH_PREFIX = '/zen/v1/';

// Curated fallback if the OpenRouter catalog is unreachable (free + tool-capable, verified 2026-06)
const STATIC_FREE_MODELS: FreeModel[] = [
  { id: 'qwen/qwen3-coder:free', name: 'Qwen3 Coder', contextLength: 1_048_576, supportsTools: true },
  { id: 'nvidia/nemotron-3-ultra-550b-a55b:free', name: 'Nemotron 3 Ultra 550B', contextLength: 1_000_000, supportsTools: true },
  { id: 'nvidia/nemotron-3-super-120b-a12b:free', name: 'Nemotron 3 Super 120B', contextLength: 1_000_000, supportsTools: true },
  { id: 'meta-llama/llama-3.3-70b-instruct:free', name: 'Llama 3.3 70B', contextLength: 65_536, supportsTools: true },
  { id: 'qwen/qwen3-next-80b-a3b-instruct:free', name: 'Qwen3 Next 80B', contextLength: 262_144, supportsTools: true },
  { id: 'google/gemma-4-31b-it:free', name: 'Gemma 4 31B', contextLength: 262_144, supportsTools: true },
];

const CATALOG_TTL_MS = 60 * 60 * 1000; // 1h

interface OpenRouterModel {
  id: string;
  name?: string;
  context_length?: number;
  pricing?: { prompt?: string; completion?: string };
  supported_parameters?: string[];
}

interface ModelsDevModel {
  id: string;
  name?: string;
  tool_call?: boolean;
  reasoning?: boolean;
  limit?: { context?: number; output?: number };
  cost?: { input?: number; output?: number };
}

interface ModelsDevProvider {
  id: string;
  name?: string;
  models?: Record<string, ModelsDevModel>;
}

export class ModelService {
  #orCatalog: FreeModel[] | null = null;
  #orCatalogFetchedAt = 0;
  #catalogs: ProviderCatalog[] | null = null;
  #catalogsFetchedAt = 0;

  constructor(
    private readonly manager: LLMProviderManager,
    private readonly keys: ModelServiceKeys,
    // Invocado tras cada selección exitosa — permite persistirla (p.ej. en Redis)
    private readonly onSelect?: (model: string) => void,
  ) {}

  /** Live catalog of free models from OpenRouter (cached 1h, static fallback). */
  async getCatalog(): Promise<FreeModel[]> {
    if (this.#orCatalog && Date.now() - this.#orCatalogFetchedAt < CATALOG_TTL_MS) {
      return this.#orCatalog;
    }
    const all = await this.#fetchOpenRouterModels();
    if (all) {
      const free = all
        .filter((m) => m.free && m.supportsTools)
        .map((m) => ({ id: m.id, name: m.name, contextLength: m.contextLength, supportsTools: true }))
        .sort((a, b) => b.contextLength - a.contextLength);
      if (free.length > 0) {
        this.#orCatalog = free;
        this.#orCatalogFetchedAt = Date.now();
        return free;
      }
    }
    return this.#orCatalog ?? STATIC_FREE_MODELS;
  }

  /**
   * Catálogo universal estilo opencode: todos los proveedores con sus modelos,
   * metadatos y precios. Fuentes: models.dev (groq/anthropic/openai),
   * OpenRouter API (openrouter, incluye variantes :free) y Ollama local.
   */
  async getCatalogs(): Promise<ProviderCatalog[]> {
    if (this.#catalogs && Date.now() - this.#catalogsFetchedAt < CATALOG_TTL_MS) {
      return this.#catalogs;
    }

    const [modelsDev, openrouterModels, ollamaModels] = await Promise.all([
      this.#fetchModelsDev(),
      this.#fetchOpenRouterModels(),
      this.#fetchOllamaModels(),
    ]);

    const fromModelsDev = (providerId: string): CatalogModel[] => {
      const prov = modelsDev?.[providerId];
      if (!prov?.models) return [];
      return Object.values(prov.models)
        .filter((m) => m.tool_call === true)
        .map((m) => ({
          id: m.id,
          name: m.name ?? m.id,
          contextLength: m.limit?.context ?? 0,
          supportsTools: true,
          reasoning: m.reasoning === true,
          costIn: m.cost?.input ?? null,
          costOut: m.cost?.output ?? null,
          free: (m.cost?.input ?? 1) === 0 && (m.cost?.output ?? 1) === 0,
        }))
        .sort((a, b) => b.contextLength - a.contextLength);
    };

    const catalogs: ProviderCatalog[] = [
      {
        id: 'groq',
        name: 'Groq',
        configured: Boolean(this.keys.groq),
        models: fromModelsDev('groq'),
      },
      {
        id: 'openrouter',
        name: 'OpenRouter',
        configured: Boolean(this.keys.openrouter),
        // OpenRouter desde su propia API: trae las variantes :free reales
        models: (openrouterModels ?? [])
          .filter((m) => m.supportsTools)
          .sort((a, b) => Number(b.free) - Number(a.free) || b.contextLength - a.contextLength),
      },
      {
        id: 'opencode',
        name: 'OpenCode Zen',
        configured: Boolean(this.keys.opencode),
        // Gratis primero, como el selector de opencode
        models: fromModelsDev('opencode').sort(
          (a, b) => Number(b.free) - Number(a.free) || b.contextLength - a.contextLength,
        ),
      },
      {
        id: 'anthropic',
        name: 'Anthropic (Claude)',
        configured: Boolean(this.keys.anthropic),
        models: fromModelsDev('anthropic'),
      },
      {
        id: 'openai',
        name: 'OpenAI',
        configured: Boolean(this.keys.openai),
        models: fromModelsDev('openai'),
      },
      {
        id: 'ollama',
        name: 'Ollama (local)',
        configured: ollamaModels !== null,
        models: ollamaModels ?? [],
      },
    ];

    // Cachear solo si al menos una fuente remota respondió
    if (modelsDev || openrouterModels) {
      this.#catalogs = catalogs;
      this.#catalogsFetchedAt = Date.now();
    }
    return catalogs;
  }

  async #fetchModelsDev(): Promise<Record<string, ModelsDevProvider> | null> {
    try {
      const res = await fetch(MODELS_DEV_URL, { signal: AbortSignal.timeout(10_000) });
      if (!res.ok) throw new Error(`models.dev HTTP ${res.status}`);
      return (await res.json()) as Record<string, ModelsDevProvider>;
    } catch (err) {
      logger.warn({ err: (err as Error).message }, 'Failed to fetch models.dev catalog');
      return null;
    }
  }

  async #fetchOpenRouterModels(): Promise<CatalogModel[] | null> {
    try {
      const res = await fetch(`${OPENROUTER_BASE_URL}/api/v1/models`, {
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) throw new Error(`OpenRouter catalog HTTP ${res.status}`);
      const body = (await res.json()) as { data: OpenRouterModel[] };
      return body.data.map((m) => {
        const costIn = m.pricing?.prompt !== undefined ? Number(m.pricing.prompt) * 1_000_000 : null;
        const costOut = m.pricing?.completion !== undefined ? Number(m.pricing.completion) * 1_000_000 : null;
        return {
          id: m.id,
          name: m.name ?? m.id,
          contextLength: m.context_length ?? 0,
          supportsTools: (m.supported_parameters ?? []).includes('tools'),
          reasoning: (m.supported_parameters ?? []).includes('reasoning'),
          costIn,
          costOut,
          free: costIn === 0 && costOut === 0,
        };
      });
    } catch (err) {
      logger.warn({ err: (err as Error).message }, 'Failed to fetch OpenRouter catalog');
      return null;
    }
  }

  async #fetchOllamaModels(): Promise<CatalogModel[] | null> {
    const base = this.keys.ollamaBaseUrl ?? 'http://localhost:11434';
    try {
      const res = await fetch(`${base}/api/tags`, { signal: AbortSignal.timeout(3_000) });
      if (!res.ok) throw new Error(`Ollama HTTP ${res.status}`);
      const body = (await res.json()) as { models?: Array<{ name: string }> };
      return (body.models ?? []).map((m) => ({
        id: m.name,
        name: m.name,
        contextLength: 0,
        supportsTools: true,
        reasoning: false,
        costIn: 0,
        costOut: 0,
        free: true,
      }));
    } catch {
      return null; // Ollama apagado — no es un error
    }
  }

  listProviders(): ProviderStatus[] {
    return this.manager.listProviders();
  }

  get currentProvider(): string {
    return this.manager.currentProviderName;
  }

  /**
   * Selecciona un modelo como primario. Formatos aceptados:
   * - "provider:modelId" (canónico, estilo opencode): "groq:llama-3.3-70b-versatile",
   *   "openrouter:qwen/qwen3-coder:free", "anthropic:claude-sonnet-4-6", "ollama:llama3.2:latest"
   * - "provider" a secas (legado): "groq", "ollama", "anthropic", "openai"
   * - id de OpenRouter a secas (legado): "x/y:free"
   */
  select(spec: string): { ok: boolean; provider: string; error?: string } {
    const colonIdx = spec.indexOf(':');
    const head = colonIdx > 0 ? spec.slice(0, colonIdx) : spec;

    if (colonIdx > 0 && KNOWN_PROVIDERS.has(head)) {
      return this.#selectProviderModel(head, spec.slice(colonIdx + 1));
    }

    // Nombre de proveedor a secas (legado)
    if (this.manager.makePrimary(spec)) {
      this.onSelect?.(spec);
      return { ok: true, provider: spec };
    }

    // Id de OpenRouter a secas (legado)
    return this.#selectProviderModel('openrouter', spec);
  }

  #selectProviderModel(provider: string, modelId: string): { ok: boolean; provider: string; error?: string } {
    const fail = (error: string) => ({ ok: false, provider: this.currentProvider, error });
    if (!modelId) return fail('Modelo vacío');

    switch (provider) {
      case 'groq': {
        if (!this.keys.groq) return fail('GROQ_API_KEY no configurada');
        const adapter = new OpenAICompatibleAdapter(this.keys.groq, modelId, 'https://api.groq.com', 'groq');
        this.manager.setProvider('groq', adapter, true, modelId);
        break;
      }
      case 'openrouter': {
        if (!this.keys.openrouter) return fail('OPENROUTER_API_KEY no configurada');
        const name = `openrouter:${modelId}`;
        this.manager.setProvider(name, buildOpenRouterAdapter(this.keys.openrouter, modelId), true, modelId);
        this.onSelect?.(`openrouter:${modelId}`);
        logger.info({ provider, model: modelId }, 'Model selected as primary');
        return { ok: true, provider: name };
      }
      case 'anthropic': {
        if (!this.keys.anthropic) return fail('ANTHROPIC_API_KEY no configurada');
        this.manager.setProvider('anthropic', new ClaudeAdapter(this.keys.anthropic, modelId), true, modelId);
        break;
      }
      case 'openai': {
        if (!this.keys.openai) return fail('OPENAI_API_KEY no configurada');
        const adapter = new OpenAICompatibleAdapter(this.keys.openai, modelId, 'https://api.openai.com/v1', 'openai');
        this.manager.setProvider('openai', adapter, true, modelId);
        break;
      }
      case 'opencode': {
        if (!this.keys.opencode) return fail('OPENCODE_API_KEY no configurada');
        const adapter = new OpenAICompatibleAdapter(
          this.keys.opencode, modelId, OPENCODE_ZEN_BASE_URL, 'opencode', OPENCODE_ZEN_PATH_PREFIX,
        );
        this.manager.setProvider('opencode', adapter, true, modelId);
        break;
      }
      case 'ollama': {
        const adapter = new OllamaAdapter(this.keys.ollamaBaseUrl ?? 'http://localhost:11434', modelId);
        this.manager.setProvider('ollama', adapter, true, modelId);
        break;
      }
      default:
        return fail(`Proveedor desconocido: ${provider}`);
    }

    // setProvider reemplaza in-place pero NO reordena: sin esto el modelo elegido
    // queda detrás del antiguo primario en la cadena de fallback
    this.manager.makePrimary(provider);
    this.onSelect?.(`${provider}:${modelId}`);
    logger.info({ provider, model: modelId }, 'Model selected as primary');
    return { ok: true, provider };
  }
}

export function buildOpenRouterAdapter(apiKey: string, model: string): OpenAICompatibleAdapter {
  return new OpenAICompatibleAdapter(
    apiKey,
    model,
    OPENROUTER_BASE_URL,
    `openrouter:${model}`,
    OPENROUTER_PATH_PREFIX,
  );
}
