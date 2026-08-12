import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// masteryService 依赖 SQLite（streak 落 mastery_states）+ wrongBookRepo。
// 临时 DATA_DIR + 动态 import 隔离。

let tempDir: string;
let db: import('better-sqlite3').Database;
let checkMasteryAfterGrade: (questionId: string, isCorrect: boolean) => boolean;

beforeAll(async () => {
  tempDir = mkdtempSync(join(tmpdir(), 'exam-mastery-'));
  process.env.DATA_DIR = tempDir;

  const dbMod = await import('../db/index.js');
  db = dbMod.getDb();
  // 造一道题 + 错题本初始记录（已掌握软标记联动验证用）
  db.prepare(`INSERT INTO banks (id, name, created_at) VALUES ('b1', '测试库', 0)`).run();
  db.prepare(
    `INSERT INTO questions (id, bank_id, type, stem, options, answer, created_at)
     VALUES ('q1','b1','single','Q1','["A","B"]','1',0)`,
  ).run();

  const svc = await import('../services/masteryService.js');
  checkMasteryAfterGrade = svc.checkMasteryAfterGrade;
});

afterAll(async () => {
  const { closeDb } = await import('../db/index.js');
  closeDb();
  rmSync(tempDir, { recursive: true, force: true });
});

describe('checkMasteryAfterGrade（连续 N=3 次正确→掌握）', () => {
  it('前两次答对不达标，第三次达标并联动错题本软标记', () => {
    expect(checkMasteryAfterGrade('q1', true)).toBe(false);
    expect(checkMasteryAfterGrade('q1', true)).toBe(false);
    const mastered = checkMasteryAfterGrade('q1', true);
    expect(mastered).toBe(true);

    // 直接查库验证状态
    const row = db
      .prepare('SELECT consecutive_correct, mastered FROM mastery_states WHERE question_id = ?')
      .get('q1') as { consecutive_correct: number; mastered: number };
    expect(row.consecutive_correct).toBe(3);
    expect(row.mastered).toBe(1);
    // 错题本软标记联动
    const wr = db
      .prepare('SELECT is_mastered FROM wrong_book_state WHERE question_id = ?')
      .get('q1') as { is_mastered: number };
    expect(wr.is_mastered).toBe(1);
  });

  it('答错重置 streak（不清除已掌握标记）', () => {
    // 先积累 2 次正确
    checkMasteryAfterGrade('q1', true);
    checkMasteryAfterGrade('q1', true);
    // 答错 → streak 归零
    expect(checkMasteryAfterGrade('q1', false)).toBe(false);
    const row = db
      .prepare('SELECT consecutive_correct, mastered FROM mastery_states WHERE question_id = ?')
      .get('q1') as { consecutive_correct: number; mastered: number };
    expect(row.consecutive_correct).toBe(0);
    // 已掌握标记保留（mastered 仍为 1——前一个用例已达标）
    expect(row.mastered).toBe(1);
  });

  it('错误后重新积累需满 3 次才达标', () => {
    // streak 已归零，重新答对 3 次
    expect(checkMasteryAfterGrade('q1', true)).toBe(false);
    expect(checkMasteryAfterGrade('q1', true)).toBe(false);
    expect(checkMasteryAfterGrade('q1', true)).toBe(true);
  });
});
