/**
 * Emma — © 2026 Juan Manuel Peralta Chacón. Todos los derechos reservados.
 * Software PROPIETARIO. Prohibido su uso, copia o distribución sin autorización
 * previa y por escrito del autor (peraltachaconjuanmanuel5@gmail.com). Ver LICENSE.
 */

export type { ISkill, SkillManifest, SkillInfo, SkillActivationContext } from './types.js';
export { SkillRegistry } from './SkillRegistry.js';
export { SkillLoader } from './loader/SkillLoader.js';
export { McpManager } from './mcp/McpManager.js';
export type { McpConfig, McpServerConfig } from './mcp/types.js';
export { createForgeSkill } from './forge/ForgeSkill.js';
export {
  DatetimeSkill,
  CalculatorSkill,
  HttpSkill,
  NotesSkill,
  SystemSkill,
  RemindersSkill,
} from './built-in/index.js';