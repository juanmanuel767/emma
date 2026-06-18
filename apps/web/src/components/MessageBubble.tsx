import type { ChatMessage } from '../hooks/useChat.js';
import { ToolCallCard } from './ToolCallCard.js';
import { MediaPreview, findMedia, stripAttachmentMarkers } from './MediaPreview.js';
import clsx from 'clsx';

interface Props {
  message: ChatMessage;
}

export function MessageBubble({ message }: Props) {
  const isUser = message.role === 'user';
  // Medios tanto del asistente (genera en /tmp/emma) como del señor (adjuntos subidos).
  const media = message.content ? findMedia(message.content) : [];
  // En los mensajes del señor, ocultar el marcador técnico del adjunto (ya se previsualiza).
  const text = isUser ? stripAttachmentMarkers(message.content) : message.content;

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
        {text}
        {message.streaming && !message.content && (
          <span className="inline-block w-2 h-4 bg-gray-400 animate-pulse ml-1" />
        )}
        {message.streaming && message.content && (
          <span className="inline-block w-0.5 h-4 bg-gray-400 animate-pulse ml-0.5 align-middle" />
        )}
        {media.length > 0 && <MediaPreview paths={media} />}
        {message.audioUrl && (
          <audio
            src={message.audioUrl}
            controls
            autoPlay={!isUser}
            className="mt-2 w-full max-w-[280px] h-9"
          />
        )}
      </div>

      {!isUser && message.localMode && (
        <div className="flex items-center gap-1.5 text-[11px] text-amber-400/80 px-1">
          <span>🐢</span>
          <span>
            Modo local{message.streaming ? ' — generando, puede tardar un poco' : ' (cuotas en la nube agotadas)'}
          </span>
        </div>
      )}

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
