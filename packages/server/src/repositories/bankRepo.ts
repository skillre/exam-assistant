import { randomUUID } from 'node:crypto';
import type { Bank } from '@exam/shared';
import { db } from '../db/index.js';

interface BankRow {
  id: string;
  name: string;
  created_at: number;
}

function toBank(row: BankRow): Bank {
  return { id: row.id, name: row.name, createdAt: row.created_at };
}

export const bankRepo = {
  list(): Bank[] {
    const rows = db.prepare('SELECT * FROM banks ORDER BY created_at DESC').all() as BankRow[];
    return rows.map(toBank);
  },

  get(id: string): Bank | undefined {
    const row = db.prepare('SELECT * FROM banks WHERE id = ?').get(id) as BankRow | undefined;
    return row ? toBank(row) : undefined;
  },

  create(name: string): Bank {
    const id = randomUUID();
    const now = Date.now();
    db.prepare('INSERT INTO banks (id, name, created_at) VALUES (?, ?, ?)').run(id, name, now);
    return { id, name, createdAt: now };
  },

  /** 重命名。返回更新后的 Bank，不存在则 undefined。 */
  rename(id: string, name: string): Bank | undefined {
    const info = db.prepare('UPDATE banks SET name = ? WHERE id = ?').run(name, id);
    if (info.changes === 0) return undefined;
    return this.get(id);
  },

  /** 各题库的题目数（一次聚合，避免 N+1）。返回 bankId -> count 映射。 */
  questionCounts(): Map<string, number> {
    const rows = db
      .prepare('SELECT bank_id, COUNT(*) AS n FROM questions GROUP BY bank_id')
      .all() as { bank_id: string; n: number }[];
    return new Map(rows.map((r) => [r.bank_id, r.n]));
  },

  remove(id: string): boolean {
    // questions/attempts/tutor_sessions 经 ON DELETE CASCADE 一并清除（DEC-13）
    const info = db.prepare('DELETE FROM banks WHERE id = ?').run(id);
    return info.changes > 0;
  },
};
