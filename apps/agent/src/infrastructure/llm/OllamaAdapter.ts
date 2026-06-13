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

export class OllamaAdapter implements ILLMAdapter {
  constructor(
    private readonly baseUrl: string = 'http://localhost:11434',
    private readonly model: string = 'qwen2.5:7b',
  ) {}

  async *stream(
    messages: Message[],
    options: LLMCompletionOptions,
  ): AsyncIterable<LLMStreamEvent> {
    const ollamaMessages = this.#toOllamaMessages(messages, options.systemPrompt);
    const tools = options.tools?.map(this.#toOllamaTool);

    const response = await fetch(`${this.baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: this.model,
        messages: ollamaMessages,
        tools: tools?.length ? tools : undefined,
        stream: true,
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
        model: this.model,
        messages: ollamaMessages,
        stream: false,
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
