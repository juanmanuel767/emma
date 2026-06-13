import type { ZodType, ZodTypeDef } from 'zod';

export interface ToolContext {
  sessionId: string;
  conversationId: string;
  permissions: string[];
  signal: AbortSignal;
}

export interface ToolResult<T = unknown> {
  success: boolean;
  data?: T;
  error?: string;
  metadata?: Record<string, unknown>;
}

// ZodType<Output, Def, Input> — we fix Output=TInput but leave Input=unknown
// so Zod schemas with .optional()/.default() still satisfy the contract.
export interface ITool<TInput = unknown, TOutput = unknown> {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: ZodType<TInput, ZodTypeDef, unknown>;
  // When set, overrides the Zod-derived JSON Schema sent to the LLM.
  // MCP tools use this to forward their native JSON Schema verbatim.
  readonly jsonSchema?: Record<string, unknown>;
  execute(input: TInput, ctx: ToolContext): Promise<ToolResult<TOutput>>;
}
