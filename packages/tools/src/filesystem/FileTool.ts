import { readFile, writeFile, readdir, stat } from 'node:fs/promises';
import { resolve, join, extname } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { z } from 'zod';
import { PermissionDeniedError } from '@emma/shared/errors';
import type { ITool, ToolContext, ToolResult } from '../registry/ITool.js';

const execFileAsync = promisify(execFile);

// Tope de texto devuelto al modelo: un archivo enorme (o un PDF largo) reventaría el límite
// de tokens/minuto del proveedor gratis (Groq: 12k TPM) y rompería el bucle de herramientas.
const MAX_TEXT_CHARS = 24_000;

const ALLOWED_READ_PREFIXES = [
  process.env['HOME'] ?? '/home/user',
  '/tmp/emma',
];

const ALLOWED_WRITE_PREFIXES = ['/tmp/emma'];

const BLOCKED_PATHS = ['.ssh', '.env', 'shadow', 'passwd'];

const inputSchema = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('read'),
    path: z.string(),
    encoding: z.enum(['utf8', 'base64']).optional().default('utf8'),
  }),
  z.object({
    action: z.literal('write'),
    path: z.string(),
    content: z.string(),
  }),
  z.object({
    action: z.literal('list'),
    path: z.string(),
  }),
  z.object({
    action: z.literal('stat'),
    path: z.string(),
  }),
]);

type Input = z.infer<typeof inputSchema>;

export class FileTool implements ITool<Input> {
  readonly name = 'file_system';
  readonly description =
    'Read, write, or list files. Write access is restricted to /tmp/emma. Read access is limited to the home directory. PDF files are automatically extracted to plain text — use action "read" on a .pdf to get its text content. Attachments uploaded by the user live in /tmp/emma/.';
  readonly inputSchema = inputSchema;

  async execute(input: Input, _ctx: ToolContext): Promise<ToolResult> {
    const path = resolve(input.path);

    if (input.action === 'read') {
      this.#assertReadPermission(path);
      try {
        // PDF → extraer texto con pdftotext (leerlo como utf8 daría binario ilegible y enorme)
        if (input.encoding !== 'base64' && extname(path).toLowerCase() === '.pdf') {
          return { success: true, data: this.#cap(await this.#extractPdfText(path)) };
        }
        const content = await readFile(path, input.encoding as BufferEncoding);
        // Si pidieron texto pero el archivo es binario, no devolver "mojibake" (engaña al modelo
        // y dispara el límite de tokens). Avisar con claridad.
        if (input.encoding !== 'base64' && this.#looksBinary(content)) {
          return {
            success: true,
            data: `[El archivo '${path}' (${extname(path) || 'sin extensión'}) es binario, no texto legible. Si es un documento, pídame extraer su contenido; si es una imagen, puedo analizarla con visión.]`,
          };
        }
        return { success: true, data: this.#cap(content) };
      } catch (err) {
        return { success: false, error: `Cannot read '${path}': ${(err as Error).message}` };
      }
    }

    if (input.action === 'write') {
      this.#assertWritePermission(path);
      try {
        await writeFile(path, input.content, 'utf8');
        return { success: true, data: `Written to '${path}'` };
      } catch (err) {
        return { success: false, error: `Cannot write '${path}': ${(err as Error).message}` };
      }
    }

    if (input.action === 'list') {
      this.#assertReadPermission(path);
      try {
        const entries = await readdir(path, { withFileTypes: true });
        const listing = entries.map((e) => `${e.isDirectory() ? 'd' : 'f'} ${e.name}`).join('\n');
        return { success: true, data: listing };
      } catch (err) {
        return { success: false, error: `Cannot list '${path}': ${(err as Error).message}` };
      }
    }

    if (input.action === 'stat') {
      this.#assertReadPermission(path);
      try {
        const info = await stat(path);
        return {
          success: true,
          data: JSON.stringify({
            size: info.size,
            isDirectory: info.isDirectory(),
            isFile: info.isFile(),
            modified: info.mtime.toISOString(),
          }),
        };
      } catch (err) {
        return { success: false, error: `Cannot stat '${path}': ${(err as Error).message}` };
      }
    }

    return { success: false, error: 'Unknown action' };
  }

  /** Extrae el texto de un PDF con poppler (pdftotext). */
  async #extractPdfText(path: string): Promise<string> {
    try {
      const { stdout } = await execFileAsync('pdftotext', ['-q', '-enc', 'UTF-8', path, '-'], {
        maxBuffer: 10 * 1024 * 1024,
      });
      const text = stdout.trim();
      return (
        text ||
        '[El PDF no contiene texto extraíble (probablemente es escaneado/imagen). Puedo intentar analizarlo como imagen si lo desea, señor.]'
      );
    } catch (err) {
      return `[No pude extraer el texto del PDF: ${(err as Error).message}. ¿pdftotext (poppler-utils) está instalado?]`;
    }
  }

  /** Heurística: ¿el contenido parece binario y no texto? (null bytes o muchos caracteres de reemplazo) */
  #looksBinary(content: string): boolean {
    const sample = content.slice(0, 2000);
    if (sample.includes('\u0000')) return true;
    let bad = 0;
    for (const ch of sample) if (ch === '\uFFFD') bad += 1;
    return sample.length > 0 && bad > sample.length * 0.05;
  }

  /** Trunca textos enormes para no reventar el límite de tokens del proveedor. */
  #cap(text: string): string {
    if (text.length <= MAX_TEXT_CHARS) return text;
    return `${text.slice(0, MAX_TEXT_CHARS)}\n[…truncado: ${text.length} caracteres en total]`;
  }

  #assertReadPermission(path: string): void {
    const allowed = ALLOWED_READ_PREFIXES.some((prefix) => path.startsWith(resolve(prefix)));
    const blocked = BLOCKED_PATHS.some((p) => path.includes(p));
    if (!allowed || blocked) throw new PermissionDeniedError(`read path '${path}'`);
  }

  #assertWritePermission(path: string): void {
    const allowed = ALLOWED_WRITE_PREFIXES.some((prefix) => path.startsWith(resolve(prefix)));
    if (!allowed) throw new PermissionDeniedError(`write path '${path}'`);
  }
}
