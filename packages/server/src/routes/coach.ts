import type { FastifyInstance } from 'fastify';
import type { AiService } from '../ai/AiService.js';
import type { DiagnosisResult, LearningTask } from '@exam/shared';
import { collectDiagnosisContext } from '../insights/diagnosisCollector.js';
import { buildDiagnosisPrompt, DIAGNOSIS_SYSTEM_PROMPT } from '../ai/diagnosisPrompts.js';
import { validateDiagnosisResults } from '../import/diagnosisSchema.js';
import { diagnosisRepo } from '../repositories/diagnosisRepo.js';
import { learningDataCollector } from '../insights/LearningDataCollector.js';
import { buildPlanPrompt, PLAN_SYSTEM_PROMPT } from '../ai/planPrompts.js';
import { validatePlan } from '../import/planSchema.js';
import { planRepo } from '../repositories/planRepo.js';
import { openSse } from './sseWriter.js';

// Coach 路由（v3 Slice 5 & 6）：AI 学习教练 —— 错因诊断 + 学习计划生成 + 任务管理。
// 面板数据走 REST（即时），AI 深度产出按需触发（SSE 流式 + 结构化落库，DEC-35/FR5.2）。

/** 从 AI 返回文本中提取 JSON 数组/对象（容忍 markdown 围栏与前后缀） */
function extractJson(text: string): unknown {
  const arrStart = text.indexOf('[');
  const arrEnd = text.lastIndexOf(']');
  if (arrStart !== -1 && arrEnd > arrStart) {
    try {
      return JSON.parse(text.slice(arrStart, arrEnd + 1));
    } catch {
      /* fallback */
    }
  }
  const objStart = text.indexOf('{');
  const objEnd = text.lastIndexOf('}');
  if (objStart !== -1 && objEnd > objStart) {
    try {
      return JSON.parse(text.slice(objStart, objEnd + 1));
    } catch {
      /* fallback */
    }
  }
  throw new Error('AI 未返回可识别的 JSON');
}

export function registerCoachRoutes(app: FastifyInstance, ai: AiService): void {
  // ── Slice 5：错误诊断（SSE 流式 + 结构化保存，DEC-33） ──

  app.post<{ Body: { bankId?: string } }>('/api/coach/diagnosis', async (req, reply) => {
    const bankId = req.body?.bankId;
    const sse = openSse(reply);

    try {
      const ctx = await collectDiagnosisContext(bankId);
      if (ctx.wrongAttempts.length === 0) {
        sse.error('暂无错题记录，无需诊断');
        return;
      }

      const prompt = buildDiagnosisPrompt(ctx);
      const raw = await ai.runOnce(DIAGNOSIS_SYSTEM_PROMPT, prompt);

      sse.delta(raw);

      const json = extractJson(raw);
      const results = validateDiagnosisResults(json);

      diagnosisRepo.save(bankId ?? null, results);

      sse.done();
    } catch (err) {
      sse.error((err as Error).message);
    }
  });

  // 获取最新诊断结果（FR5.3 缓存）
  app.get<{ Querystring: { bankId?: string } }>('/api/coach/diagnosis/latest', async (req) => {
    const record = diagnosisRepo.getLatest(req.query?.bankId);
    if (!record) return { results: [] };
    return { results: record.results, createdAt: record.createdAt };
  });

  // ── Slice 6：学习计划生成 + 任务管理（D2 两表） ──

  app.post<{ Body: { bankId?: string } }>('/api/coach/plan', async (req, reply) => {
    const bankId = req.body?.bankId;
    const sse = openSse(reply);

    try {
      const snapshot = await learningDataCollector.collect(bankId);
      if (snapshot.totalAttempts === 0) {
        sse.error('暂无做题记录，无法生成计划');
        return;
      }

      const diagnosis = diagnosisRepo.getLatest(bankId);
      const diagnosisResults: DiagnosisResult[] = diagnosis?.results ?? [];

      const prompt = buildPlanPrompt(snapshot, diagnosisResults);
      const raw = await ai.runOnce(PLAN_SYSTEM_PROMPT, prompt);

      sse.delta(raw);

      const json = extractJson(raw);
      const plan = validatePlan(json);

      // 落两表：learning_plans + learning_tasks（createPlan 内展开任务）
      planRepo.createPlan(bankId ?? '', plan.title, plan.description, plan.phases);

      sse.done();
    } catch (err) {
      sse.error((err as Error).message);
    }
  });

  // 列出所有学习计划
  app.get('/api/coach/plan', async () => {
    return planRepo.listPlans();
  });

  // 列出某计划的所有任务
  app.get<{ Params: { id: string } }>('/api/coach/plan/:id/tasks', async (req, reply) => {
    const plan = planRepo.getPlan(req.params.id);
    if (!plan) return reply.code(404).send({ error: '计划不存在' });
    return planRepo.listTasksByPlan(req.params.id);
  });

  // 更新任务状态
  app.patch<{ Params: { id: string }; Body: { status: LearningTask['status'] } }>(
    '/api/coach/task/:id/status',
    async (req, reply) => {
      const { status } = req.body ?? {};
      if (!status || !['pending', 'in_progress', 'done'].includes(status)) {
        return reply.code(400).send({ error: 'status 必须是 pending/in_progress/done' });
      }
      const ok = planRepo.updateTaskStatus(req.params.id, status);
      if (!ok) return reply.code(404).send({ error: '任务不存在' });
      return reply.code(204).send();
    },
  );
}
