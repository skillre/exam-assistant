import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// questionRepo 的 v2 题库管理操作（单题 CRUD / 移动复制 / 批量标签）测试。
// 依赖 SQLite：先设 DATA_DIR 到临时目录，再动态 import 被测模块。

let tempDir: string;
let repo: typeof import('./questionRepo.js').questionRepo;
let db: import('better-sqlite3').Database;

beforeAll(async () => {
  tempDir = mkdtempSync(join(tmpdir(), 'exam-qrepo-'));
  process.env.DATA_DIR = tempDir;

  db = (await import('../db/index.js')).getDb();
  repo = (await import('./questionRepo.js')).questionRepo;

  db.prepare(`INSERT INTO banks (id, name, created_at) VALUES ('b1','库1',0),('b2','库2',0)`).run();
});

afterAll(() => {
  db.close();
  rmSync(tempDir, { recursive: true, force: true });
  delete process.env.DATA_DIR;
});

describe('questionRepo v2 管理操作', () => {
  it('insertOne / update / remove 单题闭环', () => {
    const q = repo.insertOne('b1', {
      type: 'single',
      stem: '1+1=?',
      options: ['1', '2'],
      answer: 1,
      tags: ['算术'],
    });
    expect(q.bankId).toBe('b1');
    expect(repo.get(q.id)?.stem).toBe('1+1=?');

    const updated = repo.update(q.id, {
      type: 'single',
      stem: '2+2=?',
      options: ['3', '4'],
      answer: 1,
      tags: ['算术'],
    });
    expect(updated?.stem).toBe('2+2=?');
    expect(repo.update('nope', updated!)).toBeUndefined();

    expect(repo.remove(q.id)).toBe(true);
    expect(repo.get(q.id)).toBeUndefined();
  });

  it('move 改归属保留 id；copy 生成新 id', () => {
    const q = repo.insertOne('b1', {
      type: 'single',
      stem: 'move-me',
      options: ['a', 'b'],
      answer: 0,
    });

    // copy 到 b2：源仍在 b1，b2 多一条不同 id
    const copied = repo.moveOrCopy([q.id], 'b2', 'copy');
    expect(copied).toBe(1);
    expect(repo.get(q.id)?.bankId).toBe('b1');
    const b2copy = repo.listByBank('b2').find((x) => x.stem === 'move-me');
    expect(b2copy).toBeDefined();
    expect(b2copy!.id).not.toBe(q.id);

    // move 到 b2：id 不变，归属变 b2
    const moved = repo.moveOrCopy([q.id], 'b2', 'move');
    expect(moved).toBe(1);
    expect(repo.get(q.id)?.bankId).toBe('b2');
  });

  it('addTags：add 并集去重，replace 整体替换', () => {
    const q = repo.insertOne('b1', {
      type: 'single',
      stem: 'tag-me',
      options: ['a', 'b'],
      answer: 0,
      tags: ['旧标签'],
    });

    repo.addTags([q.id], ['新标签', '旧标签'], 'add');
    expect([...repo.get(q.id)!.tags!].sort()).toEqual(['新标签', '旧标签'].sort());

    repo.addTags([q.id], ['唯一'], 'replace');
    expect(repo.get(q.id)!.tags).toEqual(['唯一']);
  });

  it('allTags 汇总去重排序', () => {
    const tags = repo.allTags();
    expect(Array.isArray(tags)).toBe(true);
    expect(new Set(tags).size).toBe(tags.length); // 无重复
  });
});
