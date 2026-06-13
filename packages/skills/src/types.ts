import type { ITool } from '@emma/tools';

export interface ISkill {
  readonly name: string;
  readonly version: string;
  readonly description: string;
  readonly author?: string;
  readonly tools: ITool[];
  activate?(ctx: SkillActivationContext): Promise<void>;
  deactivate?(): Promise<void>;
}

export interface SkillActivationContext {
  dataDir: string;
  config?: Record<string, unknown>;
}

export interface SkillManifest {
  name: string;
  version: string;
  description: string;
  author?: string;
  entry: string;
  enabled?: boolean;
}

export interface SkillInfo {
  name: string;
  version: string;
  description: string;
  toolCount: number;
  source: 'built-in' | 'external';
  enabled: boolean;
}
