import type { FastifyInstance } from 'fastify';
import type { ActiveModelSelection } from '@exam/shared';
import type { AiService } from '../ai/AiService.js';

// 评审 #3：模型列举 + 切换当前激活模型。

export function registerModelRoutes(app: FastifyInstance, ai: AiService): void {
  app.get('/api/models', async () => ai.listModels());

  app.post<{ Body: ActiveModelSelection }>('/api/settings/model', async (req, reply) => {
    const { providerId, modelId } = req.body ?? {};
    if (!providerId || !modelId) {
      return reply.code(400).send({ error: 'providerId/modelId 必填' });
    }
    try {
      ai.setModel(providerId, modelId);
      return { ok: true };
    } catch (err) {
      return reply.code(400).send({ error: (err as Error).message });
    }
  });
}
