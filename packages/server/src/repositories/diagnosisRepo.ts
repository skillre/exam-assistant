import { randomUUID } from 'node:crypto';
import type { DiagnosisResult } from '@exam/shared';
import { db } from '../db/index.js';

// v3 诊断结果仓储（DEC-33，FR5.3 缓存）：AI 错因归类产出缓存，避免重复调用。

interface DiagnosisRow {
  id: string;
  bank_id: string | null;
  results: string; // JSON
  created_at: number;
}

export interface DiagnosisRecord {
  id: string;
  bankId: string | null;
  results: DiagnosisResult[];
  createdAt: number;
}

function parseJson(raw: string): DiagnosisResult[] {
  try {
    const arr = JSON.parse(raw) as DiagnosisResult[];
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

function toRecord(row: DiagnosisRow): DiagnosisRecord {
  return {
    id: row.id,
    bankId: row.bank_id,
    results: parseJson(row.results),
    createdAt: row.created_at,
  };
}

export const diagnosisRepo = {
  /** 保存诊断结果，返回记录 id */
  save(bankId: string | null, results: DiagnosisResult[]): string {
    const id = randomUUID();
    const now = Date.now();
    db.prepare(
      `INSERT INTO diagnosis_results (id, bank_id, results, created_at)
       VALUES (@id, @bank_id, @results, @created_at)`,
    ).run({
      id,
      bank_id: bankId,
      results: JSON.stringify(results),
      created_at: now,
    });
    return id;
  },

  /** 获取最新一条诊断结果（bankId 指定时按库取，否则取全局） */
  getLatest(bankId?: string): DiagnosisRecord | undefined {
    if (bankId) {
      const row = db
        .prepare(
          'SELECT * FROM diagnosis_results WHERE bank_id = ? ORDER BY created_at DESC LIMIT 1',
        )
        .get(bankId) as DiagnosisRow | undefined;
      return row ? toRecord(row) : undefined;
    }
    const row = db
      .prepare('SELECT * FROM diagnosis_results WHERE bank_id IS NULL ORDER BY created_at DESC LIMIT 1')
      .get() as DiagnosisRow | undefined;
    return row ? toRecord(row) : undefined;
  },
};
