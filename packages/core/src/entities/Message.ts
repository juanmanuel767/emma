export type MessageRole = 'user' | 'assistant' | 'tool';

export interface ToolCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface ToolResult {
  toolCallId: string;
  toolName: string;
  output: string;
  isError: boolean;
}

export interface Message {
  readonly id: string;
  readonly conversationId: string;
  readonly role: MessageRole;
  readonly content: string;
  readonly toolCall?: ToolCall;
  readonly toolResult?: ToolResult;
  readonly createdAt: Date;
}

export function createMessage(
  params: Omit<Message, 'id' | 'createdAt'> & { id?: string; createdAt?: Date },
): Message {
  return {
    id: params.id ?? crypto.randomUUID(),
    createdAt: params.createdAt ?? new Date(),
    conversationId: params.conversationId,
    role: params.role,
    content: params.content,
    toolCall: params.toolCall,
    toolResult: params.toolResult,
  };
}
