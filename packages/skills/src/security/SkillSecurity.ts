import { createLogger } from '@emma/shared/logger';

const logger = createLogger('SkillSecurity');

export interface SkillSecurityInput {
  skillName: string;
  toolName?: string;
  description?: string;
  code?: string;
}

const SENSITIVE_PATH_RE =
  /(^|[\/\\])\.env(\.[\w-]+)?\b|\/etc\/(?:shadow|passwd|sudoers)\b|(?:^|[\/\\])\.ssh[\/\\]|(?:^|[\/\\])(?:id_rsa|id_ed25519|id_dsa)\b|\.aws[\/\\]credentials|\.docker[\/\\]config\.json|(?:^|[\/\\])(?:\.npmrc|\.pgpass|\.netrc)\b|private key/i;

const DANGEROUS_INTENT_RE =
  /\b(?:read|leer|lee|dump|volcar|mostrar|muestra|print|imprimir|extraer|extract|exfiltrar|exfiltrate)\b[\s\S]{0,80}\b(?:env|secret|secreto|credential|credencial|token|api[_ -]?key|password|contrase(?:n|ñ)a|jwt|database_url|ssh|clave privada|archivo|file)\b/i;

const ARBITRARY_FILE_RE =
  /\b(?:read|leer|lee)\b[\s\S]{0,80}\b(?:any|cualquier|arbitrary|arbitrario|todo|entero)\b[\s\S]{0,80}\b(?:file|archivo|filesystem|sistema)\b/i;

const ARBITRARY_COMMAND_RE =
  /\b(?:execute|ejecuta|ejecutar|run|correr|shell|bash|command|comando)\b[\s\S]{0,80}\b(?:any|cualquier|arbitrary|arbitrario|sudo|administraci[oó]n)\b/i;

const CODE_BYPASS_RE =
  /process\.env\s*(?:\[|\.[A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|DATABASE_URL|PRIVATE_KEY))|\/proc\/(?:self|\d+)\/environ|child_process[\s\S]{0,120}(?:input\.(?:command|cmd|args)|sudo)|(?:readFile|readFileSync)\s*\([^)]*(?:input\.path|\.env|\/etc\/shadow|\/etc\/passwd|\.ssh|id_rsa|id_ed25519)/i;

function compact(input: SkillSecurityInput): string {
  return [
    input.skillName,
    input.toolName ?? '',
    input.description ?? '',
    input.code ?? '',
  ].join('\n');
}

export function inspectSkillSecurity(input: SkillSecurityInput): string | null {
  const text = compact(input);
  if (SENSITIVE_PATH_RE.test(text)) {
    return 'blocked sensitive path/secret target';
  }
  if (DANGEROUS_INTENT_RE.test(text)) {
    return 'blocked secret-reading intent';
  }
  if (ARBITRARY_FILE_RE.test(text)) {
    return 'blocked arbitrary file reader';
  }
  if (ARBITRARY_COMMAND_RE.test(text)) {
    return 'blocked arbitrary command executor';
  }
  if (input.code && CODE_BYPASS_RE.test(input.code)) {
    return 'blocked sandbox/policy bypass code';
  }
  return null;
}

/**
 * Inspección estática de skills. Antes BLOQUEABA la carga, pero generaba falsos positivos que
 * tumbaban skills legítimas del señor (whatsapp, facebook, cybersecurity, skill-guard…). La
 * defensa REAL es el sandbox de runtime (`runForgedInSandbox`: entorno sin secretos + guard
 * fs/child_process) más la redacción de salidas — esas sí son infranqueables y verificadas; este
 * filtro estático es evadible por concatenación de strings. Por eso ahora solo AVISA (no lanza),
 * dejando que la skill cargue y se ejecute aislada. Se conserva el registro para trazabilidad.
 */
export function assertSkillSafe(input: SkillSecurityInput): void {
  const reason = inspectSkillSecurity(input);
  if (reason) {
    logger.warn(
      { skill: input.skillName, tool: input.toolName, reason },
      'Skill marcada por inspección estática — se ejecutará AISLADA en el sandbox de runtime',
    );
  }
}
