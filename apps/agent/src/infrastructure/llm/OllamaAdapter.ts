import type { ILLMAdapter, LLMStreamEvent, LLMCompletionOptions } from '@emma/core/ports';
import type { Message } from '@emma/core/entities';

interface OllamaChatMessage {
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: string;
  tool_calls?: Array<{ function: { name: string; arguments: Record<string, unknown> } }>;
  tool_call_id?: string;
}

interface OllamaTool {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

interface OllamaStreamChunk {
  message?: {
    role?: string;
    content?: string;
    tool_calls?: Array<{
      id?: string;
      function: { name: string; arguments: Record<string, unknown> };
    }>;
  };
  done: boolean;
}

// Charla trivial (saludos, agradecimientos, confirmaciones cortas): no necesita el modelo fuerte.
// Tolera signos iniciales (¿¡), acentos y un vocativo final ("emma"/"señor"). El ancla $ asegura
// que TODO el mensaje sea trivial: "hola emma, mándame el correo" NO matchea → va al modelo fuerte.
const TRIVIAL_RE =
  /^[¿¡\s]*(?:hola|buen[oa]s(?:\s*(?:d[ií]as|tardes|noches))?|hey|qu[eé]\s*tal|saludos|(?:muchas\s*)?gracias|ok|okay|vale|listo|perfecto|genial|de acuerdo|entendido|adi[oó]s|chao|hasta luego|c[oó]mo\s*est[aá]s|qu[eé]\s*haces|bien|s[ií]|no|claro|dale|jaja+|jeje+)(?:[\s,]+(?:emma|emmita|se[ñn]or))*[\s!?.,]*$/i;

export class OllamaAdapter implements ILLMAdapter {
  /**
   * Piso local ESCALONADO: `model` (rápido, p.ej. llama3.2:1b) para charla trivial, y
   * `heavyModel` (p.ej. qwen2.5:3b, mejor con herramientas y razonamiento) para tareas reales o
   * cuando estamos en medio de un bucle de herramientas. Si `heavyModel` no se define (selección
   * manual de un modelo concreto), se usa siempre `model`.
   */
  constructor(
    private readonly baseUrl: string = 'http://localhost:11434',
    private readonly model: string = 'qwen2.5:7b',
    private readonly heavyModel?: string,
  ) {}

  /** Elige el modelo local según la complejidad del turno. */
  #pickModel(messages: Message[], options: LLMCompletionOptions): string {
    if (!this.heavyModel || this.heavyModel === this.model) return this.model;
    // En medio de un bucle de herramientas (el último mensaje es un resultado de tool): modelo fuerte.
    const last = messages[messages.length - 1];
    if (last?.role === 'tool') return this.heavyModel;
    // Sin herramientas disponibles y mensaje trivial → modelo rápido.
    const lastUser = [...messages].reverse().find((m) => m.role === 'user');
    const text = (lastUser?.content ?? '').trim();
    const trivial = text.length <= 60 && TRIVIAL_RE.test(text);
    return trivial ? this.model : this.heavyModel;
  }

  async *stream(
    messages: Message[],
    options: LLMCompletionOptions,
  ): AsyncIterable<LLMStreamEvent> {
    const ollamaMessages = this.#toOllamaMessages(messages, options.systemPrompt);
    const tools = options.tools?.map(this.#toOllamaTool);
    const model = this.#pickModel(messages, options);

    const response = await fetch(`${this.baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        messages: ollamaMessages,
        tools: tools?.length ? tools : undefined,
        stream: true,
        keep_alive: '30m', // mantener el modelo en RAM: piso local instantáneo entre turnos
        options: { temperature: 0.7, num_ctx: 8192 },
      }),
      signal: options.signal,
    });

    if (!response.ok) {
      throw new Error(`Ollama error ${response.status}: ${await response.text()}`);
    }

    const reader = response.body?.getReader();
    if (!reader) throw new Error('No response body from Ollama');

    const decoder = new TextDecoder();
    let buffer = '';
    let pendingToolCalls: Array<{ id: string; name: string; input: Record<string, unknown> }> = [];

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';

        for (const line of lines) {
          if (!line.trim()) continue;
          let chunk: OllamaStreamChunk;
          try {
            chunk = JSON.parse(line) as OllamaStreamChunk;
          } catch {
            continue;
          }

          const msg = chunk.message;
          if (msg?.content) {
            yield { type: 'text_delta', text: msg.content };
          }

          if (msg?.tool_calls?.length) {
            for (const tc of msg.tool_calls) {
              const id = tc.id ?? crypto.randomUUID();
              const name = tc.function.name;
              const input = tc.function.arguments;
              pendingToolCalls.push({ id, name, input });
              yield { type: 'tool_use_start', toolCallId: id, toolName: name };
              yield { type: 'tool_use_end', toolCallId: id, toolName: name, toolInput: input };
            }
          }

          if (chunk.done) {
            yield { type: 'message_stop' };
          }
        }
      }
    } finally {
      reader.releaseLock();
    }
  }

  async complete(messages: Message[], options: LLMCompletionOptions): Promise<string> {
    const ollamaMessages = this.#toOllamaMessages(messages, options.systemPrompt);

    const response = await fetch(`${this.baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: this.#pickModel(messages, options),
        messages: ollamaMessages,
        stream: false,
        keep_alive: '30m',
      }),
    });

    if (!response.ok) throw new Error(`Ollama error ${response.status}`);
    const data = (await response.json()) as { message?: { content?: string } };
    return data.message?.content ?? '';
  }

  #toOllamaMessages(messages: Message[], systemPrompt?: string): OllamaChatMessage[] {
    const result: OllamaChatMessage[] = [];
    if (systemPrompt) {
      result.push({ role: 'system', content: systemPrompt });
    }
    for (const msg of messages) {
      if (msg.role === 'user') {
        result.push({ role: 'user', content: msg.content });
      } else if (msg.role === 'assistant') {
        if (msg.toolCall) {
          result.push({
            role: 'assistant',
            content: msg.content,
            tool_calls: [{
              function: { name: msg.toolCall.name, arguments: msg.toolCall.input },
            }],
          });
        } else {
          result.push({ role: 'assistant', content: msg.content });
        }
      } else if (msg.role === 'tool' && msg.toolResult) {
        result.push({
          role: 'tool',
          content: msg.toolResult.output,
          tool_call_id: msg.toolResult.toolCallId,
        });
      }
    }
    return result;
  }

  #toOllamaTool(tool: { name: string; description: string; inputSchema: Record<string, unknown> }): OllamaTool {
    return {
      type: 'function',
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.inputSchema,
      },
    };
  }
}
