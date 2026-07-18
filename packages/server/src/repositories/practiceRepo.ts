import { randomUUID } from 'node:crypto';
import type { PracticeScope, PracticeSession } from '@exam/shared';
import { db } from '../db/index.js';

// v2：练习会话仓储（DEC-25）。定序后的题目 id 列表落库，续做读回原顺序。

interface PracticeRow {
  id: string;
  bank_id: string;
  question_ids: string; // JSON string[]
  current_index: number;
  scope: string; // JSON PracticeScope
  created_at: number;
}

function toSession(row: PracticeRow): PracticeSession {
  return {
    id: row.id,
    bankId: row.bank_id,
    questionIds: JSON.parse(row.question_ids) as string[],
    currentIndex: row.current_index,
    scope: JSON.parse(row.scope) as PracticeScope,
    createdAt: row.created_at,
  };
}

export const practiceRepo = {
  /** 新建练习会话，questionIds 已按范围/乱序定序 */
  create(scope: PracticeScope, questionIds: string[]): PracticeSession {
    const id = randomUUID();
    const createdAt = Date.now();
    db.prepare(
      `INSERT INTO practice_sessions (id, bank_id, question_ids, current_index, scope, created_at)
       VALUES (@id, @bank_id, @question_ids, 0, @scope, @created_at)`,
    ).run({
      id,
      bank_id: scope.bankId,
      question_ids: JSON.stringify(questionIds),
      scope: JSON.stringify(scope),
      created_at: createdAt,
    });
    return { id, bankId: scope.bankId, questionIds, currentIndex: 0, scope, createdAt };
  },

  get(id: string): PracticeSession | undefined {
    const row = db.prepare('SELECT * FROM practice_sessions WHERE id = ?').get(id) as
      | PracticeRow
      | undefined;
    return row ? toSession(row) : undefined;
  },

  /** 更新续做进度指针 */
  updateIndex(id: string, currentIndex: number): void {
    db.prepare('UPDATE practice_sessions SET current_index = ? WHERE id = ?').run(
      currentIndex,
      id,
    );
  },

  remove(id: string): void {
    db.prepare('DELETE FROM practice_sessions WHERE id = ?').run(id);
  },
};
