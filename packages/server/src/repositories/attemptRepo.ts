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
    userAnswer: parseJsonSafe(row.user_answer, 0 as AnswerValue),
    isCorrect: row.is_correct === 1,
    answeredAt: row.answered_at,
  };
}

/** 容错解析 JSON 列：数据自产自销（写入侧均 JSON.stringify），异常时回退默认值不抛 */
function parseJsonSafe<T>(raw: string, fallback: T): T {
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
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
    return rows.map(rowToQuestion);
  },

  /**
   * v2：错题明细聚合 —— 每题错误次数 + 最近错误时间（题粒度去重）。
   * 返回 question 全字段 + wrongCount + lastWrongAt，供错题本增强。
   */
  listWrongDetailed(): { question: Question; wrongCount: number; lastWrongAt: number }[] {
    const rows = db
      .prepare(
        `SELECT q.*, COUNT(a.id) AS wrong_count, MAX(a.answered_at) AS last_wrong_at
         FROM questions q
         JOIN attempts a ON a.question_id = q.id
         WHERE a.is_correct = 0
         GROUP BY q.id
         ORDER BY last_wrong_at DESC`,
      )
      .all() as (WrongQuestionRow & { wrong_count: number; last_wrong_at: number })[];
    return rows.map((row) => ({
      question: rowToQuestion(row),
      wrongCount: row.wrong_count,
      lastWrongAt: row.last_wrong_at,
    }));
  },

  /** v2：某题库内已作答过的题目 id 集合（"仅未做"范围用） */
  answeredQuestionIds(bankId: string): Set<string> {
    const rows = db
      .prepare(
        `SELECT DISTINCT a.question_id FROM attempts a
         JOIN questions q ON q.id = a.question_id
         WHERE q.bank_id = ?`,
      )
      .all(bankId) as { question_id: string }[];
    return new Set(rows.map((r) => r.question_id));
  },

  /**
   * v2：给定题目 id 集合，取每题"最新一次"作答的对错（成绩单用）。
   * append-only 语义下用 answered_at DESC 取最新。
   */
  latestByQuestion(questionIds: string[]): Map<string, { isCorrect: boolean; answeredAt: number }> {
    const result = new Map<string, { isCorrect: boolean; answeredAt: number }>();
    if (questionIds.length === 0) return result;
    const stmt = db.prepare(
      `SELECT is_correct, answered_at FROM attempts
       WHERE question_id = ? ORDER BY answered_at DESC LIMIT 1`,
    );
    for (const qid of questionIds) {
      const row = stmt.get(qid) as { is_correct: number; answered_at: number } | undefined;
      if (row) result.set(qid, { isCorrect: row.is_correct === 1, answeredAt: row.answered_at });
    }
    return result;
  },

  /**
   * P0-2：给定题目 id 集合，取每题最新一次作答的完整信息（含 attemptId），
   * 供练习会话续做恢复判分态（gradedById 填充）。
   */
  latestAttempts(
    questionIds: string[],
  ): Map<string, { attemptId: string; isCorrect: boolean; answeredAt: number }> {
    const result = new Map<string, { attemptId: string; isCorrect: boolean; answeredAt: number }>();
    if (questionIds.length === 0) return result;
    const stmt = db.prepare(
      `SELECT id, is_correct, answered_at FROM attempts
       WHERE question_id = ? ORDER BY answered_at DESC LIMIT 1`,
    );
    for (const qid of questionIds) {
      const row = stmt.get(qid) as
        | { id: string; is_correct: number; answered_at: number }
        | undefined;
      if (row) {
        result.set(qid, {
          attemptId: row.id,
          isCorrect: row.is_correct === 1,
          answeredAt: row.answered_at,
        });
      }
    }
    return result;
  },
};

function rowToQuestion(row: WrongQuestionRow): Question {
  return {
    id: row.id,
    bankId: row.bank_id,
    type: row.type as QuestionType,
    stem: row.stem,
    options: parseJsonSafe(row.options, [] as string[]),
    answer: parseJsonSafe(row.answer, 0 as AnswerValue),
    explanation: row.explanation ?? undefined,
    tags: row.tags ? parseJsonSafe(row.tags, [] as string[]) : undefined,
    source: (row.source as Question['source']) ?? undefined,
    createdAt: row.created_at,
  };
}
