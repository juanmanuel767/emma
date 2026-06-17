import Fastify from 'fastify';
import cors from '@fastify/cors';
import jwt from '@fastify/jwt';
import rateLimit from '@fastify/rate-limit';
import type { AgentClient } from '../../infrastructure/agent-client/AgentClient.js';
import { chatRoutes } from './routes/chat.js';
import { settingsRoutes } from './routes/settings.js';
import { modelManagerRoutes } from './routes/models-manager.js';
import { createLogger } from '@emma/shared/logger';

const logger = createLogger('gateway-server');

export async function buildGateway(deps: {
  agentClient: AgentClient;
  jwtSecret: string;
  port: number;
  redisUrl: string;
  ollamaBaseUrl: string;
}) {
  const app = Fastify({ logger: false, trustProxy: true });

  await app.register(cors, { origin: true, credentials: true });

  await app.register(jwt, {
    secret: deps.jwtSecret,
    sign: { expiresIn: '7d' },
  });

  await app.register(rateLimit, {
    max: 60,
    timeWindow: '1 minute',
    skipOnError: true,
  });

  app.get('/health', async () => ({ status: 'ok', service: 'gateway' }));

  // Optional JWT verification — skip if no Authorization header (anonymous usage)
  app.addHook('onRequest', async (req, reply) => {
    const auth = req.headers.authorization;
    if (auth?.startsWith('Bearer ')) {
      try {
        await req.jwtVerify();
      } catch {
        return reply.status(401).send({ error: 'Invalid token' });
      }
    }
  });

  await app.register(chatRoutes, { agentClient: deps.agentClient });
  await app.register(settingsRoutes);
  await app.register(modelManagerRoutes, { ollamaBaseUrl: deps.ollamaBaseUrl });

  return {
    start: async () => {
      await app.listen({ port: deps.port, host: '0.0.0.0' });
      logger.info({ port: deps.port }, 'Gateway started');
    },
    stop: () => app.close(),
    app,
  };
}
