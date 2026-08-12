import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// 第四批 ②：practiceRepo.listRecent（倒序 + completed 判定 + 题数）单测。

let tempDir: string;
let db: import('better-sqlite3').Database;
let practiceRepo: typeof import('./practiceRepo.js').practiceRepo;
let snapshotRepo: typeof import('./snapshotRepo.js').snapshotRepo;

const scope = { bankId: 'b1', mode: 'all' as const, shuffle: false };

beforeAll(async () => {
  tempDir = mkdtempSync(join(tmpdir(), 'exam-hist-'));
  process.env.DATA_DIR = tempDir;
  const dbMod = await import('../db/index.js');
  db = dbMod.getDb();
  db.prepare(`INSERT INTO banks (id, name, created_at) VALUES ('b1', '测试库', 0)`).run();
  practiceRepo = (await import('./practiceRepo.js')).practiceRepo;
  snapshotRepo = (await import('./snapshotRepo.js')).snapshotRepo;
});

afterAll(async () => {
  const { closeDb } = await import('../db/index.js');
  closeDb();
  rmSync(tempDir, { recursive: true, force: true });
});

describe('practiceRepo.listRecent', () => {
  it('按 created_at 倒序，含题库名与题数', () => {
    const a = practiceRepo.create(scope, ['q1', 'q2']);
    const b = practiceRepo.create(scope, ['q3']);
    const list = practiceRepo.listRecent(10);
    expect(list[0]!.id).toBe(b.id); // 后创建在前
    expect(list[1]!.id).toBe(a.id);
    expect(list[0]!.bankName).toBe('测试库');
    expect(list[1]!.questionCount).toBe(2);
    expect(list[1]!.scope.mode).toBe('all');
  });

  it('completed：落过快照为 true，否则 false', () => {
    const done = practiceRepo.create(scope, ['q1']);
    const todo = practiceRepo.create(scope, ['q1']);
    snapshotRepo.save({
      sessionId: done.id,
      bankId: 'b1',
      total: 1,
      correct: 1,
      accuracy: 1,
      byTag: [],
      byType: [],
    });
    const list = practiceRepo.listRecent(10);
    const byId = new Map(list.map((r) => [r.id, r]));
    expect(byId.get(done.id)?.completed).toBe(true);
    expect(byId.get(todo.id)?.completed).toBe(false);
  });

  it('limit 生效', () => {
    practiceRepo.create(scope, ['q1']);
    practiceRepo.create(scope, ['q2']);
    expect(practiceRepo.listRecent(2).length).toBe(2);
  });

  it('删库后会话被 CASCADE 清除（影响面声明的现有行为）', () => {
    db.prepare(`INSERT INTO banks (id, name, created_at) VALUES ('b9', '将删', 0)`).run();
    const s = practiceRepo.create({ ...scope, bankId: 'b9' }, ['q1']);
    expect(practiceRepo.get(s.id)).toBeDefined();
    db.prepare('DELETE FROM banks WHERE id = ?').run('b9');
    expect(practiceRepo.get(s.id)).toBeUndefined(); // ON DELETE CASCADE
    expect(practiceRepo.listRecent(10).some((r) => r.id === s.id)).toBe(false);
  });
});
