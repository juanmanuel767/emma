import { useRef, useEffect } from 'react';
import type { ChatMessage } from '../hooks/useChat.js';
import { MessageBubble } from './MessageBubble.js';

interface Props {
  messages: ChatMessage[];
  isLoading: boolean;
}

export function ChatWindow({ messages, isLoading }: Props) {
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  return (
    <div className="flex-1 overflow-y-auto px-4 py-6 space-y-4">
      {messages.length === 0 && (
        <div className="flex items-center justify-center h-full">
          <div className="text-center text-gray-400">
            <div className="text-5xl mb-4">⚡</div>
            <p className="text-xl font-light">Emma está lista.</p>
            <p className="text-sm mt-1">Escribe un mensaje para comenzar.</p>
          </div>
        </div>
      )}
      {messages.map((msg) => (
        <MessageBubble key={msg.id} message={msg} />
      ))}
      {isLoading && messages[messages.length - 1]?.role === 'user' && (
        <div className="flex gap-2 items-center text-gray-400 text-sm px-2">
          <span className="animate-pulse">●</span>
          <span className="animate-pulse delay-100">●</span>
          <span className="animate-pulse delay-200">●</span>
        </div>
      )}
      <div ref={bottomRef} />
    </div>
  );
}
