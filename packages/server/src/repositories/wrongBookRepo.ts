import { db } from '../db/index.js';

// v2：错题本状态仓储（DEC-28）。"已掌握"软标记，不物删 attempts。

interface WrongStateRow {
  question_id: string;
  is_mastered: number; // 0/1
  mastered_at: number | null;
}

export interface WrongState {
  mastered: boolean;
  masteredAt?: number;
}

export const wrongBookRepo = {
  /** 标记/取消"已掌握"（upsert） */
  setMastered(questionId: string, mastered: boolean): void {
    db.prepare(
      `INSERT INTO wrong_book_state (question_id, is_mastered, mastered_at)
       VALUES (@qid, @m, @at)
       ON CONFLICT(question_id) DO UPDATE SET is_mastered = @m, mastered_at = @at`,
    ).run({
      qid: questionId,
      m: mastered ? 1 : 0,
      at: mastered ? Date.now() : null,
    });
  },

  getState(questionId: string): WrongState | undefined {
    const row = db
      .prepare('SELECT * FROM wrong_book_state WHERE question_id = ?')
      .get(questionId) as WrongStateRow | undefined;
    if (!row) return undefined;
    return { mastered: row.is_mastered === 1, masteredAt: row.mastered_at ?? undefined };
  },

  /** 返回 question_id → 是否已掌握 的映射（错题列表批量拼接用） */
  listMasteredIds(): Set<string> {
    const rows = db
      .prepare('SELECT question_id FROM wrong_book_state WHERE is_mastered = 1')
      .all() as { question_id: string }[];
    return new Set(rows.map((r) => r.question_id));
  },
};
