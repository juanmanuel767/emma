import { spawn } from 'node:child_process';
import { z } from 'zod';
import { PermissionDeniedError } from '@emma/shared/errors';
import type { ITool, ToolContext, ToolResult } from '../registry/ITool.js';

const inputSchema = z.object({
  command: z.string().describe('The command to execute'),
  args: z.array(z.string()).optional().default([]).describe('Command arguments'),
  cwd: z.string().optional().describe('Working directory'),
});

type Input = z.infer<typeof inputSchema>;

const ALLOWED_COMMANDS = new Set([
  // `env`/`printenv` quedan FUERA a propósito: el proceso del agente tiene todas las
  // claves (GROQ, OPENCODE, TELEGRAM, DATABASE_URL…) en process.env; volcarlas = fuga.
  'ls', 'cat', 'pwd', 'echo', 'find', 'grep', 'git', 'node', 'npm',
  'pnpm', 'curl', 'wget', 'df', 'du', 'ps', 'which', 'date',
  'wc', 'head', 'tail', 'sort', 'uniq', 'cut', 'tr', 'sed', 'awk',
  'mkdir', 'touch', 'cp', 'mv', 'diff', 'tar', 'zip', 'unzip',
  'gh',
]);

const BLOCKED_PATTERNS = [
  /rm\s+-rf\s+\//,
  /sudo/,
  />\s*\/etc\//,
  /\|\s*sh$/,
  /\|\s*bash$/,
  /eval\s*\(/,
  /chmod\s+777/,
  /\/dev\/null.*rm/,
  // Volcado de variables de entorno por otras vías (set, printenv, declare, /proc/self/environ).
  /\b(printenv|set|declare|export)\b/,
  /\/proc\/\d*\/environ/,
];

const BLOCKED_PATHS = ['/etc/shadow', '/etc/passwd', '/root/.ssh', '/home/user/.ssh'];

// Archivos cuyo CONTENIDO es secreto: nunca leerlos por comando, sea cual sea el verbo
// (cat/head/tail/grep/sed/awk/cut/sort/diff/find…). Se evalúa sobre cada argumento.
const SECRET_FILE_RE = /(^|\/)\.env(\.|$)|\.env$|(^|\/)\.env(\.[\w-]+)?$|\.(pem|key|p12|pfx)$|(^|\/)(id_rsa|id_ed25519|id_dsa|credentials|\.npmrc|\.pgpass|\.netrc)$/i;
const MAX_EXECUTION_MS = 15_000;

export class CommandTool implements ITool<Input, string> {
  readonly name = 'execute_command';
  readonly description =
    'Execute a shell command on the local system. Only whitelisted commands are allowed for security.';
  readonly inputSchema = inputSchema;

  async execute(input: Input, ctx: ToolContext): Promise<ToolResult<string>> {
    // Los modelos a veces mandan el comando entero en `command` ("gh repo list")
    // en vez de separarlo. Lo normalizamos: primer token = comando, resto = args.
    const norm = this.#normalize(input);
    this.#validate(norm);

    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        child.kill('SIGTERM');
        resolve({ success: false, error: `Command timed out after ${MAX_EXECUTION_MS}ms` });
      }, MAX_EXECUTION_MS);

      const child = spawn(norm.command, norm.args ?? [], {
        cwd: norm.cwd ?? process.cwd(),
        shell: false,
        signal: ctx.signal,
      });

      let stdout = '';
      let stderr = '';

      child.stdout.on('data', (d: Buffer) => { stdout += d.toString(); });
      child.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });

      child.on('close', (code) => {
        clearTimeout(timer);
        const output = (stdout + (stderr ? `\nSTDERR: ${stderr}` : '')).trim();
        if (code === 0 || code === null) {
          resolve({ success: true, data: output || '(no output)' });
        } else {
          resolve({ success: false, error: output || `Process exited with code ${code}` });
        }
      });

      child.on('error', (err) => {
        clearTimeout(timer);
        resolve({ success: false, error: err.message });
      });
    });
  }

  // Separa "gh repo list --title \"x y\"" en command + args, respetando comillas.
  #normalize(input: Input): Input {
    if (!input.command.includes(' ')) return input;
    const tokens: string[] = [];
    const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(input.command)) !== null) tokens.push(m[1] ?? m[2] ?? m[3] ?? '');
    if (tokens.length === 0) return input;
    return { ...input, command: tokens[0]!, args: [...tokens.slice(1), ...(input.args ?? [])] };
  }

  #validate(input: Input): void {
    if (!ALLOWED_COMMANDS.has(input.command)) {
      throw new PermissionDeniedError(`execute command '${input.command}'`);
    }

    const fullCommand = [input.command, ...(input.args ?? [])].join(' ');

    for (const pattern of BLOCKED_PATTERNS) {
      if (pattern.test(fullCommand)) {
        throw new PermissionDeniedError(`execute command with blocked pattern`);
      }
    }

    for (const blocked of input.args ?? []) {
      if (BLOCKED_PATHS.some((p) => blocked.startsWith(p))) {
        throw new PermissionDeniedError(`access path '${blocked}'`);
      }
      if (SECRET_FILE_RE.test(blocked)) {
        throw new PermissionDeniedError(`read secret file '${blocked}'`);
      }
    }
    // El secreto puede ir embebido en el propio `command` (p.ej. cat .env mal tokenizado).
    if (SECRET_FILE_RE.test(fullCommand)) {
      throw new PermissionDeniedError(`read secret file`);
    }
  }
}
