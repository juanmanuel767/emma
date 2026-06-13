import { useState, useRef, type KeyboardEvent } from 'react';

interface Props {
  onSend: (message: string) => void;
  onStop: () => void;
  isLoading: boolean;
}

export function ChatInput({ onSend, onStop, isLoading }: Props) {
  const [value, setValue] = useState('');
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const handleSend = () => {
    const trimmed = value.trim();
    if (!trimmed || isLoading) return;
    onSend(trimmed);
    setValue('');
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto';
    }
  };

  const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const handleInput = () => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
  };

  return (
    <div className="border-t border-gray-700 bg-gray-900 px-4 py-3">
      <div className="flex items-end gap-3 max-w-4xl mx-auto">
        <textarea
          ref={textareaRef}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={handleKeyDown}
          onInput={handleInput}
          placeholder="Escribe un mensaje... (Enter para enviar, Shift+Enter para nueva línea)"
          rows={1}
          disabled={false}
          className="flex-1 resize-none bg-gray-800 text-gray-100 placeholder-gray-500 rounded-xl px-4 py-3 text-sm outline-none focus:ring-1 focus:ring-blue-500 border border-gray-700 max-h-48 overflow-y-auto"
        />
        {isLoading ? (
          <button
            onClick={onStop}
            className="shrink-0 p-3 rounded-xl bg-red-600 hover:bg-red-500 text-white transition-colors"
            title="Detener"
          >
            ■
          </button>
        ) : (
          <button
            onClick={handleSend}
            disabled={!value.trim()}
            className="shrink-0 p-3 rounded-xl bg-blue-600 hover:bg-blue-500 disabled:opacity-40 disabled:cursor-not-allowed text-white transition-colors"
            title="Enviar"
          >
            ▶
          </button>
        )}
      </div>
    </div>
  );
}
