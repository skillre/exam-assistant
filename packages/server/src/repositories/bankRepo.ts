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

  remove(id: string): boolean {
    // questions/attempts/tutor_sessions 经 ON DELETE CASCADE 一并清除（DEC-13）
    const info = db.prepare('DELETE FROM banks WHERE id = ?').run(id);
    return info.changes > 0;
  },
};
