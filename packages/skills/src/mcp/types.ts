export interface McpStdioConfig {
  transport: 'stdio';
  command: string;
  args?: string[];
  env?: Record<string, string>;
  description?: string;
}

export interface McpHttpConfig {
  transport: 'http' | 'sse';
  url: string;
  headers?: Record<string, string>;
  description?: string;
}

export type McpServerConfig = McpStdioConfig | McpHttpConfig;

export interface McpConfig {
  servers: Record<string, McpServerConfig>;
}
