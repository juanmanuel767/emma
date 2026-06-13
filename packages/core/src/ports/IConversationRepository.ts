import type { Conversation } from '../entities/Conversation.js';
import type { Message } from '../entities/Message.js';

export interface ConversationSummary extends Conversation {
  messageCount: number;
  preview: string;
}

export interface IConversationRepository {
  findById(id: string): Promise<Conversation | null>;
  findBySessionId(sessionId: string): Promise<Conversation[]>;
  listAll(limit?: number): Promise<ConversationSummary[]>;
  create(conversation: Conversation): Promise<Conversation>;
  update(id: string, patch: Partial<Pick<Conversation, 'title' | 'updatedAt'>>): Promise<Conversation>;
  delete(id: string): Promise<void>;

  addMessage(message: Message): Promise<Message>;
  getMessages(conversationId: string, limit?: number): Promise<Message[]>;
  getRecentMessages(conversationId: string, limit: number): Promise<Message[]>;
}
