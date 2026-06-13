import type { LLMTool } from '@emma/core/ports';
import type { ITool, ToolContext, ToolResult } from '@emma/tools';
import { createLogger } from '@emma/shared/logger';
import { ToolError } from '@emma/shared/errors';
import type { ISkill, SkillInfo, SkillActivationContext } from './types.js';
import { SkillLoader } from './loader/SkillLoader.js';

const logger = createLogger('SkillRegistry');

export class SkillRegistry {
  readonly #skills = new Map<string, ISkill>();
  readonly #tools = new Map<string, ITool>();
  readonly #externalSkillNames = new Set<string>();
  #externalSkillsDir: string | null = null;

  registerSkill(skill: ISkill): this {
    if (this.#skills.has(skill.name)) {
      logger.warn({ name: skill.name }, 'Skill overwritten in registry');
    }
    this.#skills.set(skill.name, skill);
    for (const tool of skill.tools) {
      this.#tools.set(tool.name, tool);
      logger.debug({ skill: skill.name, tool: tool.name }, 'Tool registered from skill');
    }
    logger.info({ name: skill.name, tools: skill.tools.length }, 'Skill registered');
    return this;
  }

  async activateAll(ctx: SkillActivationContext): Promise<void> {
    for (const skill of this.#skills.values()) {
      if (skill.activate) {
        try {
          await skill.activate(ctx);
        } catch (err) {
          logger.error({ name: skill.name, err }, 'Skill activation failed');
        }
      }
    }
  }

  async loadExternalSkills(skillsDir: string): Promise<void> {
    this.#externalSkillsDir = skillsDir;
    const loader = new SkillLoader(skillsDir);
    const skills = await loader.loadAll();
    for (const skill of skills) {
      this.registerSkill(skill);
      this.#externalSkillNames.add(skill.name);
    }
    logger.info({ count: skills.length }, 'External skills loaded');
  }

  /** Hot-reload: evict old external skills and re-load from disk with cache-busting */
  async hotReload(): Promise<{ added: string[]; updated: string[] }> {
    const dir = this.#externalSkillsDir;
    if (!dir) return { added: [], updated: [] };

    // Evict previously-loaded external skills and their tools
    for (const skillName of this.#externalSkillNames) {
      const skill = this.#skills.get(skillName);
      if (skill) {
        for (const tool of skill.tools) this.#tools.delete(tool.name);
        this.#skills.delete(skillName);
      }
    }
    this.#externalSkillNames.clear();

    const loader = new SkillLoader(dir);
    const skills = await loader.loadAll();
    const added: string[] = [];
    const updated: string[] = [];

    for (const skill of skills) {
      if (this.#skills.has(skill.name)) {
        updated.push(skill.name);
      } else {
        added.push(skill.name);
      }
      this.registerSkill(skill);
      this.#externalSkillNames.add(skill.name);
    }

    logger.info({ added, updated }, 'External skills hot-reloaded');
    return { added, updated };
  }

  getTool(name: string): ITool {
    const tool = this.#tools.get(name);
    if (!tool) throw new ToolError(name, `Tool '${name}' not found`);
    return tool;
  }

  listTools(): ITool[] {
    return Array.from(this.#tools.values());
  }

  listSkills(): SkillInfo[] {
    return Array.from(this.#skills.values()).map((s) => ({
      name: s.name,
      version: s.version,
      description: s.description,
      toolCount: s.tools.length,
      source: 'built-in' as const,
      enabled: true,
    }));
  }

  async execute(
    toolName: string,
    input: unknown,
    ctx: Omit<ToolContext, 'permissions'>,
  ): Promise<ToolResult> {
    const tool = this.getTool(toolName);
    const parsed = tool.inputSchema.safeParse(input);
    if (!parsed.success) {
      return {
        success: false,
        error: `Invalid input for tool '${toolName}': ${JSON.stringify(parsed.error.issues, null, 2)}`,
      };
    }
    return tool.execute(parsed.data, { ...ctx, permissions: [] });
  }

  toLLMTools(): LLMTool[] {
    return this.listTools().map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.jsonSchema ?? zodToJsonSchema(tool.inputSchema),
    }));
  }
}

function zodToJsonSchema(schema: ITool['inputSchema']): Record<string, unknown> {
  const def = (schema as unknown as { _def: Record<string, unknown> })._def;
  return buildJsonSchema(def);
}

function buildJsonSchema(def: Record<string, unknown>): Record<string, unknown> {
  const typeName = def['typeName'] as string;

  if (typeName === 'ZodObject') {
    const shape = def['shape'] as () => Record<string, { _def: Record<string, unknown> }>;
    const properties: Record<string, unknown> = {};
    const required: string[] = [];
    for (const [key, field] of Object.entries(shape())) {
      properties[key] = buildJsonSchema(field._def);
      if (field._def['typeName'] !== 'ZodOptional' && field._def['typeName'] !== 'ZodDefault') {
        required.push(key);
      }
    }
    return { type: 'object', properties, required };
  }
  if (typeName === 'ZodString') return { type: 'string', description: def['description'] as string | undefined };
  if (typeName === 'ZodNumber') return { type: 'number' };
  if (typeName === 'ZodBoolean') return { type: 'boolean' };
  if (typeName === 'ZodArray') return { type: 'array', items: buildJsonSchema((def['type'] as { _def: Record<string, unknown> })._def) };
  if (typeName === 'ZodOptional') return buildJsonSchema((def['innerType'] as { _def: Record<string, unknown> })._def);
  if (typeName === 'ZodDefault') return buildJsonSchema((def['innerType'] as { _def: Record<string, unknown> })._def);
  if (typeName === 'ZodEnum') return { type: 'string', enum: def['values'] as string[] };
  if (typeName === 'ZodDiscriminatedUnion' || typeName === 'ZodUnion') {
    // Las APIs de tools exigen type:"object" en la raíz — fusionar las variantes
    // en un solo objeto permisivo (propiedades unión, required = comunes a todas)
    const options = (def['options'] as Array<{ _def: Record<string, unknown> }>) ?? [];
    const properties: Record<string, unknown> = {};
    let required: string[] | null = null;
    for (const opt of options) {
      const variant = buildJsonSchema(opt._def) as { properties?: Record<string, unknown>; required?: string[] };
      Object.assign(properties, variant.properties ?? {});
      required = required === null
        ? (variant.required ?? [])
        : required.filter((k) => (variant.required ?? []).includes(k));
    }
    return { type: 'object', properties, required: required ?? [] };
  }
  return { type: 'string' };
}
