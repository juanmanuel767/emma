import { useState, useCallback, useRef } from 'react';
import { streamChat, saveSettings, type StreamEvent } from '../services/api.js';

// Paridad con el bot de Telegram: una clave API pegada en el chat se guarda en
// Integraciones sin pasar por el LLM. El orden importa (sk-or- antes que sk-).
const KEY_PATTERNS: Array<{ re: RegExp; envKey: string; label: string }> = [
  { re: /\b\d+:[A-Za-z0-9_-]{30,}\b/, envKey: 'TELEGRAM_BOT_TOKEN', label: 'Telegram' },
  { re: /\bgsk_[A-Za-z0-9_]{20,}\b/, envKey: 'GROQ_API_KEY', label: 'Groq' },
  { re: /\bsk-ant-[A-Za-z0-9_-]{20,}\b/, envKey: 'ANTHROPIC_API_KEY', label: 'Anthropic' },
  { re: /\bsk-or-[A-Za-z0-9_-]{20,}\b/, envKey: 'OPENROUTER_API_KEY', label: 'OpenRouter' },
  { re: /\bsk-(?!ant-|or-)[A-Za-z0-9_-]{20,}\b/, envKey: 'OPENAI_API_KEY', label: 'OpenAI' },
  { re: /\bpa-[A-Za-z0-9_-]{10,}\b/, envKey: 'VOYAGE_API_KEY', label: 'Voyage AI' },
  { re: /\b(?:ghp_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,})\b/, envKey: 'GH_TOKEN', label: 'GitHub' },
];

function detectApiKey(text: string): { envKey: string; label: string; key: string } | null {
  for (const p of KEY_PATTERNS) {
    const m = text.match(p.re);
    if (m) return { envKey: p.envKey, label: p.label, key: m[0] };
  }
  return null;
}

export type MessageRole = 'user' | 'assistant';

export interface ToolCallInfo {
  name: string;
  input?: Record<string, unknown>;
  result?: string;
}

export interface ChatMessage {
  id: string;
  role: MessageRole;
  content: string;
  toolCalls?: ToolCallInfo[];
  streaming?: boolean;
  /** Emma cayó al modelo LOCAL (cuotas cloud agotadas): la respuesta puede tardar más. */
  localMode?: boolean;
}

export function useChat(sessionId: string) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const sendMessage = useCallback(
    async (text: string) => {
      if (!text.trim() || isLoading) return;

      abortRef.current?.abort();
      abortRef.current = new AbortController();

      setError(null);

      // Clave API pegada en el chat → guardarla, no enviarla al modelo
      const detected = detectApiKey(text);
      if (detected) {
        const masked = `${detected.key.slice(0, 5)}…${detected.key.slice(-4)}`;
        const infoId = crypto.randomUUID();
        setMessages((prev) => [
          ...prev,
          { id: crypto.randomUUID(), role: 'user', content: `🔑 ${masked}` },
          { id: infoId, role: 'assistant', content: '', streaming: true },
        ]);
        setIsLoading(true);
        try {
          const res = await saveSettings({ [detected.envKey]: detected.key });
          const restartNote =
            res.restarted.length > 0 ? ` Reiniciando: ${res.restarted.join(', ')}.` : '';
          setMessages((prev) =>
            prev.map((m) =>
              m.id === infoId
                ? {
                    ...m,
                    streaming: false,
                    content: `Clave de ${detected.label} detectada y guardada en Integraciones, señor.${restartNote} La clave no se envió al modelo.`,
                  }
                : m,
            ),
          );
        } catch (err) {
          setMessages((prev) =>
            prev.map((m) =>
              m.id === infoId
                ? {
                    ...m,
                    streaming: false,
                    content: `No pude guardar la clave de ${detected.label}: ${(err as Error).message}`,
                  }
                : m,
            ),
          );
        } finally {
          setIsLoading(false);
        }
        return;
      }

      setIsLoading(true);

      const userMsg: ChatMessage = {
        id: crypto.randomUUID(),
        role: 'user',
        content: text,
      };

      const assistantId = crypto.randomUUID();
      const assistantMsg: ChatMessage = {
        id: assistantId,
        role: 'assistant',
        content: '',
        toolCalls: [],
        streaming: true,
      };

      setMessages((prev) => [...prev, userMsg, assistantMsg]);

      let currentToolCall: ToolCallInfo | null = null;

      try {
        for await (const event of streamChat(text, sessionId, abortRef.current.signal)) {
          setMessages((prev) =>
            prev.map((m) => {
              if (m.id !== assistantId) return m;
              return applyEvent(m, event, (tc) => { currentToolCall = tc; });
            }),
          );

          if (event.type === 'done') break;
        }
      } catch (err) {
        if ((err as Error).name !== 'AbortError') {
          const msg = (err as Error).message;
          // TypeError "Failed to fetch" = el gateway no respondió (caído o reiniciándose)
          setError(
            msg.includes('Failed to fetch') || msg.includes('NetworkError')
              ? 'No hay conexión con Emma — puede que el servicio se esté reiniciando. Inténtelo de nuevo en unos segundos.'
              : msg,
          );
        }
      } finally {
        setIsLoading(false);
        setMessages((prev) =>
          prev.map((m) => (m.id === assistantId ? { ...m, streaming: false } : m)),
        );
      }
    },
    [sessionId, isLoading],
  );

  const stopGeneration = useCallback(() => {
    abortRef.current?.abort();
    setIsLoading(false);
  }, []);

  const clearMessages = useCallback(() => {
    abortRef.current?.abort();
    setMessages([]);
    setError(null);
    setIsLoading(false);
  }, []);

  return { messages, isLoading, error, sendMessage, stopGeneration, clearMessages };
}

function applyEvent(
  msg: ChatMessage,
  event: StreamEvent,
  setCurrentTool: (tc: ToolCallInfo | null) => void,
): ChatMessage {
  if (event.type === 'text_delta' && event.text) {
    return { ...msg, content: msg.content + event.text };
  }
  if (event.type === 'tool_start' && event.toolName) {
    const tc: ToolCallInfo = { name: event.toolName, input: event.toolInput };
    setCurrentTool(tc);
    return { ...msg, toolCalls: [...(msg.toolCalls ?? []), tc] };
  }
  if (event.type === 'tool_end' && event.toolName && event.toolResult) {
    return {
      ...msg,
      toolCalls: (msg.toolCalls ?? []).map((tc) =>
        tc.name === event.toolName && !tc.result
          ? { ...tc, result: event.toolResult }
          : tc,
      ),
    };
  }
  // Failover SILENCIOSO: los saltos entre proveedores de nube no se muestran. Solo se marca el
  // modo LOCAL (Ollama), que es más lento, para que el chat no parezca colgado durante la espera.
  if (event.type === 'provider_switched' && event.toProvider === 'ollama') {
    return { ...msg, localMode: true };
  }
  return msg;
}
