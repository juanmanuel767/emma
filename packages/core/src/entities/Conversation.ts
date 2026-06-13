export interface Conversation {
  readonly id: string;
  readonly sessionId: string;
  readonly title: string | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export function createConversation(
  params: Omit<Conversation, 'id' | 'createdAt' | 'updatedAt' | 'title'> & {
    id?: string;
    title?: string | null;
    createdAt?: Date;
    updatedAt?: Date;
  },
): Conversation {
  const now = new Date();
  return {
    id: params.id ?? crypto.randomUUID(),
    sessionId: params.sessionId,
    title: params.title ?? null,
    createdAt: params.createdAt ?? now,
    updatedAt: params.updatedAt ?? now,
  };
}
