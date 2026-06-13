import { eq, sql } from 'drizzle-orm';
import { memoryEntries } from '../schema/index.js';
export class MemoryRepository {
    db;
    constructor(db) {
        this.db = db;
    }
    async store(entry) {
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
        if (!row)
            throw new Error('Insert did not return a row');
        return this.#toEntity(row);
    }
    async searchSemantic(sessionId, embedding, limit) {
        const vectorLiteral = `[${embedding.join(',')}]`;
        const rows = await this.db
            .select({
            entry: memoryEntries,
            similarity: sql `1 - (${memoryEntries.embedding} <=> ${vectorLiteral}::vector)`,
        })
            .from(memoryEntries)
            .where(eq(memoryEntries.sessionId, sessionId))
            .orderBy(sql `${memoryEntries.embedding} <=> ${vectorLiteral}::vector`)
            .limit(limit);
        return rows.map((r) => ({
            entry: this.#toEntity(r.entry),
            similarity: r.similarity,
        }));
    }
    async searchKeyword(sessionId, query, limit) {
        const rows = await this.db
            .select()
            .from(memoryEntries)
            .where(sql `${memoryEntries.sessionId} = ${sessionId}
          AND to_tsvector('english', ${memoryEntries.content}) @@ plainto_tsquery('english', ${query})`)
            .limit(limit);
        return rows.map(this.#toEntity);
    }
    async deleteBySessionId(sessionId) {
        await this.db.delete(memoryEntries).where(eq(memoryEntries.sessionId, sessionId));
    }
    #toEntity(row) {
        return {
            id: row.id,
            sessionId: row.sessionId,
            content: row.content,
            embedding: row.embedding ?? null,
            metadata: row.metadata ?? {},
            createdAt: row.createdAt,
        };
    }
}
//# sourceMappingURL=MemoryRepository.js.map