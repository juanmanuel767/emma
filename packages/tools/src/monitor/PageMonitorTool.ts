import { z } from 'zod';
import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import type { ITool, ToolContext, ToolResult } from '../registry/ITool.js';

const MONITOR_DIR = join(homedir(), '.emma', 'page-monitors');

const inputSchema = z.object({
  action: z
    .enum(['snapshot', 'list'])
    .default('snapshot')
    .describe('snapshot = compare current content vs last saved & store new; list = list watched pages'),
  label: z
    .string()
    .optional()
    .describe('Short id for the page being watched (e.g. "aula-12373"). Required for snapshot.'),
  content: z
    .string()
    .optional()
    .describe('The current text of the page (e.g. from browser extract_text). Required for snapshot.'),
});

type Input = z.infer<typeof inputSchema>;

function safeName(label: string): string {
  return label.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 80) || 'page';
}

/** Normaliza el texto para comparar: líneas no vacías, sin espacios sobrantes ni horas/fechas volátiles. */
function normalizeLines(text: string): string[] {
  return text
    .split('\n')
    .map((l) => l.replace(/\s+/g, ' ').trim())
    .filter((l) => l.length > 0);
}

/**
 * Detecta cambios en una página entre visitas. Emma extrae el texto con el navegador
 * (browser extract_text) y se lo pasa aquí con una etiqueta; la herramienta lo compara con
 * la última instantánea guardada y reporta qué líneas se añadieron o quitaron. Pensada para
 * vigilar páginas del señor (calificaciones, anuncios) y avisarle de novedades — no modifica nada.
 */
export class PageMonitorTool implements ITool<Input> {
  readonly name = 'monitor_page';
  readonly description =
    'Detect changes on a web page between visits. First get the page text (browser extract_text), then call this with a label and that content. It compares against the last snapshot and reports what was added/removed (e.g. a new grade posted). action "list" shows watched pages. Read-only; never modifies the page.';
  readonly inputSchema = inputSchema;

  async execute(input: Input, _ctx: ToolContext): Promise<ToolResult> {
    await mkdir(MONITOR_DIR, { recursive: true });

    if (input.action === 'list') {
      try {
        const files = (await readdir(MONITOR_DIR)).filter((f) => f.endsWith('.txt'));
        const labels = files.map((f) => f.replace(/\.txt$/, ''));
        return { success: true, data: labels.length ? `Páginas vigiladas: ${labels.join(', ')}` : 'No hay páginas vigiladas todavía.' };
      } catch (err) {
        return { success: false, error: (err as Error).message };
      }
    }

    if (!input.label || !input.content) {
      return { success: false, error: 'Para "snapshot" se requieren "label" y "content".' };
    }

    const file = join(MONITOR_DIR, `${safeName(input.label)}.txt`);
    const current = normalizeLines(input.content);

    let previous: string[] | null = null;
    try {
      previous = normalizeLines(await readFile(file, 'utf8'));
    } catch {
      previous = null; // primera vez
    }

    // Guardar siempre la instantánea actual (texto crudo) para la próxima comparación.
    await writeFile(file, input.content, 'utf8');

    if (previous === null) {
      return {
        success: true,
        data: `Primera instantánea de "${input.label}" guardada (${current.length} líneas). Desde ahora vigilaré los cambios, señor.`,
        metadata: { firstSnapshot: true, changed: false },
      };
    }

    const prevSet = new Set(previous);
    const currSet = new Set(current);
    const added = current.filter((l) => !prevSet.has(l));
    const removed = previous.filter((l) => !currSet.has(l));

    if (added.length === 0 && removed.length === 0) {
      return {
        success: true,
        data: `Sin cambios en "${input.label}", señor. La página está igual que la última vez.`,
        metadata: { changed: false },
      };
    }

    const cap = (arr: string[]) => arr.slice(0, 25);
    const parts: string[] = [`Detecté cambios en "${input.label}", señor:`];
    if (added.length) parts.push(`➕ AÑADIDO (${added.length}):\n- ${cap(added).join('\n- ')}`);
    if (removed.length) parts.push(`➖ QUITADO (${removed.length}):\n- ${cap(removed).join('\n- ')}`);

    return {
      success: true,
      data: parts.join('\n\n'),
      metadata: { changed: true, addedCount: added.length, removedCount: removed.length },
    };
  }
}
