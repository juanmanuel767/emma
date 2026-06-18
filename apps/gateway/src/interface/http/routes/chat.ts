import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { extname, basename } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { AgentClient } from '../../../infrastructure/agent-client/AgentClient.js';

const bodySchema = z.object({
  message: z.string().min(1).max(32_000),
  sessionId: z.string().optional(),
});

const MEDIA_DIR = '/tmp/emma';
// Límite por ruta para subidas/audio (base64 infla ~33% → ~18 MB de archivo real).
const UPLOAD_BODY_LIMIT = 26_214_400; // 25 MB

// Extensiones que el señor puede ADJUNTAR (entrante). Imagen/audio se previsualizan;
// el resto son archivos que el agente puede leer con sus herramientas.
const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp']);
const AUDIO_EXT = new Set(['.ogg', '.oga', '.wav', '.mp3', '.m4a', '.webm']);
const FILE_EXT = new Set([
  '.pdf', '.txt', '.md', '.csv', '.json', '.log', '.xml', '.yaml', '.yml',
  '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx', '.zip', '.mp4',
]);

function extFromName(name: string): string {
  return extname(name).toLowerCase();
}

function kindFor(ext: string): 'image' | 'audio' | 'file' | null {
  if (IMAGE_EXT.has(ext)) return 'image';
  if (AUDIO_EXT.has(ext)) return 'audio';
  if (FILE_EXT.has(ext)) return 'file';
  return null;
}

// Sirve los medios que Emma genera en /tmp/emma/ (QR, imágenes, audio) para que la web
// pueda mostrarlos. Solo lectura, solo /tmp/emma/, extensiones de medios conocidas.
const MEDIA_TYPES: Record<string, string> = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp',
  '.ogg': 'audio/ogg', '.oga': 'audio/ogg', '.wav': 'audio/wav', '.mp3': 'audio/mpeg', '.mp4': 'video/mp4',
};

export const chatRoutes: FastifyPluginAsync<{ agentClient: AgentClient; groqApiKey?: string }> = async (
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

  // Subida de adjuntos del señor (imágenes/audio/archivos) → se guardan en /tmp/emma/ y se
  // devuelve la ruta. La web la inserta como marcador en el mensaje; el agente ya sabe leer
  // "[imagen adjunta guardada en: /tmp/emma/...]" (visión) y archivos con sus herramientas.
  fastify.post('/upload', { bodyLimit: UPLOAD_BODY_LIMIT }, async (req, reply) => {
    const parsed = z
      .object({
        name: z.string().min(1).max(200),
        data: z.string().min(1), // base64 (sin prefijo data:)
      })
      .safeParse(req.body);
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.message });

    const ext = extFromName(parsed.data.name);
    const kind = kindFor(ext);
    if (!kind) return reply.status(415).send({ error: `Tipo de archivo no permitido: ${ext || 'sin extensión'}` });

    let buf: Buffer;
    try {
      buf = Buffer.from(parsed.data.data, 'base64');
    } catch {
      return reply.status(400).send({ error: 'base64 inválido' });
    }
    if (buf.length === 0) return reply.status(400).send({ error: 'Archivo vacío' });

    const safeName = `up-${randomUUID()}${ext}`;
    const path = `${MEDIA_DIR}/${safeName}`;
    try {
      await mkdir(MEDIA_DIR, { recursive: true });
      await writeFile(path, buf);
    } catch (err) {
      return reply.status(500).send({ error: `No se pudo guardar: ${(err as Error).message}` });
    }
    return reply.send({ path, kind, name: parsed.data.name, url: `/media/${safeName}` });
  });

  // Transcribe una nota de voz de la web con Groq Whisper (mismo modelo que Telegram).
  fastify.post('/transcribe', { bodyLimit: UPLOAD_BODY_LIMIT }, async (req, reply) => {
    if (!opts.groqApiKey) {
      return reply.status(503).send({ error: 'Transcripción no disponible: falta GROQ_API_KEY. Configúrela en Integraciones, señor.' });
    }
    const parsed = z
      .object({
        data: z.string().min(1), // base64 del audio
        mime: z.string().default('audio/webm'),
      })
      .safeParse(req.body);
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.message });

    let audio: Buffer;
    try {
      audio = Buffer.from(parsed.data.data, 'base64');
    } catch {
      return reply.status(400).send({ error: 'base64 inválido' });
    }

    try {
      const form = new FormData();
      const filename = parsed.data.mime.includes('ogg') ? 'voz.ogg' : 'voz.webm';
      form.append('file', new Blob([audio], { type: parsed.data.mime }), filename);
      form.append('model', 'whisper-large-v3-turbo');
      const res = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', {
        method: 'POST',
        headers: { Authorization: `Bearer ${opts.groqApiKey}` },
        body: form,
      });
      if (!res.ok) {
        const detail = await res.text().catch(() => '');
        return reply.status(502).send({ error: `Whisper error ${res.status}: ${detail.slice(0, 200)}` });
      }
      const json = (await res.json()) as { text?: string };
      return reply.send({ text: (json.text ?? '').trim() });
    } catch (err) {
      return reply.status(502).send({ error: (err as Error).message });
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
