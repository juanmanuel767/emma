import { eq, desc, asc } from 'drizzle-orm';
import { NotFoundError } from '@emma/shared/errors';
import { conversations, messages } from '../schema/index.js';
export class ConversationRepository {
    db;
    constructor(db) {
        this.db = db;
    }
    async findById(id) {
        const rows = await this.db
            .select()
            .from(conversations)
            .where(eq(conversations.id, id))
            .limit(1);
        return rows[0] ? this.#toEntity(rows[0]) : null;
    }
    async findBySessionId(sessionId) {
        const rows = await this.db
            .select()
            .from(conversations)
            .where(eq(conversations.sessionId, sessionId))
            .orderBy(desc(conversations.updatedAt));
        return rows.map(this.#toEntity);
    }
    async create(conversation) {
        const [row] = await this.db
            .insert(conversations)
            .values({
            id: conversation.id,
            sessionId: conversation.sessionId,
            title: conversation.title,
            createdAt: conversation.createdAt,
            updatedAt: conversation.updatedAt,
        })
            .returning();
        if (!row)
            throw new Error('Insert did not return a row');
        return this.#toEntity(row);
    }
    async update(id, patch) {
        const [row] = await this.db
            .update(conversations)
            .set({ ...patch, updatedAt: new Date() })
            .where(eq(conversations.id, id))
            .returning();
        if (!row)
            throw new NotFoundError('Conversation', id);
        return this.#toEntity(row);
    }
    async delete(id) {
        await this.db.delete(conversations).where(eq(conversations.id, id));
    }
    async addMessage(message) {
        const [row] = await this.db
            .insert(messages)
            .values({
            id: message.id,
            conversationId: message.conversationId,
            role: message.role,
            content: message.content,
            toolName: message.toolCall?.name ?? message.toolResult?.toolName,
            toolCallId: message.toolCall?.id ?? message.toolResult?.toolCallId,
            toolInput: message.toolCall?.input,
            toolResult: message.toolResult
                ? { output: message.toolResult.output, isError: message.toolResult.isError }
                : undefined,
            createdAt: message.createdAt,
        })
            .returning();
        if (!row)
            throw new Error('Insert did not return a row');
        return this.#toMessageEntity(row);
    }
    async getMessages(conversationId, limit) {
        const query = this.db
            .select()
            .from(messages)
            .where(eq(messages.conversationId, conversationId))
            .orderBy(asc(messages.createdAt));
        const rows = limit ? await query.limit(limit) : await query;
        return rows.map(this.#toMessageEntity);
    }
    async getRecentMessages(conversationId, limit) {
        const rows = await this.db
            .select()
            .from(messages)
            .where(eq(messages.conversationId, conversationId))
            .orderBy(desc(messages.createdAt))
            .limit(limit);
        return rows.reverse().map(this.#toMessageEntity);
    }
    #toEntity(row) {
        return {
            id: row.id,
            sessionId: row.sessionId,
            title: row.title ?? null,
            createdAt: row.createdAt,
            updatedAt: row.updatedAt,
        };
    }
    #toMessageEntity(row) {
        return {
            id: row.id,
            conversationId: row.conversationId,
            role: row.role,
            content: row.content,
            createdAt: row.createdAt,
            toolCall: row.toolCallId && row.toolName && row.toolInput
                ? {
                    id: row.toolCallId,
                    name: row.toolName,
                    input: row.toolInput,
                }
                : undefined,
            toolResult: row.toolCallId && row.toolName && row.toolResult
                ? {
                    toolCallId: row.toolCallId,
                    toolName: row.toolName,
                    output: row.toolResult.output,
                    isError: row.toolResult.isError,
                }
                : undefined,
        };
    }
}
//# sourceMappingURL=ConversationRepository.js.map