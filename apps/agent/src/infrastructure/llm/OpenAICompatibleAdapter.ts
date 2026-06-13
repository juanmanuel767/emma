import Groq from 'groq-sdk';
import type { ILLMAdapter, LLMStreamEvent, LLMCompletionOptions } from '@emma/core/ports';
import type { Message } from '@emma/core/entities';
import { QuotaExhaustedError } from './QuotaExhaustedError.js';

type OAIMessage =
  | { role: 'system'; content: string }
  | { role: 'user'; content: string }
  | { role: 'assistant'; content: string | null; reasoning_content?: string; tool_calls?: Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }> }
  | { role: 'tool'; content: string; tool_call_id: string };

// Works with any OpenAI-compatible API: Groq, OpenAI, Together, Mistral, etc.
export class OpenAICompatibleAdapter implements ILLMAdapter {
  readonly #client: Groq;
  readonly #model: string;
  readonly #providerName: string;

  constructor(
    apiKey: string,
    model: string,
    baseURL = 'https://api.groq.com/openai/v1',
    providerName = 'groq',
    // groq-sdk hardcodes paths under /openai/v1/ — pass e.g. '/api/v1/' for OpenRouter
    apiPathPrefix?: string,
  ) {
    const fetchOverride = apiPathPrefix
      ? (url: string | URL | Request, init?: RequestInit) =>
          fetch(String(url).replace('/openai/v1/', apiPathPrefix), init)
      : undefined;
    // maxRetries: 0 — un 429 debe disparar el failover al siguiente proveedor de inmediato,
    // no esperar los reintentos del SDK (que respetan Retry-After de hasta 30s cada uno)
    this.#client = new Groq({ apiKey, baseURL, maxRetries: 0, timeout: 90_000, ...(fetchOverride ? { fetch: fetchOverride as typeof fetch } : {}) });
    this.#model = model;
    this.#providerName = providerName;
  }

  get model(): string {
    return this.#model;
  }

  async *stream(messages: Message[], options: LLMCompletionOptions): AsyncIterable<LLMStreamEvent> {
    const oaiMessages = this.#toOAIMessages(messages, options.systemPrompt);
    const tools = options.tools?.map(this.#toOAITool);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let streamObj: any;
    try {
      streamObj = await this.#client.chat.completions.create(
        {
          model: this.#model,
          messages: oaiMessages,
          tools: tools?.length ? tools : undefined,
          tool_choice: tools?.length ? 'auto' : undefined,
          parallel_tool_calls: false,
          stream: true,
          temperature: 0.7,
          max_tokens: 4096,
        },
        { signal: options.signal },
      );
    } catch (err) {
      this.#handleApiError(err);
      throw err;
    }

    const toolCallBuffers: Record<number, { id: string; name: string; args: string }> = {};

    // Algunos modelos (DeepSeek y otros gratuitos) a veces emiten la llamada a herramienta
    // como TEXTO en vez de como tool_call estructurado (formato "DSML"/"invoke name=...").
    // Detectamos ese patrón, ocultamos el galimatías al usuario y lo convertimos en una
    // llamada real. Mantenemos una ventana de retención por si el marcador llega fragmentado.
    const FAKE_START = /<｜|<\||｜｜DSML｜｜|DSML｜｜|tool▁call|<tool_call|invoke name=|<function/i;
    let textBuf = '';
    let emittedLen = 0;
    let inFake = false;
    let fakeBuf = '';
    const toolList = options.tools;

    try {
      for await (const chunk of streamObj as AsyncIterable<{ choices: Array<{ delta?: { content?: string | null; tool_calls?: Array<{ index: number; id?: string; function?: { name?: string; arguments?: string } }>; }; finish_reason?: string | null }> }>) {
        const delta = chunk.choices[0]?.delta;
        if (!delta) continue;

        if (delta.content) {
          if (inFake) {
            fakeBuf += delta.content;
          } else {
            textBuf += delta.content;
            const markerIdx = textBuf.search(FAKE_START);
            if (markerIdx >= 0) {
              if (markerIdx > emittedLen) yield { type: 'text_delta', text: textBuf.slice(emittedLen, markerIdx) };
              inFake = true;
              fakeBuf = textBuf.slice(markerIdx);
              emittedLen = textBuf.length;
            } else {
              // retener los últimos chars por si el marcador llega partido entre deltas
              const safeLen = Math.max(emittedLen, textBuf.length - 12);
              if (safeLen > emittedLen) { yield { type: 'text_delta', text: textBuf.slice(emittedLen, safeLen) }; emittedLen = safeLen; }
            }
          }
        }

        if (delta.tool_calls) {
          for (const tc of delta.tool_calls) {
            const idx = tc.index;
            if (!toolCallBuffers[idx]) {
              toolCallBuffers[idx] = { id: tc.id ?? '', name: tc.function?.name ?? '', args: '' };
              yield { type: 'tool_use_start', toolCallId: toolCallBuffers[idx].id, toolName: toolCallBuffers[idx].name };
            }
            if (tc.id && !toolCallBuffers[idx].id) toolCallBuffers[idx].id = tc.id;
            if (tc.function?.name) toolCallBuffers[idx].name = tc.function.name;
            if (tc.function?.arguments) toolCallBuffers[idx].args += tc.function.arguments;
          }
        }

        const finishReason = chunk.choices[0]?.finish_reason;
        if (finishReason === 'tool_calls' || finishReason === 'stop') {
          // emitir el remanente de texto limpio (si no estábamos en modo fake)
          if (!inFake && emittedLen < textBuf.length) {
            yield { type: 'text_delta', text: textBuf.slice(emittedLen) };
            emittedLen = textBuf.length;
          }

          for (const buf of Object.values(toolCallBuffers)) {
            let input: Record<string, unknown> = {};
            try {
              const parsed = JSON.parse(buf.args || '{}');
              input = (parsed !== null && typeof parsed === 'object') ? parsed as Record<string, unknown> : {};
            } catch { /* use empty object */ }
            yield { type: 'tool_use_end', toolCallId: buf.id, toolName: buf.name, toolInput: input };
          }

          // Recuperar las llamadas que el modelo escribió como texto
          if (inFake) {
            for (const call of this.#parseFakeToolCalls(fakeBuf, toolList)) {
              const id = crypto.randomUUID();
              yield { type: 'tool_use_start', toolCallId: id, toolName: call.name };
              yield { type: 'tool_use_end', toolCallId: id, toolName: call.name, toolInput: call.input };
            }
          }
          yield { type: 'message_stop' };
        }
      }
    } catch (err) {
      this.#handleApiError(err);
      throw err;
    }
  }

