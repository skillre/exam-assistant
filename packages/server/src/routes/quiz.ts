import type { FastifyInstance } from 'fastify';
import type { GradeRequest, GradeResponse } from '@exam/shared';
import { bankRepo } from '../repositories/bankRepo.js';
import { questionRepo } from '../repositories/questionRepo.js';
import { attemptRepo } from '../repositories/attemptRepo.js';
import { gradeQuestion } from '../grading/grade.js';

// Phase 4：刷题闭环。判分纯程序、确定性（DEC-3），每次作答落 attempt。

export function registerQuizRoutes(app: FastifyInstance): void {
  // 题库列表
  app.get('/api/banks', async () => bankRepo.list());

  // 某题库的题目
  app.get<{ Params: { id: string } }>('/api/banks/:id/questions', async (req, reply) => {
    const bank = bankRepo.get(req.params.id);
    if (!bank) return reply.code(404).send({ error: '题库不存在' });
    return questionRepo.listByBank(req.params.id);
  });

  // 判分 + 落库。attemptId 回传供 tutor/explain 关联（评审 #4）。
  app.post<{ Body: GradeRequest }>('/api/quiz/grade', async (req, reply) => {
    const { questionId, userAnswer } = req.body ?? {};
    if (!questionId || userAnswer === undefined) {
      return reply.code(400).send({ error: 'questionId/userAnswer 必填' });
    }
    const question = questionRepo.get(questionId);
    if (!question) return reply.code(404).send({ error: '题目不存在' });

    const isCorrect = gradeQuestion(question, userAnswer);
    const attemptId = attemptRepo.record(questionId, userAnswer, isCorrect);

    const res: GradeResponse = {
      attemptId,
      isCorrect,
      correctAnswer: question.answer,
    };
    return res;
  });

  // 错题本：做错过的题（去重到题粒度）
  app.get('/api/quiz/wrong', async () => attemptRepo.listWrongQuestions());
}
