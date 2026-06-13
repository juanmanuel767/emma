import { readFileSync, writeFileSync, existsSync, copyFileSync, openSync, mkdirSync } from 'fs';
import { spawn, spawnSync } from 'child_process';
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { createLogger } from '@emma/shared/logger';

const logger = createLogger('settings');

// dist/interface/http/routes/settings.js → 6 niveles hasta la raíz del monorepo
const EMMA_DIR = new URL('../../../../../../', import.meta.url).pathname;
const ENV_PATH = `${EMMA_DIR}.env`;
const ENV_EXAMPLE_PATH = `${EMMA_DIR}.env.example`;

type ServiceName = 'agent' | 'telegram';

interface IntegrationField {
  envKey: string;
  label: string;
  placeholder: string;
  secret: boolean;
  pattern?: RegExp;
}

interface Integration {
  id: string;
  label: string;
  description: string;
  helpUrl: string;
  fields: IntegrationField[];
  restarts: ServiceName[];
}

const INTEGRATIONS: Integration[] = [
  {
    id: 'telegram',
    label: 'Telegram',
    description: 'Bot de Telegram para chatear con Emma desde el móvil. Crea uno con @BotFather.',
    helpUrl: 'https://t.me/BotFather',
    fields: [
      {
        envKey: 'TELEGRAM_BOT_TOKEN',
        label: 'Bot token',
        placeholder: '123456789:AAF...',
        secret: true,
        pattern: /^\d+:[A-Za-z0-9_-]{30,}$/,
      },
    ],
    restarts: ['telegram'],
  },
  {
    id: 'openrouter',
    label: 'OpenRouter',
    description: 'Modelos gratis con tools (recomendado como primario).',
    helpUrl: 'https://openrouter.ai/keys',
    fields: [
      {
        envKey: 'OPENROUTER_API_KEY',
        label: 'API key',
        placeholder: 'sk-or-...',
        secret: true,
        pattern: /^sk-or-[A-Za-z0-9_-]{20,}$/,
      },
    ],
    restarts: ['agent'],
  },
  {
    id: 'groq',
    label: 'Groq',
    description: 'Llama 3.3 70B rápido y gratis. También habilita la transcripción de voz (Whisper) en Telegram.',
    helpUrl: 'https://console.groq.com/keys',
    fields: [
      {
        envKey: 'GROQ_API_KEY',
        label: 'API key',
        placeholder: 'gsk_...',
        secret: true,
        pattern: /^gsk_[A-Za-z0-9_]{20,}$/,
      },
    ],
    restarts: ['agent', 'telegram'],
  },
  {
    id: 'opencode',
    label: 'OpenCode Zen',
    description: 'Pasarela de opencode con modelos gratis verificados (Big Pickle, GLM, Grok Code, MiniMax…). Ojo: los modelos free pueden usar sus datos para entrenamiento.',
    helpUrl: 'https://opencode.ai/auth',
    fields: [
      {
        envKey: 'OPENCODE_API_KEY',
        label: 'API key',
        placeholder: 'clave de opencode.ai/auth',
        secret: true,
      },
    ],
    restarts: ['agent'],
  },
  {
    id: 'anthropic',
    label: 'Anthropic (Claude)',
    description: 'Modelos Claude de pago — máxima calidad como respaldo.',
    helpUrl: 'https://console.anthropic.com',
    fields: [
      {
        envKey: 'ANTHROPIC_API_KEY',
        label: 'API key',
        placeholder: 'sk-ant-...',
        secret: true,
        pattern: /^sk-ant-[A-Za-z0-9_-]{20,}$/,
      },
    ],
    restarts: ['agent'],
  },
  {
    id: 'openai',
    label: 'OpenAI',
    description: 'GPT como proveedor de respaldo opcional.',
    helpUrl: 'https://platform.openai.com/api-keys',
    fields: [
      {
        envKey: 'OPENAI_API_KEY',
        label: 'API key',
        placeholder: 'sk-...',
        secret: true,
        pattern: /^sk-(?!ant-|or-)[A-Za-z0-9_-]{20,}$/,
      },
    ],
    restarts: ['agent'],
  },
  {
    id: 'voyage',
    label: 'Voyage AI',
    description: 'Embeddings para la memoria semántica de largo plazo.',
    helpUrl: 'https://dash.voyageai.com',
    fields: [
      {
        envKey: 'VOYAGE_API_KEY',
        label: 'API key',
        placeholder: 'pa-...',
        secret: true,
        pattern: /^pa-[A-Za-z0-9_-]{10,}$/,
      },
    ],
    restarts: ['agent'],
  },
  {
    id: 'email',
    label: 'Gmail',
    description: 'Enviar, leer y buscar correo. Requiere un App Password generado desde la MISMA cuenta.',
    helpUrl: 'https://myaccount.google.com/apppasswords',
    fields: [
      {
        envKey: 'EMAIL_USER',
        label: 'Dirección Gmail',
        placeholder: 'usuario@gmail.com',
        secret: false,
        pattern: /^[^\s@]+@[^\s@]+\.[^\s@]+$/,
      },
      {
        envKey: 'EMAIL_PASSWORD',
        label: 'App Password (16 caracteres)',
        placeholder: 'xxxx xxxx xxxx xxxx',
        secret: true,
        pattern: /^([a-z]{4} [a-z]{4} [a-z]{4} [a-z]{4}|[a-z]{16})$/i,
      },
    ],
    restarts: ['agent'],
  },
  {
    id: 'github',
    label: 'GitHub',
    description: 'Gestionar repos, issues y PRs vía la CLI gh.',
    helpUrl: 'https://github.com/settings/tokens',
    fields: [
      {
        envKey: 'GH_TOKEN',
        label: 'Personal Access Token',
        placeholder: 'ghp_... o github_pat_...',
        secret: true,
        pattern: /^(ghp_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,})$/,
      },
    ],
    restarts: ['agent'],
  },
];

