import { readFile, writeFile, readdir, stat } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { z } from 'zod';
import { PermissionDeniedError } from '@emma/shared/errors';
import type { ITool, ToolContext, ToolResult } from '../registry/ITool.js';

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
    'Read, write, or list files. Write access is restricted to /tmp/emma. Read access is limited to the home directory.';
  readonly inputSchema = inputSchema;

  async execute(input: Input, _ctx: ToolContext): Promise<ToolResult> {
    const path = resolve(input.path);

    if (input.action === 'read') {
      this.#assertReadPermission(path);
      try {
        const content = await readFile(path, input.encoding as BufferEncoding);
        return { success: true, data: content };
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
