import { z } from 'zod';
import type { ITool, ToolContext, ToolResult } from '../registry/ITool.js';
declare const inputSchema: z.ZodDiscriminatedUnion<"action", [z.ZodObject<{
    action: z.ZodLiteral<"navigate">;
    url: z.ZodString;
}, "strip", z.ZodTypeAny, {
    action: "navigate";
    url: string;
}, {
    action: "navigate";
    url: string;
}>, z.ZodObject<{
    action: z.ZodLiteral<"screenshot">;
    url: z.ZodOptional<z.ZodString>;
    path: z.ZodDefault<z.ZodOptional<z.ZodString>>;
}, "strip", z.ZodTypeAny, {
    path: string;
    action: "screenshot";
    url?: string | undefined;
}, {
    action: "screenshot";
    path?: string | undefined;
    url?: string | undefined;
}>, z.ZodObject<{
    action: z.ZodLiteral<"extract_text">;
    url: z.ZodString;
    selector: z.ZodOptional<z.ZodString>;
}, "strip", z.ZodTypeAny, {
    action: "extract_text";
    url: string;
    selector?: string | undefined;
}, {
    action: "extract_text";
    url: string;
    selector?: string | undefined;
}>, z.ZodObject<{
    action: z.ZodLiteral<"click">;
    selector: z.ZodString;
}, "strip", z.ZodTypeAny, {
    action: "click";
    selector: string;
}, {
    action: "click";
    selector: string;
}>, z.ZodObject<{
    action: z.ZodLiteral<"fill">;
    selector: z.ZodString;
    value: z.ZodString;
}, "strip", z.ZodTypeAny, {
    value: string;
    action: "fill";
    selector: string;
}, {
    value: string;
    action: "fill";
    selector: string;
}>, z.ZodObject<{
    action: z.ZodLiteral<"close">;
}, "strip", z.ZodTypeAny, {
    action: "close";
}, {
    action: "close";
}>]>;
type Input = z.infer<typeof inputSchema>;
export declare class PlaywrightTool implements ITool<Input> {
    #private;
    readonly name = "browser";
    readonly description = "Control a headless browser. Navigate URLs, take screenshots, extract text, click elements, fill forms.";
    readonly inputSchema: z.ZodDiscriminatedUnion<"action", [z.ZodObject<{
        action: z.ZodLiteral<"navigate">;
        url: z.ZodString;
    }, "strip", z.ZodTypeAny, {
        action: "navigate";
        url: string;
    }, {
        action: "navigate";
        url: string;
    }>, z.ZodObject<{
        action: z.ZodLiteral<"screenshot">;
        url: z.ZodOptional<z.ZodString>;
        path: z.ZodDefault<z.ZodOptional<z.ZodString>>;
    }, "strip", z.ZodTypeAny, {
        path: string;
        action: "screenshot";
        url?: string | undefined;
    }, {
        action: "screenshot";
        path?: string | undefined;
        url?: string | undefined;
    }>, z.ZodObject<{
        action: z.ZodLiteral<"extract_text">;
        url: z.ZodString;
        selector: z.ZodOptional<z.ZodString>;
    }, "strip", z.ZodTypeAny, {
        action: "extract_text";
        url: string;
        selector?: string | undefined;
    }, {
        action: "extract_text";
        url: string;
        selector?: string | undefined;
    }>, z.ZodObject<{
        action: z.ZodLiteral<"click">;
        selector: z.ZodString;
    }, "strip", z.ZodTypeAny, {
        action: "click";
        selector: string;
    }, {
        action: "click";
        selector: string;
    }>, z.ZodObject<{
        action: z.ZodLiteral<"fill">;
        selector: z.ZodString;
        value: z.ZodString;
    }, "strip", z.ZodTypeAny, {
        value: string;
        action: "fill";
        selector: string;
    }, {
        value: string;
        action: "fill";
        selector: string;
    }>, z.ZodObject<{
        action: z.ZodLiteral<"close">;
    }, "strip", z.ZodTypeAny, {
        action: "close";
    }, {
        action: "close";
    }>]>;
    execute(input: Input, ctx: ToolContext): Promise<ToolResult>;
}
export {};
//# sourceMappingURL=PlaywrightTool.d.ts.map