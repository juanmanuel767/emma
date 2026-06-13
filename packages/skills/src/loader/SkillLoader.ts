import { readdir, readFile, access } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { z } from 'zod';
import { createLogger } from '@emma/shared/logger';
import type { ITool, ToolContext } from '@emma/tools';
import type { ISkill, SkillManifest } from '../types.js';

const logger = createLogger('SkillLoader');

/** Forged skill format — tools use plain JSON Schema instead of Zod */
interface ForgedTool {
  name: string;
  description: string;
  parameters?: Record<string, unknown>;
  execute: (input: unknown, ctx: ToolContext) => Promise<{ success: boolean; data?: unknown; error?: string }>;
}

interface ForgedSkillModule {
  name: string;
  version: string;
  description: string;
  author?: string;
  tools: ForgedTool[];
}

function isForgedFormat(mod: unknown): mod is ForgedSkillModule {
  if (!mod || typeof mod !== 'object') return false;
  const m = mod as Record<string, unknown>;
  if (!Array.isArray(m['tools']) || m['tools'].length === 0) return false;
  const first = m['tools'][0] as Record<string, unknown>;
  // Forged tools have 'execute' as a plain function but no Zod 'inputSchema'
  return typeof first['execute'] === 'function' && !('inputSchema' in first);
}

function wrapForgedSkill(mod: ForgedSkillModule): ISkill {
  const tools: ITool[] = mod.tools.map((t) => ({
    name: t.name,
    description: t.description,
    inputSchema: z.record(z.unknown()),
    jsonSchema: t.parameters ?? { type: 'object', properties: {} },
    execute: async (input: unknown, ctx: ToolContext) => {
      try {
        const result = await t.execute(input, ctx);
        return result ?? { success: true, data: null };
      } catch (err) {
        return { success: false, error: String(err) };
      }
    },
  }));

  return {
    name: mod.name,
    version: mod.version,
    description: mod.description,
    author: mod.author,
    tools,
  };
}

export class SkillLoader {
  constructor(private readonly skillsDir: string) {}

  async loadAll(): Promise<ISkill[]> {
    const skills: ISkill[] = [];

    try {
      await access(this.skillsDir);
    } catch {
      logger.info({ dir: this.skillsDir }, 'Skills directory does not exist — skipping external skills');
      return skills;
    }

    let entries: string[];
    try {
      entries = await readdir(this.skillsDir);
    } catch {
      return skills;
    }

    for (const entry of entries) {
      const skillPath = join(this.skillsDir, entry);
      try {
        const skill = await this.load(skillPath);
        skills.push(skill);
        logger.info({ name: skill.name, version: skill.version }, 'External skill loaded');
      } catch (err) {
        logger.warn({ path: skillPath, err }, 'Failed to load skill — skipping');
      }
    }

    return skills;
  }

  async load(skillPath: string, cacheBust = false): Promise<ISkill> {
    const manifestPath = join(skillPath, 'skill.json');
    const manifestRaw = await readFile(manifestPath, 'utf-8');
    const manifest = JSON.parse(manifestRaw) as SkillManifest;

    if (manifest.enabled === false) {
      throw new Error(`Skill '${manifest.name}' is disabled`);
    }

    const entryPath = resolve(skillPath, manifest.entry);
    // Cache-bust with timestamp so hot-reload picks up new code
    const importUrl = cacheBust
      ? `file://${entryPath}?v=${Date.now()}`
      : `file://${entryPath}`;

    const mod = await import(importUrl) as { default?: ISkill | ForgedSkillModule };

    if (!mod.default || typeof mod.default !== 'object') {
      throw new Error(`Skill '${manifest.name}' entry must export a default object`);
    }

    // Detect and wrap forged-format skills
    if (isForgedFormat(mod.default)) {
      return wrapForgedSkill(mod.default as ForgedSkillModule);
    }

    return mod.default as ISkill;
  }
}
