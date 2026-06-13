import { z } from 'zod';
const inputSchema = z.object({
    query: z.string().min(1).max(512).describe('The search query'),
    maxResults: z.number().int().min(1).max(10).optional().default(5),
});
export class WebSearchTool {
    name = 'web_search';
    description = 'Search the web for information using DuckDuckGo.';
    inputSchema = inputSchema;
    async execute(input, _ctx) {
        try {
            const url = new URL('https://api.duckduckgo.com/');
            url.searchParams.set('q', input.query);
            url.searchParams.set('format', 'json');
            url.searchParams.set('no_html', '1');
            url.searchParams.set('skip_disambig', '1');
            const response = await fetch(url.toString(), {
                headers: { 'User-Agent': 'Emma-Agent/1.0' },
                signal: AbortSignal.timeout(10_000),
            });
            if (!response.ok) {
                return { success: false, error: `Search API error: ${response.status}` };
            }
            const data = (await response.json());
            const results = [];
            if (data.AbstractText && data.AbstractURL) {
                results.push({
                    title: data.AbstractSource ?? 'Result',
                    url: data.AbstractURL,
                    snippet: data.AbstractText,
                });
            }
            for (const topic of (data.RelatedTopics ?? []).slice(0, input.maxResults - results.length)) {
                if (topic.Text && topic.FirstURL) {
                    results.push({
                        title: topic.FirstURL,
                        url: topic.FirstURL,
                        snippet: topic.Text,
                    });
                }
            }
            if (results.length === 0) {
                return { success: true, data: [], metadata: { message: 'No results found' } };
            }
            return { success: true, data: results };
        }
        catch (err) {
            return { success: false, error: `Search failed: ${err.message}` };
        }
    }
}
//# sourceMappingURL=WebSearchTool.js.map