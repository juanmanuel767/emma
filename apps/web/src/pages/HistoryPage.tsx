import { useEffect, useState } from 'react';
import {
  fetchConversations,
  fetchConversationMessages,
  type ConversationSummary,
  type ConversationMessage,
} from '../services/api.js';

function sourceOf(sessionId: string): { icon: string; label: string } {
  if (sessionId.startsWith('tg-')) return { icon: '📱', label: 'Telegram' };
  // Sesiones web: prefijo web- (nuevas) o UUID pelado (versiones anteriores)
  if (sessionId.startsWith('web-') || /^[0-9a-f]{8}-[0-9a-f]{4}/.test(sessionId)) {
    return { icon: '💬', label: 'Web' };
  }
  return { icon: '🔧', label: 'Sistema' };
}

function fmtDate(iso: string): string {
  const d = new Date(iso);
  const today = new Date();
  const sameDay = d.toDateString() === today.toDateString();
  return sameDay
    ? d.toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' })
    : d.toLocaleDateString('es-ES', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
}

export function HistoryPage() {
  const [conversations, setConversations] = useState<ConversationSummary[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [messages, setMessages] = useState<ConversationMessage[]>([]);
  const [loadingMsgs, setLoadingMsgs] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<'all' | 'telegram' | 'web'>('all');

  useEffect(() => {
    fetchConversations()
      .then(setConversations)
      .catch((err) => setError((err as Error).message));
  }, []);

  useEffect(() => {
    if (!selected) return;
    setLoadingMsgs(true);
    fetchConversationMessages(selected)
      .then(({ messages }) => setMessages(messages))
      .catch((err) => setError((err as Error).message))
      .finally(() => setLoadingMsgs(false));
  }, [selected]);

  const visible = conversations.filter((c) => {
    if (c.messageCount === 0) return false;
    if (filter === 'telegram') return c.sessionId.startsWith('tg-');
    if (filter === 'web') return !c.sessionId.startsWith('tg-');
    return true;
  });

  return (
    <div className="flex-1 flex min-h-0">
      {/* Lista de conversaciones */}
      <div className="w-80 shrink-0 flex flex-col border-r border-ink-700 bg-ink-900">
        <div className="px-4 py-4 border-b border-ink-700">
          <h1 className="font-mono text-lg text-gray-100">Historial</h1>
          <p className="text-xs text-gray-500 mt-1">Conversaciones de todos los canales.</p>
          <div className="flex gap-1 mt-3">
            {([['all', 'Todas'], ['telegram', '📱 Telegram'], ['web', '💬 Web']] as const).map(([id, label]) => (
              <button
                key={id}
                onClick={() => setFilter(id)}
                className={`px-2 py-1 rounded text-[11px] font-mono transition-colors ${
                  filter === id
                    ? 'bg-bee/20 text-bee-glow border border-bee/40'
                    : 'text-gray-400 border border-ink-700 hover:text-gray-200'
                }`}
              >
                {label}
              </button>
            ))}
          </div>
        </div>

        <div className="flex-1 overflow-y-auto">
          {error && (
            <div className="m-3 px-3 py-2 text-xs text-red-300 bg-red-900/30 border border-red-700 rounded">
              {error}
            </div>
          )}
          {visible.length === 0 && !error && (
            <div className="p-4 text-xs text-gray-500 font-mono">Sin conversaciones todavía.</div>
          )}
          {visible.map((c) => {
            const src = sourceOf(c.sessionId);
            return (
              <button
                key={c.id}
                onClick={() => setSelected(c.id)}
                className={`w-full text-left px-4 py-3 border-b border-ink-800 transition-colors ${
                  selected === c.id ? 'bg-ink-800 border-l-2 border-l-bee' : 'hover:bg-ink-850'
                }`}
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="text-[11px] font-mono text-gray-500">
                    {src.icon} {src.label}
                  </span>
                  <span className="text-[10px] font-mono text-gray-600">{fmtDate(c.updatedAt)}</span>
                </div>
                <div className="text-xs text-gray-300 mt-1 truncate">
                  {c.title ?? c.preview ?? '(sin texto)'}
                </div>
                <div className="text-[10px] font-mono text-gray-600 mt-0.5">
                  {c.messageCount} mensajes
                </div>
              </button>
            );
          })}
        </div>
      </div>

      {/* Detalle de la conversación */}
      <div className="flex-1 overflow-y-auto p-6">
        {!selected && (
          <div className="h-full flex items-center justify-center text-gray-600 font-mono text-sm">
            🐝 Seleccione una conversación para revisarla
          </div>
        )}
        {selected && loadingMsgs && (
          <div className="text-gray-500 font-mono text-sm">Cargando…</div>
        )}
        {selected && !loadingMsgs && (
          <div className="max-w-2xl mx-auto space-y-3">
            {messages
              .filter((m) => m.role !== 'tool' && (m.content || m.toolCall))
              .map((m) => (
                <div key={m.id} className={`flex ${m.role === 'user' ? 'justify-end' : 'justify-start'}`}>
                  <div
                    className={`max-w-[85%] rounded-lg px-3 py-2 text-sm whitespace-pre-wrap break-words ${
                      m.role === 'user'
                        ? 'bg-bee/15 border border-bee/30 text-gray-100'
                        : 'bg-ink-900 border border-ink-700 text-gray-200'
                    }`}
                  >
                    {m.content || (m.toolCall ? `🔧 ${m.toolCall.name}` : '')}
                    <div className="text-[10px] font-mono text-gray-600 mt-1 text-right">
                      {fmtDate(m.createdAt)}
                    </div>
                  </div>
                </div>
              ))}
          </div>
        )}
      </div>
    </div>
  );
}
