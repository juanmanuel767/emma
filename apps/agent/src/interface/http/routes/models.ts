import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import type { ModelService } from '../../../infrastructure/llm/ModelService.js';

const selectSchema = z.object({
  model: z.string().min(1).max(200),
});

export const modelRoutes: FastifyPluginAsync<{ modelService: ModelService }> = async (
  fastify,
  opts,
) => {
  fastify.get('/models', async () => ({
    current: opts.modelService.currentProvider,
    providers: opts.modelService.listProviders(),
    catalog: await opts.modelService.getCatalog(),
    catalogs: await opts.modelService.getCatalogs(),
  }));

  fastify.post('/models/select', async (req, reply) => {
    const body = selectSchema.safeParse(req.body);
    if (!body.success) {
      return reply.status(400).send({ error: body.error.message });
    }
    const result = opts.modelService.select(body.data.model);
    if (!result.ok) {
      return reply.status(422).send({ error: result.error });
    }
    return { ok: true, current: result.provider };
  });
};
