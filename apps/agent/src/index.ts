/**
 * Emma — © 2026 Juan Manuel Peralta Chacón. Todos los derechos reservados.
 * Software PROPIETARIO. Prohibido su uso, copia o distribución sin autorización
 * previa y por escrito del autor (peraltachaconjuanmanuel5@gmail.com). Ver LICENSE.
 */

import { Redis } from 'ioredis';
import { z } from 'zod';
import { loadConfig } from '@emma/shared/config';
import { createLogger } from '@emma/shared/logger';
import { createDb } from '@emma/memory';
import { ConversationRepository, MemoryRepository, VoyageEmbeddingAdapter } from '@emma/memory';
import { ClaudeAdapter } from './infrastructure/llm/ClaudeAdapter.js';
import { OllamaAdapter } from './infrastructure/llm/OllamaAdapter.js';
import { OpenAICompatibleAdapter } from './infrastructure/llm/OpenAICompatibleAdapter.js';
import { LLMProviderManager } from './infrastructure/llm/LLMProviderManager.js';
import { ModelService, buildOpenRouterAdapter } from './infrastructure/llm/ModelService.js';
import { RedisSessionStore } from './infrastructure/session/RedisSessionStore.js';
import { RunConversation } from './application/use-cases/RunConversation.js';
import { buildServer } from './interface/http/server.js';
import { buildSkillRegistry } from './infrastructure/tools/buildSkillRegistry.js';
import { installRuntimeSecretGuard } from './infrastructure/security/runtimeGuard.js';

const logger = createLogger('agent');

// Forged tools run arbitrary code; a stray stream 'error' event or rejected promise
// must never take down the whole agent. Log and keep serving.
process.on('uncaughtException', (err) => {
  logger.error({ err }, 'Uncaught exception (kept alive — likely a forged tool)');
});
process.on('unhandledRejection', (reason) => {
  logger.error({ reason }, 'Unhandled rejection (kept alive — likely a forged tool)');
});

const envSchema = z.object({
  LLM_PROVIDER: z.enum(['anthropic', 'ollama', 'groq', 'openai']).optional(),
  ANTHROPIC_API_KEY: z.string().transform((v) => v || undefined).optional(),
  OLLAMA_BASE_URL: z.string().url().default('http://localhost:11434'),
  OLLAMA_MODEL: z.string().default('llama3.2:1b'),
  OLLAMA_HEAVY_MODEL: z.string().default('qwen2.5:3b'),
  GROQ_API_KEY: z.string().transform((v) => v || undefined).optional(),
  GROQ_MODEL: z.string().default('qwen/qwen3-32b'),
  OPENAI_API_KEY: z.string().transform((v) => v || undefined).optional(),
  OPENAI_MODEL: z.string().default('gpt-4o'),
  OPENROUTER_API_KEY: z.string().transform((v) => v || undefined).optional(),
  // OpenCode Zen — pasarela de opencode con modelos free (https://opencode.ai/auth)
  OPENCODE_API_KEY: z.string().transform((v) => v || undefined).optional(),
  // Primario INTERACTIVO: nemotron responde al instante (sin fase de razonamiento que congela
  // el chat web). deepseek-v4-flash y north-mini razonan en silencio antes de responder → van al
  // final como respaldo. big-pickle se omite (alias rotatorio que a veces va a backends sin tools).
  OPENCODE_MODEL: z.string().default('deepseek-v4-flash-free'),
  // Modelos gratis de OpenCode Zen como cadena de fallback (separados por coma). Todos con tools.
  // Orden: RÁPIDOS primero (deepseek-flash ~2s, mimo, north-mini); nemotron-ultra 550B al final
  // (más capaz pero ~5.5s/saludo y ~37s con herramientas → solo como último recurso).
  OPENCODE_MODELS: z.string().default(
    'deepseek-v4-flash-free,mimo-v2.5-free,north-mini-code-free,nemotron-3-ultra-free',
  ),
  // Cadena de modelos gratis (separados por coma) que se registran como fallback.
  // Por defecto: solo modelos con ~1M tokens de contexto.
  OPENROUTER_MODELS: z.string().default(
    'qwen/qwen3-coder:free,nvidia/nemotron-3-ultra-550b-a55b:free,nvidia/nemotron-3-super-120b-a12b:free',
  ),
  VOYAGE_API_KEY: z.string().transform((v) => v || undefined).optional(),
  DATABASE_URL: z.string().url(),
  REDIS_URL: z.string().url(),
  AGENT_PORT: z.coerce.number().default(3001),
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
});

