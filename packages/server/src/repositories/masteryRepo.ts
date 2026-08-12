import { db } from '../db/index.js';

// v3 掌握判定仓储（DEC-32，D1 Option A 增量列）：不查历史 attempts，O(1) streak 维护。

interface MasteryRow {
  question_id: string;
  consecutive_correct: number;
  mastered: number;
  updated_at: number | null;
}

export const masteryRepo = {
  getOrCreate(questionId: string): { consecutiveCorrect: number; mastered: boolean } {
    let row = db
      .prepare('SELECT * FROM mastery_states WHERE question_id = ?')
      .get(questionId) as MasteryRow | undefined;
    if (!row) {
      db.prepare(
        'INSERT INTO mastery_states (question_id, consecutive_correct, mastered) VALUES (?, 0, 0)',
      ).run(questionId);
      row = { question_id: questionId, consecutive_correct: 0, mastered: 0, updated_at: null };
    }
    return {
      consecutiveCorrect: row.consecutive_correct,
      mastered: row.mastered === 1,
    };
  },

  /** 答对：streak+1，返回最新连续次数 */
  incrementCorrect(questionId: string): number {
    this.getOrCreate(questionId);
    db.prepare(
      `UPDATE mastery_states SET consecutive_correct = consecutive_correct + 1, updated_at = ? WHERE question_id = ?`,
    ).run(Date.now(), questionId);
    const row = db
      .prepare('SELECT consecutive_correct FROM mastery_states WHERE question_id = ?')
      .get(questionId) as { consecutive_correct: number };
    return row.consecutive_correct;
  },

  /** 答错：streak 清零（仅清零，不取消已掌握标记——masteryService 语义） */
  reset(questionId: string): void {
    this.getOrCreate(questionId);
    db.prepare(
      'UPDATE mastery_states SET consecutive_correct = 0, updated_at = ? WHERE question_id = ?',
    ).run(Date.now(), questionId);
  },

  getByQuestion(questionId: string): { consecutiveCorrect: number; mastered: boolean } | undefined {
    const row = db
      .prepare('SELECT * FROM mastery_states WHERE question_id = ?')
      .get(questionId) as MasteryRow | undefined;
    if (!row) return undefined;
    return {
      consecutiveCorrect: row.consecutive_correct,
      mastered: row.mastered === 1,
    };
  },

  setMastered(questionId: string, mastered: boolean): void {
    this.getOrCreate(questionId);
    db.prepare(
      'UPDATE mastery_states SET mastered = ?, updated_at = ? WHERE question_id = ?',
    ).run(mastered ? 1 : 0, Date.now(), questionId);
  },
};
