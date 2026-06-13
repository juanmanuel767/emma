import { pgTable, uuid, text, jsonb, timestamp, index } from 'drizzle-orm/pg-core';
import { customType } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
// pgvector custom type
const vector = (name, dimensions) => customType({
    dataType() {
        return `vector(${dimensions})`;
    },
    toDriver(value) {
        return `[${value.join(',')}]`;
    },
    fromDriver(value) {
        return value
            .slice(1, -1)
            .split(',')
            .map(Number);
    },
})(name);
export const conversations = pgTable('conversations', {
    id: uuid('id').primaryKey().defaultRandom(),
    sessionId: text('session_id').notNull(),
    title: text('title'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});
export const messages = pgTable('messages', {
    id: uuid('id').primaryKey().defaultRandom(),
    conversationId: uuid('conversation_id')
        .notNull()
        .references(() => conversations.id, { onDelete: 'cascade' }),
    role: text('role', { enum: ['user', 'assistant', 'tool'] }).notNull(),
    content: text('content').notNull(),
    toolName: text('tool_name'),
    toolCallId: text('tool_call_id'),
    toolInput: jsonb('tool_input'),
    toolResult: jsonb('tool_result'),
    isError: text('is_error'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});
export const memoryEntries = pgTable('memory_entries', {
    id: uuid('id').primaryKey().defaultRandom(),
    sessionId: text('session_id').notNull(),
    content: text('content').notNull(),
    embedding: vector('embedding', 1024),
    metadata: jsonb('metadata').notNull().default(sql `'{}'::jsonb`),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
    index('memory_session_idx').on(table.sessionId),
]);
//# sourceMappingURL=index.js.map