import type { FastifyPluginAsync } from 'fastify';
import type { IConversationRepository } from '@emma/core/ports';

// Historial unificado: expone las conversaciones persistidas en Postgres
// (web y Telegram por igual) para que la interfaz web pueda listarlas y leerlas.
export const conversationRoutes: FastifyPluginAsync<{ conversationRepo: IConversationRepository }> = async (
  fastify,
  opts,
) => {
  fastify.get('/conversations', async (req, reply) => {
    const { limit } = req.query as { limit?: string };
    try {
      const conversations = await opts.conversationRepo.listAll(
        limit ? Math.min(Number(limit) || 100, 500) : 100,
      );
      return { conversations };
    } catch (err) {
      return reply.status(500).send({ error: (err as Error).message });
    }
  });

  fastify.get('/conversations/:id/messages', async (req, reply) => {
    const { id } = req.params as { id: string };
    try {
      const conversation = await opts.conversationRepo.findById(id);
      if (!conversation) return reply.status(404).send({ error: 'Conversación no encontrada' });
      const messages = await opts.conversationRepo.getMessages(id);
      return { conversation, messages };
    } catch (err) {
      return reply.status(500).send({ error: (err as Error).message });
    }
  });
};
