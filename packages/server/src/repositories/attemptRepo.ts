import { randomUUID } from 'node:crypto';
import type { AnswerValue, Attempt, Question, QuestionType } from '@exam/shared';
import { db } from '../db/index.js';

interface AttemptRow {
  id: string;
  question_id: string;
  user_answer: string; // JSON
  is_correct: number; // 0/1
  answered_at: number;
}

function toAttempt(row: AttemptRow): Attempt {
  return {
    id: row.id,
    questionId: row.question_id,
    userAnswer: JSON.parse(row.user_answer) as AnswerValue,
    isCorrect: row.is_correct === 1,
    answeredAt: row.answered_at,
  };
}

interface WrongQuestionRow {
  id: string;
  bank_id: string;
  type: string;
  stem: string;
  options: string;
  answer: string;
  explanation: string | null;
  tags: string | null;
  source: string | null;
  created_at: number;
}

export const attemptRepo = {
  /** 记录一次作答，返回新 attempt 的 id（供 tutor/explain 关联，评审 #4） */
  record(questionId: string, userAnswer: AnswerValue, isCorrect: boolean): string {
    const id = randomUUID();
    db.prepare(
      `INSERT INTO attempts (id, question_id, user_answer, is_correct, answered_at)
       VALUES (@id, @question_id, @user_answer, @is_correct, @answered_at)`,
    ).run({
      id,
      question_id: questionId,
      user_answer: JSON.stringify(userAnswer),
      is_correct: isCorrect ? 1 : 0,
      answered_at: Date.now(),
    });
    return id;
  },

  get(id: string): Attempt | undefined {
    const row = db.prepare('SELECT * FROM attempts WHERE id = ?').get(id) as
      | AttemptRow
      | undefined;
    return row ? toAttempt(row) : undefined;
  },

  /**
   * 错题本：曾经做错过的题（去重到题粒度）。
   * 只要该题存在 is_correct=0 的记录即算错题，即便后来做对也保留（供复习）。
   */
  listWrongQuestions(): Question[] {
    const rows = db
      .prepare(
        `SELECT DISTINCT q.* FROM questions q
         JOIN attempts a ON a.question_id = q.id
         WHERE a.is_correct = 0
         ORDER BY q.created_at`,
      )
      .all() as WrongQuestionRow[];
    return rows.map((row) => ({
      id: row.id,
      bankId: row.bank_id,
      type: row.type as QuestionType,
      stem: row.stem,
      options: JSON.parse(row.options) as string[],
      answer: JSON.parse(row.answer) as AnswerValue,
      explanation: row.explanation ?? undefined,
      tags: row.tags ? (JSON.parse(row.tags) as string[]) : undefined,
      source: (row.source as Question['source']) ?? undefined,
      createdAt: row.created_at,
    }));
  },
};
