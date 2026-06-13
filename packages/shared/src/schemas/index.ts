import { z } from 'zod';

export const uuidSchema = z.string().uuid();

export const paginationSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

export const sessionIdSchema = z.string().min(1).max(128);

export const messageRoleSchema = z.enum(['user', 'assistant', 'tool']);

export type MessageRole = z.infer<typeof messageRoleSchema>;
export type Pagination = z.infer<typeof paginationSchema>;

export { z };
