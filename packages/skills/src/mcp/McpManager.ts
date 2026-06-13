import { readFile, access } from 'node:fs/promises';
import { createLogger } from '@emma/shared/logger';
import type { ISkill } from '../types.js';
import type { SkillRegistry } from '../SkillRegistry.js';
import { McpClientAdapter } from './McpClientAdapter.js';
import type { McpConfig } from './types.js';

const logger = createLogger('McpManager');

export class McpManager {
  readonly #adapters: McpClientAdapter[] = [];

  async loadFromConfig(configPath: string, registry: SkillRegistry): Promise<void> {
    let config: McpConfig;

    try {
      await access(configPath);
      const raw = await readFile(configPath, 'utf-8');
      config = JSON.parse(raw) as McpConfig;
    } catch {
      logger.info({ path: configPath }, 'No mcp.json found — skipping MCP servers');
      return;
    }

    const entries = Object.entries(config.servers ?? {});
    if (entries.length === 0) return;

    logger.info({ count: entries.length }, 'Connecting to MCP servers...');

    const results = await Promise.allSettled(
      entries.map(async ([name, serverConfig]) => {
        // Skip servers whose env vars are empty (e.g. BRAVE_API_KEY not set)
        if (serverConfig.transport === 'stdio' && serverConfig.env) {
          const missing = Object.entries(serverConfig.env)
            .filter(([, v]) => {
              const resolved = v.replace(/\$\{([^}]+)\}/g, (_, n) => process.env[n] ?? '');
              return resolved.trim() === '';
            })
            .map(([k]) => k);
          if (missing.length > 0) {
            logger.info({ server: name, missing }, 'MCP server skipped — env vars not set');
            return null;
          }
        }
        const adapter = new McpClientAdapter(name, serverConfig);
        await adapter.connect();
        this.#adapters.push(adapter);
        const skill = await adapter.toSkill();
        registry.registerSkill(skill);
        logger.info({ server: name, tools: skill.tools.length }, 'MCP skill registered');
        return skill as ISkill | null;
      }),
    );

    const failed = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
    if (failed.length > 0) {
      for (const f of failed) {
        logger.warn({ err: f.reason }, 'MCP server failed to connect — skipped');
      }
    }

    const loaded = results.filter((r) => r.status === 'fulfilled').length;
    logger.info({ loaded, failed: failed.length }, 'MCP servers loaded');
  }

  async disconnectAll(): Promise<void> {
    await Promise.allSettled(this.#adapters.map((a) => a.disconnect()));
  }
}
