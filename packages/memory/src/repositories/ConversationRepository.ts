import { eq, desc, asc, inArray, sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type { IConversationRepository, ConversationSummary } from '@emma/core/ports';
import type { Conversation } from '@emma/core/entities';
import type { Message } from '@emma/core/entities';
import { NotFoundError } from '@emma/shared/errors';
import { conversations, messages } from '../schema/index.js';
import type * as schema from '../schema/index.js';

type DB = NodePgDatabase<typeof schema>;

export class ConversationRepository implements IConversationRepository {
  constructor(private readonly db: DB) {}

  async findById(id: string): Promise<Conversation | null> {
    const rows = await this.db
      .select()
      .from(conversations)
      .where(eq(conversations.id, id))
      .limit(1);
    return rows[0] ? this.#toEntity(rows[0]) : null;
  }

  async findBySessionId(sessionId: string): Promise<Conversation[]> {
    const rows = await this.db
      .select()
      .from(conversations)
      .where(eq(conversations.sessionId, sessionId))
      .orderBy(desc(conversations.updatedAt));
    return rows.map(this.#toEntity);
  }

  async listAll(limit = 100): Promise<ConversationSummary[]> {
    const convs = await this.db
      .select()
      .from(conversations)
      .orderBy(desc(conversations.updatedAt))
      .limit(limit);
    if (convs.length === 0) return [];

    const ids = convs.map((c) => c.id);
    const stats = await this.db
      .select({
        conversationId: messages.conversationId,
        messageCount: sql<number>`count(*)::int`,
        preview: sql<string>`coalesce((array_agg(${messages.content} ORDER BY ${messages.createdAt} ASC) FILTER (WHERE ${messages.role} = 'user' AND ${messages.content} <> ''))[1], '')`,
      })
      .from(messages)
      .where(inArray(messages.conversationId, ids))
      .groupBy(messages.conversationId);

    const byId = new Map(stats.map((s) => [s.conversationId, s]));
    return convs.map((row) => ({
      ...this.#toEntity(row),
      messageCount: byId.get(row.id)?.messageCount ?? 0,
      preview: (byId.get(row.id)?.preview ?? '').slice(0, 160),
    }));
  }

  async create(conversation: Conversation): Promise<Conversation> {
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
    if (!row) throw new Error('Insert did not return a row');
    return this.#toEntity(row);
  }

  async update(
    id: string,
    patch: Partial<Pick<Conversation, 'title' | 'updatedAt'>>,
  ): Promise<Conversation> {
    const [row] = await this.db
      .update(conversations)
      .set({ ...patch, updatedAt: new Date() })
      .where(eq(conversations.id, id))
      .returning();
    if (!row) throw new NotFoundError('Conversation', id);
    return this.#toEntity(row);
  }

  async delete(id: string): Promise<void> {
    await this.db.delete(conversations).where(eq(conversations.id, id));
  }

  async addMessage(message: Message): Promise<Message> {
    const [row] = await this.db
      .insert(messages)
      .values({
        id: message.id,
        conversationId: message.conversationId,
        role: message.role,
        content: message.content,
        toolName: message.toolCall?.name ?? message.toolResult?.toolName,
        toolCallId: message.toolCall?.id ?? message.toolResult?.toolCallId,
        toolInput: message.toolCall?.input as Record<string, unknown> | undefined,
        toolResult: message.toolResult
          ? { output: message.toolResult.output, isError: message.toolResult.isError }
          : undefined,
        createdAt: message.createdAt,
      })
      .returning();
    if (!row) throw new Error('Insert did not return a row');
    return this.#toMessageEntity(row);
  }

  async getMessages(conversationId: string, limit?: number): Promise<Message[]> {
    const query = this.db
      .select()
      .from(messages)
      .where(eq(messages.conversationId, conversationId))
      .orderBy(asc(messages.createdAt));
    const rows = limit ? await query.limit(limit) : await query;
    return rows.map(this.#toMessageEntity);
  }

  async getRecentMessages(conversationId: string, limit: number): Promise<Message[]> {
    const rows = await this.db
      .select()
      .from(messages)
      .where(eq(messages.conversationId, conversationId))
      .orderBy(desc(messages.createdAt))
      .limit(limit);
    return rows.reverse().map(this.#toMessageEntity);
  }

  #toEntity(row: typeof conversations.$inferSelect): Conversation {
    return {
      id: row.id,
      sessionId: row.sessionId,
      title: row.title ?? null,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }

  #toMessageEntity(row: typeof messages.$inferSelect): Message {
    return {
      id: row.id,
      conversationId: row.conversationId,
      role: row.role as Message['role'],
      content: row.content,
      createdAt: row.createdAt,
      toolCall:
        row.toolCallId && row.toolName && row.toolInput
          ? {
              id: row.toolCallId,
              name: row.toolName,
              input: row.toolInput as Record<string, unknown>,
            }
          : undefined,
      toolResult:
        row.toolCallId && row.toolName && row.toolResult
          ? {
              toolCallId: row.toolCallId,
              toolName: row.toolName,
              output: (row.toolResult as { output: string }).output,
              isError: (row.toolResult as { isError: boolean }).isError,
            }
          : undefined,
    };
  }
}
