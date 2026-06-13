import { z } from 'zod';
import type { ISkill } from '../types.js';
import type { ITool, ToolContext, ToolResult } from '@emma/tools';

const BLOCKED_HOSTS = ['localhost', '127.0.0.1', '0.0.0.0', '::1', '169.254'];

function isBlockedUrl(url: string): boolean {
  try {
    const { hostname } = new URL(url);
    return BLOCKED_HOSTS.some((h) => hostname === h || hostname.startsWith(h));
  } catch {
    return true;
  }
}

const httpGetSchema = z.object({
  url: z.string().url().describe('URL to fetch'),
  headers: z.record(z.string()).optional().describe('Optional HTTP headers'),
  timeout_ms: z.number().default(10_000),
});

const httpPostSchema = z.object({
  url: z.string().url(),
  body: z.record(z.unknown()).describe('JSON body to send'),
  headers: z.record(z.string()).optional(),
  timeout_ms: z.number().default(10_000),
});

const httpGetTool: ITool = {
  name: 'http_get',
  description: 'Make an HTTP GET request to an external URL and return the response body. Use for calling APIs or fetching web content.',
  inputSchema: httpGetSchema,
  async execute(input: z.infer<typeof httpGetSchema>, ctx: ToolContext): Promise<ToolResult> {
    if (isBlockedUrl(input.url)) {
      return { success: false, error: 'Access to internal/local URLs is blocked' };
    }
    try {
      const response = await fetch(input.url, {
        method: 'GET',
        headers: { 'User-Agent': 'Emma-Agent/1.0', ...input.headers },
        signal: AbortSignal.timeout(input.timeout_ms),
      });
      const contentType = response.headers.get('content-type') ?? '';
      const text = await response.text();
      let data: unknown = text;
      if (contentType.includes('application/json')) {
        try { data = JSON.parse(text); } catch { data = text; }
      }
      return {
        success: response.ok,
        data: { status: response.status, body: data },
        error: response.ok ? undefined : `HTTP ${response.status}`,
      };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  },
};

const httpPostTool: ITool = {
  name: 'http_post',
  description: 'Make an HTTP POST request with a JSON body to an external URL.',
  inputSchema: httpPostSchema,
  async execute(input: z.infer<typeof httpPostSchema>, _ctx: ToolContext): Promise<ToolResult> {
    if (isBlockedUrl(input.url)) {
      return { success: false, error: 'Access to internal/local URLs is blocked' };
    }
    try {
      const response = await fetch(input.url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'User-Agent': 'Emma-Agent/1.0', ...input.headers },
        body: JSON.stringify(input.body),
        signal: AbortSignal.timeout(input.timeout_ms),
      });
      const text = await response.text();
      let data: unknown = text;
      try { data = JSON.parse(text); } catch { data = text; }
      return {
        success: response.ok,
        data: { status: response.status, body: data },
        error: response.ok ? undefined : `HTTP ${response.status}`,
      };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  },
};

export const HttpSkill: ISkill = {
  name: 'http',
  version: '1.0.0',
  description: 'HTTP client — make GET and POST requests to external APIs and web services.',
  tools: [httpGetTool, httpPostTool],
};
