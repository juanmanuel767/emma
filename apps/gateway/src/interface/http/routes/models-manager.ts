import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { probeHardware, hardwareSummary, evaluateForHardware } from '../hardware.js';

// ─────────────────────────────────────────────────────────────────────────────
// Gestor de Modelos (Fase A) — administra los modelos locales de Ollama:
// listar instalados, ver recomendados, instalar/actualizar (con progreso) y eliminar.
// Habla DIRECTAMENTE con Ollama (no toca el agente ni los adaptadores del núcleo).
// ─────────────────────────────────────────────────────────────────────────────

// Catálogo curado de modelos recomendados. Tamaño = descarga aproximada (q4);
// minRamGB = RAM práctica para correrlo con holgura en CPU.
interface RecommendedModel {
  id: string;          // tag exacto de Ollama (lo que se hace `pull`)
  label: string;       // nombre legible
  sizeGB: number;      // tamaño de descarga aprox.
  minRamGB: number;    // RAM mínima recomendada
  role: string;        // para qué sirve
}

const RECOMMENDED: RecommendedModel[] = [
  { id: 'qwen2.5-coder:7b', label: 'Qwen2.5 Coder 7B', sizeGB: 4.7, minRamGB: 8, role: 'código' },
  { id: 'deepseek-r1:7b',   label: 'DeepSeek R1 7B',   sizeGB: 4.7, minRamGB: 8, role: 'razonamiento' },
  { id: 'llama3.2:3b',      label: 'Llama 3.2 3B',     sizeGB: 2.0, minRamGB: 4, role: 'general' },
  { id: 'gemma2:2b',        label: 'Gemma 2 2B',       sizeGB: 1.6, minRamGB: 4, role: 'rápido' },
  { id: 'mistral:7b',       label: 'Mistral 7B',       sizeGB: 4.1, minRamGB: 8, role: 'general' },
  { id: 'moondream',        label: 'Moondream (visión)', sizeGB: 1.7, minRamGB: 4, role: 'visión' },
];

// Prioridad de rol para el onboarding: queremos un asistente general ágil, no visión.
const ONBOARDING_ROLE_RANK: Record<string, number> = { general: 0, código: 1, razonamiento: 2, rápido: 3, visión: 9 };

function humanSize(bytes: number): string {
  if (!bytes || bytes < 0) return '—';
  const gb = bytes / 1e9;
  if (gb >= 1) return `${gb.toFixed(1)} GB`;
  return `${(bytes / 1e6).toFixed(0)} MB`;
}

interface OllamaTag {
  name: string;
  size: number;
  details?: { family?: string; parameter_size?: string; quantization_level?: string };
  modified_at?: string;
}

