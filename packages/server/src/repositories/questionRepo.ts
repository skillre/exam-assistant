import { randomUUID } from 'node:crypto';
import type { AnswerValue, Question, QuestionDraft, QuestionType } from '@exam/shared';
import { db } from '../db/index.js';

interface QuestionRow {
  id: string;
  bank_id: string;
  type: string;
  stem: string;
  options: string; // JSON
  answer: string; // JSON
  explanation: string | null;
  tags: string | null; // JSON
  source: string | null;
  created_at: number;
}

function toQuestion(row: QuestionRow): Question {
  return {
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
  };
}

export const questionRepo = {
  listByBank(bankId: string): Question[] {
    const rows = db
      .prepare('SELECT * FROM questions WHERE bank_id = ? ORDER BY created_at')
      .all(bankId) as QuestionRow[];
    return rows.map(toQuestion);
  },

  get(id: string): Question | undefined {
    const row = db.prepare('SELECT * FROM questions WHERE id = ?').get(id) as
      | QuestionRow
      | undefined;
    return row ? toQuestion(row) : undefined;
  },

  /** 批量入库草稿题，返回入库条数。用事务保证原子性。 */
  insertMany(bankId: string, drafts: QuestionDraft[]): number {
    const now = Date.now();
    const stmt = db.prepare(
      `INSERT INTO questions (id, bank_id, type, stem, options, answer, explanation, tags, source, created_at)
       VALUES (@id, @bank_id, @type, @stem, @options, @answer, @explanation, @tags, @source, @created_at)`,
    );
    const insertAll = db.transaction((items: QuestionDraft[]) => {
      for (const q of items) {
        stmt.run({
          id: randomUUID(),
          bank_id: bankId,
          type: q.type,
          stem: q.stem,
          options: JSON.stringify(q.options),
          answer: JSON.stringify(q.answer),
          explanation: q.explanation ?? null,
          tags: q.tags ? JSON.stringify(q.tags) : null,
          source: q.source ?? null,
          created_at: now,
        });
      }
      return items.length;
    });
    return insertAll(drafts);
  },
};