  // Parsea llamadas a herramienta que el modelo emitió como texto (formato "invoke/parameter")
  // y mapea el nombre abreviado a la herramienta real disponible (p.ej. read_chat → whatsapp_read_chat).
  #parseFakeToolCalls(
    buf: string,
    tools?: Array<{ name: string }>,
  ): Array<{ name: string; input: Record<string, unknown> }> {
    const calls: Array<{ name: string; input: Record<string, unknown> }> = [];
    const blocks = buf.split(/invoke\s+name=/i).slice(1);
    for (const block of blocks) {
      const nameM = block.match(/^[">\s｜|]*"?([\w-]+)"?/);
      if (!nameM) continue;
      let name = nameM[1]!;
      if (tools?.length) {
        const exact = tools.find((t) => t.name === name);
        const fuzzy = tools.find((t) => t.name.includes(name) || name.includes(t.name));
        name = (exact ?? fuzzy)?.name ?? name;
      }
      const input: Record<string, unknown> = {};
      const paramRe = /parameter\s+name="([\w-]+)"[^>]*>([\s\S]*?)<\/[^>]*?parameter>/gi;
      let pm: RegExpExecArray | null;
      while ((pm = paramRe.exec(block)) !== null) {
        const val = pm[2]!.replace(/<\/?[^>]*>/g, '').trim();
        input[pm[1]!] = /^-?\d+$/.test(val) ? Number(val) : val;
      }
      calls.push({ name, input });
    }
    return calls;
  }

  async complete(messages: Message[], options: LLMCompletionOptions): Promise<string> {
    const oaiMessages = this.#toOAIMessages(messages, options.systemPrompt);
    const response = await this.#client.chat.completions.create({
      model: this.#model,
      messages: oaiMessages,
      stream: false,
    });
    return (response as { choices: Array<{ message?: { content?: string } }> }).choices[0]?.message?.content ?? '';
  }

  #handleApiError(err: unknown): void {
    if (err && typeof err === 'object') {
      const status = (err as { status?: number }).status;
      const message = (err as { message?: string }).message ?? '';
      // 429 = rate limit / quota exhausted; 402 = out of credits (OpenRouter); 413 = request too large (also a quota signal)
      if (status === 429 || status === 402 || (status === 413 && message.includes('rate_limit'))) {
        throw new QuotaExhaustedError(this.#providerName, message);
      }
      // Tool call malformado generado por el modelo (error estocástico) — saltar al siguiente
      // proveedor en lugar de devolver el error al usuario
      if (status === 400 && (message.includes('tool_use_failed') || message.includes('Failed to call a function'))) {
        throw new QuotaExhaustedError(this.#providerName, `tool call malformado: ${message.slice(0, 120)}`);
      }
    }
  }

  #toOAIMessages(messages: Message[], systemPrompt?: string): OAIMessage[] {
    const result: OAIMessage[] = [];
    if (systemPrompt) result.push({ role: 'system', content: systemPrompt });
    for (const msg of messages) {
      if (msg.role === 'user') {
        result.push({ role: 'user', content: msg.content });
      } else if (msg.role === 'assistant') {
        if (msg.toolCall) {
          result.push({
            role: 'assistant',
            content: msg.content || null,
            // DeepSeek (vía OpenCode Zen) en thinking mode exige que reasoning_content
            // vuelva en el replay; un string vacío satisface la validación
            ...(this.#providerName === 'opencode' ? { reasoning_content: '' } : {}),
            tool_calls: [{
              id: msg.toolCall.id ?? crypto.randomUUID(),
              type: 'function',
              function: { name: msg.toolCall.name, arguments: JSON.stringify(msg.toolCall.input) },
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

  #toOAITool(tool: { name: string; description: string; inputSchema: Record<string, unknown> }) {
    return {
      type: 'function' as const,
      function: { name: tool.name, description: tool.description, parameters: tool.inputSchema },
    };
  }
}
