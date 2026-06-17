import type { MemoryEntry } from '../entities/MemoryEntry.js';

export interface MemorySearchResult {
  entry: MemoryEntry;
  similarity: number;
}

export interface IMemoryRepository {
  store(entry: MemoryEntry): Promise<MemoryEntry>;
  searchSemantic(
    sessionId: string,
    embedding: number[],
    limit: number,
  ): Promise<MemorySearchResult[]>;
  searchKeyword(sessionId: string, query: string, limit: number): Promise<MemoryEntry[]>;
  /** Trae las entradas de una sesión por orden cronológico inverso, sin búsqueda semántica. */
  listBySession(sessionId: string, limit: number): Promise<MemoryEntry[]>;
  deleteBySessionId(sessionId: string): Promise<void>;
  /** Borra una única entrada por su id. Devuelve true si existía y se eliminó. */
  deleteById(id: string): Promise<boolean>;
}
