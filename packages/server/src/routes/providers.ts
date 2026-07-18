import type { FastifyInstance } from 'fastify';
import type { ProviderUpsert } from '@exam/shared';
import { providerRepo } from '../repositories/providerRepo.js';
import type { AiService } from '../ai/AiService.js';

// DEC-20：provider 增删改查。响应体永不含明文 Key（providerRepo 已脱敏）。

export function registerProviderRoutes(app: FastifyInstance, ai: AiService): void {
  app.get('/api/providers', async () => providerRepo.list());

  app.post<{ Body: ProviderUpsert }>('/api/providers', async (req, reply) => {
    const body = req.body;
    if (!body?.name || !body?.baseUrl || !body?.api || !body?.apiKey) {
      return reply.code(400).send({ error: 'name/baseUrl/api/apiKey 必填' });
    }
    const created = providerRepo.create(body);
    await ai.reloadProviders(); // DEC-21：provider 变更后重建 runtime
    return reply.code(201).send(created);
  });

  app.put<{ Params: { id: string }; Body: ProviderUpsert }>(
    '/api/providers/:id',
    async (req, reply) => {
      const updated = providerRepo.update(req.params.id, req.body);
      if (!updated) return reply.code(404).send({ error: 'provider 不存在' });
      await ai.reloadProviders();
      return updated;
    },
  );

  app.delete<{ Params: { id: string } }>('/api/providers/:id', async (req, reply) => {
    const ok = providerRepo.remove(req.params.id);
    if (!ok) return reply.code(404).send({ error: 'provider 不存在' });
    await ai.reloadProviders();
    return reply.code(204).send();
  });

  // v2：连通性测试（DEC-27）。用已存解密 Key 发一次最小请求，Key 绝不回传。
  app.post<{ Params: { id: string }; Body: { modelId?: string } }>(
    '/api/providers/:id/test',
    async (req, reply) => {
      const provider = providerRepo.list().find((p) => p.id === req.params.id);
      if (!provider) return reply.code(404).send({ error: 'provider 不存在' });
      if (!provider.configured) {
        return reply.send({ ok: false, message: '该 provider 尚未配置 API Key' });
      }
      const modelId = req.body?.modelId ?? provider.models[0]?.id;
      if (!modelId) {
        return reply.send({ ok: false, message: '该 provider 没有可用模型' });
      }
      const result = await ai.testProvider(req.params.id, modelId);
      return reply.send(result); // ConnTestResult：绝不含 Key
    },
  );
}
