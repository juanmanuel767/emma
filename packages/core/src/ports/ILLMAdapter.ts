import type { Message } from '../entities/Message.js';

export interface LLMTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface LLMStreamEvent {
  type: 'text_delta' | 'tool_use_start' | 'tool_use_delta' | 'tool_use_end' | 'message_stop';
  text?: string;
  toolCallId?: string;
  toolName?: string;
  toolInput?: Record<string, unknown>;
}

export interface LLMCompletionOptions {
  model?: string;
  maxTokens?: number;
  systemPrompt?: string;
  tools?: LLMTool[];
  signal?: AbortSignal;
  /** Nombre de proveedor preferido para este turno (p.ej. 'anthropic' para tareas complejas).
   *  Si no existe o está en cooldown, se ignora y se usa el mejor disponible. */
  preferProvider?: string;
}

export interface ILLMAdapter {
  stream(
    messages: Message[],
    options: LLMCompletionOptions,
  ): AsyncIterable<LLMStreamEvent>;

  complete(
    messages: Message[],
    options: LLMCompletionOptions,
  ): Promise<string>;
}
