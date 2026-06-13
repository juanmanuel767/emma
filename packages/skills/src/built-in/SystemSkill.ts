import { z } from 'zod';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile } from 'node:fs/promises';
import type { ISkill } from '../types.js';
import type { ITool, ToolContext, ToolResult } from '@emma/tools';
import os from 'node:os';

const execFileAsync = promisify(execFile);

const systemInfoSchema = z.object({
  include: z.array(z.enum(['cpu', 'memory', 'disk', 'network', 'uptime', 'processes'])).default(['cpu', 'memory', 'uptime']),
});

async function getCpuInfo(): Promise<Record<string, unknown>> {
  const cpus = os.cpus();
  const model = cpus[0]?.model ?? 'unknown';
  const cores = cpus.length;
  const loadAvg = os.loadavg();
  return { model, cores, load_1m: loadAvg[0]?.toFixed(2), load_5m: loadAvg[1]?.toFixed(2) };
}

async function getMemoryInfo(): Promise<Record<string, unknown>> {
  const total = os.totalmem();
  const free = os.freemem();
  const used = total - free;
  const toMB = (b: number) => Math.round(b / 1024 / 1024);
  return {
    total_mb: toMB(total),
    used_mb: toMB(used),
    free_mb: toMB(free),
    usage_pct: ((used / total) * 100).toFixed(1) + '%',
  };
}

async function getDiskInfo(): Promise<Record<string, unknown>> {
  try {
    const { stdout } = await execFileAsync('df', ['-h', '/'], { timeout: 5000 });
    const lines = stdout.trim().split('\n');
    const parts = lines[1]?.split(/\s+/) ?? [];
    return {
      filesystem: parts[0] ?? 'unknown',
      size: parts[1] ?? '?',
      used: parts[2] ?? '?',
      available: parts[3] ?? '?',
      usage_pct: parts[4] ?? '?',
    };
  } catch {
    return { error: 'disk info unavailable' };
  }
}

async function getTopProcesses(): Promise<string[]> {
  try {
    const { stdout } = await execFileAsync('ps', ['aux', '--sort=-%cpu'], { timeout: 5000 });
    return stdout.split('\n').slice(1, 6).map((l) => l.trim()).filter(Boolean);
  } catch {
    return [];
  }
}

const systemInfoTool: ITool = {
  name: 'get_system_info',
  description: 'Get system information: CPU usage, memory, disk space, uptime, and running processes.',
  inputSchema: systemInfoSchema,
  async execute(input: z.infer<typeof systemInfoSchema>, _ctx: ToolContext): Promise<ToolResult> {
    try {
      const result: Record<string, unknown> = {
        hostname: os.hostname(),
        platform: `${os.platform()} ${os.arch()}`,
        node_version: process.version,
      };

      const inc = new Set(input.include);
      if (inc.has('cpu')) result['cpu'] = await getCpuInfo();
      if (inc.has('memory')) result['memory'] = await getMemoryInfo();
      if (inc.has('disk')) result['disk'] = await getDiskInfo();
      if (inc.has('uptime')) result['uptime_hours'] = (os.uptime() / 3600).toFixed(1);
      if (inc.has('processes')) result['top_processes'] = await getTopProcesses();
      if (inc.has('network')) {
        const ifaces = os.networkInterfaces();
        result['network'] = Object.fromEntries(
          Object.entries(ifaces).map(([name, addrs]) => [
            name,
            addrs?.filter((a) => !a.internal).map((a) => a.address) ?? [],
          ]),
        );
      }

      return { success: true, data: result };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  },
};

export const SystemSkill: ISkill = {
  name: 'system',
  version: '1.0.0',
  description: 'System monitoring — CPU, memory, disk, uptime, and process information.',
  tools: [systemInfoTool],
};
