import Fastify from 'fastify';
import cors from '@fastify/cors';
import type { RunConversation } from '../../application/use-cases/RunConversation.js';
import type { SkillRegistry } from '@emma/skills';
import { chatRoutes } from './routes/chat.js';
import { modelRoutes } from './routes/models.js';
import { conversationRoutes } from './routes/conversations.js';
import type { ModelService } from '../../infrastructure/llm/ModelService.js';
import type { IConversationRepository } from '@emma/core/ports';
import { createLogger } from '@emma/shared/logger';

const logger = createLogger('agent-server');

export async function buildServer(deps: { runConversation: RunConversation; skillRegistry: SkillRegistry; modelService: ModelService; conversationRepo: IConversationRepository; port: number }) {
  const app = Fastify({ logger: false });

  await app.register(cors, { origin: true });

  app.get('/health', async () => ({ status: 'ok', service: 'agent' }));

  app.get('/skills', async () => ({
    skills: deps.skillRegistry.listSkills(),
    tools: deps.skillRegistry.listTools().map((t) => ({ name: t.name, description: t.description.slice(0, 80) })),
  }));

  await app.register(chatRoutes, { runConversation: deps.runConversation });
  await app.register(modelRoutes, { modelService: deps.modelService });
  await app.register(conversationRoutes, { conversationRepo: deps.conversationRepo });

  return {
    start: async () => {
      await app.listen({ port: deps.port, host: '0.0.0.0' });
      logger.info({ port: deps.port }, 'Agent service started');
    },
    stop: () => app.close(),
    app,
  };
}
