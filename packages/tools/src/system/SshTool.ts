import { z } from 'zod';
import { spawn } from 'node:child_process';
import type { ITool, ToolContext, ToolResult } from '../registry/ITool.js';
import { createLogger } from '@emma/shared/logger';

const logger = createLogger('SshTool');

// ── Input schema ──────────────────────────────────────────────────────────────
const inputSchema = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('execute'),
    host: z.string().describe('Remote host (e.g. "192.168.1.10", "user@host")'),
    command: z.string().describe('Command to execute on the remote host'),
    port: z.coerce.number().default(22).describe('SSH port (default 22)'),
    username: z.string().optional().describe('SSH username (overrides user@ in host)'),
    identity_file: z.string().optional().describe('Path to private key file (e.g. ~/.ssh/id_rsa)'),
    password: z.string().optional().describe('SSH password (prefer key-based auth)'),
    timeout: z.coerce.number().default(30).describe('Timeout in seconds (default 30)'),
    strict_host_key_checking: z.boolean().default(false).describe('Whether to verify host key (default: false for convenience)'),
  }),
  z.object({
    action: z.literal('test'),
    host: z.string().describe('Remote host to test connectivity'),
    port: z.coerce.number().default(22).describe('SSH port (default 22)'),
    username: z.string().optional().describe('SSH username'),
    identity_file: z.string().optional().describe('Path to private key file'),
    timeout: z.coerce.number().default(10).describe('Timeout in seconds (default 10)'),
    strict_host_key_checking: z.boolean().default(false).describe('Whether to verify host key'),
  }),
]);

type Input = z.infer<typeof inputSchema>;

// ── Tool implementation ───────────────────────────────────────────────────────
export class SshTool implements ITool<Input, string> {
  readonly name = 'ssh_execute';
  readonly description =
    'SSH into a remote host and execute commands. Supports key-based and password authentication. ' +
    'Actions: execute (run a command and return output), test (check if SSH connection works).';

  readonly inputSchema = inputSchema;

  async execute(input: Input, _ctx: ToolContext): Promise<ToolResult<string>> {
    try {
      if (input.action === 'execute') {
        return this.#executeRemote(input);
      } else {
        return this.#testConnection(input);
      }
    } catch (err) {
      logger.error({ err }, 'SshTool error');
      return { success: false, error: String(err) };
    }
  }

  async #executeRemote(input: Extract<Input, { action: 'execute' }>): Promise<ToolResult<string>> {
    const { host, command, port, username, identity_file, timeout, strict_host_key_checking } =
      input;

    const [resolvedUser, resolvedHost] = this.#parseHost(host, username);
    const target = resolvedUser ? `${resolvedUser}@${resolvedHost}` : resolvedHost;

    const args = this.#buildSshArgs({
      target,
      port,
      identityFile: identity_file,
      timeout,
      strictHostKeyChecking: strict_host_key_checking,
      command,
    });

    logger.info({ target, command, port }, 'SSH execute');

    return new Promise<ToolResult<string>>((resolve) => {
      const proc = spawn('ssh', args, {
        timeout: timeout * 1000,
        env: { ...process.env, SSH_ASKPASS: '', SSH_ASKPASS_REQUIRE: 'never' },
      });

      let stdout = '';
      let stderr = '';

      proc.stdout.on('data', (d: Buffer) => {
        stdout += d.toString();
      });
      proc.stderr.on('data', (d: Buffer) => {
        stderr += d.toString();
      });

      proc.on('close', (code: number | null) => {
        if (code === 0) {
          resolve({
            success: true,
            data: stdout || '(command produced no output)',
            metadata: { exitCode: 0, host: resolvedHost, command },
          });
        } else {
          const errMsg = stderr.trim() || `Process exited with code ${code}`;
          resolve({
            success: false,
            error: errMsg,
            metadata: { exitCode: code, host: resolvedHost, command, stdout: stdout.trim() },
          });
        }
      });

      proc.on('error', (err: Error) => {
        resolve({ success: false, error: `Failed to spawn ssh: ${err.message}` });
      });
    });
  }

  async #testConnection(
    input: Extract<Input, { action: 'test' }>,
  ): Promise<ToolResult<string>> {
    const { host, port, username, identity_file, timeout, strict_host_key_checking } = input;
    const [resolvedUser, resolvedHost] = this.#parseHost(host, username);
    const target = resolvedUser ? `${resolvedUser}@${resolvedHost}` : resolvedHost;

    const args = this.#buildSshArgs({
      target,
      port,
      identityFile: identity_file,
      timeout,
      strictHostKeyChecking: strict_host_key_checking,
      command: 'echo SSH_OK',
    });

    logger.info({ target, port }, 'SSH test');

    return new Promise<ToolResult<string>>((resolve) => {
      const proc = spawn('ssh', args, {
        timeout: timeout * 1000,
        env: { ...process.env, SSH_ASKPASS: '', SSH_ASKPASS_REQUIRE: 'never' },
      });

      let stdout = '';
      let stderr = '';

      proc.stdout.on('data', (d: Buffer) => {
        stdout += d.toString();
      });
      proc.stderr.on('data', (d: Buffer) => {
        stderr += d.toString();
      });

      proc.on('close', (code: number | null) => {
        if (code === 0 && stdout.includes('SSH_OK')) {
          resolve({
            success: true,
            data: `SSH connection to ${target}:${port} is working`,
            metadata: { host: resolvedHost, port },
          });
        } else {
          resolve({
            success: false,
            error: stderr.trim() || `Connection failed (exit code ${code})`,
            metadata: { host: resolvedHost, port },
          });
        }
      });

      proc.on('error', (err: Error) => {
        resolve({ success: false, error: `Failed to spawn ssh: ${err.message}` });
      });
    });
  }

  /** Parse "user@host" or just "host", allowing username override. */
  #parseHost(host: string, usernameOverride?: string): [string | undefined, string] {
    const atIdx = host.indexOf('@');
    if (atIdx > 0) {
      const parsed = host.slice(atIdx + 1);
      const user = usernameOverride ?? host.slice(0, atIdx);
      return [user, parsed];
    }
    return [usernameOverride, host];
  }

  #buildSshArgs(opts: {
    target: string;
    port: number;
    identityFile?: string;
    timeout: number;
    strictHostKeyChecking: boolean;
    command: string;
  }): string[] {
    const { target, port, identityFile, timeout, strictHostKeyChecking, command } = opts;
    const args: string[] = [
      '-p', String(port),
      '-o', `ConnectTimeout=${timeout}`,
      '-o', `StrictHostKeyChecking=${strictHostKeyChecking ? 'yes' : 'no'}`,
      '-o', 'BatchMode=yes',
      '-o', 'PasswordAuthentication=no',
    ];

    if (identityFile) {
      args.push('-i', identityFile);
    }

    args.push(target, command);
    return args;
  }
}
