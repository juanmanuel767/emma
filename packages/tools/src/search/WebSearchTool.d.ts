import { z } from 'zod';
import type { ITool, ToolContext, ToolResult } from '../registry/ITool.js';
declare const inputSchema: z.ZodObject<{
    query: z.ZodString;
    maxResults: z.ZodDefault<z.ZodOptional<z.ZodNumber>>;
}, "strip", z.ZodTypeAny, {
    query: string;
    maxResults: number;
}, {
    query: string;
    maxResults?: number | undefined;
}>;
type Input = z.infer<typeof inputSchema>;
interface SearchResult {
    title: string;
    url: string;
    snippet: string;
}
export declare class WebSearchTool implements ITool<Input, SearchResult[]> {
    readonly name = "web_search";
    readonly description = "Search the web for information using DuckDuckGo.";
    readonly inputSchema: z.ZodObject<{
        query: z.ZodString;
        maxResults: z.ZodDefault<z.ZodOptional<z.ZodNumber>>;
    }, "strip", z.ZodTypeAny, {
        query: string;
        maxResults: number;
    }, {
        query: string;
        maxResults?: number | undefined;
    }>;
    execute(input: Input, _ctx: ToolContext): Promise<ToolResult<SearchResult[]>>;
}
export {};
//# sourceMappingURL=WebSearchTool.d.ts.map