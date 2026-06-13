import { z } from 'zod';
import type { ITool, ToolContext, ToolResult } from '../registry/ITool.js';
declare const inputSchema: z.ZodObject<{
    command: z.ZodString;
    args: z.ZodDefault<z.ZodOptional<z.ZodArray<z.ZodString, "many">>>;
    cwd: z.ZodOptional<z.ZodString>;
}, "strip", z.ZodTypeAny, {
    command: string;
    args: string[];
    cwd?: string | undefined;
}, {
    command: string;
    args?: string[] | undefined;
    cwd?: string | undefined;
}>;
type Input = z.infer<typeof inputSchema>;
export declare class CommandTool implements ITool<Input, string> {
    #private;
    readonly name = "execute_command";
    readonly description = "Execute a shell command on the local system. Only whitelisted commands are allowed for security.";
    readonly inputSchema: z.ZodObject<{
        command: z.ZodString;
        args: z.ZodDefault<z.ZodOptional<z.ZodArray<z.ZodString, "many">>>;
        cwd: z.ZodOptional<z.ZodString>;
    }, "strip", z.ZodTypeAny, {
        command: string;
        args: string[];
        cwd?: string | undefined;
    }, {
        command: string;
        args?: string[] | undefined;
        cwd?: string | undefined;
    }>;
    execute(input: Input, ctx: ToolContext): Promise<ToolResult<string>>;
}
export {};
//# sourceMappingURL=CommandTool.d.ts.map