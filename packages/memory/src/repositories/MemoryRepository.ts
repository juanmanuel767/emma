import { eq, sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type { IMemoryRepository, MemorySearchResult } from '@emma/core/ports';
import type { MemoryEntry } from '@emma/core/entities';
import { memoryEntries } from '../schema/index.js';
import type * as schema from '../schema/index.js';

type DB = NodePgDatabase<typeof schema>;

export class MemoryRepository implements IMemoryRepository {
  constructor(private readonly db: DB) {}

  async store(entry: MemoryEntry): Promise<MemoryEntry> {
    const [row] = await this.db
      .insert(memoryEntries)
      .values({
        id: entry.id,
        sessionId: entry.sessionId,
        content: entry.content,
        embedding: entry.embedding ?? undefined,
        metadata: entry.metadata,
        createdAt: entry.createdAt,
      })
      .returning();
    if (!row) throw new Error('Insert did not return a row');
    return this.#toEntity(row);
  }

  async searchSemantic(
    sessionId: string,
    embedding: number[],
    limit: number,
  ): Promise<MemorySearchResult[]> {
    const vectorLiteral = `[${embedding.join(',')}]`;
    const rows = await this.db
      .select({
        entry: memoryEntries,
        similarity: sql<number>`1 - (${memoryEntries.embedding} <=> ${vectorLiteral}::vector)`,
      })
      .from(memoryEntries)
      .where(eq(memoryEntries.sessionId, sessionId))
      .orderBy(sql`${memoryEntries.embedding} <=> ${vectorLiteral}::vector`)
      .limit(limit);

    return rows.map((r) => ({
      entry: this.#toEntity(r.entry),
      similarity: r.similarity,
    }));
  }

  async searchKeyword(sessionId: string, query: string, limit: number): Promise<MemoryEntry[]> {
    const rows = await this.db
      .select()
      .from(memoryEntries)
      .where(
        sql`${memoryEntries.sessionId} = ${sessionId}
          AND to_tsvector('english', ${memoryEntries.content}) @@ plainto_tsquery('english', ${query})`,
      )
      .limit(limit);
    return rows.map(this.#toEntity);
  }

  async listBySession(sessionId: string, limit: number): Promise<MemoryEntry[]> {
    const rows = await this.db
      .select()
      .from(memoryEntries)
      .where(eq(memoryEntries.sessionId, sessionId))
      .orderBy(sql`${memoryEntries.createdAt} DESC`)
      .limit(limit);
    return rows.map(this.#toEntity);
  }

  async deleteBySessionId(sessionId: string): Promise<void> {
    await this.db.delete(memoryEntries).where(eq(memoryEntries.sessionId, sessionId));
  }

  #toEntity(row: typeof memoryEntries.$inferSelect): MemoryEntry {
    return {
      id: row.id,
      sessionId: row.sessionId,
      content: row.content,
      embedding: row.embedding ?? null,
      metadata: (row.metadata as Record<string, unknown>) ?? {},
      createdAt: row.createdAt,
    };
  }
}
