import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { readFile } from 'node:fs/promises';
import { extname, basename } from 'node:path';
import type { AgentClient } from '../../../infrastructure/agent-client/AgentClient.js';

const bodySchema = z.object({
  message: z.string().min(1).max(32_000),
  sessionId: z.string().optional(),
});

// Sirve los medios que Emma genera en /tmp/emma/ (QR, imágenes, audio) para que la web
// pueda mostrarlos. Solo lectura, solo /tmp/emma/, extensiones de medios conocidas.
const MEDIA_TYPES: Record<string, string> = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp',
  '.ogg': 'audio/ogg', '.oga': 'audio/ogg', '.wav': 'audio/wav', '.mp3': 'audio/mpeg', '.mp4': 'video/mp4',
};

export const chatRoutes: FastifyPluginAsync<{ agentClient: AgentClient }> = async (
  fastify,
  opts,
) => {
  fastify.post('/chat', async (req, reply) => {
    const body = bodySchema.safeParse(req.body);
    if (!body.success) {
      return reply.status(400).send({ error: body.error.message });
    }

    const sessionId = body.data.sessionId ?? crypto.randomUUID();
    const userId = (req.user as { sub?: string } | undefined)?.sub ?? 'anonymous';

    // Hijack the response and open SSE stream.
    // hijack() bypasses Fastify's reply lifecycle, so @fastify/cors never adds
    // its headers here — without them the browser blocks the stream ("Failed to fetch").
    const origin = req.headers.origin;
    reply.hijack();
    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
      'X-Session-Id': sessionId,
      ...(origin
        ? {
            'Access-Control-Allow-Origin': origin,
            'Access-Control-Allow-Credentials': 'true',
            'Vary': 'Origin',
          }
        : {}),
    });

    const write = (event: string, data: unknown) =>
      reply.raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

    // AbortController tied to the raw socket so disconnect cancels the agent call
    const ac = new AbortController();
    reply.raw.on('close', () => ac.abort());

    try {
      for await (const chunk of opts.agentClient.streamChat(
        { sessionId, userId, message: body.data.message },
        ac.signal,
      )) {
        if (ac.signal.aborted) break;
        reply.raw.write(`data: ${chunk}\n\n`);
      }
      write('done', { sessionId });
    } catch (err) {
      if (!ac.signal.aborted) {
        write('error', { error: (err as Error).message });
      }
    } finally {
      reply.raw.end();
    }
  });

  fastify.get('/media/:name', async (req, reply) => {
    // basename evita path traversal (descarta cualquier ../ o ruta absoluta)
    const name = basename((req.params as { name: string }).name);
    const ext = extname(name).toLowerCase();
    const type = MEDIA_TYPES[ext];
    if (!type) return reply.status(415).send({ error: 'Tipo de archivo no permitido' });
    try {
      const buf = await readFile(`/tmp/emma/${name}`);
      return reply.header('Content-Type', type).header('Cache-Control', 'public, max-age=300').send(buf);
    } catch {
      return reply.status(404).send({ error: 'Archivo no encontrado' });
    }
  });

  fastify.get('/skills', async (_req, reply) => {
    try {
      return await opts.agentClient.getSkills();
    } catch (err) {
      return reply.status(502).send({ error: (err as Error).message });
    }
  });

  fastify.get('/models', async (_req, reply) => {
    try {
      return await opts.agentClient.getModels();
    } catch (err) {
      return reply.status(502).send({ error: (err as Error).message });
    }
  });

  fastify.post('/models/select', async (req, reply) => {
    const body = z.object({ model: z.string().min(1).max(200) }).safeParse(req.body);
    if (!body.success) {
      return reply.status(400).send({ error: body.error.message });
    }
    try {
      return await opts.agentClient.selectModel(body.data.model);
    } catch (err) {
      return reply.status(422).send({ error: (err as Error).message });
    }
  });

  fastify.get('/conversations', async (req, reply) => {
    const { limit } = req.query as { limit?: string };
    try {
      return await opts.agentClient.getConversations(limit ? Number(limit) : undefined);
    } catch (err) {
      return reply.status(502).send({ error: (err as Error).message });
    }
  });

  fastify.get('/conversations/:id/messages', async (req, reply) => {
    const { id } = req.params as { id: string };
    try {
      return await opts.agentClient.getConversationMessages(id);
    } catch (err) {
      return reply.status(502).send({ error: (err as Error).message });
    }
  });

  fastify.delete('/sessions/:sessionId', async (req, reply) => {
    return reply.send({ message: 'Session cleared' });
  });

  fastify.get('/sessions/:sessionId/conversations', async (req, reply) => {
    return reply.send({ conversations: [] });
  });
};
