import type { FastifyInstance } from 'fastify';
import type { AiService } from '../ai/AiService.js';
import { learningDataCollector } from '../insights/LearningDataCollector.js';
import { buildInsightsPrompt, INSIGHTS_SYSTEM_PROMPT } from '../ai/insightsPrompts.js';
import { openSse } from './sseWriter.js';

// Phase 7：错因归纳 + 学情分析（SSE 流式）。
// 跨源汇集（DEC-12）→ 一次性分析会话 → 流式推报告。分析是无状态一次性任务，
// 用临时讲解会话跑完即弃（不落 tutor_sessions）。

export function registerInsightsRoutes(app: FastifyInstance, ai: AiService): void {
  // v2：结构化学情快照（REST 即时返回，非 SSE，DEC-24）。空记录返回空快照而非 409，
  // 让前端面板能显示「暂无数据」。
  app.get<{ Querystring: { bankId?: string } }>('/api/insights/snapshot', async (req) => {
    return learningDataCollector.collect(req.query?.bankId);
  });

  app.post<{ Body: { bankId?: string } }>('/api/insights/analyze', async (req, reply) => {
    const bankId = req.body?.bankId;

    const snapshot = await learningDataCollector.collect(bankId);
    if (snapshot.totalAttempts === 0) {
      return reply.code(409).send({ error: '暂无做题记录，先做几道题再来分析' });
    }

    const sse = openSse(reply);
    try {
      const created = await ai.createTutorSession({ systemPrompt: INSIGHTS_SYSTEM_PROMPT });
      const prompt = buildInsightsPrompt(snapshot);
      await ai.streamPrompt(created.session, prompt, (chunk) => sse.delta(chunk));
      created.session.dispose();
      sse.done();
    } catch (err) {
      sse.error((err as Error).message);
    }
  });
}
