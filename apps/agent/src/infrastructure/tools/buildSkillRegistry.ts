import { join } from 'node:path';
import { homedir } from 'node:os';
import {
  SkillRegistry,
  McpManager,
  DatetimeSkill,
  CalculatorSkill,
  HttpSkill,
  NotesSkill,
  SystemSkill,
  RemindersSkill,
  createForgeSkill,
} from '@emma/skills';
import { CommandTool, FileTool, PlaywrightTool, WebSearchTool, SshTool, EmailTool } from '@emma/tools';
import type { ISkill } from '@emma/skills';

const legacyToolsSkill: ISkill = {
  name: 'core-tools',
  version: '1.0.0',
  description: 'Core tools: shell commands, file system, browser automation, web search, SSH.',
  tools: [new CommandTool(), new FileTool(), new PlaywrightTool(), new WebSearchTool(), new SshTool(), new EmailTool()],
};

export async function buildSkillRegistry(mcpConfigPath?: string): Promise<{ registry: SkillRegistry; mcp: McpManager }> {
  const registry = new SkillRegistry();
  const dataDir = join(homedir(), '.emma');

  // Built-in skills
  registry
    .registerSkill(legacyToolsSkill)
    .registerSkill(DatetimeSkill)
    .registerSkill(CalculatorSkill)
    .registerSkill(HttpSkill)
    .registerSkill(NotesSkill)
    .registerSkill(SystemSkill)
    .registerSkill(RemindersSkill);

  // External skills from ~/.emma/skills/ (sets the hot-reload dir)
  await registry.loadExternalSkills(join(dataDir, 'skills'));

  // ForgeSkill — lets Emma create new tools at runtime
  registry.registerSkill(createForgeSkill(registry, dataDir));

  // MCP servers from mcp.json
  const mcp = new McpManager();
  // mcp.json lives at monorepo root — two levels up from apps/agent/
  const monorepoRoot = join(process.cwd(), '..', '..');
  const configPath = mcpConfigPath ?? join(monorepoRoot, 'mcp.json');
  await mcp.loadFromConfig(configPath, registry);

  // Lifecycle activation
  await registry.activateAll({ dataDir });

  return { registry, mcp };
}
