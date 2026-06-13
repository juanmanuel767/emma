import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import type { RunConversation } from '../../../application/use-cases/RunConversation.js';

const chatBodySchema = z.object({
  sessionId: z.string().min(1),
  userId: z.string().min(1).default('default'),
  message: z.string().min(1).max(32_000),
});

export const chatRoutes: FastifyPluginAsync<{ runConversation: RunConversation }> = async (
  fastify,
  opts,
) => {
  fastify.post(
    '/chat',
    {
      schema: {
        body: {
          type: 'object',
          required: ['sessionId', 'message'],
          properties: {
            sessionId: { type: 'string' },
            userId: { type: 'string' },
            message: { type: 'string' },
          },
        },
      },
    },
    async (req, reply) => {
      const body = chatBodySchema.safeParse(req.body);
      if (!body.success) {
        return reply.status(400).send({ error: body.error.message });
      }

      const { sessionId, userId, message } = body.data;
      const ac = new AbortController();

      // Take control of the raw response — Fastify v5 requires hijack() for manual streaming
      reply.hijack();
      reply.raw.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no',
      });

      // Detect client disconnect after hijack via the underlying socket
      reply.raw.socket?.on('close', () => ac.abort());

      const sendEvent = (event: string, data: unknown): boolean =>
        reply.raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

      try {
        for await (const chunk of opts.runConversation.execute({
          sessionId,
          userId,
          userMessage: message,
          signal: ac.signal,
        })) {
          if (ac.signal.aborted) break;
          sendEvent(chunk.type, chunk);
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (!ac.signal.aborted) {
          sendEvent('error', { error: msg });
        }
      } finally {
        reply.raw.end();
      }
    },
  );
};
