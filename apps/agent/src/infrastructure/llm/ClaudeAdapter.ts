import Anthropic from '@anthropic-ai/sdk';
import type { ILLMAdapter, LLMStreamEvent, LLMCompletionOptions, LLMTool } from '@emma/core/ports';
import type { Message } from '@emma/core/entities';
import { QuotaExhaustedError } from './QuotaExhaustedError.js';

const DEFAULT_MODEL = 'claude-sonnet-4-6';
const DEFAULT_MAX_TOKENS = 8192;

export class ClaudeAdapter implements ILLMAdapter {
  readonly #client: Anthropic;
  readonly #model: string;

  constructor(apiKey: string, model: string = DEFAULT_MODEL) {
    this.#client = new Anthropic({ apiKey });
    this.#model = model;
  }

  async *stream(messages: Message[], options: LLMCompletionOptions): AsyncIterable<LLMStreamEvent> {
    const anthropicMessages = messages.map(toAnthropicMessage).filter(Boolean) as Anthropic.MessageParam[];
    const tools = options.tools?.map(toAnthropicTool);

    let stream: Awaited<ReturnType<Anthropic['messages']['stream']>>;
    try {
      stream = this.#client.messages.stream({
        model: options.model ?? this.#model,
        max_tokens: options.maxTokens ?? DEFAULT_MAX_TOKENS,
        system: options.systemPrompt,
        messages: anthropicMessages,
        tools: tools?.length ? tools : undefined,
      });
    } catch (err) {
      this.#checkQuota(err);
      throw err;
    }

    try {
      for await (const event of stream) {
        if (event.type === 'content_block_delta') {
          if (event.delta.type === 'text_delta') {
            yield { type: 'text_delta', text: event.delta.text };
          } else if (event.delta.type === 'input_json_delta') {
            yield { type: 'tool_use_delta', text: event.delta.partial_json };
          }
        } else if (event.type === 'content_block_start') {
          if (event.content_block.type === 'tool_use') {
            yield {
              type: 'tool_use_start',
              toolCallId: event.content_block.id,
              toolName: event.content_block.name,
            };
          }
        } else if (event.type === 'content_block_stop') {
          const block = stream.currentMessage?.content?.[event.index];
          if (block?.type === 'tool_use') {
            yield {
              type: 'tool_use_end',
              toolCallId: block.id,
              toolName: block.name,
              toolInput: block.input as Record<string, unknown>,
            };
          }
        } else if (event.type === 'message_stop') {
          yield { type: 'message_stop' };
        }
      }
    } catch (err) {
      this.#checkQuota(err);
      throw err;
    }
  }

  async complete(messages: Message[], options: LLMCompletionOptions): Promise<string> {
    const anthropicMessages = messages.map(toAnthropicMessage).filter(Boolean) as Anthropic.MessageParam[];
    const response = await this.#client.messages.create({
      model: options.model ?? DEFAULT_MODEL,
      max_tokens: options.maxTokens ?? DEFAULT_MAX_TOKENS,
      system: options.systemPrompt,
      messages: anthropicMessages,
    });
    const textBlock = response.content.find((b) => b.type === 'text');
    return textBlock?.type === 'text' ? textBlock.text : '';
  }

  // CUALQUIER fallo de Claude debe tratarse como "no disponible" y disparar el failover a
  // los modelos gratuitos — NUNCA romper la conversación del señor. Cubre clave inválida
  // (401), sin crédito (402), prohibido (403), rate limit (429), sobrecarga (529), errores
  // de servidor (5xx), red/timeout… Así integrar Claude jamás puede romper lo que ya funciona.
  #checkQuota(err: unknown): void {
    const status = (err as { status?: number })?.status;
    const message = (err as { message?: string })?.message ?? String(err);
    throw new QuotaExhaustedError('anthropic', `Claude no disponible (${status ?? 'error'}): ${message.slice(0, 120)}`);
  }
}

function toAnthropicMessage(msg: Message): Anthropic.MessageParam | null {
  if (msg.role === 'user') return { role: 'user', content: msg.content };
  if (msg.role === 'assistant') return { role: 'assistant', content: msg.content };
  if (msg.role === 'tool' && msg.toolResult) {
    return {
      role: 'user',
      content: [{
        type: 'tool_result',
        tool_use_id: msg.toolResult.toolCallId,
        content: msg.toolResult.output,
        is_error: msg.toolResult.isError,
      }],
    };
  }
  return null;
}

function toAnthropicTool(tool: LLMTool): Anthropic.Tool {
  return {
    name: tool.name,
    description: tool.description,
    input_schema: tool.inputSchema as Anthropic.Tool['input_schema'],
  };
}
