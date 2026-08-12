import type { FastifyInstance } from 'fastify';
import { rm } from 'node:fs/promises';
import type {
  BankWithCount,
  CreateBankRequest,
  RenameBankRequest,
  QuestionUpsert,
  MoveCopyRequest,
  ApplyTagsRequest,
} from '@exam/shared';
import { bankRepo } from '../repositories/bankRepo.js';
import { questionRepo } from '../repositories/questionRepo.js';
import { tutorSessionRepo } from '../repositories/tutorSessionRepo.js';
import { questionDraftSchema } from '../import/questionSchema.js';

// v2：题库管理。新建/重命名/题数统计 + 单题 CRUD + 移动复制 + 批量打标签。
// 判分/作答历史保持在 quiz.ts；这里只管题库与题目的组织维护。
export function registerBankRoutes(app: FastifyInstance): void {
  // 题库列表（附题目数），供管理页展示
  app.get('/api/banks/with-counts', async () => {
    const counts = bankRepo.questionCounts();
    return bankRepo.list().map<BankWithCount>((b) => ({
      ...b,
      questionCount: counts.get(b.id) ?? 0,
    }));
  });

  // 全库已用标签集合，供下拉建议 + 学情/批量打标签复用
  app.get('/api/tags', async () => questionRepo.allTags());

  // 第四批 ③：按题库统计标签题量（{tag,count}[]，count=0 不返回）。
  // 前端 QuizPage byTag 下拉按当前选中 bank 拉取，避免跨库标签触发 409。
  app.get<{ Querystring: { bankId?: string } }>(
    '/api/tags/counts',
    async (req, reply) => {
      const bankId = req.query.bankId;
      if (!bankId) return reply.code(400).send({ error: 'bankId 必填' });
      const bank = bankRepo.get(bankId);
      if (!bank) return reply.code(404).send({ error: '题库不存在' });
      const counts = new Map<string, number>();
      for (const q of questionRepo.listByBank(bankId)) {
        for (const tag of q.tags ?? []) counts.set(tag, (counts.get(tag) ?? 0) + 1);
      }
      return [...counts.entries()]
        .map(([tag, count]) => ({ tag, count }))
        .sort((a, b) => a.tag.localeCompare(b.tag));
    },
  );

  // 新建空题库（管理页可先建库再导入）
  app.post<{ Body: CreateBankRequest }>('/api/banks', async (req, reply) => {
    const name = req.body?.name?.trim();
    if (!name) return reply.code(400).send({ error: '题库名称不能为空' });
    return reply.code(201).send(bankRepo.create(name));
  });

  // 重命名题库
  app.patch<{ Params: { id: string }; Body: RenameBankRequest }>(
    '/api/banks/:id',
    async (req, reply) => {
      const name = req.body?.name?.trim();
      if (!name) return reply.code(400).send({ error: '题库名称不能为空' });
      const bank = bankRepo.rename(req.params.id, name);
      if (!bank) return reply.code(404).send({ error: '题库不存在' });
      return bank;
    },
  );

  // ── 单题 CRUD ──
  // 新增单题到指定题库
  app.post<{ Params: { id: string }; Body: QuestionUpsert }>(
    '/api/banks/:id/questions',
    async (req, reply) => {
      const bank = bankRepo.get(req.params.id);
      if (!bank) return reply.code(404).send({ error: '题库不存在' });
      const parsed = questionDraftSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: parsed.error.issues.map((i) => i.message).join('；') });
      }
      return reply.code(201).send(questionRepo.insertOne(req.params.id, parsed.data));
    },
  );

  // 整题更新（题库归属不变）
  app.put<{ Params: { qid: string }; Body: QuestionUpsert }>(
    '/api/questions/:qid',
    async (req, reply) => {
      const parsed = questionDraftSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: parsed.error.issues.map((i) => i.message).join('；') });
      }
      const updated = questionRepo.update(req.params.qid, parsed.data);
      if (!updated) return reply.code(404).send({ error: '题目不存在' });
      return updated;
    },
  );

  // 删单题（先清答疑 JSONL 孤儿文件，再删；attempts/wrong_book_state 经 CASCADE 清）
  app.delete<{ Params: { qid: string } }>('/api/questions/:qid', async (req, reply) => {
    const q = questionRepo.get(req.params.qid);
    if (!q) return reply.code(404).send({ error: '题目不存在' });
    const paths = tutorSessionRepo.listJsonlPathsByQuestion(req.params.qid);
    await Promise.all(paths.map((p) => rm(p, { force: true }).catch(() => {})));
    questionRepo.remove(req.params.qid);
    return reply.code(204).send();
  });

  // ── 批量：移动/复制 + 打标签 ──
  app.post<{ Body: MoveCopyRequest }>('/api/questions/move-copy', async (req, reply) => {
    const { questionIds, targetBankId, op } = req.body ?? {};
    if (!Array.isArray(questionIds) || questionIds.length === 0) {
      return reply.code(400).send({ error: 'questionIds 不能为空' });
    }
    if (op !== 'move' && op !== 'copy') {
      return reply.code(400).send({ error: 'op 必须是 move 或 copy' });
    }
    if (!bankRepo.get(targetBankId)) {
      return reply.code(404).send({ error: '目标题库不存在' });
    }
    return { affected: questionRepo.moveOrCopy(questionIds, targetBankId, op) };
  });

  app.post<{ Body: ApplyTagsRequest }>('/api/questions/apply-tags', async (req, reply) => {
    const { questionIds, tags, mode } = req.body ?? {};
    if (!Array.isArray(questionIds) || questionIds.length === 0) {
      return reply.code(400).send({ error: 'questionIds 不能为空' });
    }
    if (!Array.isArray(tags)) {
      return reply.code(400).send({ error: 'tags 必须是数组' });
    }
    if (mode !== 'add' && mode !== 'replace') {
      return reply.code(400).send({ error: 'mode 必须是 add 或 replace' });
    }
    return { affected: questionRepo.addTags(questionIds, tags, mode) };
  });
}
