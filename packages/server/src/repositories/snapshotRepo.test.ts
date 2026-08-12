import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// snapshotRepo 依赖 SQLite：临时 DATA_DIR + 动态 import。

let tempDir: string;
let db: import('better-sqlite3').Database;
let snapshotRepo: typeof import('./snapshotRepo.js').snapshotRepo;

beforeAll(async () => {
  tempDir = mkdtempSync(join(tmpdir(), 'exam-snap-'));
  process.env.DATA_DIR = tempDir;
  const dbMod = await import('../db/index.js');
  db = dbMod.getDb();
  db.prepare(`INSERT INTO banks (id, name, created_at) VALUES ('b1', '测试库', 0)`).run();
  db.prepare(`INSERT INTO banks (id, name, created_at) VALUES ('b2', '库2', 0)`).run();
  snapshotRepo = (await import('./snapshotRepo.js')).snapshotRepo;
});

afterAll(async () => {
  const { closeDb } = await import('../db/index.js');
  closeDb();
  rmSync(tempDir, { recursive: true, force: true });
});

const base = {
  bankId: 'b1',
  total: 10,
  correct: 7,
  accuracy: 0.7,
  byTag: [
    { tag: '代数', total: 5, correct: 4 },
    { tag: '几何', total: 5, correct: 3 },
  ],
  byType: [{ type: 'single' as const, total: 10, correct: 7 }],
};

describe('snapshotRepo（练习完成落库，D5 幂等）', () => {
  it('save 返回完整快照，可 listAll 查回', () => {
    const snap = snapshotRepo.save({ sessionId: 's1', ...base });
    expect(snap).not.toBeNull();
    expect(snap!.accuracy).toBeCloseTo(0.7);
    expect(snap!.byTag).toHaveLength(2);

    const all = snapshotRepo.listAll('b1');
    expect(all).toHaveLength(1);
    expect(all[0]!.sessionId).toBe('s1');
    expect(all[0]!.byTag[0]!.tag).toBe('代数');
  });

  it('同 sessionId 重复 save 幂等返回 null（不重复落点）', () => {
    const again = snapshotRepo.save({ sessionId: 's1', ...base });
    expect(again).toBeNull();
    expect(snapshotRepo.listAll('b1')).toHaveLength(1);
  });

  it('listAll 按库隔离 + 时间倒序', async () => {
    const { randomUUID } = await import('node:crypto');
    snapshotRepo.save({ sessionId: randomUUID(), ...base, bankId: 'b2' });
    await new Promise((r) => setTimeout(r, 2));
    snapshotRepo.save({ sessionId: randomUUID(), ...base });
    const b1 = snapshotRepo.listAll('b1');
    expect(b1).toHaveLength(2);
    // 倒序：第二条（更新）在前
    expect(b1[0]!.createdAt).toBeGreaterThanOrEqual(b1[1]!.createdAt);
    expect(snapshotRepo.listAll('b2')).toHaveLength(1);
  });
});
