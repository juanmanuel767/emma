export interface MemoryEntry {
  readonly id: string;
  readonly sessionId: string;
  readonly content: string;
  readonly embedding: number[] | null;
  readonly metadata: Record<string, unknown>;
  readonly createdAt: Date;
}

export function createMemoryEntry(
  params: Omit<MemoryEntry, 'id' | 'createdAt'> & { id?: string; createdAt?: Date },
): MemoryEntry {
  return {
    id: params.id ?? crypto.randomUUID(),
    sessionId: params.sessionId,
    content: params.content,
    embedding: params.embedding ?? null,
    metadata: params.metadata,
    createdAt: params.createdAt ?? new Date(),
  };
}
