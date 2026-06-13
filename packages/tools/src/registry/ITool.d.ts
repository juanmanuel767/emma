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
export interface ITool<TInput = unknown, TOutput = unknown> {
    readonly name: string;
    readonly description: string;
    readonly inputSchema: ZodType<TInput, ZodTypeDef, unknown>;
    execute(input: TInput, ctx: ToolContext): Promise<ToolResult<TOutput>>;
}
//# sourceMappingURL=ITool.d.ts.map