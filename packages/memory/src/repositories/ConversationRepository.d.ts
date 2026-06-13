import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type { IConversationRepository } from '@emma/core/ports';
import type { Conversation } from '@emma/core/entities';
import type { Message } from '@emma/core/entities';
import type * as schema from '../schema/index.js';
type DB = NodePgDatabase<typeof schema>;
export declare class ConversationRepository implements IConversationRepository {
    #private;
    private readonly db;
    constructor(db: DB);
    findById(id: string): Promise<Conversation | null>;
    findBySessionId(sessionId: string): Promise<Conversation[]>;
    create(conversation: Conversation): Promise<Conversation>;
    update(id: string, patch: Partial<Pick<Conversation, 'title' | 'updatedAt'>>): Promise<Conversation>;
    delete(id: string): Promise<void>;
    addMessage(message: Message): Promise<Message>;
    getMessages(conversationId: string, limit?: number): Promise<Message[]>;
    getRecentMessages(conversationId: string, limit: number): Promise<Message[]>;
}
export {};
//# sourceMappingURL=ConversationRepository.d.ts.map