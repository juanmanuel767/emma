import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type { IMemoryRepository, MemorySearchResult } from '@emma/core/ports';
import type { MemoryEntry } from '@emma/core/entities';
import type * as schema from '../schema/index.js';
type DB = NodePgDatabase<typeof schema>;
export declare class MemoryRepository implements IMemoryRepository {
    #private;
    private readonly db;
    constructor(db: DB);
    store(entry: MemoryEntry): Promise<MemoryEntry>;
    searchSemantic(sessionId: string, embedding: number[], limit: number): Promise<MemorySearchResult[]>;
    searchKeyword(sessionId: string, query: string, limit: number): Promise<MemoryEntry[]>;
    deleteBySessionId(sessionId: string): Promise<void>;
}
export {};
//# sourceMappingURL=MemoryRepository.d.ts.map