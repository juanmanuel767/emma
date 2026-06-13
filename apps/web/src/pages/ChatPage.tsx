import { useMemo } from 'react';
import { useChat } from '../hooks/useChat.js';
import { ChatWindow } from '../components/ChatWindow.js';
import { ChatInput } from '../components/ChatInput.js';
import { ModelSelector } from '../components/ModelSelector.js';

function getOrCreateSessionId(): string {
  const key = 'emma-session-id';
  let id = localStorage.getItem(key);
  if (!id) {
    id = `web-${crypto.randomUUID()}`;
    localStorage.setItem(key, id);
  }
  return id;
}

export function ChatPage() {
  const sessionId = useMemo(() => getOrCreateSessionId(), []);
  const { messages, isLoading, error, sendMessage, stopGeneration, clearMessages } =
    useChat(sessionId);

  return (
    <div className="flex flex-col h-full min-h-0">
      {/* Header */}
      <header className="flex items-center justify-between px-6 py-3 border-b border-ink-700 bg-ink-900">
        <div className="flex items-center gap-3">
          <span className="font-mono text-sm text-gray-300">Chat</span>
          <span className="text-[10px] text-gray-600 font-mono">
            {sessionId.slice(0, 8)}
          </span>
        </div>
        <div className="flex items-center gap-3">
          {isLoading && (
            <span className="text-xs text-bee-glow animate-pulse font-mono">procesando…</span>
          )}
          <ModelSelector />
          <button
            onClick={clearMessages}
            className="text-xs font-mono text-gray-400 hover:text-bee-glow transition-colors px-2 py-1 rounded border border-ink-700 hover:border-bee"
          >
            /new
          </button>
        </div>
      </header>

      {error && (
        <div className="mx-4 mt-2 px-3 py-2 text-xs text-red-300 bg-red-900/30 border border-red-700 rounded-lg">
          {error}
        </div>
      )}

      <ChatWindow messages={messages} isLoading={isLoading} />
      <ChatInput onSend={sendMessage} onStop={stopGeneration} isLoading={isLoading} />
    </div>
  );
}
