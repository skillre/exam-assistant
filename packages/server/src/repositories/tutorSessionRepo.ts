import { randomUUID } from 'node:crypto';
import { db } from '../db/index.js';

// tutor_sessions（DEC-7）：每道题一个答疑会话，只存 JSONL 路径引用，
// 对话历史真相源是 pi SDK 写的 JSONL 文件，我们不复制内容。

interface TutorSessionRow {
  id: string;
  question_id: string;
  jsonl_path: string;
  created_at: number;
}

export interface TutorSession {
  id: string;
  questionId: string;
  jsonlPath: string;
  createdAt: number;
}

function toTutorSession(row: TutorSessionRow): TutorSession {
  return {
    id: row.id,
    questionId: row.question_id,
    jsonlPath: row.jsonl_path,
    createdAt: row.created_at,
  };
}

export const tutorSessionRepo = {
  /** 找某题已有的答疑会话（复用，避免重复建会话） */
  getByQuestion(questionId: string): TutorSession | undefined {
    const row = db
      .prepare('SELECT * FROM tutor_sessions WHERE question_id = ? ORDER BY created_at LIMIT 1')
      .get(questionId) as TutorSessionRow | undefined;
    return row ? toTutorSession(row) : undefined;
  },

  /** 记录一个新答疑会话的 JSONL 路径 */
  create(questionId: string, jsonlPath: string): TutorSession {
    const id = randomUUID();
    const now = Date.now();
    db.prepare(
      `INSERT INTO tutor_sessions (id, question_id, jsonl_path, created_at)
       VALUES (?, ?, ?, ?)`,
    ).run(id, questionId, jsonlPath, now);
    return { id, questionId, jsonlPath, createdAt: now };
  },

  /** 某题库下所有答疑会话的 JSONL 路径（级联删除题库前用来清理孤儿文件，DEC-13） */
  listJsonlPathsByBank(bankId: string): string[] {
    const rows = db
      .prepare(
        `SELECT ts.jsonl_path FROM tutor_sessions ts
         JOIN questions q ON q.id = ts.question_id
         WHERE q.bank_id = ?`,
      )
      .all(bankId) as { jsonl_path: string }[];
    return rows.map((r) => r.jsonl_path);
  },

  /** 单题的答疑 JSONL 路径（删单题前清理孤儿文件） */
  listJsonlPathsByQuestion(questionId: string): string[] {
    const rows = db
      .prepare('SELECT jsonl_path FROM tutor_sessions WHERE question_id = ?')
      .all(questionId) as { jsonl_path: string }[];
    return rows.map((r) => r.jsonl_path);
  },
};
