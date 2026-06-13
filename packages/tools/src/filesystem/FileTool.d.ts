import { z } from 'zod';
import type { ITool, ToolContext, ToolResult } from '../registry/ITool.js';
declare const inputSchema: z.ZodDiscriminatedUnion<"action", [z.ZodObject<{
    action: z.ZodLiteral<"read">;
    path: z.ZodString;
    encoding: z.ZodDefault<z.ZodOptional<z.ZodEnum<["utf8", "base64"]>>>;
}, "strip", z.ZodTypeAny, {
    path: string;
    action: "read";
    encoding: "utf8" | "base64";
}, {
    path: string;
    action: "read";
    encoding?: "utf8" | "base64" | undefined;
}>, z.ZodObject<{
    action: z.ZodLiteral<"write">;
    path: z.ZodString;
    content: z.ZodString;
}, "strip", z.ZodTypeAny, {
    content: string;
    path: string;
    action: "write";
}, {
    content: string;
    path: string;
    action: "write";
}>, z.ZodObject<{
    action: z.ZodLiteral<"list">;
    path: z.ZodString;
}, "strip", z.ZodTypeAny, {
    path: string;
    action: "list";
}, {
    path: string;
    action: "list";
}>, z.ZodObject<{
    action: z.ZodLiteral<"stat">;
    path: z.ZodString;
}, "strip", z.ZodTypeAny, {
    path: string;
    action: "stat";
}, {
    path: string;
    action: "stat";
}>]>;
type Input = z.infer<typeof inputSchema>;
export declare class FileTool implements ITool<Input> {
    #private;
    readonly name = "file_system";
    readonly description = "Read, write, or list files. Write access is restricted to /tmp/emma. Read access is limited to the home directory.";
    readonly inputSchema: z.ZodDiscriminatedUnion<"action", [z.ZodObject<{
        action: z.ZodLiteral<"read">;
        path: z.ZodString;
        encoding: z.ZodDefault<z.ZodOptional<z.ZodEnum<["utf8", "base64"]>>>;
    }, "strip", z.ZodTypeAny, {
        path: string;
        action: "read";
        encoding: "utf8" | "base64";
    }, {
        path: string;
        action: "read";
        encoding?: "utf8" | "base64" | undefined;
    }>, z.ZodObject<{
        action: z.ZodLiteral<"write">;
        path: z.ZodString;
        content: z.ZodString;
    }, "strip", z.ZodTypeAny, {
        content: string;
        path: string;
        action: "write";
    }, {
        content: string;
        path: string;
        action: "write";
    }>, z.ZodObject<{
        action: z.ZodLiteral<"list">;
        path: z.ZodString;
    }, "strip", z.ZodTypeAny, {
        path: string;
        action: "list";
    }, {
        path: string;
        action: "list";
    }>, z.ZodObject<{
        action: z.ZodLiteral<"stat">;
        path: z.ZodString;
    }, "strip", z.ZodTypeAny, {
        path: string;
        action: "stat";
    }, {
        path: string;
        action: "stat";
    }>]>;
    execute(input: Input, _ctx: ToolContext): Promise<ToolResult>;
}
export {};
//# sourceMappingURL=FileTool.d.ts.map