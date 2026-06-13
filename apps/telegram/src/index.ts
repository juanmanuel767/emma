/**
 * Emma — © 2026 Juan Manuel Peralta Chacón. Todos los derechos reservados.
 * Software PROPIETARIO. Prohibido su uso, copia o distribución sin autorización
 * previa y por escrito del autor (peraltachaconjuanmanuel5@gmail.com). Ver LICENSE.
 */

import { Bot } from 'grammy';
import { z } from 'zod';
import { loadConfig } from '@emma/shared/config';
import { createLogger } from '@emma/shared/logger';
import { GatewayClient } from './infrastructure/GatewayClient.js';
import { registerHandlers } from './bot/handlers.js';

const logger = createLogger('telegram');

const envSchema = z.object({
  TELEGRAM_BOT_TOKEN: z.string().min(1),
  GATEWAY_URL: z.string().url().default('http://localhost:3000'),
  GROQ_API_KEY: z.string().transform((v) => v || undefined).optional(),
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
});

async function main() {
  const env = loadConfig(envSchema);

  const bot = new Bot(env.TELEGRAM_BOT_TOKEN);
  const gateway = new GatewayClient(env.GATEWAY_URL);

  registerHandlers(bot, gateway, {
    botToken: env.TELEGRAM_BOT_TOKEN,
    groqApiKey: env.GROQ_API_KEY,
  });

  bot.catch((err) => logger.error({ err }, 'Bot error'));

  process.on('SIGTERM', () => { bot.stop(); process.exit(0); });
  process.on('SIGINT', () => { bot.stop(); process.exit(0); });

  logger.info('Starting Telegram bot...');
  await bot.start({ onStart: (info) => logger.info({ username: info.username }, 'Bot started') });
}

main().catch((err) => {
  logger.error({ err }, 'Fatal error starting telegram bot');
  process.exit(1);
});