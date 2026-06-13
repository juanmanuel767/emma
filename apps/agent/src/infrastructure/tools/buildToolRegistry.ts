import { ToolRegistry } from '../../domain/tools/ToolRegistry.js';
import { CommandTool, FileTool, PlaywrightTool, WebSearchTool, EmailTool } from '@emma/tools';

export function buildToolRegistry(): ToolRegistry {
  const registry = new ToolRegistry();

  registry
    .register(new CommandTool())
    .register(new FileTool())
    .register(new PlaywrightTool())
    .register(new WebSearchTool())
    .register(new EmailTool());

  return registry;
}
