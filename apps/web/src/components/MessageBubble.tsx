import type { ChatMessage } from '../hooks/useChat.js';
import { ToolCallCard } from './ToolCallCard.js';
import { MediaPreview, findMedia } from './MediaPreview.js';
import clsx from 'clsx';

interface Props {
  message: ChatMessage;
}

export function MessageBubble({ message }: Props) {
  const isUser = message.role === 'user';
  const media = !isUser && message.content ? findMedia(message.content) : [];

  return (
    <div className={clsx('flex flex-col gap-2', isUser ? 'items-end' : 'items-start')}>
      <div
        className={clsx(
          'max-w-[80%] rounded-2xl px-4 py-3 text-sm leading-relaxed whitespace-pre-wrap break-words',
          isUser
            ? 'bg-blue-600 text-white rounded-tr-sm'
            : 'bg-gray-800 text-gray-100 rounded-tl-sm',
        )}
      >
        {message.content}
        {message.streaming && !message.content && (
          <span className="inline-block w-2 h-4 bg-gray-400 animate-pulse ml-1" />
        )}
        {message.streaming && message.content && (
          <span className="inline-block w-0.5 h-4 bg-gray-400 animate-pulse ml-0.5 align-middle" />
        )}
        {media.length > 0 && <MediaPreview paths={media} />}
      </div>

      {message.toolCalls && message.toolCalls.length > 0 && (
        <div className="flex flex-col gap-1 w-full max-w-[80%]">
          {message.toolCalls.map((tc, i) => (
            <ToolCallCard key={i} toolCall={tc} />
          ))}
        </div>
      )}
    </div>
  );
}
