import type { ToolCallInfo } from '../hooks/useChat.js';
import clsx from 'clsx';
import { MediaPreview, findMedia } from './MediaPreview.js';

interface Props {
  toolCall: ToolCallInfo;
}

export function ToolCallCard({ toolCall }: Props) {
  const isDone = toolCall.result !== undefined;
  const media = toolCall.result ? findMedia(toolCall.result) : [];

  return (
    <div className="bg-gray-900 border border-gray-700 rounded-xl px-3 py-2 text-xs font-mono">
      <div className="flex items-center gap-2 mb-1">
        <span className={clsx('text-xs', isDone ? 'text-green-400' : 'text-yellow-400')}>
          {isDone ? '✓' : '⟳'}
        </span>
        <span className="text-purple-400 font-semibold">{toolCall.name}</span>
        {!isDone && <span className="text-gray-500 animate-pulse">running...</span>}
      </div>
      {toolCall.input && (
        <pre className="text-gray-400 overflow-x-auto text-[10px] max-h-20">
          {JSON.stringify(toolCall.input, null, 2)}
        </pre>
      )}
      {toolCall.result && (
        <div className="mt-1 pt-1 border-t border-gray-700 text-gray-300 overflow-x-auto max-h-24">
          {toolCall.result}
        </div>
      )}
      <MediaPreview paths={media} />
    </div>
  );
}
