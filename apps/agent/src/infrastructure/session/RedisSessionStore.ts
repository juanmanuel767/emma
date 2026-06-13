import type { Redis } from 'ioredis';
import type { ISessionStore } from '@emma/core/ports';
import type { Session } from '@emma/core/entities';
import type { Message } from '@emma/core/entities';

const SESSION_TTL = 86_400; // 24 hours
const HISTORY_MAX_LENGTH = 20;

export class RedisSessionStore implements ISessionStore {
  constructor(private readonly redis: Redis) {}

  async get(sessionId: string): Promise<Session | null> {
    const raw = await this.redis.hgetall(this.#sessionKey(sessionId));
    if (!raw['sessionId']) return null;
    return {
      sessionId: raw['sessionId'] as string,
      conversationId: raw['conversationId'] as string,
      userId: raw['userId'] as string,
      lastActive: new Date(raw['lastActive'] as string),
    };
  }

  async set(session: Session, ttlSeconds = SESSION_TTL): Promise<void> {
    const key = this.#sessionKey(session.sessionId);
    await this.redis.hset(key, {
      sessionId: session.sessionId,
      conversationId: session.conversationId,
      userId: session.userId,
      lastActive: session.lastActive.toISOString(),
    });
    await this.redis.expire(key, ttlSeconds);
  }

  async touch(sessionId: string): Promise<void> {
    const key = this.#sessionKey(sessionId);
    await this.redis.hset(key, 'lastActive', new Date().toISOString());
    await this.redis.expire(key, SESSION_TTL);
  }

  async delete(sessionId: string): Promise<void> {
    await this.redis.del(this.#sessionKey(sessionId), this.#historyKey(sessionId));
  }

  async pushHistory(sessionId: string, message: Message): Promise<void> {
    const key = this.#historyKey(sessionId);
    await this.redis.rpush(key, JSON.stringify(message));
    await this.redis.ltrim(key, -HISTORY_MAX_LENGTH, -1);
    await this.redis.expire(key, SESSION_TTL);
  }

  async getHistory(sessionId: string): Promise<Message[]> {
    const items = await this.redis.lrange(this.#historyKey(sessionId), 0, -1);
    return items.map((item) => JSON.parse(item) as Message);
  }

  async clearHistory(sessionId: string): Promise<void> {
    await this.redis.del(this.#historyKey(sessionId));
  }

  #sessionKey(sessionId: string): string {
    return `emma:session:${sessionId}`;
  }

  #historyKey(sessionId: string): string {
    return `emma:history:${sessionId}`;
  }
}
