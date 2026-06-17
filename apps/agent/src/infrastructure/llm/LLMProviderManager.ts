import type { ILLMAdapter, LLMStreamEvent, LLMCompletionOptions } from '@emma/core/ports';
import type { Message } from '@emma/core/entities';
import { QuotaExhaustedError } from './QuotaExhaustedError.js';
import { createLogger } from '@emma/shared/logger';

const logger = createLogger('LLMProviderManager');

export interface ProviderEntry {
  name: string;
  adapter: ILLMAdapter;
  /** Model id served by this provider (informational, for the UI) */
  model?: string;
}

export interface ProviderStatus {
  name: string;
  model?: string;
  active: boolean;
  exhausted: boolean;
  priority: number;
}

/**
 * Manages multiple LLM providers with automatic fallback.
 * Priority order: providers[0] → ... → ollama (always last)
 */
const COOLDOWN_MS = 5 * 60_000; // tras un rate-limit, esperar 5 min antes de re-probar (evita
                                // re-descubrir toda la cascada de agotados cada minuto)
const DAILY_COOLDOWN_MS = 60 * 60_000; // límite DIARIO agotado: no insistir cada minuto

export class LLMProviderManager implements ILLMAdapter {
  #providers: ProviderEntry[];
  #currentIndex = 0;
  // proveedor → timestamp hasta el que se considera agotado (cooldown)
  #exhaustedUntil = new Map<string, number>();

  constructor(providers: ProviderEntry[]) {
    if (providers.length === 0) throw new Error('At least one provider required');
    this.#providers = [...providers];
  }

  #isExhausted(name: string): boolean {
    const until = this.#exhaustedUntil.get(name);
    if (until === undefined) return false;
    if (Date.now() >= until) { this.#exhaustedUntil.delete(name); return false; }
    return true;
  }

  /** Selecciona el proveedor disponible de mayor prioridad (índice más bajo no en cooldown). */
  #pickBestAvailable(): number {
    for (let i = 0; i < this.#providers.length; i++) {
      if (!this.#isExhausted(this.#providers[i]!.name)) return i;
    }
    // Todos en cooldown → usar ollama si existe, si no el primero
    const ollamaIdx = this.#providers.findIndex((p) => p.name === 'ollama');
    return ollamaIdx >= 0 ? ollamaIdx : 0;
  }

  get currentProviderName(): string {
    return this.#providers[this.#currentIndex]?.name ?? 'unknown';
  }

  /** Snapshot of all providers in priority order, with cooldown state. */
  listProviders(): ProviderStatus[] {
    return this.#providers.map((p, i) => ({
      name: p.name,
      model: p.model,
      active: i === this.#currentIndex,
      exhausted: this.#isExhausted(p.name),
      priority: i,
    }));
  }

  /** Move an existing provider to the top priority. Returns false if not found. */
  makePrimary(name: string): boolean {
    const idx = this.#providers.findIndex((p) => p.name === name);
    if (idx < 0) return false;
    const [entry] = this.#providers.splice(idx, 1);
    this.#providers.unshift(entry!);
    this.#exhaustedUntil.delete(name);
    this.#currentIndex = 0;
    logger.info({ provider: name }, 'Provider promoted to primary');
    return true;
  }

  /** Swap in a new provider at runtime (e.g. user sent a new API key). */
  setProvider(name: string, adapter: ILLMAdapter, makePrimary = true, model?: string): void {
    const existing = this.#providers.findIndex((p) => p.name === name);
    if (existing >= 0) {
      this.#providers[existing] = { name, adapter, model };
    } else {
      const ollamaIdx = this.#providers.findIndex((p) => p.name === 'ollama');
      const insertAt = ollamaIdx >= 0 ? ollamaIdx : this.#providers.length;
      this.#providers.splice(insertAt, 0, { name, adapter, model });
    }
    this.#exhaustedUntil.delete(name);
    if (makePrimary) {
      this.#currentIndex = this.#providers.findIndex((p) => p.name === name);
    }
    logger.info({ provider: name, makePrimary }, 'Provider updated');
  }

  async *stream(messages: Message[], options: LLMCompletionOptions): AsyncIterable<LLMStreamEvent> {
    // Al iniciar cada turno, volver al mejor proveedor disponible (Groq se recupera tras el cooldown).
    // Si el turno pide un proveedor concreto (p.ej. 'anthropic' para razonar) y está disponible, usarlo.
    const preferred = options.preferProvider;
    const preferredIdx = preferred ? this.#providers.findIndex((p) => p.name === preferred) : -1;
    this.#currentIndex =
      preferredIdx >= 0 && !this.#isExhausted(preferred!)
        ? preferredIdx
        : this.#pickBestAvailable();

    while (this.#currentIndex < this.#providers.length) {
      const entry = this.#providers[this.#currentIndex];
      if (!entry) break;
      const { name, adapter } = entry;

      try {
        yield* adapter.stream(messages, options);
        return;
      } catch (err) {
        if (!(err instanceof QuotaExhaustedError)) throw err;

        const exhaustedName = name;
        const isDailyLimit = /per.?day|daily/i.test((err as Error).message);
        const cooldown = isDailyLimit ? DAILY_COOLDOWN_MS : COOLDOWN_MS;
        this.#exhaustedUntil.set(exhaustedName, Date.now() + cooldown);

        // El límite diario de OpenRouter es por CUENTA: si un modelo :free lo agota,
        // todos los demás openrouter:* están igual de muertos — no quemar requests probándolos.
        if (isDailyLimit && exhaustedName.startsWith('openrouter:')) {
          for (const p of this.#providers) {
            if (p.name.startsWith('openrouter:')) {
              this.#exhaustedUntil.set(p.name, Date.now() + cooldown);
            }
          }
        }

        logger.warn({ provider: exhaustedName, cooldownMs: cooldown, isDailyLimit }, 'Quota/rate-limit hit, switching provider (will retry after cooldown)');

        // Mejor proveedor disponible globalmente (no solo hacia abajo): así, si falla
        // un proveedor preferido como Anthropic, se recupera la cadena normal (opencode/groq…).
        const fallbackIdx = this.#pickBestAvailable();

        if (fallbackIdx === this.#currentIndex) {
          throw new Error(`All LLM providers exhausted. Last error: ${(err as Error).message}`);
        }

        this.#currentIndex = fallbackIdx;
        const nextEntry = this.#providers[this.#currentIndex];
        const nextName = nextEntry?.name ?? 'ollama';

        // Emit switch event (type cast needed since LLMStreamEvent union doesn't include this type)
        yield {
          type: 'provider_switched' as LLMStreamEvent['type'],
          fromProvider: exhaustedName,
          toProvider: nextName,
        } as LLMStreamEvent & { fromProvider: string; toProvider: string };

        // Retry with new provider
        continue;
      }
    }
  }

  async complete(messages: Message[], options: LLMCompletionOptions): Promise<string> {
    const entry = this.#providers[this.#currentIndex];
    if (!entry) throw new Error('No LLM provider available');
    return entry.adapter.complete(messages, options);
  }
}
