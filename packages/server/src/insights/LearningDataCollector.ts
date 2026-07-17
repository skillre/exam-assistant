import type { LearningSnapshot, WeakTag } from '@exam/shared';
import { db } from '../db/index.js';
import { tutorSessionRepo } from '../repositories/tutorSessionRepo.js';
import { readSessionHistory } from '../ai/sessionHistory.js';

// DEC-12：学情分析的跨源汇集器。
// - SQLite：做题记录(attempts) + 题目标签(tags) → 正确率、按知识点聚合的薄弱点
// - JSONL：答疑会话内容 → 提炼要点（学生问过什么、卡在哪）
// 无答疑记录时降级为仅用做题记录，不报错。

interface AttemptTagRow {
  is_correct: number;
  tags: string | null; // JSON 字符串数组
}

interface TutorRow {
  question_id: string;
  jsonl_path: string;
}

export class LearningDataCollector {
  /** 汇集学情快照。bankId 可选：限定某题库，否则全量。 */
  async collect(bankId?: string): Promise<LearningSnapshot> {
    const rows = this.queryAttemptTags(bankId);

    const totalAttempts = rows.length;
    const correctCount = rows.filter((r) => r.is_correct === 1).length;
    const accuracy = totalAttempts > 0 ? correctCount / totalAttempts : 0;

    const weakTags = this.aggregateWeakTags(rows);
    const tutorHighlights = await this.collectTutorHighlights(bankId);

    return { totalAttempts, accuracy, weakTags, tutorHighlights };
  }

  /** 查 attempts join questions 拿到 (是否正确, 题目标签) */
  private queryAttemptTags(bankId?: string): AttemptTagRow[] {
    if (bankId) {
      return db
        .prepare(
          `SELECT a.is_correct, q.tags FROM attempts a
           JOIN questions q ON q.id = a.question_id
           WHERE q.bank_id = ?`,
        )
        .all(bankId) as AttemptTagRow[];
    }
    return db
      .prepare(
        `SELECT a.is_correct, q.tags FROM attempts a
         JOIN questions q ON q.id = a.question_id`,
      )
      .all() as AttemptTagRow[];
  }

  /** 按知识点标签聚合薄弱点：每个 tag 的 错数/总数，按错数降序 */
  private aggregateWeakTags(rows: AttemptTagRow[]): WeakTag[] {
    const map = new Map<string, { wrong: number; total: number }>();
    for (const row of rows) {
      const tags = this.parseTags(row.tags);
      // 无标签的题归到 "未分类"，仍纳入统计
      const effectiveTags = tags.length > 0 ? tags : ['未分类'];
      for (const tag of effectiveTags) {
        const entry = map.get(tag) ?? { wrong: 0, total: 0 };
        entry.total += 1;
        if (row.is_correct === 0) entry.wrong += 1;
        map.set(tag, entry);
      }
    }
    return [...map.entries()]
      .map(([tag, s]) => ({ tag, wrong: s.wrong, total: s.total }))
      .filter((t) => t.wrong > 0) // 只报有错的标签
      .sort((a, b) => b.wrong - a.wrong);
  }

  private parseTags(raw: string | null): string[] {
    if (!raw) return [];
    try {
      const arr = JSON.parse(raw);
      return Array.isArray(arr) ? arr.filter((x) => typeof x === 'string') : [];
    } catch {
      return [];
    }
  }

  /** 从答疑会话 JSONL 提炼要点：取学生的提问（user 轮）作为"关注点"信号 */
  private async collectTutorHighlights(bankId?: string): Promise<string[]> {
    const sessions = this.queryTutorSessions(bankId);
    const highlights: string[] = [];
    for (const s of sessions) {
      const turns = await readSessionHistory(s.jsonl_path);
      // 跳过首条注入的讲解 prompt，取后续 user 追问作为关注点
      const userAsks = turns.filter((t) => t.role === 'user').slice(1);
      for (const ask of userAsks) {
        const trimmed = ask.content.slice(0, 60);
        if (trimmed) highlights.push(trimmed);
      }
    }
    return highlights.slice(0, 20); // 上限，避免喂给模型的输入过长
  }

  private queryTutorSessions(bankId?: string): TutorRow[] {
    if (bankId) {
      return db
        .prepare(
          `SELECT ts.question_id, ts.jsonl_path FROM tutor_sessions ts
           JOIN questions q ON q.id = ts.question_id
           WHERE q.bank_id = ?`,
        )
        .all(bankId) as TutorRow[];
    }
    return db
      .prepare('SELECT question_id, jsonl_path FROM tutor_sessions')
      .all() as TutorRow[];
  }
}

export const learningDataCollector = new LearningDataCollector();
