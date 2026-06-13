export interface ChatStreamEvent {
  type: string;
  text?: string;
  toolName?: string;
  toolInput?: Record<string, unknown>;
  toolResult?: string;
  error?: string;
  sessionId?: string;
  fromProvider?: string;
  toProvider?: string;
}

export interface ChatRequest {
  sessionId: string;
  userId: string;
  message: string;
}

export interface ProviderStatus {
  name: string;
  model?: string;
  active: boolean;
  exhausted: boolean;
  priority: number;
}

export interface ModelsInfo {
  current: string;
  providers: ProviderStatus[];
  catalog: Array<{ id: string; name: string; contextLength: number }>;
}

export class GatewayClient {
  constructor(private readonly baseUrl: string) {}

  async getModels(): Promise<ModelsInfo> {
    const res = await fetch(`${this.baseUrl}/models`, { signal: AbortSignal.timeout(15_000) });
    if (!res.ok) throw new Error(`Gateway error ${res.status}`);
    return res.json() as Promise<ModelsInfo>;
  }

  async selectModel(model: string): Promise<{ ok: boolean; current: string }> {
    const res = await fetch(`${this.baseUrl}/models/select`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model }),
      signal: AbortSignal.timeout(15_000),
    });
    const body = (await res.json()) as { ok?: boolean; current?: string; error?: string };
    if (!res.ok) throw new Error(body.error ?? `Gateway error ${res.status}`);
    return { ok: body.ok ?? false, current: body.current ?? '' };
  }

  async *streamChat(req: ChatRequest): AsyncIterable<ChatStreamEvent> {
    const response = await fetch(`${this.baseUrl}/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: req.sessionId, message: req.message }),
      signal: AbortSignal.timeout(120_000),
    });

    if (!response.ok) {
      throw new Error(`Gateway error ${response.status}`);
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
            try {
              yield JSON.parse(line.slice(6)) as ChatStreamEvent;
            } catch {
              // Skip malformed lines
            }
          }
        }
      }
    } finally {
      reader.releaseLock();
    }
  }
}