function buildProviderManager(env: z.infer<typeof envSchema>): LLMProviderManager {
  // Always include Ollama as the ultimate fallback
  const ollama = new OllamaAdapter(env.OLLAMA_BASE_URL, env.OLLAMA_MODEL, env.OLLAMA_HEAVY_MODEL);
  const providers: Array<{ name: string; adapter: import('@emma/core/ports').ILLMAdapter; model?: string }> = [];

  // Add cloud providers in priority order
  if (env.GROQ_API_KEY) {
    providers.push({
      name: 'groq',
      // Groq SDK default base URL is https://api.groq.com — do NOT add /openai/v1 (it's appended internally)
      adapter: new OpenAICompatibleAdapter(env.GROQ_API_KEY, env.GROQ_MODEL, 'https://api.groq.com', 'groq'),
      model: env.GROQ_MODEL,
    });
  }

  // OpenCode Zen: endpoint OpenAI-compatible en /zen/v1/ con modelos free.
  // El primario conserva el nombre 'opencode' (ModelService lo usa al seleccionar desde el catálogo);
  // los demás modelos gratis se añaden como eslabones de fallback 'opencode:<modelo>'.
  if (env.OPENCODE_API_KEY) {
    providers.push({
      name: 'opencode',
      adapter: new OpenAICompatibleAdapter(env.OPENCODE_API_KEY, env.OPENCODE_MODEL, 'https://opencode.ai', 'opencode', '/zen/v1/'),
      model: env.OPENCODE_MODEL,
    });
    for (const model of env.OPENCODE_MODELS.split(',').map((m) => m.trim()).filter(Boolean)) {
      if (model === env.OPENCODE_MODEL) continue; // el primario ya está
      providers.push({
        name: `opencode:${model}`,
        adapter: new OpenAICompatibleAdapter(env.OPENCODE_API_KEY, model, 'https://opencode.ai', 'opencode', '/zen/v1/'),
        model,
      });
    }
  }

  // OpenRouter: cada modelo gratis es un proveedor independiente en la cadena de fallback
  if (env.OPENROUTER_API_KEY) {
    for (const model of env.OPENROUTER_MODELS.split(',').map((m) => m.trim()).filter(Boolean)) {
      providers.push({
        name: `openrouter:${model}`,
        adapter: buildOpenRouterAdapter(env.OPENROUTER_API_KEY, model),
        model,
      });
    }
  }

  if (env.ANTHROPIC_API_KEY) {
    providers.push({ name: 'anthropic', adapter: new ClaudeAdapter(env.ANTHROPIC_API_KEY) });
  }

  if (env.OPENAI_API_KEY) {
    providers.push({
      name: 'openai',
      // OpenAI SDK base URL includes /v1 — groq-sdk will append /chat/completions
      adapter: new OpenAICompatibleAdapter(env.OPENAI_API_KEY, env.OPENAI_MODEL, 'https://api.openai.com/v1', 'openai'),
    });
  }

  // Ollama is always last (free, local, unlimited)
  providers.push({ name: 'ollama', adapter: ollama, model: env.OLLAMA_MODEL });

  const manager = new LLMProviderManager(providers);
  logger.info({ provider: manager.currentProviderName, totalProviders: providers.length }, 'LLM initialized');
  return manager;
}

async function main() {
  const env = loadConfig(envSchema);
  // Tras cargar el .env propio, blindar el runtime: ninguna herramienta (ni forjada) podrá
  // ya leer archivos secreto ni volcar el entorno, pase como pase construida la ruta/comando.
  installRuntimeSecretGuard();
  const llm = buildProviderManager(env);

  const db = createDb(env.DATABASE_URL);
  const redis = new Redis(env.REDIS_URL);
  redis.on('error', (err) => logger.error({ err }, 'Redis error'));

  const conversationRepo = new ConversationRepository(db);
  const memoryRepo = new MemoryRepository(db);
  const sessionStore = new RedisSessionStore(redis);
  const embedding = env.VOYAGE_API_KEY
    ? new VoyageEmbeddingAdapter(env.VOYAGE_API_KEY)
    : new NullEmbeddingAdapter();

  const { registry: toolRegistry, mcp } = await buildSkillRegistry(undefined, memoryRepo);

  const runConversation = new RunConversation(
    llm,
    sessionStore,
    conversationRepo,
    memoryRepo,
    embedding,
    toolRegistry,
  );

  const MODEL_PERSIST_KEY = 'emma:llm:primary';
  const modelService = new ModelService(llm, {
    groq: env.GROQ_API_KEY,
    openrouter: env.OPENROUTER_API_KEY,
    anthropic: env.ANTHROPIC_API_KEY,
    openai: env.OPENAI_API_KEY,
    opencode: env.OPENCODE_API_KEY,
    ollamaBaseUrl: env.OLLAMA_BASE_URL,
  }, (model) => {
    void redis.set(MODEL_PERSIST_KEY, model).catch((err) => logger.warn({ err }, 'Could not persist model selection'));
  });

  // Restaurar la última selección de modelo tras un reinicio
  try {
    const savedModel = await redis.get(MODEL_PERSIST_KEY);
    if (savedModel) {
      const restored = modelService.select(savedModel);
      logger.info({ savedModel, ok: restored.ok }, 'Restored persisted model selection');
    }
  } catch (err) {
    logger.warn({ err }, 'Could not restore persisted model selection');
  }

  const server = await buildServer({ runConversation, skillRegistry: toolRegistry, modelService, conversationRepo, port: env.AGENT_PORT });

  const shutdown = async () => {
    logger.info('Shutting down agent...');
    await Promise.allSettled([server.stop(), redis.quit(), mcp.disconnectAll()]);
    process.exit(0);
  };

  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);

  await server.start();
}

class NullEmbeddingAdapter {
  readonly dimensions = 1024;
  async embed(_text: string): Promise<number[]> { return new Array(1024).fill(0) as number[]; }
  async embedBatch(texts: string[]): Promise<number[][]> { return texts.map(() => new Array(1024).fill(0) as number[]); }
}

main().catch((err) => {
  logger.error({ err }, 'Fatal error starting agent');
  process.exit(1);
});