export const modelManagerRoutes: FastifyPluginAsync<{ ollamaBaseUrl: string }> = async (
  fastify,
  opts,
) => {
  const OLLAMA = opts.ollamaBaseUrl.replace(/\/$/, '');

  async function listInstalled(): Promise<OllamaTag[]> {
    const res = await fetch(`${OLLAMA}/api/tags`, { signal: AbortSignal.timeout(5_000) });
    if (!res.ok) throw new Error(`Ollama respondió ${res.status}`);
    const body = (await res.json()) as { models?: OllamaTag[] };
    return body.models ?? [];
  }

  // ── Modelos instalados ───────────────────────────────────────────────────────
  fastify.get('/ollama/installed', async (_req, reply) => {
    try {
      const models = await listInstalled();
      return {
        models: models.map((m) => ({
          name: m.name,
          provider: 'ollama',
          sizeBytes: m.size,
          size: humanSize(m.size),
          family: m.details?.family ?? null,
          paramSize: m.details?.parameter_size ?? null,
          quant: m.details?.quantization_level ?? null,
          modifiedAt: m.modified_at ?? null,
        })),
      };
    } catch (err) {
      return reply.status(503).send({ error: `Ollama no disponible: ${(err as Error).message}` });
    }
  });

  // ── Hardware del equipo ──────────────────────────────────────────────────────
  fastify.get('/hardware', async () => {
    const hw = probeHardware();
    return { ...hw, summary: hardwareSummary(hw) };
  });

  // ── Modelos recomendados (con marca de "instalado" + aptitud para el hardware) ─
  fastify.get('/ollama/recommended', async (_req, reply) => {
    let installedNames = new Set<string>();
    try {
      installedNames = new Set((await listInstalled()).map((m) => m.name));
    } catch {
      /* si Ollama no responde, devolvemos el catálogo igualmente con installed:false */
    }
    const hw = probeHardware();
    return {
      hardware: hardwareSummary(hw),
      models: RECOMMENDED.map((r) => ({
        ...r,
        provider: 'ollama',
        installed: installedNames.has(r.id) || installedNames.has(`${r.id}:latest`),
        ...evaluateForHardware(hw, r),
      })),
    };
  });

  // ── Eliminar un modelo ───────────────────────────────────────────────────────
  const deleteSchema = z.object({ name: z.string().min(1).max(200) });
  fastify.post('/ollama/delete', async (req, reply) => {
    const body = deleteSchema.safeParse(req.body);
    if (!body.success) return reply.status(400).send({ error: body.error.message });
    try {
      const res = await fetch(`${OLLAMA}/api/delete`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: body.data.name }),
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) {
        const txt = await res.text();
        let msg = txt || `Ollama respondió ${res.status}`;
        try { msg = (JSON.parse(txt) as { error?: string }).error ?? msg; } catch { /* texto plano */ }
        return reply.status(res.status).send({ error: msg });
      }
      return { ok: true };
    } catch (err) {
      return reply.status(503).send({ error: `No se pudo eliminar: ${(err as Error).message}` });
    }
  });

  // ── Onboarding: hardware + mejor modelo apto recomendado para el primer arranque ──
  fastify.get('/onboarding', async () => {
    const hw = probeHardware();
    let installedNames = new Set<string>();
    let ollamaAvailable = false;
    try {
      installedNames = new Set((await listInstalled()).map((m) => m.name));
      ollamaAvailable = true;
    } catch {
      ollamaAvailable = false;
    }

    // Mejor modelo APTO (cabe y no es lento): el más capaz dentro de lo ágil, por rol.
    const apt = RECOMMENDED.map((r) => ({ ...r, ...evaluateForHardware(hw, r) }))
      .filter((r) => r.fits && !r.heavy && r.role !== 'visión')
      .sort((a, b) => {
        const rank = (ONBOARDING_ROLE_RANK[a.role] ?? 5) - (ONBOARDING_ROLE_RANK[b.role] ?? 5);
        return rank !== 0 ? rank : b.sizeGB - a.sizeGB; // mismo rol → el más capaz
      });
    // Si nada es "ágil", caer al más pequeño que al menos quepa.
    const fallback = RECOMMENDED.map((r) => ({ ...r, ...evaluateForHardware(hw, r) }))
      .filter((r) => r.fits && r.role !== 'visión')
      .sort((a, b) => a.sizeGB - b.sizeGB);
    const pick = apt[0] ?? fallback[0] ?? null;

    return {
      ollamaAvailable,
      hardware: hardwareSummary(hw),
      recommended: pick
        ? {
            id: pick.id,
            label: pick.label,
            sizeGB: pick.sizeGB,
            minRamGB: pick.minRamGB,
            role: pick.role,
            installed: installedNames.has(pick.id) || installedNames.has(`${pick.id}:latest`),
          }
        : null,
    };
  });

  // ── Instalar / Actualizar con progreso (SSE) ─────────────────────────────────
  // Replica el patrón hijack+CORS de /chat: hijack() se salta @fastify/cors,
  // así que las cabeceras CORS se escriben a mano o el navegador bloquea el stream.
  const pullSchema = z.object({ name: z.string().min(1).max(200) });
  fastify.post('/ollama/pull', async (req, reply) => {
    const body = pullSchema.safeParse(req.body);
    if (!body.success) return reply.status(400).send({ error: body.error.message });
    const name = body.data.name;

    const origin = req.headers.origin;
    reply.hijack();
    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
      ...(origin
        ? { 'Access-Control-Allow-Origin': origin, 'Access-Control-Allow-Credentials': 'true', 'Vary': 'Origin' }
        : {}),
    });
    const send = (event: string, data: unknown) =>
      reply.raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

    const ac = new AbortController();
    reply.raw.on('close', () => ac.abort());

    try {
      const res = await fetch(`${OLLAMA}/api/pull`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, stream: true }),
        signal: ac.signal,
      });
      if (!res.ok || !res.body) {
        send('error', { error: `Ollama respondió ${res.status}` });
        return reply.raw.end();
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';
        for (const line of lines) {
          if (!line.trim()) continue;
          let obj: { status?: string; total?: number; completed?: number; error?: string };
          try { obj = JSON.parse(line); } catch { continue; }
          if (obj.error) { send('error', { error: obj.error }); continue; }
          const total = obj.total ?? 0;
          const completed = obj.completed ?? 0;
          const percent = total > 0 ? Math.round((completed / total) * 100) : null;
          send('progress', { status: obj.status ?? '', completed, total, percent });
        }
      }
      send('done', { name });
    } catch (err) {
      if (!ac.signal.aborted) send('error', { error: (err as Error).message });
    } finally {
      reply.raw.end();
    }
  });
};
