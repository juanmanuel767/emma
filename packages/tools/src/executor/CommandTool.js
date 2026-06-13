import { spawn } from 'node:child_process';
import { z } from 'zod';
import { PermissionDeniedError } from '@emma/shared/errors';
const inputSchema = z.object({
    command: z.string().describe('The command to execute'),
    args: z.array(z.string()).optional().default([]).describe('Command arguments'),
    cwd: z.string().optional().describe('Working directory'),
});
const ALLOWED_COMMANDS = new Set([
    'ls', 'cat', 'pwd', 'echo', 'find', 'grep', 'git', 'node', 'npm',
    'pnpm', 'curl', 'wget', 'df', 'du', 'ps', 'env', 'which', 'date',
    'wc', 'head', 'tail', 'sort', 'uniq', 'cut', 'tr', 'sed', 'awk',
    'mkdir', 'touch', 'cp', 'mv', 'diff', 'tar', 'zip', 'unzip',
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
];
const BLOCKED_PATHS = ['/etc/shadow', '/etc/passwd', '/root/.ssh', '/home/user/.ssh'];
const MAX_EXECUTION_MS = 15_000;
export class CommandTool {
    name = 'execute_command';
    description = 'Execute a shell command on the local system. Only whitelisted commands are allowed for security.';
    inputSchema = inputSchema;
    async execute(input, ctx) {
        this.#validate(input);
        return new Promise((resolve) => {
            const timer = setTimeout(() => {
                child.kill('SIGTERM');
                resolve({ success: false, error: `Command timed out after ${MAX_EXECUTION_MS}ms` });
            }, MAX_EXECUTION_MS);
            const child = spawn(input.command, input.args ?? [], {
                cwd: input.cwd ?? process.cwd(),
                shell: false,
                signal: ctx.signal,
            });
            let stdout = '';
            let stderr = '';
            child.stdout.on('data', (d) => { stdout += d.toString(); });
            child.stderr.on('data', (d) => { stderr += d.toString(); });
            child.on('close', (code) => {
                clearTimeout(timer);
                const output = (stdout + (stderr ? `\nSTDERR: ${stderr}` : '')).trim();
                if (code === 0 || code === null) {
                    resolve({ success: true, data: output || '(no output)' });
                }
                else {
                    resolve({ success: false, error: output || `Process exited with code ${code}` });
                }
            });
            child.on('error', (err) => {
                clearTimeout(timer);
                resolve({ success: false, error: err.message });
            });
        });
    }
    #validate(input) {
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
        }
    }
}
//# sourceMappingURL=CommandTool.js.map