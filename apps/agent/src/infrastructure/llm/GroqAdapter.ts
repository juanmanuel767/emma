import Groq from 'groq-sdk';
import type { ILLMAdapter, LLMStreamEvent, LLMCompletionOptions } from '@emma/core/ports';
import type { Message } from '@emma/core/entities';

type GroqMessage =
  | { role: 'system'; content: string }
  | { role: 'user'; content: string }
  | { role: 'assistant'; content: string | null; tool_calls?: Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }> }
  | { role: 'tool'; content: string; tool_call_id: string };

export class GroqAdapter implements ILLMAdapter {
  readonly #client: Groq;
  readonly #model: string;

  constructor(apiKey: string, model = 'meta-llama/llama-4-scout-17b-16e-instruct') {
    this.#client = new Groq({ apiKey });
    this.#model = model;
  }

  async *stream(messages: Message[], options: LLMCompletionOptions): AsyncIterable<LLMStreamEvent> {
    const groqMessages = this.#toGroqMessages(messages, options.systemPrompt);
    const tools = options.tools?.map(this.#toGroqTool);

    const stream = await this.#client.chat.completions.create(
      {
        model: this.#model,
        messages: groqMessages,
        tools: tools?.length ? tools : undefined,
        tool_choice: tools?.length ? 'auto' : undefined,
        parallel_tool_calls: false,
        stream: true,
        temperature: 0.7,
        max_tokens: 4096,
      },
      { signal: options.signal },
    );

    // Accumulate tool call deltas across chunks
    const toolCallBuffers: Record<number, { id: string; name: string; args: string }> = {};

    for await (const chunk of stream) {
      const delta = chunk.choices[0]?.delta;
      if (!delta) continue;

      if (delta.content) {
        yield { type: 'text_delta', text: delta.content };
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

      if (chunk.choices[0]?.finish_reason === 'tool_calls' || chunk.choices[0]?.finish_reason === 'stop') {
        // Emit completed tool calls
        for (const [, buf] of Object.entries(toolCallBuffers)) {
          let input: Record<string, unknown> = {};
          try {
            const parsed = JSON.parse(buf.args || '{}');
            input = (parsed !== null && typeof parsed === 'object') ? parsed as Record<string, unknown> : {};
          } catch { /* use empty object */ }
          yield { type: 'tool_use_end', toolCallId: buf.id, toolName: buf.name, toolInput: input };
        }
        yield { type: 'message_stop' };
      }
    }
  }

  async complete(messages: Message[], options: LLMCompletionOptions): Promise<string> {
    const groqMessages = this.#toGroqMessages(messages, options.systemPrompt);
    const response = await this.#client.chat.completions.create({
      model: this.#model,
      messages: groqMessages,
      stream: false,
    });
    return response.choices[0]?.message?.content ?? '';
  }

  #toGroqMessages(messages: Message[], systemPrompt?: string): GroqMessage[] {
    const result: GroqMessage[] = [];
    if (systemPrompt) result.push({ role: 'system', content: systemPrompt });

    for (const msg of messages) {
      if (msg.role === 'user') {
        result.push({ role: 'user', content: msg.content });
      } else if (msg.role === 'assistant') {
        if (msg.toolCall) {
          result.push({
            role: 'assistant',
            content: msg.content || null,
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

  #toGroqTool(tool: { name: string; description: string; inputSchema: Record<string, unknown> }) {
    return {
      type: 'function' as const,
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.inputSchema,
      },
    };
  }
}