const FIELD_BY_KEY = new Map(
  INTEGRATIONS.flatMap((i) => i.fields.map((f) => [f.envKey, { field: f, integration: i }] as const)),
);

function readEnv(): Record<string, string> {
  if (!existsSync(ENV_PATH) && existsSync(ENV_EXAMPLE_PATH)) {
    copyFileSync(ENV_EXAMPLE_PATH, ENV_PATH);
  }
  const out: Record<string, string> = {};
  if (!existsSync(ENV_PATH)) return out;
  for (const line of readFileSync(ENV_PATH, 'utf8').split('\n')) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m?.[1] !== undefined) out[m[1]] = m[2] ?? '';
  }
  return out;
}

function updateEnv(values: Record<string, string>): void {
  let content = existsSync(ENV_PATH) ? readFileSync(ENV_PATH, 'utf8') : '';
  for (const [key, value] of Object.entries(values)) {
    if (content.match(new RegExp(`^${key}=`, 'm'))) {
      content = content.replace(new RegExp(`^${key}=.*`, 'm'), `${key}=${value}`);
    } else {
      content += `${content.endsWith('\n') || content === '' ? '' : '\n'}${key}=${value}\n`;
    }
  }
  writeFileSync(ENV_PATH, content, 'utf8');
}

function mask(value: string): string {
  if (value.length <= 8) return '••••';
  return `${value.slice(0, 5)}…${value.slice(-4)}`;
}

function restartService(service: ServiceName): void {
  // Los servicios los gestiona systemd --user (Restart=always). NO usar pkill+spawn:
  // systemd revive el proceso y el spawn manual crearía un segundo que choca de puerto.
  const xdg = process.env['XDG_RUNTIME_DIR'] ?? `/run/user/${process.getuid?.() ?? 1000}`;
  const res = spawnSync('systemctl', ['--user', 'restart', `emma-${service}`], {
    timeout: 8000,
    env: { ...process.env, XDG_RUNTIME_DIR: xdg },
  });
  if (res.status === 0) {
    logger.info({ service }, 'Service restarted with new settings (systemd)');
    return;
  }
  // Fallback (entorno sin systemd): relanzar a mano como antes
  logger.warn({ service, err: res.stderr?.toString() }, 'systemctl restart failed, falling back to spawn');
  spawnSync('pkill', ['-f', `apps/${service}/dist/index.js`], { timeout: 3000 });
  setTimeout(() => {
    mkdirSync('/tmp/emma', { recursive: true });
    const log = openSync(`/tmp/emma-${service}.log`, 'a');
    const child = spawn(
      process.execPath,
      [`--env-file=${ENV_PATH}`, `apps/${service}/dist/index.js`],
      { cwd: EMMA_DIR, detached: true, stdio: ['ignore', log, log] },
    );
    child.unref();
    logger.info({ service }, 'Service restarted with new settings (spawn fallback)');
  }, 1500);
}

const EMPTY_VALUES = new Set(['', 'sk-ant-...', 'pa-...', 'change-me-in-production-min-32-chars']);

export const settingsRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get('/settings', async () => {
    const env = readEnv();
    return {
      integrations: INTEGRATIONS.map((i) => ({
        id: i.id,
        label: i.label,
        description: i.description,
        helpUrl: i.helpUrl,
        configured: i.fields.every((f) => {
          const v = env[f.envKey] ?? '';
          return v !== '' && !EMPTY_VALUES.has(v);
        }),
        fields: i.fields.map((f) => {
          const v = env[f.envKey] ?? '';
          const set = v !== '' && !EMPTY_VALUES.has(v);
          return {
            envKey: f.envKey,
            label: f.label,
            placeholder: f.placeholder,
            secret: f.secret,
            value: set ? (f.secret ? mask(v) : v) : null,
          };
        }),
      })),
    };
  });

  fastify.post('/settings', async (req, reply) => {
    const body = z.object({ values: z.record(z.string().min(1).max(500)) }).safeParse(req.body);
    if (!body.success) {
      return reply.status(400).send({ error: body.error.message });
    }

    const restarts = new Set<ServiceName>();
    const warnings: string[] = [];

    for (const [key, value] of Object.entries(body.data.values)) {
      const entry = FIELD_BY_KEY.get(key);
      if (!entry) {
        return reply.status(400).send({ error: `Clave no permitida: ${key}` });
      }
      if (entry.field.pattern && !entry.field.pattern.test(value.trim())) {
        warnings.push(`${entry.field.label}: el formato no es el habitual — guardada de todos modos.`);
      }
      for (const s of entry.integration.restarts) restarts.add(s);
    }

    const trimmed = Object.fromEntries(
      Object.entries(body.data.values).map(([k, v]) => [k, v.trim()]),
    );
    updateEnv(trimmed);
    for (const service of restarts) restartService(service);

    logger.info({ keys: Object.keys(trimmed), restarted: [...restarts] }, 'Settings updated');
    return { ok: true, restarted: [...restarts], warnings };
  });
};
