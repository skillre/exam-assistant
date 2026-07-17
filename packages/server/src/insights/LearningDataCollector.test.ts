import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// LearningDataCollector 依赖 SQLite（db/index.js 在 import 时按 DATA_DIR 派生路径）。
// 所以先设 DATA_DIR 到临时目录，再用动态 import 加载被测模块。

let tempDir: string;
let collector: import('./LearningDataCollector.js').LearningDataCollector;
let db: import('better-sqlite3').Database;

beforeAll(async () => {
  tempDir = mkdtempSync(join(tmpdir(), 'exam-collector-'));
  process.env.DATA_DIR = tempDir;

  const dbMod = await import('../db/index.js');
  db = dbMod.getDb();
  const { LearningDataCollector } = await import('./LearningDataCollector.js');
  collector = new LearningDataCollector();

  // 建库 + 两道题（不同标签）+ attempts（含对错）
  db.prepare(`INSERT INTO banks (id, name, created_at) VALUES ('b1', '测试库', 0)`).run();
  db.prepare(
    `INSERT INTO questions (id, bank_id, type, stem, options, answer, tags, created_at)
     VALUES ('q1','b1','single','Q1','["A","B"]','1','["代数","方程"]',0),
            ('q2','b1','single','Q2','["A","B"]','0','["几何"]',0),
            ('q3','b1','single','Q3','["A","B"]','1',NULL,0)`,
  ).run();
  // q1 错2次对0次；q2 对1次；q3(无标签) 错1次
  db.prepare(
    `INSERT INTO attempts (id, question_id, user_answer, is_correct, answered_at) VALUES
       ('a1','q1','0',0,0),
       ('a2','q1','0',0,0),
       ('a3','q2','0',1,0),
       ('a4','q3','0',0,0)`,
  ).run();
});

afterAll(async () => {
  const { closeDb } = await import('../db/index.js');
  closeDb();
  rmSync(tempDir, { recursive: true, force: true });
});

describe('LearningDataCollector.collect', () => {
  it('产出正确的 snapshot 结构与统计', async () => {
    const snap = await collector.collect('b1');
    // 4 次作答，1 次对 → 25%
    expect(snap.totalAttempts).toBe(4);
    expect(snap.accuracy).toBeCloseTo(0.25, 5);
    expect(Array.isArray(snap.weakTags)).toBe(true);
    expect(Array.isArray(snap.tutorHighlights)).toBe(true);
  });

  it('按 tag 聚合薄弱点，错数降序', async () => {
    const snap = await collector.collect('b1');
    // 代数/方程 各错 2；未分类(q3) 错 1；几何(q2)全对不进榜
    const tags = snap.weakTags.map((t) => t.tag);
    expect(tags).toContain('代数');
    expect(tags).toContain('方程');
    expect(tags).toContain('未分类');
    expect(tags).not.toContain('几何');
    // 降序：第一个的 wrong >= 最后一个的 wrong
    expect(snap.weakTags.length).toBeGreaterThan(0);
    expect(snap.weakTags[0]!.wrong).toBeGreaterThanOrEqual(
      snap.weakTags[snap.weakTags.length - 1]!.wrong,
    );
    const algebra = snap.weakTags.find((t) => t.tag === '代数')!;
    expect(algebra.wrong).toBe(2);
    expect(algebra.total).toBe(2);
  });

  it('无答疑记录时降级为空 highlights，不报错', async () => {
    const snap = await collector.collect('b1');
    expect(snap.tutorHighlights).toEqual([]);
  });

  it('提炼答疑关注点：跳过首条注入 prompt，取后续 user 追问', async () => {
    // 造一个 tutor 会话 JSONL（模拟 pi SDK 落盘格式）
    const sessDir = join(tempDir, 'sessions');
    mkdirSync(sessDir, { recursive: true });
    const jsonlPath = join(sessDir, 'sess1.jsonl');
    const line = (msg: unknown, id: string) =>
      JSON.stringify({ type: 'message', id, parentId: null, timestamp: '2026-01-01T00:00:00Z', message: msg });
    writeFileSync(
      jsonlPath,
      [
        line({ role: 'user', content: [{ type: 'text', text: '首条注入的讲解上下文（应被跳过）' }], timestamp: 0 }, 'm1'),
        line({ role: 'assistant', content: [{ type: 'text', text: '讲解回复' }], timestamp: 0 }, 'm2'),
        line({ role: 'user', content: [{ type: 'text', text: '为什么这里要用平方？' }], timestamp: 0 }, 'm3'),
        line({ role: 'assistant', content: [{ type: 'text', text: '因为...' }], timestamp: 0 }, 'm4'),
      ].join('\n'),
    );
    db.prepare(
      `INSERT INTO tutor_sessions (id, question_id, jsonl_path, created_at) VALUES ('t1','q1',?,0)`,
    ).run(jsonlPath);

    const snap = await collector.collect('b1');
    // 应包含第二个 user 追问，不含首条注入
    expect(snap.tutorHighlights.some((h) => h.includes('平方'))).toBe(true);
    expect(snap.tutorHighlights.some((h) => h.includes('首条注入'))).toBe(false);
  });
});
