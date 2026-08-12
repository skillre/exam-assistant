import { randomUUID } from 'node:crypto';
import type { InsightSnapshot, TagStat, TypeStat } from '@exam/shared';
import { db } from '../db/index.js';

// v3 学情快照仓储（DEC-30）：练习完成时落库，session_id UNIQUE 幂等（D5）。

interface SnapshotRow {
  id: string;
  session_id: string;
  bank_id: string;
  total: number;
  correct: number;
  accuracy: number;
  by_tag: string;
  by_type: string;
  created_at: number;
}

function parseJson<T>(raw: string, fallback: T): T {
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function toSnapshot(row: SnapshotRow): InsightSnapshot {
  return {
    id: row.id,
    sessionId: row.session_id,
    bankId: row.bank_id,
    total: row.total,
    correct: row.correct,
    accuracy: row.accuracy,
    byTag: parseJson(row.by_tag, [] as TagStat[]),
    byType: parseJson(row.by_type, [] as TypeStat[]),
    createdAt: row.created_at,
  };
}

export const snapshotRepo = {
  /**
   * 落库一条快照（Slice0 对账 R1：对象参数）。sessionId 重复时幂等返回 null
   * （UNIQUE(session_id) + INSERT OR IGNORE，D5：练习完成只落一次）。
   */
  save(params: {
    sessionId: string;
    bankId: string;
    total: number;
    correct: number;
    accuracy: number;
    byTag: TagStat[];
    byType: TypeStat[];
  }): InsightSnapshot | null {
    const id = randomUUID();
    const createdAt = Date.now();
    const result = db
      .prepare(
        `INSERT OR IGNORE INTO insight_snapshots
         (id, session_id, bank_id, total, correct, accuracy, by_tag, by_type, created_at)
         VALUES (@id, @session_id, @bank_id, @total, @correct, @accuracy, @by_tag, @by_type, @created_at)`,
      )
      .run({
        id,
        session_id: params.sessionId,
        bank_id: params.bankId,
        total: params.total,
        correct: params.correct,
        accuracy: params.accuracy,
        by_tag: JSON.stringify(params.byTag),
        by_type: JSON.stringify(params.byType),
        created_at: createdAt,
      });
    if (result.changes === 0) return null;
    return {
      id,
      sessionId: params.sessionId,
      bankId: params.bankId,
      total: params.total,
      correct: params.correct,
      accuracy: params.accuracy,
      byTag: params.byTag,
      byType: params.byType,
      createdAt,
    };
  },

  /** 按库列出（Slice0 对账 R2：snapshotHistory 消费入口），时间倒序 */
  listAll(bankId?: string, limit = 50): InsightSnapshot[] {
    if (bankId) {
      return (
        db
          .prepare(
            'SELECT * FROM insight_snapshots WHERE bank_id = ? ORDER BY created_at DESC LIMIT ?',
          )
          .all(bankId, limit) as SnapshotRow[]
      ).map(toSnapshot);
    }
    return (
      db
        .prepare('SELECT * FROM insight_snapshots ORDER BY created_at DESC LIMIT ?')
        .all(limit) as SnapshotRow[]
    ).map(toSnapshot);
  },

  countSince(bankId: string | undefined, sinceTimestamp: number): number {
    if (bankId) {
      const row = db
        .prepare(
          'SELECT COUNT(*) as cnt FROM insight_snapshots WHERE bank_id = ? AND created_at > ?',
        )
        .get(bankId, sinceTimestamp) as { cnt: number };
      return row.cnt;
    }
    const row = db
      .prepare('SELECT COUNT(*) as cnt FROM insight_snapshots WHERE created_at > ?')
      .get(sinceTimestamp) as { cnt: number };
    return row.cnt;
  },
};
