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

  /** 第四批 ①：全库题目（错题导出/标签计数用）。 */
  listAll(): Question[] {
    const rows = db
      .prepare('SELECT * FROM questions ORDER BY created_at')
      .all() as QuestionRow[];
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

  /** 新增单题到指定题库，返回入库后的 Question。 */
  insertOne(bankId: string, draft: QuestionDraft): Question {
    const id = randomUUID();
    const now = Date.now();
    db.prepare(
      `INSERT INTO questions (id, bank_id, type, stem, options, answer, explanation, tags, source, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      bankId,
      draft.type,
      draft.stem,
      JSON.stringify(draft.options),
      JSON.stringify(draft.answer),
      draft.explanation ?? null,
      draft.tags ? JSON.stringify(draft.tags) : null,
      draft.source ?? null,
      now,
    );
    return this.get(id)!;
  },

  /** 整题更新（题库归属不变）。返回更新后 Question，不存在则 undefined。 */
  update(id: string, draft: QuestionDraft): Question | undefined {
    const info = db
      .prepare(
        `UPDATE questions SET type = ?, stem = ?, options = ?, answer = ?, explanation = ?, tags = ?
         WHERE id = ?`,
      )
      .run(
        draft.type,
        draft.stem,
        JSON.stringify(draft.options),
        JSON.stringify(draft.answer),
        draft.explanation ?? null,
        draft.tags ? JSON.stringify(draft.tags) : null,
        id,
      );
    if (info.changes === 0) return undefined;
    return this.get(id);
  },

  /** 删单题。attempts/wrong_book_state 经外键 CASCADE 一并清。 */
  remove(id: string): boolean {
    return db.prepare('DELETE FROM questions WHERE id = ?').run(id).changes > 0;
  },

  /**
   * 移动/复制一批题到目标题库（事务原子）。
   * move：改 bank_id（保留作答/错题历史，因为 id 不变）。
   * copy：拷贝为新 id 插入目标库（不带作答历史）。
   * 返回实际处理条数。
   */
  moveOrCopy(ids: string[], targetBankId: string, op: 'move' | 'copy'): number {
    const now = Date.now();
    const run = db.transaction((qids: string[]) => {
      let n = 0;
      for (const qid of qids) {
        const q = this.get(qid);
        if (!q) continue;
        if (op === 'move') {
          db.prepare('UPDATE questions SET bank_id = ? WHERE id = ?').run(targetBankId, qid);
        } else {
          db.prepare(
            `INSERT INTO questions (id, bank_id, type, stem, options, answer, explanation, tags, source, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          ).run(
            randomUUID(),
            targetBankId,
            q.type,
            q.stem,
            JSON.stringify(q.options),
            JSON.stringify(q.answer),
            q.explanation ?? null,
            q.tags ? JSON.stringify(q.tags) : null,
            q.source ?? null,
            now,
          );
        }
        n += 1;
      }
      return n;
    });
    return run(ids);
  },

  /**
   * 批量打标签（事务）。mode='add' 并集去重；'replace' 整体替换。
   * 返回实际更新条数。
   */
  addTags(ids: string[], tags: string[], mode: 'add' | 'replace'): number {
    const clean = [...new Set(tags.map((t) => t.trim()).filter(Boolean))];
    const run = db.transaction((qids: string[]) => {
      let n = 0;
      for (const qid of qids) {
        const q = this.get(qid);
        if (!q) continue;
        const next =
          mode === 'replace' ? clean : [...new Set([...(q.tags ?? []), ...clean])];
        db.prepare('UPDATE questions SET tags = ? WHERE id = ?').run(
          next.length > 0 ? JSON.stringify(next) : null,
          qid,
        );
        n += 1;
      }
      return n;
    });
    return run(ids);
  },

  /** 全库已用标签集合（去重、排序），供前端下拉建议。 */
  allTags(): string[] {
    const rows = db
      .prepare("SELECT tags FROM questions WHERE tags IS NOT NULL")
      .all() as { tags: string }[];
    const set = new Set<string>();
    for (const r of rows) {
      try {
        for (const t of JSON.parse(r.tags) as string[]) set.add(t);
      } catch {
        /* 忽略坏 JSON */
      }
    }
    return [...set].sort((a, b) => a.localeCompare(b, 'zh'));
  },
};
