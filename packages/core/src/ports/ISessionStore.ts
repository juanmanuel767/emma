import type { Session } from '../entities/Session.js';
import type { Message } from '../entities/Message.js';

export interface ISessionStore {
  get(sessionId: string): Promise<Session | null>;
  set(session: Session, ttlSeconds?: number): Promise<void>;
  touch(sessionId: string): Promise<void>;
  delete(sessionId: string): Promise<void>;

  pushHistory(sessionId: string, message: Message): Promise<void>;
  getHistory(sessionId: string): Promise<Message[]>;
  clearHistory(sessionId: string): Promise<void>;
}
