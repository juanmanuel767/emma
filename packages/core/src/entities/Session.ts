export interface Session {
  readonly sessionId: string;
  readonly conversationId: string;
  readonly userId: string;
  readonly lastActive: Date;
}

export function createSession(params: {
  sessionId: string;
  conversationId: string;
  userId: string;
}): Session {
  return {
    sessionId: params.sessionId,
    conversationId: params.conversationId,
    userId: params.userId,
    lastActive: new Date(),
  };
}

export function touchSession(session: Session): Session {
  return { ...session, lastActive: new Date() };
}
