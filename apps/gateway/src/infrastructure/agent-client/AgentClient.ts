import { createLogger } from '@emma/shared/logger';

const logger = createLogger('AgentClient');

export interface ChatRequest {
  sessionId: string;
  userId: string;
  message: string;
}

export class AgentClient {
  constructor(private readonly baseUrl: string) {}

  async getSkills(): Promise<unknown> {
    const res = await fetch(`${this.baseUrl}/skills`);
    if (!res.ok) throw new Error(`Agent error ${res.status}: ${await res.text()}`);
    return res.json();
  }

  async getModels(): Promise<unknown> {
    const res = await fetch(`${this.baseUrl}/models`);
    if (!res.ok) throw new Error(`Agent error ${res.status}: ${await res.text()}`);
    return res.json();
  }

  async selectModel(model: string): Promise<unknown> {
    const res = await fetch(`${this.baseUrl}/models/select`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model }),
    });
    const body = (await res.json()) as Record<string, unknown>;
    if (!res.ok) throw new Error((body['error'] as string) ?? `Agent error ${res.status}`);
    return body;
  }

  async getConversations(limit?: number): Promise<unknown> {
    const res = await fetch(`${this.baseUrl}/conversations${limit ? `?limit=${limit}` : ''}`);
    if (!res.ok) throw new Error(`Agent error ${res.status}: ${await res.text()}`);
    return res.json();
  }

  async getConversationMessages(id: string): Promise<unknown> {
    const res = await fetch(`${this.baseUrl}/conversations/${encodeURIComponent(id)}/messages`);
    if (!res.ok) throw new Error(`Agent error ${res.status}: ${await res.text()}`);
    return res.json();
  }

  async *streamChat(req: ChatRequest, signal: AbortSignal): AsyncIterable<string> {
    const response = await fetch(`${this.baseUrl}/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(req),
      signal,
    });

    if (!response.ok) {
      const err = await response.text();
      throw new Error(`Agent error ${response.status}: ${err}`);
    }

    const reader = response.body?.getReader();
    if (!reader) throw new Error('No response body');

    const decoder = new TextDecoder();
    let buffer = '';

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';

        for (const line of lines) {
          if (line.startsWith('data: ')) {
            yield line.slice(6);
          }
        }
      }
    } finally {
      reader.releaseLock();
    }
  }
}
