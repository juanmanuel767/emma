import { z } from 'zod';
import type { ISkill } from '@emma/skills';
import type { ITool, ToolContext, ToolResult } from '@emma/tools';
import type { IMemoryRepository } from '@emma/core/ports';
import { createLogger } from '@emma/shared/logger';

const logger = createLogger('MemorySkill');

// Misma clave estable que usa RunConversation para el perfil GLOBAL del señor.
const PROFILE_KEY = 'profile:user';

function normalize(s: string): string {
  return s
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9 ]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Herramientas de memoria de perfil: permiten al señor inspeccionar lo que Emma sabe de él
 * ("¿qué sabes de mí?", "¿de dónde sabes eso?") y ordenar que olvide un dato ("olvida que…").
 * Operan sobre el perfil GLOBAL (sessionId='profile:user'), no sobre la sesión efímera.
 */
export function createMemorySkill(memoryRepo: IMemoryRepository): ISkill {
  const forgetFact: ITool = {
    name: 'forget_fact',
    description:
      'Olvida (borra del perfil permanente) uno o más hechos que Emma sabe del señor. Úsalo cuando el señor pida "olvida que…", "ya no…", "borra de mi perfil…" o corrija un dato. Recibe una descripción del hecho a olvidar; borra los hechos del perfil cuyo texto coincida.',
    inputSchema: z.object({
      query: z.string().min(2).describe('Descripción del hecho a olvidar, p.ej. "que vivo en Bogotá".'),
    }),
    async execute(input: unknown, _ctx: ToolContext): Promise<ToolResult> {
      const query = String((input as { query?: unknown })?.query ?? '').trim();
      if (query.length < 2) return { success: false, error: 'Indica qué hecho debo olvidar.' };
      let rows;
      try {
        rows = await memoryRepo.listBySession(PROFILE_KEY, 200);
      } catch (err) {
        logger.warn({ err }, 'No se pudo leer el perfil para olvidar');
        return { success: false, error: 'No pude acceder a la memoria de perfil.' };
      }
      const q = normalize(query);
      const qWords = q.split(' ').filter((w) => w.length > 3);
      const matches = rows.filter((r) => {
        const n = normalize(r.content);
        if (n.includes(q) || q.includes(n)) return true;
        // Solapamiento por palabras significativas (al menos la mitad presentes).
        if (qWords.length === 0) return false;
        const hits = qWords.filter((w) => n.includes(w)).length;
        return hits >= Math.ceil(qWords.length / 2);
      });
      if (matches.length === 0) {
        return { success: true, data: { forgotten: [], message: 'No encontré ningún hecho que coincida con eso en el perfil.' } };
      }
      const forgotten: string[] = [];
      for (const m of matches) {
        try {
          if (await memoryRepo.deleteById(m.id)) forgotten.push(m.content);
        } catch (err) {
          logger.warn({ err, id: m.id }, 'No se pudo olvidar un hecho');
        }
      }
      logger.info({ forgotten }, 'Hechos olvidados por orden del señor');
      return { success: true, data: { forgotten, count: forgotten.length } };
    },
  };

  const listFacts: ITool = {
    name: 'list_known_facts',
    description:
      'Lista los hechos que Emma sabe del señor en su perfil permanente, con su procedencia (cuándo se aprendió). Úsalo si el señor pregunta "¿qué sabes de mí?", "¿qué recuerdas?", "¿de dónde sabes eso?".',
    inputSchema: z.object({}),
    async execute(_input: unknown, _ctx: ToolContext): Promise<ToolResult> {
      let rows;
      try {
        rows = await memoryRepo.listBySession(PROFILE_KEY, 200);
      } catch (err) {
        logger.warn({ err }, 'No se pudo leer el perfil');
        return { success: false, error: 'No pude acceder a la memoria de perfil.' };
      }
      const facts = rows.map((r) => {
        const meta = (r.metadata ?? {}) as { learnedAt?: unknown };
        const learnedAt = typeof meta.learnedAt === 'string' ? meta.learnedAt : r.createdAt?.toISOString?.();
        return { fact: r.content, learnedAt: learnedAt ?? null };
      });
      return { success: true, data: { count: facts.length, facts } };
    },
  };

  return {
    name: 'profile-memory',
    version: '1.0.0',
    description: 'Inspección y olvido de los hechos que Emma conoce del señor (perfil permanente).',
    tools: [forgetFact, listFacts],
  };
}
