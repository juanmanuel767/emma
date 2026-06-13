import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { z } from 'zod';
import { createLogger } from '@emma/shared/logger';
import type { ITool, ToolContext, ToolResult } from '@emma/tools';
import type { ISkill } from '../types.js';
import type { McpServerConfig } from './types.js';

const logger = createLogger('McpClientAdapter');

export class McpClientAdapter {
  readonly #client: Client;
  readonly #serverName: string;
  #connected = false;

  constructor(serverName: string, private readonly config: McpServerConfig) {
    this.#serverName = serverName;
    this.#client = new Client({ name: 'emma-agent', version: '1.0.0' });
  }

  async connect(): Promise<void> {
    const transport = this.#buildTransport();
    await this.#client.connect(transport);
    this.#connected = true;
    logger.info({ server: this.#serverName }, 'MCP server connected');
  }

  async disconnect(): Promise<void> {
    if (this.#connected) {
      await this.#client.close();
      this.#connected = false;
    }
  }

  async toSkill(): Promise<ISkill> {
    const { tools } = await this.#client.listTools();

    const itools: ITool[] = tools.map((mcpTool) => {
      const inputSchema = mcpTool.inputSchema as Record<string, unknown>;

      const tool: ITool = {
        name: `${this.#serverName}__${mcpTool.name}`,
        description: `[${this.#serverName}] ${mcpTool.description ?? mcpTool.name}`,
        // Passthrough schema — MCP server validates, not Zod
        inputSchema: z.record(z.unknown()) as ReturnType<typeof z.record>,
        // Forward the native MCP JSON Schema to the LLM verbatim
        jsonSchema: inputSchema,

        execute: async (input: unknown, ctx: ToolContext): Promise<ToolResult> => {
          try {
            const result = await this.#client.callTool(
              { name: mcpTool.name, arguments: input as Record<string, unknown> },
              undefined,
              { signal: ctx.signal },
            );

            // MCP results are an array of content blocks
            const content = result.content as Array<{ type: string; text?: string }>;
            const text = content
              .filter((c) => c.type === 'text')
              .map((c) => c.text ?? '')
              .join('\n');

            if (result.isError) {
              return { success: false, error: text || 'MCP tool returned an error' };
            }

            return { success: true, data: text || JSON.stringify(result.content) };
          } catch (err) {
            return { success: false, error: (err as Error).message };
          }
        },
      };

      return tool;
    });

    const serverName = this.#serverName;
    return {
      name: `mcp:${serverName}`,
      version: '1.0.0',
      description: this.config.description ?? `MCP server: ${serverName}`,
      tools: itools,
      deactivate: () => this.disconnect(),
    };
  }

  #resolveEnv(env: Record<string, string>): Record<string, string> {
    // Resolve ${VAR_NAME} placeholders from process.env
    return Object.fromEntries(
      Object.entries(env).map(([k, v]) => [
        k,
        v.replace(/\$\{([^}]+)\}/g, (_, name) => process.env[name] ?? ''),
      ]),
    );
  }

  #buildTransport() {
    if (this.config.transport === 'stdio') {
      const resolvedEnv = this.#resolveEnv(this.config.env ?? {});
      return new StdioClientTransport({
        command: this.config.command,
        args: this.config.args ?? [],
        env: {
          ...process.env as Record<string, string>,
          ...resolvedEnv,
        },
      });
    }

    // HTTP / SSE
    const url = new URL(this.config.url);
    return new StreamableHTTPClientTransport(url, {
      requestInit: { headers: this.config.headers ?? {} },
    });
  }
}
