/**
 * Emma — © 2026 Juan Manuel Peralta Chacón. Todos los derechos reservados.
 * Software PROPIETARIO. Prohibido su uso, copia o distribución sin autorización
 * previa y por escrito del autor (peraltachaconjuanmanuel5@gmail.com). Ver LICENSE.
 */

import { z } from 'zod';
import { loadConfig } from '@emma/shared/config';
import { createLogger } from '@emma/shared/logger';
import { AgentClient } from './infrastructure/agent-client/AgentClient.js';
import { buildGateway } from './interface/http/server.js';

const logger = createLogger('gateway');

const envSchema = z.object({
  GATEWAY_PORT: z.coerce.number().default(3000),
  AGENT_SERVICE_URL: z.string().url().default('http://localhost:3001'),
  REDIS_URL: z.string().url().default('redis://localhost:6379'),
  JWT_SECRET: z.string().min(32),
  OLLAMA_BASE_URL: z.string().url().default('http://localhost:11434'),
  // Clave Groq SOLO para transcribir notas de voz de la web (Whisper), igual que Telegram.
  // Opcional: sin ella el micrófono de la web avisa amablemente que falta configurarla.
  GROQ_API_KEY: z.string().transform((v) => v || undefined).optional(),
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
});

async function main() {
  const env = loadConfig(envSchema);

  const agentClient = new AgentClient(env.AGENT_SERVICE_URL);

  const gateway = await buildGateway({
    agentClient,
    jwtSecret: env.JWT_SECRET,
    port: env.GATEWAY_PORT,
    redisUrl: env.REDIS_URL,
    ollamaBaseUrl: env.OLLAMA_BASE_URL,
    groqApiKey: env.GROQ_API_KEY,
  });

  const shutdown = async () => {
    logger.info('Shutting down gateway...');
    await gateway.stop();
    process.exit(0);
  };

  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);

  await gateway.start();
}

main().catch((err) => {
  logger.error({ err }, 'Fatal error starting gateway');
  process.exit(1);
});