import { readFile, writeFile, readdir, stat, mkdir } from 'node:fs/promises';
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

// Extractor de Office (Word/Excel) en Python con SOLO stdlib (zipfile+xml): docx y xlsx son
// ZIP+XML, así que no hace falta LibreOffice (pesado) ni librerías externas. Se escribe una vez
// en /tmp/emma y se invoca con (ruta, tipo). String.raw preserva los \t y \n del script.
const OFFICE_SCRIPT_PATH = '/tmp/emma/.office_extract.py';
const OFFICE_SCRIPT = String.raw`import sys, zipfile
from xml.etree import ElementTree as ET
path, kind = sys.argv[1], sys.argv[2]
z = zipfile.ZipFile(path)
def ln(tag): return tag.rsplit('}', 1)[-1]
if kind == 'docx':
    root = ET.fromstring(z.read('word/document.xml'))
    out = []
    for p in root.iter():
        if ln(p.tag) == 'p':
            out.append(''.join(n.text for n in p.iter() if ln(n.tag) == 't' and n.text))
    print('\n'.join(out))
else:
    shared = []
    try:
        ss = ET.fromstring(z.read('xl/sharedStrings.xml'))
        for si in ss:
            if ln(si.tag) == 'si':
                shared.append(''.join(t.text or '' for t in si.iter() if ln(t.tag) == 't'))
    except KeyError:
        pass
    sheets = sorted(n for n in z.namelist() if n.startswith('xl/worksheets/sheet') and n.endswith('.xml'))
    for name in sheets:
        root = ET.fromstring(z.read(name))
        for row in root.iter():
            if ln(row.tag) != 'row':
                continue
            cells = []
            for c in row:
                if ln(c.tag) != 'c':
                    continue
                t = c.get('t')
                v = None
                for ch in c:
                    if ln(ch.tag) == 'v':
                        v = ch.text
                    elif ln(ch.tag) == 'is':
                        v = ''.join(x.text or '' for x in ch.iter() if ln(x.tag) == 't')
                if v is None:
                    cells.append('')
                elif t == 's':
                    cells.append(shared[int(v)] if v.isdigit() and int(v) < len(shared) else '')
                else:
                    cells.append(v)
            print('\t'.join(cells))
`;

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
    'Read, write, or list files. Write access is restricted to /tmp/emma. Read access is limited to the home directory. PDF, Word (.docx) and Excel (.xlsx) files are automatically extracted to plain text — use action "read" on them to get their content. Attachments uploaded by the user live in /tmp/emma/.';
  readonly inputSchema = inputSchema;

  async execute(input: Input, _ctx: ToolContext): Promise<ToolResult> {
    const path = resolve(input.path);

    if (input.action === 'read') {
      this.#assertReadPermission(path);
      try {
        // PDF / Word / Excel → extraer texto (leerlos como utf8 daría binario ilegible y enorme)
        if (input.encoding !== 'base64') {
          const ext = extname(path).toLowerCase();
          if (ext === '.pdf') {
            return { success: true, data: this.#cap(await this.#extractPdfText(path)) };
          }
          if (ext === '.docx' || ext === '.xlsx') {
            const kind = ext === '.docx' ? 'docx' : 'xlsx';
            return { success: true, data: this.#cap(await this.#extractOfficeText(path, kind)) };
          }
          if (ext === '.doc' || ext === '.xls') {
            return {
              success: true,
              data: `[El archivo '${path}' está en formato Office antiguo (${ext}, binario OLE) que no puedo extraer directamente. Si lo guarda como ${ext === '.doc' ? '.docx' : '.xlsx'} podré leerlo, señor.]`,
            };
          }
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

  /** Extrae el texto de un Word (.docx) o Excel (.xlsx) con un script Python de solo stdlib. */
  async #extractOfficeText(path: string, kind: 'docx' | 'xlsx'): Promise<string> {
    try {
      await mkdir('/tmp/emma', { recursive: true });
      await writeFile(OFFICE_SCRIPT_PATH, OFFICE_SCRIPT, 'utf8');
      const { stdout } = await execFileAsync('python3', [OFFICE_SCRIPT_PATH, path, kind], {
        maxBuffer: 10 * 1024 * 1024,
      });
      const text = stdout.trim();
      const label = kind === 'docx' ? 'documento de Word' : 'hoja de Excel';
      return text || `[El ${label} no contiene texto extraíble, señor.]`;
    } catch (err) {
      return `[No pude extraer el texto del ${kind}: ${(err as Error).message}.]`;
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
