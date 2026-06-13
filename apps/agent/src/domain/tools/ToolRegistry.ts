import type { LLMTool } from '@emma/core/ports';
import type { ITool, ToolContext, ToolResult } from '@emma/tools';
import { ToolError } from '@emma/shared/errors';
import { createLogger } from '@emma/shared/logger';

const logger = createLogger('ToolRegistry');

export class ToolRegistry {
  readonly #tools = new Map<string, ITool>();

  register(tool: ITool): this {
    if (this.#tools.has(tool.name)) {
      logger.warn(`Tool '${tool.name}' overwritten in registry`);
    }
    this.#tools.set(tool.name, tool);
    logger.debug({ toolName: tool.name }, 'Tool registered');
    return this;
  }

  get(name: string): ITool {
    const tool = this.#tools.get(name);
    if (!tool) throw new ToolError(name, `Tool '${name}' not found in registry`);
    return tool;
  }

  list(): ITool[] {
    return Array.from(this.#tools.values());
  }

  async execute(
    name: string,
    input: unknown,
    ctx: Omit<ToolContext, 'permissions'>,
  ): Promise<ToolResult> {
    const tool = this.get(name);
    const parsed = tool.inputSchema.safeParse(input);
    if (!parsed.success) {
      return {
        success: false,
        error: `Invalid input for tool '${name}': ${parsed.error.message}`,
      };
    }
    return tool.execute(parsed.data, { ...ctx, permissions: [] });
  }

  toLLMTools(): LLMTool[] {
    return this.list().map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: zodToJsonSchema(tool.inputSchema),
    }));
  }
}

// Minimal Zod-to-JSON-Schema converter for Anthropic tool format
function zodToJsonSchema(schema: ITool['inputSchema']): Record<string, unknown> {
  // Drills into Zod internals to produce a compatible JSON Schema object.
  // For production use, replace with the `zod-to-json-schema` package.
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
      if (field._def['typeName'] !== 'ZodOptional') required.push(key);
    }
    return { type: 'object', properties, required };
  }
  if (typeName === 'ZodString') return { type: 'string', description: def['description'] as string | undefined };
  if (typeName === 'ZodNumber') return { type: 'number' };
  if (typeName === 'ZodBoolean') return { type: 'boolean' };
  if (typeName === 'ZodArray') return { type: 'array', items: buildJsonSchema((def['type'] as { _def: Record<string, unknown> })._def) };
  if (typeName === 'ZodOptional') return buildJsonSchema((def['innerType'] as { _def: Record<string, unknown> })._def);
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
