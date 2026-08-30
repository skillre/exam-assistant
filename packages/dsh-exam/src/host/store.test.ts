/**
 * ExamStore 单元测试（Node 内置 node:test，零依赖）。
 * 运行：node --test packages/dsh-exam/src/host/store.test.ts
 * 覆盖（Phase 0）：目录自动创建、WAL/foreign_keys、建库/列库、幂等 close、重开持久化、
 * ':memory:' 路径、关闭后调用报错。
 * 覆盖（Phase 1）：v2 迁移（全新库 + v1→v2 升级）、题目 CRUD、级联删除、attempt 最新一条、
 * 练习会话生命周期、错题本计数/掌握标记/过滤。
 * 覆盖（Phase 2）：v3 迁移（questions 重建保数据 + 新表）、essay 题型放行、批改 upsert 重批、
 * Tutor 会话/消息（close/级联/SET NULL）、学习计划与条目（setPlanItemDone/级联）。
 * 覆盖（Phase 4）：v4 迁移（v3 库升级保数据 + explanations 表）、解析缓存 CRUD
 * （upsert 单份最新 / get / listByQuestion / FK / 级联删除）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openExamStore, type QuestionType } from './store.ts';
// 值必须动态导入：静态 import node:sqlite 会在模块实例化期（早于 store.ts 求值、
// 即早于 warning 过滤器安装）加载内置模块并触发 ExperimentalWarning。
import type { DatabaseSync } from 'node:sqlite';

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'exam-store-test-'));
}

/** 测试用惰性 DatabaseSync 构造器（动态导入，避免静态加载触发 ExperimentalWarning）。 */
let databaseSyncCtor: typeof import('node:sqlite').DatabaseSync | undefined;
async function getDatabaseSync(): Promise<typeof import('node:sqlite').DatabaseSync> {
  if (databaseSyncCtor === undefined) {
    databaseSyncCtor = (await import('node:sqlite')).DatabaseSync;
  }
  return databaseSyncCtor;
}

test('openExamStore 自动创建父目录并初始化 schema', async () => {
  const dir = tempDir();
  try {
    const path = join(dir, 'nested', 'app.db');
    const store = await openExamStore(path);
    try {
      assert.equal(store.path, path);
      assert.ok(existsSync(join(dir, 'nested')), '父目录应被自动创建');
      const health = store.health();
      assert.equal(health.ok, true);
      assert.equal(health.closed, false);
      assert.equal(health.schemaVersion, 10);
      assert.equal(store.readiness().ready, true);
      assert.deepEqual(store.listBanks(), []);
    } finally {
      store.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('createBank / listBanks 往返，id 缺省为 randomUUID，createdAt 为时间戳', async () => {
  const dir = tempDir();
  try {
    const store = await openExamStore(join(dir, 'app.db'));
    try {
      const bank = store.createBank({ name: ' 高数期中  ' });
      assert.equal(bank.name, '高数期中');
      assert.equal(bank.id.length, 36, '缺省 id 应为 UUID');
      assert.ok(Number.isInteger(bank.createdAt) && bank.createdAt > 0);

      // 排序键为 created_at ASC, id ASC；同一毫秒内会退化为 id 序，
      // 这里隔 5ms 保证两条 createdAt 可区分，避免随机 uuid 序使断言抖动。
      await new Promise((resolve) => setTimeout(resolve, 5));

      const explicit = store.createBank({ name: '英语四级', id: 'bank-1' });
      assert.equal(explicit.id, 'bank-1');

      const rows = store.listBanks();
      assert.equal(rows.length, 2);
      assert.deepEqual(
        rows.map((r) => r.name),
        ['高数期中', '英语四级'],
        '应按创建时间升序',
      );

      // 重复 id 触发约束错误
      assert.throws(() => store.createBank({ name: '重复', id: 'bank-1' }));
      // 空白名称拒绝
      assert.throws(() => store.createBank({ name: '   ' }));
    } finally {
      store.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('close 幂等；关闭后调用报错；重开同一路径数据持久', async () => {
  const dir = tempDir();
  try {
    const path = join(dir, 'app.db');
    const store = await openExamStore(path);
    store.createBank({ name: '持久题库', id: 'persist-1' });
    store.close();
    store.close(); // 幂等
    assert.equal(store.health().ok, false);
    assert.equal(store.health().closed, true);
    assert.equal(store.readiness().ready, false);
    assert.throws(() => store.listBanks(), /closed/);
    assert.throws(() => store.createBank({ name: 'x' }), /closed/);

    const reopened = await openExamStore(path);
    try {
      assert.deepEqual(
        reopened.listBanks().map((r) => r.name),
        ['持久题库'],
      );
    } finally {
      reopened.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test(':memory: 路径可用且不创建文件', async () => {
  const store = await openExamStore(':memory:');
  try {
    store.createBank({ name: '内存题库', id: 'mem-1' });
    assert.equal(store.listBanks().length, 1);
    assert.equal(store.health().ok, true);
  } finally {
    store.close();
  }
});

test('非法路径参数拒绝', async () => {
  await assert.rejects(openExamStore(''), /non-empty/);
});

// ---------------------------------------------------------------------------
// Phase 1：迁移 / 题目 / 作答 / 练习 / 错题本
// ---------------------------------------------------------------------------

/** 建一个 v1 库（仅 banks，user_version=1），用于验证 v1→v2 升级路径。 */
async function createV1Db(path: string): Promise<void> {
  const db = new (await getDatabaseSync())(path);
  db.exec(
    `CREATE TABLE banks (
       id TEXT PRIMARY KEY,
       name TEXT NOT NULL,
       created_at INTEGER NOT NULL
     )`,
  );
  db.exec('PRAGMA user_version = 1');
  db.close();
}

/** 建一个 v2 库（DDL 与 store.ts MIGRATIONS v2 组完全一致，user_version=2），用于验证 v2→v3 升级路径。 */
async function createV2Db(path: string): Promise<void> {
  const db = new (await getDatabaseSync())(path);
  db.exec(
    `CREATE TABLE banks (
       id TEXT PRIMARY KEY,
       name TEXT NOT NULL,
       created_at INTEGER NOT NULL
     )`,
  );
  db.exec(
    `CREATE TABLE questions (
       id TEXT PRIMARY KEY,
       bank_id TEXT NOT NULL REFERENCES banks(id) ON DELETE CASCADE,
       type TEXT NOT NULL CHECK(type IN ('single','multiple','boolean')),
       stem TEXT NOT NULL,
       options TEXT NOT NULL,
       answer TEXT NOT NULL,
       explanation TEXT,
       tags TEXT,
       created_at INTEGER,
       updated_at INTEGER
     )`,
  );
  db.exec(
    `CREATE TABLE attempts (
       id TEXT PRIMARY KEY,
       question_id TEXT NOT NULL REFERENCES questions(id) ON DELETE CASCADE,
       practice_id TEXT,
       user_answer TEXT NOT NULL,
       is_correct INTEGER NOT NULL,
       answered_at INTEGER NOT NULL
     )`,
  );
  db.exec(
    `CREATE TABLE practice_sessions (
       id TEXT PRIMARY KEY,
       bank_id TEXT NOT NULL REFERENCES banks(id) ON DELETE CASCADE,
       scope TEXT NOT NULL,
       question_ids TEXT NOT NULL,
       current_index INTEGER NOT NULL DEFAULT 0,
       status TEXT NOT NULL CHECK(status IN ('active','finished')),
       created_at INTEGER,
       finished_at INTEGER
     )`,
  );
  db.exec(
    `CREATE TABLE wrong_book_state (
       question_id TEXT PRIMARY KEY REFERENCES questions(id) ON DELETE CASCADE,
       wrong_count INTEGER NOT NULL DEFAULT 0,
       last_wrong_at INTEGER,
       mastered INTEGER NOT NULL DEFAULT 0
     )`,
  );
  db.exec('CREATE INDEX idx_questions_bank_id ON questions(bank_id)');
  db.exec('CREATE INDEX idx_attempts_question_id ON attempts(question_id)');
  db.exec('CREATE INDEX idx_attempts_answered_at ON attempts(answered_at)');
  db.exec('CREATE INDEX idx_practice_sessions_bank_id ON practice_sessions(bank_id)');
  db.exec('PRAGMA user_version = 2');
  db.close();
}

test('Phase2+4+t5+t9+t1 迁移：全新库 schemaVersion=10，十五表 + 全部索引齐备', async () => {
  const dir = tempDir();
  try {
    const path = join(dir, 'app.db');
    const store = await openExamStore(path);
    store.createBank({ name: 'x', id: 'b' });
    store.close();
    assert.equal(store.health().schemaVersion, 10);

    // 关闭后直接查 sqlite_master 验证表与索引（store 不暴露底层连接）。
    const db = new (await getDatabaseSync())(path);
    try {
      const tables = db
        .prepare(
          `SELECT name FROM sqlite_master WHERE type = 'table' AND name IN
           ('banks','questions','attempts','practice_sessions','wrong_book_state',
            'essay_gradings','tutor_sessions','tutor_messages','study_plans','plan_items',
            'explanations','tutor_turns','import_batches','import_drafts','diagnoses')`,
        )
        .all()
        .map((r) => r.name);
      assert.equal(tables.length, 15, '十五张表都应存在（含 t5 三张新表 + t13 diagnoses）');
      const indexes = db
        .prepare(
          `SELECT name FROM sqlite_master WHERE type = 'index' AND name IN
           ('idx_questions_bank_id','idx_attempts_question_id','idx_attempts_answered_at',
            'idx_practice_sessions_bank_id','idx_tutor_messages_session',
            'idx_essay_gradings_created','idx_plan_items_plan','idx_explanations_question',
            'idx_tutor_turns_session','idx_tutor_messages_turn','idx_questions_import_key',
            'idx_diagnoses_created')`,
        )
        .all()
        .map((r) => r.name);
      assert.equal(indexes.length, 12, '十二个要求的索引都应存在');
    } finally {
      db.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('Phase2→4 迁移：v1 库升级到最新（user_version 1 → 4，旧 banks 数据保留）', async () => {
  const dir = tempDir();
  try {
    const path = join(dir, 'legacy.db');
    await createV1Db(path);
    const db = new (await getDatabaseSync())(path);
    db.prepare('INSERT INTO banks (id, name, created_at) VALUES (?, ?, ?)').run(
      'legacy-bank',
      '旧题库',
      1,
    );
    db.close();

    const store = await openExamStore(path);
    try {
      assert.equal(store.health().schemaVersion, 10);
      assert.deepEqual(
        store.listBanks().map((b) => b.id),
        ['legacy-bank'],
        'v1 数据应保留',
      );
      // v3 表可用（迁移已应用）
      assert.deepEqual(store.listQuestionsByBank('legacy-bank'), []);
      const created = store.createQuestion('legacy-bank', {
        id: 'q-1',
        type: 'single',
        stem: '迁移后新建',
        options: ['A', 'B'],
        answer: 'A',
      });
      assert.equal(created.id, 'q-1');
    } finally {
      store.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('Phase1 题目 CRUD：create/get/list/count/update/delete', async () => {
  const store = await openExamStore(':memory:');
  try {
    const bank = store.createBank({ name: '高数', id: 'bank-q' });
    void bank;
    const created = store.createQuestion('bank-q', {
      id: 'q-1',
      type: 'single',
      stem: '1+1=?',
      options: ['1', '2', '3'],
      answer: '2',
      explanation: '常识',
      tags: ['简单', '加法'],
    });
    assert.equal(created.id, 'q-1');
    assert.equal(created.type, 'single');
    assert.deepEqual(created.options, ['1', '2', '3']);
    assert.equal(created.answer, '2');
    assert.deepEqual(created.tags, ['简单', '加法']);
    assert.ok(created.createdAt > 0 && created.updatedAt >= created.createdAt);

    // get / list / count
    const got = store.getQuestion('q-1');
    assert.equal(got?.stem, '1+1=?');
    assert.deepEqual(
      store.listQuestionsByBank('bank-q').map((q) => q.id),
      ['q-1'],
    );
    assert.equal(store.countQuestions('bank-q'), 1);
    assert.equal(store.getQuestion('missing'), undefined);
    assert.equal(store.countQuestions('bank-q'), 1);

    // update：部分字段生效，updated_at 刷新，未提供字段保留
    const updated = store.updateQuestion('q-1', { stem: '2+2=?', answer: '4' });
    assert.equal(updated.stem, '2+2=?');
    assert.equal(updated.answer, '4');
    assert.deepEqual(updated.options, ['1', '2', '3'], '未提供的字段应保留');
    assert.ok(updated.updatedAt >= created.updatedAt);
    assert.throws(() => store.updateQuestion('missing', { stem: 'x' }), /not found/);

    // delete：幂等；不存在静默
    store.deleteQuestion('q-1');
    assert.equal(store.getQuestion('q-1'), undefined);
    assert.equal(store.countQuestions('bank-q'), 0);
    store.deleteQuestion('q-1'); // no-op

    // 校验：非法 type / 空 stem / options 非数组 / answer 缺失（essay 放行见 Phase 2 用例）
    assert.throws(() => store.createQuestion('bank-q', { type: 'matching' as unknown as QuestionType, stem: 'x', options: [], answer: 1 }), /invalid question type/);
    assert.throws(() => store.createQuestion('bank-q', { type: 'single', stem: '  ', options: [], answer: 1 }), /stem/);
    assert.throws(() => store.createQuestion('bank-q', { type: 'single', stem: 'x', options: 'not-array' as unknown as string[], answer: 1 }), /options/);
    assert.throws(() => store.createQuestion('bank-q', { type: 'essay', stem: 'x', options: [] } as never), /answer is required/);
  } finally {
    store.close();
  }
});

test('Phase1 软删除：删题保留作答/错题/历史可解释；DB 层硬删仍级联（删 bank）', async () => {
  const store = await openExamStore(':memory:');
  try {
    store.createBank({ name: '级联', id: 'bank-c' });
    store.createQuestion('bank-c', { id: 'q-1', type: 'boolean', stem: '地球是圆的?', options: [], answer: 'true' });
    store.recordAttempt({ id: 'a-1', questionId: 'q-1', userAnswer: 'true', isCorrect: true });
    store.touchWrong('q-1', false);

    // t1 软删除：deleteQuestion 置 deleted_at，**不**物理删除——
    // 作答/错题本/会话引用全部保留（active 会话不破坏、finished 历史可解释）。
    assert.equal(store.deleteQuestion('q-1'), true, '首次删除返回 true');
    assert.equal(store.deleteQuestion('q-1'), false, '重复删除幂等返回 false');
    assert.equal(store.getQuestion('q-1'), undefined, '活跃读不再可见');
    assert.ok(store.getQuestionIncludingDeleted('q-1')?.deletedAt !== null, '含已删读可见 deletedAt');
    assert.equal(store.listQuestionsByBank('bank-c').length, 0);
    assert.equal(store.countQuestions('bank-c'), 0);
    assert.equal(store.listLatestAttemptByQuestion(['q-1']).size, 1, '作答保留（历史/成绩单可解释）');
    assert.equal(store.listLatestAttemptByQuestion(['q-1']).get('q-1')?.id, 'a-1');
    // 错题本状态保留但列表过滤已删题（不可再练 → 不再出现）。
    assert.equal(store.getQuestionIncludingDeleted('q-1')?.id, 'q-1');
    assert.equal(store.listWrong().length, 0, 'listWrong 排除已删题');
    // 更新/判分路径视为不存在。
    assert.throws(() => store.updateQuestion('q-1', { stem: 'x' }), /not found/);

    // FK：未知题库/未知题目抛错
    assert.throws(
      () => store.createQuestion('bank-missing', { id: 'q-x', type: 'single', stem: 'x', options: [], answer: 1 }),
      /FOREIGN KEY/i,
    );
  } finally {
    store.close();
  }
});

test('Phase1 级联删除：删 bank 级联清题目/作答/错题状态（DB 层验证）', async () => {
  const dir = tempDir();
  try {
    const path = join(dir, 'cascade.db');
    const store = await openExamStore(path);
    store.createBank({ name: '待删', id: 'bank-del' });
    store.createQuestion('bank-del', { id: 'q-1', type: 'single', stem: 's', options: ['A'], answer: 'A' });
    store.recordAttempt({ id: 'a-1', questionId: 'q-1', userAnswer: 'A', isCorrect: true });
    store.touchWrong('q-1', false);
    store.createPracticeSession({ id: 'p-1', bankId: 'bank-del', scope: {}, questionIds: ['q-1'] });
    store.close();

    const db = new (await getDatabaseSync())(path);
    try {
      db.prepare('DELETE FROM banks WHERE id = ?').run('bank-del');
      const counts = {
        questions: Number(db.prepare('SELECT COUNT(*) AS n FROM questions').get()!.n),
        attempts: Number(db.prepare('SELECT COUNT(*) AS n FROM attempts').get()!.n),
        wrong: Number(db.prepare('SELECT COUNT(*) AS n FROM wrong_book_state').get()!.n),
        practices: Number(db.prepare('SELECT COUNT(*) AS n FROM practice_sessions').get()!.n),
      };
      assert.deepEqual(counts, { questions: 0, attempts: 0, wrong: 0, practices: 0 });
    } finally {
      db.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('Phase1 作答：recordAttempt + listLatestAttemptByQuestion（每题最新一条）', async () => {
  const store = await openExamStore(':memory:');
  try {
    store.createBank({ name: '作答', id: 'bank-a' });
    store.createQuestion('bank-a', { id: 'q-1', type: 'single', stem: 's1', options: ['A', 'B'], answer: 'A' });
    store.createQuestion('bank-a', { id: 'q-2', type: 'single', stem: 's2', options: ['A', 'B'], answer: 'B' });

    // q-1 三次作答（时间递增），q-2 一次
    store.recordAttempt({ id: 'a1', questionId: 'q-1', userAnswer: 'A', isCorrect: true, answeredAt: 100 });
    store.recordAttempt({ id: 'a2', questionId: 'q-1', userAnswer: 'B', isCorrect: false, answeredAt: 200 });
    store.recordAttempt({ id: 'a3', questionId: 'q-1', userAnswer: 'A', isCorrect: true, answeredAt: 300 });
    store.recordAttempt({ id: 'a4', questionId: 'q-2', userAnswer: 'B', isCorrect: true, answeredAt: 150 });

    const latest = store.listLatestAttemptByQuestion(['q-1', 'q-2', 'missing']);
    assert.equal(latest.size, 2);
    assert.equal(latest.get('q-1')?.id, 'a3', '应取 answered_at 最新一条');
    assert.equal(latest.get('q-1')?.isCorrect, true);
    assert.equal(latest.get('q-2')?.id, 'a4');
    assert.equal(latest.get('missing'), undefined);

    // 空数组 → 空 Map；practiceId 缺省 null
    assert.equal(store.listLatestAttemptByQuestion([]).size, 0);
    assert.equal(store.listLatestAttemptByQuestion(['q-1']).get('q-1')?.practiceId, null);

    // FK：未知题目作答抛错
    assert.throws(() => store.recordAttempt({ questionId: 'ghost', userAnswer: 'x', isCorrect: true }), /FOREIGN KEY/i);
  } finally {
    store.close();
  }
});

test('Phase4.1 删除练习会话：行删除 + attempts 保留', async () => {
  const store = await openExamStore(':memory:');
  try {
    store.createBank({ name: '删除', id: 'bank-d' });
    store.createQuestion('bank-d', { id: 'q-1', type: 'single', stem: 's', options: ['A', 'B'], answer: 'A' });
    store.createPracticeSession({ id: 'p-del', bankId: 'bank-d', scope: { mode: 'all' }, questionIds: ['q-1'] });
    store.recordAttempt({ questionId: 'q-1', practiceId: 'p-del', userAnswer: 'B', isCorrect: false });

    assert.equal(store.deletePracticeSession('p-del'), true);
    assert.equal(store.deletePracticeSession('p-del'), false, '重复删除返回 false');
    assert.equal(store.getPracticeSession('p-del'), undefined);
    assert.equal(
      store.listPracticeHistory(10).some((p) => p.id === 'p-del'),
      false,
    );
    // 作答保留：孤儿 attempts 继续可查（学情/错题本数据不受影响）
    assert.equal(store.listAllAttempts().length, 1);
    assert.equal(store.listAllAttempts()[0]?.practiceId, 'p-del');
  } finally {
    store.close();
  }
});

test('Phase1 练习会话生命周期：create/get/index/finish/history', async () => {
  const store = await openExamStore(':memory:');
  try {
    store.createBank({ name: '练习', id: 'bank-p' });
    store.createQuestion('bank-p', { id: 'q-1', type: 'single', stem: 's1', options: ['A', 'B'], answer: 'A' });
    store.createQuestion('bank-p', { id: 'q-2', type: 'single', stem: 's2', options: ['A', 'B'], answer: 'B' });

    const session = store.createPracticeSession({
      id: 'p-1',
      bankId: 'bank-p',
      scope: { mode: 'wrong-book' },
      questionIds: ['q-1', 'q-2'],
      createdAt: 500,
    });
    assert.equal(session.status, 'active');
    assert.equal(session.currentIndex, 0);
    assert.deepEqual(session.questionIds, ['q-1', 'q-2']);
    assert.equal(session.finishedAt, null);
    assert.deepEqual(store.getPracticeSession('p-1')?.scope, { mode: 'wrong-book' });
    assert.equal(store.getPracticeSession('missing'), undefined);

    // 进度推进
    const advanced = store.updatePracticeIndex('p-1', 1);
    assert.equal(advanced.currentIndex, 1);
    assert.throws(() => store.updatePracticeIndex('p-1', -1), /non-negative/);
    assert.throws(() => store.updatePracticeIndex('missing', 0), /not found/);

    // 结束：status/finished_at/question_ids 更新（动态范围）
    const finished = store.finishPracticeSession('p-1', ['q-1']);
    assert.equal(finished.status, 'finished');
    assert.ok(finished.finishedAt !== null && finished.finishedAt >= 500);
    assert.deepEqual(finished.questionIds, ['q-1']);
    assert.throws(() => store.finishPracticeSession('missing', []), /not found/);

    // 历史：created_at DESC；含 active 会话（供续做）
    store.createPracticeSession({ id: 'p-2', bankId: 'bank-p', scope: { mode: 'all' }, questionIds: ['q-1'], createdAt: 600 });
    const history = store.listPracticeHistory(10);
    assert.deepEqual(
      history.map((p) => p.id),
      ['p-2', 'p-1'],
      'created_at DESC',
    );
    assert.deepEqual(
      store.listPracticeHistory(1).map((p) => p.id),
      ['p-2'],
      'limit 生效',
    );
    assert.throws(() => store.listPracticeHistory(0), /positive/);
  } finally {
    store.close();
  }
});

test('Phase1 错题本：touchWrong 计数、setMastered、listWrong 过滤与排序', async () => {
  const dir = tempDir();
  try {
    const path = join(dir, 'wrong-book.db');
    const store = await openExamStore(path);
    store.createBank({ name: '错题', id: 'bank-w' });
    store.createQuestion('bank-w', { id: 'q-1', type: 'single', stem: 's1', options: ['A', 'B'], answer: 'A' });
    store.createQuestion('bank-w', { id: 'q-2', type: 'single', stem: 's2', options: ['A', 'B'], answer: 'B' });
    store.createBank({ name: '另一题库', id: 'bank-w2' });
    store.createQuestion('bank-w2', { id: 'q-3', type: 'single', stem: 's3', options: ['A', 'B'], answer: 'A' });

    // 答错两次 → count=2, last_wrong_at 记录
    const w1 = store.touchWrong('q-1', false);
    assert.equal(w1.wrongCount, 1);
    assert.ok(w1.lastWrongAt !== null);
    const w2 = store.touchWrong('q-1', false);
    assert.equal(w2.wrongCount, 2);

    // 答对 → 递减至 0（不清行）
    const w3 = store.touchWrong('q-1', true);
    assert.equal(w3.wrongCount, 1);
    const w4 = store.touchWrong('q-1', true);
    assert.equal(w4.wrongCount, 0);

    // 另两题各错 1 次（计数语义走 touchWrong；排序时间戳在下方以 SQL 固定——
    // 连续两次 Date.now() 可能落同一毫秒（id 平局）或跨毫秒（后写者在前），
    // 直接断言顺序会间歇性失败（Phase 4 终审 §3.1），故此处只断言计数。
    const w5 = store.touchWrong('q-2', false);
    assert.equal(w5.wrongCount, 1);
    const w6 = store.touchWrong('q-3', false);
    assert.equal(w6.wrongCount, 1);
    store.close();

    // 终审建议①：SQL 种子固定 last_wrong_at（q-3 晚于 q-2），使排序断言完全确定。
    const seeder = new (await getDatabaseSync())(path);
    try {
      const bump = seeder.prepare('UPDATE wrong_book_state SET last_wrong_at = ? WHERE question_id = ?');
      bump.run(1000, 'q-2');
      bump.run(2000, 'q-3');
    } finally {
      seeder.close();
    }

    const view = await openExamStore(path);
    try {
      // 默认：wrong_count>0 且未掌握，last_wrong_at 倒序
      const wrong = view.listWrong();
      assert.deepEqual(
        wrong.map((w) => w.questionId),
        ['q-3', 'q-2'],
        'q-1 已归零被排除；排序按 last_wrong_at 倒序',
      );

      // bankId 过滤
      assert.deepEqual(
        view.listWrong({ bankId: 'bank-w' }).map((w) => w.questionId),
        ['q-2'],
      );
      assert.deepEqual(view.listWrong({ bankId: 'bank-w2' }).map((w) => w.questionId), ['q-3']);

      // setMastered：flip 标记；listWrong 默认排除、includeMastered 包含
      const mastered = view.setMastered('q-2', true);
      assert.equal(mastered.mastered, true);
      assert.equal(mastered.wrongCount, 1, '掌握标记不动 wrong_count');
      assert.deepEqual(view.listWrong().map((w) => w.questionId), ['q-3']);
      assert.deepEqual(
        view.listWrong({ includeMastered: true }).map((w) => w.questionId),
        ['q-3', 'q-2'],
        'includeMastered 时含已掌握（仍按 last_wrong_at 倒序）',
      );
      const unmastered = view.setMastered('q-2', false);
      assert.equal(unmastered.mastered, false);

      // t10：lastAnswer = 最近一次作答的用户答案（「你的作答」标记用）
      view.recordGradedAttempt({ questionId: 'q-2', userAnswer: 'C', isCorrect: false });
      const withLast = view.listWrong({ bankId: 'bank-w' }).find((w) => w.questionId === 'q-2');
      assert.ok(withLast !== undefined);
      assert.equal(withLast.lastAnswer, 'C');
      // 多次作答：取最新一条（answered_at DESC, rowid DESC —— 后写者胜）
      view.recordGradedAttempt({ questionId: 'q-2', userAnswer: 'B', isCorrect: false });
      const withNewest = view.listWrong({ bankId: 'bank-w' }).find((w) => w.questionId === 'q-2');
      assert.equal(withNewest?.lastAnswer, 'B', 'lastAnswer 取最近一次作答');
      // setMastered / touchWrong 返回同样携带 lastAnswer
      const masteredLast = view.setMastered('q-2', true);
      assert.equal(masteredLast.lastAnswer, 'B');
      // 无作答的题 lastAnswer 为 null
      const noAnswer = view.listWrong({ includeMastered: true }).find((w) => w.questionId === 'q-3');
      assert.equal(noAnswer?.lastAnswer, null);

      // FK：未知题目抛错
      assert.throws(() => view.touchWrong('ghost', false), /FOREIGN KEY/i);
      assert.throws(() => view.setMastered('ghost', true), /FOREIGN KEY/i);
    } finally {
      view.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Phase 2：v3 迁移 / essay / 批改 / Tutor / 学习计划
// ---------------------------------------------------------------------------

test('Phase2 迁移：v2 库升级（questions 重建，既有数据全保留，essay 放行；终版 v4）', async () => {
  const dir = tempDir();
  try {
    const path = join(dir, 'legacy-v2.db');
    await createV2Db(path);
    const db = new (await getDatabaseSync())(path);
    db.prepare('INSERT INTO banks (id, name, created_at) VALUES (?, ?, ?)').run(
      'legacy-bank',
      '旧题库',
      1000,
    );
    db.prepare(
      `INSERT INTO questions (id, bank_id, type, stem, options, answer, explanation, tags, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run('q-1', 'legacy-bank', 'single', '旧题1', JSON.stringify(['A', 'B']), JSON.stringify('A'), '旧解释', JSON.stringify(['旧']), 1001, 1002);
    db.prepare(
      `INSERT INTO questions (id, bank_id, type, stem, options, answer, explanation, tags, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run('q-2', 'legacy-bank', 'boolean', '旧题2', '[]', JSON.stringify('true'), null, null, 1003, 1003);
    db.prepare(
      'INSERT INTO attempts (id, question_id, practice_id, user_answer, is_correct, answered_at) VALUES (?, ?, ?, ?, ?, ?)',
    ).run('a-1', 'q-1', null, JSON.stringify('A'), 1, 1004);
    db.prepare(
      `INSERT INTO practice_sessions (id, bank_id, scope, question_ids, current_index, status, created_at, finished_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run('p-1', 'legacy-bank', JSON.stringify({ mode: 'all' }), JSON.stringify(['q-1', 'q-2']), 1, 'active', 1005, null);
    db.prepare(
      'INSERT INTO wrong_book_state (question_id, wrong_count, last_wrong_at, mastered) VALUES (?, ?, ?, ?)',
    ).run('q-2', 2, 1006, 0);
    db.close();

    const store = await openExamStore(path);
    try {
      assert.equal(store.health().schemaVersion, 10);

      // 既有数据全保留
      assert.deepEqual(store.listBanks().map((b) => b.id), ['legacy-bank']);
      const q1 = store.getQuestion('q-1');
      assert.equal(q1?.type, 'single');
      assert.deepEqual(q1?.options, ['A', 'B']);
      assert.equal(q1?.answer, 'A');
      assert.equal(q1?.explanation, '旧解释');
      assert.deepEqual(q1?.tags, ['旧']);
      const q2 = store.getQuestion('q-2');
      assert.equal(q2?.type, 'boolean');
      assert.equal(q2?.answer, 'true');
      assert.equal(store.listQuestionsByBank('legacy-bank').length, 2);
      assert.equal(store.listLatestAttemptByQuestion(['q-1']).get('q-1')?.userAnswer, 'A');
      const practice = store.getPracticeSession('p-1');
      assert.equal(practice?.status, 'active');
      assert.deepEqual(practice?.questionIds, ['q-1', 'q-2']);
      assert.equal(practice?.currentIndex, 1);
      assert.deepEqual(store.listWrong({ includeMastered: true }).map((w) => w.questionId), ['q-2']);

      // 迁移后 essay 放行（store 层）
      const essay = store.createQuestion('legacy-bank', {
        id: 'eq-1',
        type: 'essay',
        stem: '迁移后新essay',
        options: [],
        answer: null,
      });
      assert.equal(essay.type, 'essay');
      assert.equal(essay.answer, null);
    } finally {
      store.close();
    }

    // DB 层验证：type CHECK 已扩为含 essay；非法 type 仍被拒；五张新表存在
    const verify = new (await getDatabaseSync())(path);
    try {
      verify.prepare(
        `INSERT INTO questions (id, bank_id, type, stem, options, answer, explanation, tags, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run('eq-2', 'legacy-bank', 'essay', '直插essay', '[]', 'null', null, null, 1, 1);
      assert.throws(
        () => verify.prepare(
          `INSERT INTO questions (id, bank_id, type, stem, options, answer, explanation, tags, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run('bad-1', 'legacy-bank', 'matching', 'x', '[]', 'null', null, null, 1, 1),
        /CHECK/i,
      );
      const newTables = verify
        .prepare(
          `SELECT name FROM sqlite_master WHERE type = 'table' AND name IN
           ('essay_gradings','tutor_sessions','tutor_messages','study_plans','plan_items')`,
        )
        .all()
        .map((r) => r.name);
      assert.equal(newTables.length, 5, '五张新表都应存在');
    } finally {
      verify.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('Phase2 essay 题型：create/get/update 放行 options=[] answer=null，其余题型校验不变', async () => {
  const store = await openExamStore(':memory:');
  try {
    store.createBank({ name: 'essay', id: 'bank-e' });
    const created = store.createQuestion('bank-e', {
      id: 'eq-1',
      type: 'essay',
      stem: '谈谈你对微积分的理解',
      options: [],
      answer: null,
      explanation: 'AI 批改',
    });
    assert.equal(created.type as string, 'essay');
    assert.deepEqual(created.options, []);
    assert.equal(created.answer, null);
    assert.equal(created.explanation, 'AI 批改');
    assert.equal(store.getQuestion('eq-1')?.tags, null);
    assert.equal(store.countQuestions('bank-e'), 1);

    // update：essay → essay（answer 保持 null）
    const updated = store.updateQuestion('eq-1', { stem: '谈谈你对极限的理解', answer: null });
    assert.equal(updated.stem, '谈谈你对极限的理解');
    assert.equal(updated.answer, null);
    assert.deepEqual(updated.options, []);

    // 客观题 → essay（options 清空、answer 置 null）
    store.createQuestion('bank-e', { id: 'oq-1', type: 'single', stem: '1+1=?', options: ['2', '3'], answer: '2' });
    const converted = store.updateQuestion('oq-1', { type: 'essay', options: [], answer: null });
    assert.equal(converted.type as string, 'essay');
    assert.equal(converted.answer, null);
    assert.deepEqual(converted.options, []);

    // essay → 客观题（需重新提供 options/answer）
    const back = store.updateQuestion('eq-1', { type: 'single', options: ['A', 'B'], answer: 'A' });
    assert.equal(back.type, 'single');
    assert.deepEqual(back.options, ['A', 'B']);
    assert.equal(back.answer, 'A');

    // essay 校验仍要求 options 为数组、answer 不得缺失（null 放行、undefined 拒绝）
    assert.throws(
      () => store.createQuestion('bank-e', { type: 'essay', stem: 'x', options: 'bad' as unknown as string[], answer: null }),
      /options/,
    );
    assert.throws(
      // answer 缺失（运行期校验；类型层面为非法输入，故断言运行时抛错）
      () => store.createQuestion('bank-e', { type: 'essay', stem: 'x', options: [] } as never),
      /answer is required/,
    );
    assert.throws(
      () => store.createQuestion('bank-e', { type: 'matching' as unknown as QuestionType, stem: 'x', options: [], answer: null }),
      /invalid question type/,
    );
  } finally {
    store.close();
  }
});

test('Phase2 essay 批改：saveEssayGrading upsert 重批 / get / listLatestGradingByAttempt / 校验 / 软删除保留', async () => {
  const store = await openExamStore(':memory:');
  try {
    store.createBank({ name: 'g', id: 'bank-g' });
    store.createQuestion('bank-g', { id: 'q-1', type: 'essay', stem: 's1', options: [], answer: null });
    store.createQuestion('bank-g', { id: 'q-2', type: 'essay', stem: 's2', options: [], answer: null });
    store.recordAttempt({ id: 'a-1', questionId: 'q-1', userAnswer: '我的答案', isCorrect: false, answeredAt: 100 });
    store.recordAttempt({ id: 'a-2', questionId: 'q-1', userAnswer: '重写答案', isCorrect: true, answeredAt: 200 });
    store.recordAttempt({ id: 'a-3', questionId: 'q-2', userAnswer: 'x', isCorrect: true, answeredAt: 150 });

    // 保存：isCorrect 按 score>=60 归一
    const g1 = store.saveEssayGrading({
      attemptId: 'a-1',
      score: 85,
      verdict: 'correct',
      feedback: '论证充分',
      reference: '要点1',
      model: 'deepseek',
    });
    assert.equal(g1.isCorrect, true);
    assert.equal(g1.score, 85);
    assert.equal(g1.verdict, 'correct');
    assert.equal(g1.feedback, '论证充分');
    assert.equal(g1.reference, '要点1');
    assert.equal(g1.model, 'deepseek');
    const g2 = store.saveEssayGrading({ attemptId: 'a-2', score: 40, verdict: 'incorrect', feedback: '不足' });
    assert.equal(g2.isCorrect, false);
    assert.equal(g2.reference, null);
    assert.equal(g2.model, null);
    store.saveEssayGrading({ attemptId: 'a-3', score: 70, verdict: 'partial', feedback: '尚可' });

    // upsert 重批：同 attempt 覆盖，保留首次 created_at
    const regraded = store.saveEssayGrading({
      attemptId: 'a-1',
      score: 92,
      verdict: 'partial',
      feedback: '重批后评语',
      reference: '新要点',
      model: 'deepseek-v3',
    });
    assert.equal(regraded.score, 92);
    assert.equal(regraded.verdict, 'partial');
    assert.equal(regraded.feedback, '重批后评语');
    assert.equal(regraded.reference, '新要点');
    assert.equal(regraded.model, 'deepseek-v3');
    assert.equal(regraded.createdAt, g1.createdAt, '重批保留首次 created_at');

    // get / 批量
    assert.equal(store.getEssayGrading('a-1')?.score, 92);
    assert.equal(store.getEssayGrading('missing'), undefined);
    const map = store.listLatestGradingByAttempt(['a-1', 'a-2', 'a-3', 'missing']);
    assert.equal(map.size, 3);
    assert.equal(map.get('a-1')?.score, 92);
    assert.equal(map.get('a-2')?.isCorrect, false);
    assert.equal(map.get('missing'), undefined);
    assert.equal(store.listLatestGradingByAttempt([]).size, 0);

    // 校验：score 范围/整数、verdict、feedback 非空
    assert.throws(
      () => store.saveEssayGrading({ attemptId: 'a-1', score: 101, verdict: 'correct', feedback: 'x' }),
      /0\.\.100/,
    );
    assert.throws(
      () => store.saveEssayGrading({ attemptId: 'a-1', score: -1, verdict: 'correct', feedback: 'x' }),
      /0\.\.100/,
    );
    assert.throws(
      () => store.saveEssayGrading({ attemptId: 'a-1', score: 60.5, verdict: 'correct', feedback: 'x' }),
      /0\.\.100/,
    );
    assert.throws(
      () => store.saveEssayGrading({ attemptId: 'a-1', score: 60, verdict: 'unknown' as never, feedback: 'x' }),
      /verdict/,
    );
    assert.throws(
      () => store.saveEssayGrading({ attemptId: 'a-1', score: 60, verdict: 'correct', feedback: '  ' }),
      /feedback/,
    );

    // FK：attempt 不存在抛错
    assert.throws(
      () => store.saveEssayGrading({ attemptId: 'ghost', score: 60, verdict: 'correct', feedback: 'x' }),
      /FOREIGN KEY/i,
    );

    // t1 软删除：删题后批改/作答全部保留（finished 历史可解释）。
    store.deleteQuestion('q-2');
    assert.equal(store.getEssayGrading('a-3')?.score, 70, '软删除保留批改结果');
    assert.equal(store.listLatestGradingByAttempt(['a-3']).size, 1, '软删除保留批量查询');
    assert.equal(store.getQuestionIncludingDeleted('q-2')?.type, 'essay');
  } finally {
    store.close();
  }
});

test('Phase2 Tutor：会话/消息 CRUD、closeTutorSession、listTutorSessions、删题软删除保留绑定', async () => {
  const store = await openExamStore(':memory:');
  try {
    store.createBank({ name: 't', id: 'bank-t' });
    store.createQuestion('bank-t', { id: 'q-1', type: 'single', stem: 's1', options: ['A'], answer: 'A' });

    // 创建会话（缺省 status=active、时间戳自动）
    const s1 = store.createTutorSession({ id: 'ts-1', questionId: 'q-1', bankId: 'bank-t' });
    assert.equal(s1.status, 'active');
    assert.equal(s1.questionId, 'q-1');
    assert.equal(s1.bankId, 'bank-t');
    assert.ok(s1.updatedAt >= s1.createdAt);
    assert.deepEqual(store.getTutorSession('ts-1'), s1);
    assert.equal(store.getTutorSession('missing'), undefined);

    // 无题自由会话 + 显式时间戳
    store.createTutorSession({ id: 'ts-2', createdAt: 500 });
    assert.equal(store.getTutorSession('ts-2')?.questionId, null);

    // 消息：user/assistant 交替，created_at ASC（id ASC 稳定）
    store.addTutorMessage({ id: 'm-1', sessionId: 'ts-1', role: 'user', content: '这道题怎么做？', createdAt: 100 });
    store.addTutorMessage({ id: 'm-2', sessionId: 'ts-1', role: 'assistant', content: '先看题干…', createdAt: 200 });
    store.addTutorMessage({ id: 'm-3', sessionId: 'ts-1', role: 'user', content: '还有别的方法吗？', createdAt: 150 });
    assert.deepEqual(store.listTutorMessages('ts-1').map((m) => m.id), ['m-1', 'm-3', 'm-2']);
    assert.deepEqual(store.listTutorMessages('ts-1').map((m) => m.role), ['user', 'user', 'assistant']);
    assert.deepEqual(store.listTutorMessages('ts-2'), []);
    assert.deepEqual(store.listTutorMessages('missing'), []);

    // 消息校验 + FK / 会话存在性（t5：addTutorMessage 先校验会话存在与状态）
    assert.throws(
      () => store.addTutorMessage({ sessionId: 'ts-1', role: 'system' as never, content: 'x' }),
      /role/,
    );
    assert.throws(
      () => store.addTutorMessage({ sessionId: 'ts-1', role: 'user', content: '   ' }),
      /content/,
    );
    assert.throws(
      () => store.addTutorMessage({ sessionId: 'ghost', role: 'user', content: 'x' }),
      /session not found/i,
    );
    // t5 P3 纵深防御：closed 会话禁止追加消息
    store.addTutorMessage({ sessionId: 'ts-2', role: 'user', content: 'x' });
    store.closeTutorSession('ts-2');
    assert.throws(
      () => store.addTutorMessage({ sessionId: 'ts-2', role: 'user', content: 'y' }),
      /closed/i,
    );

    // close：status='closed' + updated_at 刷新；未知会话抛错
    const closed = store.closeTutorSession('ts-1');
    assert.equal(closed.status, 'closed');
    assert.ok(closed.updatedAt >= closed.createdAt);
    assert.equal(store.getTutorSession('ts-1')?.status, 'closed');
    assert.throws(() => store.closeTutorSession('missing'), /not found/);

    // list：created_at DESC, id DESC + limit
    assert.deepEqual(store.listTutorSessions().map((s) => s.id), ['ts-1', 'ts-2']);
    assert.equal(store.listTutorSessions(1).length, 1);
    assert.throws(() => store.listTutorSessions(0), /positive/);

    // t1 软删除：删题后 question_id 绑定保留（不再 SET NULL——行未被物理删除），
    // 会话与消息不受影响；Tutor 上下文仍可解释。
    store.deleteQuestion('q-1');
    assert.equal(store.getTutorSession('ts-1')?.questionId, 'q-1', '软删除保留题目绑定');
    assert.equal(store.listTutorMessages('ts-1').length, 3, '消息不受删题影响');
  } finally {
    store.close();
  }
});

test('Phase2 学习计划：create/get/list、addPlanItems、setPlanItemDone、getPlanWithItems', async () => {
  const store = await openExamStore(':memory:');
  try {
    // 创建（title 去空白、缺省 status=active）
    const p1 = store.createStudyPlan({ id: 'pl-1', title: '  期末冲刺  ', source: 'llm' });
    assert.equal(p1.title, '期末冲刺');
    assert.equal(p1.source, 'llm');
    assert.equal(p1.status, 'active');
    assert.equal(store.getStudyPlan('pl-1')?.title, '期末冲刺');
    assert.equal(store.getStudyPlan('missing'), undefined);

    // 校验
    assert.throws(() => store.createStudyPlan({ title: '  ', source: 'llm' }), /title/);
    assert.throws(() => store.createStudyPlan({ title: 'x', source: 'auto' as never }), /source/);
    assert.throws(() => store.createStudyPlan({ title: 'x', source: 'llm', status: 'paused' as never }), /status/);

    // 手动计划 + 显式时间戳（排序用）
    store.createStudyPlan({ id: 'pl-2', title: '手动计划', source: 'manual', createdAt: 100 });
    store.createStudyPlan({ id: 'pl-3', title: '早计划', source: 'manual', createdAt: 50 });

    // list：created_at DESC, id DESC + limit
    assert.deepEqual(store.listStudyPlans().map((p) => p.id), ['pl-1', 'pl-2', 'pl-3']);
    assert.equal(store.listStudyPlans(2).length, 2);
    assert.throws(() => store.listStudyPlans(0), /positive/);

    // addPlanItems：一次多插，sort 缺省 0；计划不存在抛错
    const added = store.addPlanItems('pl-1', [
      { title: ' 复习第一章  ', sort: 2 },
      { title: '刷错题本', sort: 1 },
      { title: '做一套模拟卷' },
    ]);
    assert.equal(added.plan.id, 'pl-1');
    assert.equal(added.items.length, 3);
    assert.deepEqual(added.items.map((i) => i.title), ['复习第一章', '刷错题本', '做一套模拟卷']);
    const lastAdded = added.items[2]!;
    assert.equal(lastAdded.sort, 0, 'sort 缺省 0');
    assert.equal(lastAdded.status, 'pending');
    assert.equal(lastAdded.completedAt, null);
    assert.throws(() => store.addPlanItems('ghost', [{ title: 'x' }]), /study plan not found/);
    assert.throws(() => store.addPlanItems('pl-1', [{ title: '  ' }]), /title/);

    // listPlanItems：sort ASC, created_at ASC, id ASC
    const items = store.listPlanItems('pl-1');
    assert.deepEqual(items.map((i) => i.title), ['做一套模拟卷', '刷错题本', '复习第一章']);
    assert.deepEqual(store.listPlanItems('pl-2'), []);

    // setPlanItemDone：done → completed_at；undo → null；计划/条目不存在抛错
    const item1 = items[1]!;
    const done = store.setPlanItemDone('pl-1', item1.id, true);
    assert.equal(done.status, 'done');
    assert.ok(done.completedAt !== null && done.completedAt >= done.createdAt);
    const undone = store.setPlanItemDone('pl-1', item1.id, false);
    assert.equal(undone.status, 'pending');
    assert.equal(undone.completedAt, null);
    assert.throws(() => store.setPlanItemDone('ghost', item1.id, true), /study plan not found/);
    assert.throws(() => store.setPlanItemDone('pl-1', 'ghost', true), /plan item not found/);
    assert.throws(
      () => store.setPlanItemDone('pl-2', item1.id, true),
      /plan item not found/,
      '条目不属于该计划',
    );

    // getPlanWithItems
    const withItems = store.getPlanWithItems('pl-1');
    assert.equal(withItems?.plan.id, 'pl-1');
    assert.equal(withItems?.items.length, 3);
    assert.equal(store.getPlanWithItems('missing'), undefined);
  } finally {
    store.close();
  }
});

test('t12 计划状态自动机：setPlanItemDone 事务内重算 plan.status（全 done→completed / 回退→active / updated_at 刷新）', async () => {
  const store = await openExamStore(':memory:');
  try {
    const p = store.createStudyPlan({ id: 'pl-t12', title: '冲刺', source: 'manual' });
    assert.equal(p.status, 'active');
    const { items } = store.addPlanItems('pl-t12', [
      { title: '章节一', sort: 0 },
      { title: '章节二', sort: 1 },
      { title: '章节三', sort: 2 },
    ]);
    const a = items[0]!;
    const b = items[1]!;
    const c = items[2]!;

    // 部分完成 → 仍 active（存在 pending），且 updated_at 被刷新
    const t0 = store.getStudyPlan('pl-t12')!.updatedAt;
    const doneA = store.setPlanItemDone('pl-t12', a.id, true);
    assert.equal(doneA.status, 'done');
    await new Promise((resolve) => setTimeout(resolve, 5));
    let plan = store.getStudyPlan('pl-t12')!;
    assert.equal(plan.status, 'active', '存在 pending 时保持 active');
    assert.ok(plan.updatedAt >= t0, '条目翻转刷新计划 updated_at');

    // 全部完成 → completed
    store.setPlanItemDone('pl-t12', b.id, true);
    const doneC = store.setPlanItemDone('pl-t12', c.id, true);
    assert.equal(doneC.status, 'done');
    plan = store.getStudyPlan('pl-t12')!;
    assert.equal(plan.status, 'completed', '全 done → completed');
    const completedUpdatedAt = plan.updatedAt;

    // 回退：un-done 一个已完成条目 → active，updated_at 再次刷新
    await new Promise((resolve) => setTimeout(resolve, 5));
    const undoneB = store.setPlanItemDone('pl-t12', b.id, false);
    assert.equal(undoneB.status, 'pending');
    assert.equal(undoneB.completedAt, null);
    plan = store.getStudyPlan('pl-t12')!;
    assert.equal(plan.status, 'active', '存在 pending → active');
    assert.ok(plan.updatedAt > completedUpdatedAt, '回退同样刷新 updated_at');

    // 闭环：再次全部完成 → 重新回到 completed
    const redoneB = store.setPlanItemDone('pl-t12', b.id, true);
    assert.equal(redoneB.status, 'done');
    plan = store.getStudyPlan('pl-t12')!;
    assert.equal(plan.status, 'completed', '闭环：可再次全部完成');
    assert.ok(plan.updatedAt > completedUpdatedAt, '闭环翻转也刷新 updated_at');

    // getPlanWithItems 与自动机一致
    const full = store.getPlanWithItems('pl-t12')!;
    assert.equal(full.plan.status, 'completed');
    assert.ok(full.items.every((item) => item.status === 'done'));
  } finally {
    store.close();
  }
});

test('t13 计划/条目删除：deleteStudyPlan 级联；deletePlanItem 同事务重算计划状态', async () => {
  const store = await openExamStore(':memory:');
  try {
    store.createStudyPlan({ id: 'pl-del', title: '要删除的计划', source: 'manual' });
    const { items } = store.addPlanItems('pl-del', [{ title: 'A', sort: 0 }, { title: 'B', sort: 1 }]);
    const a = items[0]!;
    const b = items[1]!;

    // 条目删除：A 完成（done）、B pending → 删 B 后全 done → completed
    store.setPlanItemDone('pl-del', a.id, true);
    store.deletePlanItem('pl-del', b.id);
    assert.equal(store.getStudyPlan('pl-del')!.status, 'completed', '剩余条目全 done → completed');
    assert.deepEqual(store.listPlanItems('pl-del').map((it) => it.id), [a.id]);

    // 删掉最后一条 → 删空回 active（与手动新建空计划初始态一致）
    store.deletePlanItem('pl-del', a.id);
    assert.equal(store.getStudyPlan('pl-del')!.status, 'active', '条目删空 → active');
    assert.deepEqual(store.listPlanItems('pl-del'), []);

    // 不存在抛错
    assert.throws(() => store.deletePlanItem('pl-del', 'ghost'), /plan item not found/);
    assert.throws(() => store.deletePlanItem('ghost-plan', a.id), /study plan not found/);

    // 计划删除：级联清条目（重建一条验证）
    store.addPlanItems('pl-del', [{ title: '孤条目' }]);
    assert.equal(store.deleteStudyPlan('pl-del'), true);
    assert.equal(store.getStudyPlan('pl-del'), undefined);
    assert.deepEqual(store.listPlanItems('pl-del'), [], '级联清理条目');
    assert.equal(store.deleteStudyPlan('pl-del'), false, '重复删除返回 false');
  } finally {
    store.close();
  }
});

test('t13 诊断持久化：saveDiagnosis 往返 + listDiagnoses 倒序', async () => {
  const store = await openExamStore(':memory:');
  try {
    const first = store.saveDiagnosis({
      id: 'd-1',
      summary: '第一次诊断',
      weaknesses: ['计算'],
      suggestions: [{ text: '每天 20 题' }, { text: '重练错题', action: { mode: 'wrong' } }],
      provider: 'p1',
      model: 'm1',
      createdAt: 100,
    });
    assert.equal(first.id, 'd-1');
    assert.deepEqual(first.weaknesses, ['计算']);
    assert.deepEqual(first.suggestions, [
      { text: '每天 20 题' },
      { text: '重练错题', action: { mode: 'wrong' } },
    ]);

    const second = store.saveDiagnosis({ id: 'd-2', summary: '第二次诊断', createdAt: 200 });
    assert.deepEqual(second.suggestions, [], '缺省 suggestions 为空数组');

    // created_at DESC
    assert.deepEqual(
      store.listDiagnoses().map((d) => d.id),
      ['d-2', 'd-1'],
    );
    // limit 生效
    assert.deepEqual(store.listDiagnoses(1).map((d) => d.id), ['d-2']);

    // 空 summary 拒绝
    assert.throws(() => store.saveDiagnosis({ summary: '   ' }), /summary must not be empty/);
  } finally {
    store.close();
  }
});

test('Phase2 级联删除（DB 层）：删 tutor_sessions 清消息；删 study_plans 清条目', async () => {
  const dir = tempDir();
  try {
    const path = join(dir, 'cascade-v3.db');
    const store = await openExamStore(path);
    store.createBank({ name: 'x', id: 'bank-x' });
    store.createTutorSession({ id: 'ts-1' });
    store.addTutorMessage({ id: 'm-1', sessionId: 'ts-1', role: 'user', content: 'hi' });
    store.addTutorMessage({ id: 'm-2', sessionId: 'ts-1', role: 'assistant', content: 'hello' });
    store.createStudyPlan({ id: 'pl-1', title: '计划1', source: 'llm' });
    store.addPlanItems('pl-1', [{ title: '复习第一章' }, { title: '做错题' }]);
    store.close();

    const db = new (await getDatabaseSync())(path);
    try {
      db.prepare('DELETE FROM tutor_sessions WHERE id = ?').run('ts-1');
      db.prepare('DELETE FROM study_plans WHERE id = ?').run('pl-1');
      const counts = {
        messages: Number(db.prepare('SELECT COUNT(*) AS n FROM tutor_messages').get()!.n),
        plans: Number(db.prepare('SELECT COUNT(*) AS n FROM study_plans').get()!.n),
        items: Number(db.prepare('SELECT COUNT(*) AS n FROM plan_items').get()!.n),
      };
      assert.deepEqual(counts, { messages: 0, plans: 0, items: 0 }, 'ON DELETE CASCADE 生效');
    } finally {
      db.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('Phase2 聚合扫描：listAllAttempts 全量升序 + countFinishedPractices', async () => {
  const store = await openExamStore(':memory:');
  try {
    store.createBank({ name: 'x', id: 'bank-s' });
    store.createQuestion('bank-s', { id: 'q-1', type: 'single', stem: 's', options: ['A'], answer: 'A' });
    store.recordAttempt({ id: 'a1', questionId: 'q-1', userAnswer: 'A', isCorrect: true, answeredAt: 300 });
    store.recordAttempt({ id: 'a2', questionId: 'q-1', userAnswer: 'B', isCorrect: false, answeredAt: 100 });
    assert.deepEqual(
      store.listAllAttempts().map((a) => a.id),
      ['a2', 'a1'],
      'answered_at ASC, id ASC',
    );

    assert.equal(store.countFinishedPractices(), 0);
    store.createPracticeSession({ id: 'p1', bankId: 'bank-s', scope: {}, questionIds: ['q-1'] });
    store.finishPracticeSession('p1', ['q-1']);
    store.createPracticeSession({ id: 'p2', bankId: 'bank-s', scope: {}, questionIds: ['q-1'] });
    assert.equal(store.countFinishedPractices(), 1, '仅 finished 会话计入');
  } finally {
    store.close();
  }
});

test('Phase2 迁移：中途失败残留 questions_new 后重试成功（DROP IF EXISTS 幂等）', async () => {
  const dir = tempDir();
  try {
    const path = join(dir, 'retry-v3.db');
    await createV2Db(path);
    const db = new (await getDatabaseSync())(path);
    db.prepare('INSERT INTO banks (id, name, created_at) VALUES (?, ?, ?)').run('legacy-bank', '旧题库', 1000);
    db.prepare(
      `INSERT INTO questions (id, bank_id, type, stem, options, answer, explanation, tags, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run('q-1', 'legacy-bank', 'single', '旧题1', JSON.stringify(['A', 'B']), JSON.stringify('A'), null, null, 1001, 1002);
    // 模拟上一次 v3 迁移中途失败：questions_new 已创建（含复制数据），user_version 仍为 2、questions 未删。
    db.exec(
      `CREATE TABLE questions_new (
         id TEXT PRIMARY KEY,
         bank_id TEXT NOT NULL REFERENCES banks(id) ON DELETE CASCADE,
         type TEXT NOT NULL CHECK(type IN ('single','multiple','boolean','essay')),
         stem TEXT NOT NULL,
         options TEXT NOT NULL,
         answer TEXT NOT NULL,
         explanation TEXT,
         tags TEXT,
         created_at INTEGER,
         updated_at INTEGER
       )`,
    );
    db.prepare(
      `INSERT INTO questions_new (id, bank_id, type, stem, options, answer, explanation, tags, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run('q-1', 'legacy-bank', 'single', '旧题1', JSON.stringify(['A', 'B']), JSON.stringify('A'), null, null, 1001, 1002);
    db.close();

    // 重试迁移：DROP TABLE IF EXISTS questions_new 清残留 → 重建成功、数据恰好一份。
    const store = await openExamStore(path);
    try {
      assert.equal(store.health().schemaVersion, 10);
      const questions = store.listQuestionsByBank('legacy-bank');
      assert.equal(questions.length, 1, '数据恰好一份（残留表被清理后重建）');
      assert.equal(questions[0]?.answer, 'A');
      assert.equal(store.getQuestion('q-1')?.stem, '旧题1');
    } finally {
      store.close();
    }

    // DB 层验证：残留 questions_new 已清理；重复 open 仍幂等。
    const verify = new (await getDatabaseSync())(path);
    try {
      const leftover = verify
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'questions_new'")
        .all();
      assert.equal(leftover.length, 0, '残留 questions_new 已被清理');
    } finally {
      verify.close();
    }
    const reopened = await openExamStore(path);
    try {
      assert.equal(reopened.health().schemaVersion, 10);
      assert.equal(reopened.listQuestionsByBank('legacy-bank').length, 1, '重复 open 幂等');
    } finally {
      reopened.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('Phase4 作答定向查询：getLatestAttemptByPracticeQuestion（EXAM_NOT_GRADED 校验 / 推导 norm 用）', async () => {
  const store = await openExamStore(':memory:');
  try {
    store.createBank({ name: 'x', id: 'bank-x' });
    store.createQuestion('bank-x', { id: 'q-1', type: 'single', stem: 's1', options: ['A', 'B'], answer: 'A' });

    // 无练习归属的作答不命中（practice_id 精确匹配）
    store.recordAttempt({ id: 'a0', questionId: 'q-1', userAnswer: 'B', isCorrect: false });
    assert.equal(store.getLatestAttemptByPracticeQuestion('p-1', 'q-1'), undefined);

    store.createPracticeSession({ id: 'p-1', bankId: 'bank-x', scope: {}, questionIds: ['q-1'] });
    store.recordAttempt({ id: 'a1', questionId: 'q-1', practiceId: 'p-1', userAnswer: 'B', isCorrect: false, answeredAt: 100 });
    store.recordAttempt({ id: 'a2', questionId: 'q-1', practiceId: 'p-1', userAnswer: 'A', isCorrect: true, answeredAt: 200 });

    const latest = store.getLatestAttemptByPracticeQuestion('p-1', 'q-1');
    assert.equal(latest?.id, 'a2', '取 answered_at 最新一条');
    assert.equal(latest?.userAnswer, 'A');
    assert.equal(latest?.isCorrect, true);
    assert.equal(latest?.practiceId, 'p-1');
    assert.equal(store.getLatestAttemptByPracticeQuestion('p-missing', 'q-1'), undefined);
    assert.equal(store.getLatestAttemptByPracticeQuestion('p-1', 'q-missing'), undefined);
  } finally {
    store.close();
  }
});

// ---------------------------------------------------------------------------
// Phase 4：v4 迁移 / AI 解析缓存
// ---------------------------------------------------------------------------

test('Phase4 迁移：v3 库升级到 v4（存量数据保留，explanations 表可用 + UNIQUE 键生效）', async () => {
  const dir = tempDir();
  try {
    const path = join(dir, 'upgrade-v4.db');
    // 先以当前代码建满 v4 库并写入数据，再回拨 user_version=3 并删除 explanations——
    // v4 组为纯增量 DDL（仅 explanations 表 + 索引），回拨后即等价于真实的历史 v3 库。
    const seed = await openExamStore(path);
    seed.createBank({ name: '老题库', id: 'legacy-bank' });
    seed.createQuestion('legacy-bank', {
      id: 'q-1',
      type: 'single',
      stem: '1+1=?',
      options: ['A. 1', 'B. 2'],
      answer: 'B',
      explanation: '加法常识',
      tags: ['数学'],
    });
    seed.recordAttempt({ id: 'a-1', questionId: 'q-1', userAnswer: 'A', isCorrect: false });
    seed.touchWrong('q-1', false);
    seed.close();

    const raw = new (await getDatabaseSync())(path);
    raw.exec('DROP TABLE explanations');
    raw.exec('PRAGMA user_version = 3');
    raw.close();

    // 重开：仅 v4+v5 组重放（幂等 IF NOT EXISTS / ADD COLUMN 会重复报错——v5 组
    // 仅在 user_version<6 时执行，重放安全）→ schemaVersion=9（v4..v9 全组重放）、存量数据原样。
    const store = await openExamStore(path);
    try {
      assert.equal(store.health().schemaVersion, 10);
      assert.deepEqual(store.listBanks().map((b) => b.id), ['legacy-bank']);
      const q = store.getQuestion('q-1');
      assert.equal(q?.stem, '1+1=?');
      assert.equal(q?.explanation, '加法常识');
      assert.deepEqual(q?.tags, ['数学']);
      assert.equal(store.listLatestAttemptByQuestion(['q-1']).get('q-1')?.userAnswer, 'A');
      assert.deepEqual(store.listWrong({ includeMastered: true }).map((w) => w.questionId), ['q-1']);

      // 升级后 explanations 立即可用（v5 列 provider/reasoning_effort 一并落库）
      const saved = store.upsertExplanation({
        questionId: 'q-1',
        answerNorm: '0',
        content: '升级后的新解析',
        model: 'deepseek-chat',
        provider: 'deepseek-official',
        reasoningEffort: 'max',
      });
      assert.equal(saved.answerNorm, '0');
      assert.equal(saved.provider, 'deepseek-official');
      assert.equal(saved.reasoningEffort, 'max');
      assert.equal(store.getExplanation('q-1', '0')?.content, '升级后的新解析');
    } finally {
      store.close();
    }

    // DB 层验证：UNIQUE(question_id, answer_norm) 生效；重复 open 幂等。
    // 探针用 '1' 键（store 此前只写过 '0' 键）。
    const verify = new (await getDatabaseSync())(path);
    try {
      verify
        .prepare(
          'INSERT INTO explanations (id, question_id, answer_norm, content, model, created_at) VALUES (?, ?, ?, ?, ?, ?)',
        )
        .run('dup-x', 'q-1', '1', '直插第一份', null, 1);
      assert.throws(
        () =>
          verify
            .prepare(
              'INSERT INTO explanations (id, question_id, answer_norm, content, model, created_at) VALUES (?, ?, ?, ?, ?, ?)',
            )
            .run('dup-y', 'q-1', '1', '同键第二份应被拒', null, 2),
        /UNIQUE/i,
      );
    } finally {
      verify.close();
    }
    const reopened = await openExamStore(path);
    try {
      assert.equal(reopened.health().schemaVersion, 10);
      assert.equal(reopened.listExplanationsByQuestion('q-1').length, 2, "重复 open 幂等（store 的 '0' + 探针 '1'）");
      assert.equal(
        reopened.getExplanation('q-1', '0')?.content,
        '升级后的新解析',
        '原键内容不受直插探针影响',
      );
    } finally {
      reopened.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('Phase4 解析缓存：upsert 单份最新 / get / listByQuestion / 校验 / FK / 软删除保留', async () => {
  const store = await openExamStore(':memory:');
  try {
    store.createBank({ name: 'x', id: 'bank-x' });
    store.createQuestion('bank-x', { id: 'q-1', type: 'single', stem: 's1', options: ['A', 'B'], answer: 'A' });
    store.createQuestion('bank-x', { id: 'q-2', type: 'boolean', stem: 's2', options: [], answer: 'true' });

    const first = store.upsertExplanation({
      questionId: 'q-1',
      answerNorm: '0',
      content: '第一份解析',
      model: 'm-1',
    });
    assert.equal(first.id.length, 36, '缺省 id 为 UUID');
    assert.equal(first.questionId, 'q-1');
    assert.equal(first.answerNorm, '0');
    assert.equal(first.content, '第一份解析');
    assert.equal(first.model, 'm-1');
    assert.ok(Number.isInteger(first.createdAt) && first.createdAt > 0);

    // upsert 覆盖（重新解析）：同键单行、新 id/content/model、created_at 刷新。
    await new Promise((resolve) => setTimeout(resolve, 5));
    const second = store.upsertExplanation({
      questionId: 'q-1',
      answerNorm: '0',
      content: '重新解析覆盖',
      model: 'm-2',
    });
    assert.notEqual(second.id, first.id, '覆盖后为新行（单份最新原则）');
    assert.ok(second.createdAt >= first.createdAt);
    assert.equal(store.getExplanation('q-1', '0')?.content, '重新解析覆盖');
    assert.equal(store.getExplanation('q-1', '0')?.model, 'm-2');
    assert.equal(store.listExplanationsByQuestion('q-1').length, 1, 'UNIQUE 键保证无重复行');

    // content 去首尾空白；model 缺省 null。
    const trimmed = store.upsertExplanation({ questionId: 'q-2', answerNorm: 'false', content: '  判断题解析  ' });
    assert.equal(trimmed.content, '判断题解析');
    assert.equal(trimmed.model, null);

    // 不同答案键 + G 形态空键共存（created_at DESC 排序）。
    await new Promise((resolve) => setTimeout(resolve, 5));
    store.upsertExplanation({ questionId: 'q-1', answerNorm: '1', content: '另一答案的解析' });
    await new Promise((resolve) => setTimeout(resolve, 5));
    store.upsertExplanation({ questionId: 'q-1', answerNorm: '', content: 'G 通用解析' });
    assert.deepEqual(
      store.listExplanationsByQuestion('q-1').map((r) => r.answerNorm),
      ['', '1', '0'],
      '按创建时间倒序',
    );
    assert.deepEqual(store.listExplanationsByQuestion('q-2').map((r) => r.answerNorm), ['false']);
    assert.equal(store.getExplanation('q-1', '')?.content, 'G 通用解析');
    assert.equal(store.getExplanation('missing', ''), undefined);
    assert.deepEqual(store.listExplanationsByQuestion('ghost'), []);

    // 校验：content 空、answerNorm 非字符串。
    assert.throws(() => store.upsertExplanation({ questionId: 'q-1', answerNorm: 'x', content: '   ' }), /content/);
    assert.throws(
      () => store.upsertExplanation({ questionId: 'q-1', answerNorm: 42 as never, content: 'x' }),
      /answerNorm/,
    );

    // FK：未知题目抛错。
    assert.throws(
      () => store.upsertExplanation({ questionId: 'ghost', answerNorm: '', content: 'x' }),
      /FOREIGN KEY/i,
    );

    // t1 软删除：删题后解析缓存保留（历史回看仍可解释）；他题不受影响。
    store.deleteQuestion('q-1');
    assert.equal(store.listExplanationsByQuestion('q-1').length, 3, '软删除保留全部缓存键');
    assert.equal(store.getExplanation('q-1', '')?.content, 'G 通用解析');
    assert.equal(store.listExplanationsByQuestion('q-2').length, 1, '他题缓存不受影响');
  } finally {
    store.close();
  }
});

// ---------------------------------------------------------------------------
// t1 修复：会话域最新作答 / 判分事务 / 软删除策略（补充用例）
// ---------------------------------------------------------------------------

test('t1 会话域最新作答：listLatestAttemptByPracticeQuestions 按 practice_id 隔离，跨会话同题不串味', async () => {
  const store = await openExamStore(':memory:');
  try {
    store.createBank({ name: 't1', id: 'bank-t1' });
    store.createQuestion('bank-t1', { id: 'q-1', type: 'single', stem: 's1', options: ['A', 'B'], answer: 'A' });
    store.createQuestion('bank-t1', { id: 'q-2', type: 'single', stem: 's2', options: ['A', 'B'], answer: 'B' });
    store.createPracticeSession({ id: 'p-1', bankId: 'bank-t1', scope: { mode: 'all' }, questionIds: ['q-1', 'q-2'] });
    store.createPracticeSession({ id: 'p-2', bankId: 'bank-t1', scope: { mode: 'all' }, questionIds: ['q-1'] });

    // p-1：q-1 答错（时间 200）；p-2：同一 q-1 答对（时间 300，更晚）
    store.recordAttempt({ id: 'a1', questionId: 'q-1', practiceId: 'p-1', userAnswer: 'B', isCorrect: false, answeredAt: 200 });
    store.recordAttempt({ id: 'a2', questionId: 'q-1', practiceId: 'p-2', userAnswer: 'A', isCorrect: true, answeredAt: 300 });
    // 独立作答（practiceId null）：不得进入任何会话域查询
    store.recordAttempt({ id: 'a3', questionId: 'q-1', practiceId: null, userAnswer: 'A', isCorrect: true, answeredAt: 400 });
    // p-1 内 q-1 重复作答：取该会话内最新
    store.recordAttempt({ id: 'a4', questionId: 'q-1', practiceId: 'p-1', userAnswer: 'B', isCorrect: false, answeredAt: 250 });

    // 全局口径（跨会话最新）：a3（400 最晚，含独立作答）——这正是会话域查询要防的串味
    const globalLatest = store.listLatestAttemptByQuestion(['q-1']);
    assert.equal(globalLatest.get('q-1')?.id, 'a3');

    // 会话域口径：p-1 只见 p-1 的作答（a4），p-2 只见 p-2 的作答（a2）
    const scoped1 = store.listLatestAttemptByPracticeQuestions('p-1', ['q-1', 'q-2']);
    assert.equal(scoped1.size, 1, 'q-2 无作答不在 Map 中');
    assert.equal(scoped1.get('q-1')?.id, 'a4', 'p-1 会话内最新（250 晚于 200）');
    assert.equal(scoped1.get('q-1')?.isCorrect, false);
    const scoped2 = store.listLatestAttemptByPracticeQuestions('p-2', ['q-1']);
    assert.equal(scoped2.get('q-1')?.id, 'a2');
    assert.equal(scoped2.get('q-1')?.isCorrect, true);
    // 空数组 / 无匹配会话
    assert.equal(store.listLatestAttemptByPracticeQuestions('p-1', []).size, 0);
    assert.equal(store.listLatestAttemptByPracticeQuestions('ghost', ['q-1']).size, 0, '未知会话无作答');
    // 独立作答不进入会话域（a3 的 practiceId=null 被精确匹配排除）
    assert.notEqual(scoped1.get('q-1')?.id, 'a3');
  } finally {
    store.close();
  }
});

test('t1 判分事务：recordGradedAttempt 作答+错题本同事务；essay 记录失败整体回滚', async () => {
  const store = await openExamStore(':memory:');
  try {
    store.createBank({ name: 't1', id: 'bank-tx' });
    store.createQuestion('bank-tx', { id: 'q-1', type: 'single', stem: 's1', options: ['A', 'B'], answer: 'A' });
    store.createQuestion('bank-tx', { id: 'q-2', type: 'essay', stem: 'e2', options: [], answer: null });

    // 客观判分事务成功：attempt + wrong 同时可见
    const graded = store.recordGradedAttempt({ questionId: 'q-1', userAnswer: 'B', isCorrect: false });
    assert.ok(graded.attempt.id.length > 0);
    assert.equal(graded.wrong.questionId, 'q-1');
    assert.equal(graded.wrong.wrongCount, 1);
    assert.equal(store.listLatestAttemptByQuestion(['q-1']).get('q-1')?.isCorrect, false);
    assert.equal(store.listWrong().length, 1);

    // essay 事务成功：attemptId 由事务内 attempt 派生，attempt+wrong+grading 一致
    const essay = store.recordGradedEssay({
      attempt: { questionId: 'q-2', practiceId: 'p-x', userAnswer: '我的论述', isCorrect: true },
      grading: { score: 75, verdict: 'partial', feedback: '尚可', reference: '要点', model: 'm' },
    });
    assert.equal(essay.attempt.practiceId, 'p-x');
    assert.equal(essay.wrong.wrongCount, 0, '答对不增计数');
    assert.equal(essay.grading.attemptId, essay.attempt.id, '批改绑定同一事务内创建的 attempt');
    assert.equal(essay.grading.score, 75);
    assert.equal(store.getEssayGrading(essay.attempt.id)?.feedback, '尚可');

    // essay 事务回滚：grading 校验失败（score 越界）→ attempt 与 wrong 一并回滚
    const before = store.listAllAttempts().length;
    assert.throws(
      () =>
        store.recordGradedEssay({
          attempt: { questionId: 'q-2', practiceId: 'p-y', userAnswer: '坏数据', isCorrect: false },
          grading: { score: 150, verdict: 'correct', feedback: 'x' },
        }),
      /0\.\.100/,
    );
    assert.equal(store.listAllAttempts().length, before, '回滚后无孤儿 attempt');
    // 成功用例的批改仍原样保留（回滚只撤销失败事务自身）
    assert.equal(store.getEssayGrading(essay.attempt.id)?.score, 75);
    // 错题本计数未被半提交污染：q-2 若事务泄漏（答错 touchWrong 半提交）会以
    // wrong_count>=1 出现在列表；回滚后应完全不存在（计数仍 0）。
    assert.equal(
      store.listWrong({ includeMastered: true }).some((w) => w.questionId === 'q-2'),
      false,
      '失败事务的 touchWrong 已回滚',
    );
    // 未知题目 → FK 失败，同样不留任何行
    assert.throws(() => store.recordGradedAttempt({ questionId: 'ghost', userAnswer: 'x', isCorrect: true }), /FOREIGN KEY/i);
    assert.equal(store.listAllAttempts().length, before);
  } finally {
    store.close();
  }
});

// ---------------------------------------------------------------------------
// t9：题库管理与学情计划产品升级
// ---------------------------------------------------------------------------

test('t9 题库生命周期：rename/archive/restore/delete 与 listBanks 过滤', async () => {
  const store = await openExamStore(':memory:');
  try {
    const bank = store.createBank({ name: '原始', id: 'b-1' });
    assert.equal(bank.deletedAt, null);
    assert.equal(bank.archivedAt, null);

    const renamed = store.renameBank('b-1', '改名后');
    assert.equal(renamed.name, '改名后');

    // archive → 默认列表排除；includeArchived 包含；includeDeleted 不含归档（仍排除）
    const archived = store.archiveBank('b-1');
    assert.ok(archived.archivedAt !== null);
    assert.equal(archived.deletedAt, null);
    assert.deepEqual(store.listBanks().map((b) => b.id), [], '默认列表删除题库排除已归档');
    assert.deepEqual(store.listBanks({ includeArchived: true }).map((b) => b.id), ['b-1']);
    assert.deepEqual(store.listBanks({ includeDeleted: true }).map((b) => b.id), [], 'includeDeleted 不包含归档');

    // restore → 恢复活跃
    const restored = store.restoreBank('b-1');
    assert.equal(restored.archivedAt, null);
    assert.equal(restored.deletedAt, null);
    assert.deepEqual(store.listBanks().map((b) => b.id), ['b-1']);

    // delete → 软删除；默认排除；includeDeleted 包含；再次删除幂等返回 false
    store.deleteBank('b-1');
    assert.deepEqual(store.listBanks().map((b) => b.id), []);
    assert.equal(store.listBanks({ includeDeleted: true })[0]?.id, 'b-1');
    assert.equal(store.deleteBank('b-1'), false, '已删除的再次删除不产生新变更');

    // restore 可恢复已删除题库（清空 deleted_at）
    const restoredAgain = store.restoreBank('b-1');
    assert.equal(restoredAgain.deletedAt, null);
    assert.deepEqual(store.listBanks().map((b) => b.id), ['b-1']);

    // 不存在/非法操作
    assert.throws(() => store.renameBank('ghost', 'x'), /not found/);
    assert.throws(() => store.archiveBank('ghost'), /not found/);
    assert.throws(() => store.deleteBank('ghost'), /not found/);
    assert.throws(() => store.renameBank('b-1', '   '), /must not be empty/);
  } finally {
    store.close();
  }
});

test('t9 题目列表过滤：q/type/tags/hasExplanation/sort 与 move/restore', async () => {
  const store = await openExamStore(':memory:');
  try {
    store.createBank({ name: '题库', id: 'b-1' });
    store.createBank({ name: '目标题库', id: 'b-2' });
    store.createQuestion('b-1', { id: 'q-1', type: 'single', stem: '1+1=?', options: ['1', '2'], answer: '2', explanation: '加法', tags: ['数学', '基础'] });
    await new Promise((resolve) => setTimeout(resolve, 5));
    store.createQuestion('b-1', { id: 'q-2', type: 'single', stem: '2+2=?', options: ['3', '4'], answer: '4', tags: ['数学'] });
    await new Promise((resolve) => setTimeout(resolve, 5));
    store.createQuestion('b-1', { id: 'q-3', type: 'boolean', stem: '地球是圆的', options: [], answer: 'true', explanation: '常识' });

    // q 关键词（不区分大小写）
    assert.deepEqual(store.listQuestionsByBank('b-1', { q: '1+1' }).map((q) => q.id), ['q-1']);
    // type 单值 / 多值
    assert.deepEqual(store.listQuestionsByBank('b-1', { type: 'single' }).map((q) => q.id), ['q-1', 'q-2']);
    assert.deepEqual(store.listQuestionsByBank('b-1', { type: ['single', 'boolean'] }).map((q) => q.id), ['q-1', 'q-2', 'q-3']);
    // tags 包含（数组 = 全部包含 AND）
    assert.deepEqual(store.listQuestionsByBank('b-1', { tags: '数学' }).map((q) => q.id), ['q-1', 'q-2']);
    assert.deepEqual(store.listQuestionsByBank('b-1', { tags: ['数学', '基础'] }).map((q) => q.id), ['q-1']);
    // hasExplanation
    assert.deepEqual(store.listQuestionsByBank('b-1', { hasExplanation: true }).map((q) => q.id), ['q-1', 'q-3']);
    assert.deepEqual(store.listQuestionsByBank('b-1', { hasExplanation: false }).map((q) => q.id), ['q-2']);
    // sort createdAt desc（created_at 通过 sleep 保证不同毫秒，避免 id 平局掩盖方向）
    assert.deepEqual(
      store.listQuestionsByBank('b-1', { sort: { field: 'createdAt', dir: 'desc' } }).map((q) => q.id),
      ['q-3', 'q-2', 'q-1'],
    );

    // restore + move + delete
    store.deleteQuestion('q-2');
    assert.equal(store.getQuestion('q-2'), undefined);
    assert.equal(store.restoreQuestion('q-2'), true, '首次恢复成功');
    assert.ok(store.getQuestion('q-2') !== undefined);
    assert.equal(store.restoreQuestion('q-2'), false, '未删除的题目恢复返回 false');

    const moved = store.moveQuestion('q-1', 'b-2');
    assert.equal(moved.bankId, 'b-2');
    assert.deepEqual(store.listQuestionsByBank('b-1').map((q) => q.id), ['q-2', 'q-3'], 'q-1 移出后，q-2/q-3 仍在原题库');
    assert.throws(() => store.moveQuestion('q-1', 'ghost-bank'), /FOREIGN KEY/i);
  } finally {
    store.close();
  }
});

test('t9 listQuestionsByBank includeDeleted：缺省排除已软删除，includeDeleted=true 连同返回（供题库内恢复）', async () => {
  const store = await openExamStore(':memory:');
  try {
    store.createBank({ name: '题库', id: 'b-del' });
    store.createQuestion('b-del', { id: 'q-1', type: 'single', stem: '存活题', options: ['A', 'B'], answer: 'A' });
    await new Promise((resolve) => setTimeout(resolve, 5));
    store.createQuestion('b-del', { id: 'q-2', type: 'single', stem: '已删题', options: ['A', 'B'], answer: 'B' });
    store.deleteQuestion('q-2');

    // 缺省：仅活跃题（q-2 软删除后被排除）
    const active = store.listQuestionsByBank('b-del');
    assert.deepEqual(active.map((q) => q.id), ['q-1']);

    // includeDeleted=true：连同已软删除题返回，且保留 deletedAt 标记（供客户端显示「已删除」徽标与「恢复」）
    const withDeleted = store.listQuestionsByBank('b-del', { includeDeleted: true });
    assert.deepEqual(withDeleted.map((q) => q.id), ['q-1', 'q-2'], '含已删题且按 createdAt 升序');
    const deletedQ = withDeleted.find((q) => q.id === 'q-2');
    assert.ok(deletedQ !== undefined && deletedQ.deletedAt !== null && deletedQ.deletedAt !== undefined, '已删题带 deletedAt');

    // 恢复后再次缺省可见（闭环：恢复 → 回归活跃列表）
    assert.equal(store.restoreQuestion('q-2'), true);
    assert.deepEqual(store.listQuestionsByBank('b-del').map((q) => q.id), ['q-1', 'q-2']);
  } finally {
    store.close();
  }
});

test('t1 知识点 topics：create/update 存取、来源字段、标签规范化（trim/小写/空白/去重）', async () => {
  const store = await openExamStore(':memory:');
  try {
    store.createBank({ name: 'x', id: 'b-t1' });
    // create：topics 全链 + topicsSource
    const q = store.createQuestion('b-t1', {
      id: 'q-t1',
      type: 'single',
      stem: 's',
      options: ['A', 'B'],
      answer: 'A',
      tags: [' TOGAF 9.2 ', 'togaf9.2', ''],
      topics: [' 架构治理 ', 'data architecture', '架构治理'],
      topicsSource: 'ai-deep',
    });
    assert.deepEqual(q.tags, ['togaf9.2'], 'tags 规范化：trim/小写/去空白/去重/去空');
    assert.deepEqual(q.topics, ['架构治理', 'dataarchitecture'], 'topics 规范化且保序去重');
    assert.equal(q.topicsSource, 'ai-deep');

    // update：覆盖式设置 topics（null 清空）
    const q2 = store.updateQuestion('q-t1', { topics: ['ARCH\\TECH'] });
    assert.deepEqual(q2.topics, ['arch\\tech'], 'update 后规范化');
    const q3 = store.updateQuestion('q-t1', { topics: null });
    assert.equal(q3.topics, null, 'topics null 清空');
    assert.equal(q3.topicsSource, null, 'topics 清空后来源置 null');

    // update 不改 topics 时保留
    const q4 = store.updateQuestion('q-t1', { tags: ['新 tag'] });
    assert.equal(q4.topics, null);
  } finally {
    store.close();
  }
});

test('t9 错题掌握模型：streak/达标 mastered/答错重置/lifetime_wrong_count 只增/setMastered source', async () => {
  const store = await openExamStore(':memory:');
  try {
    store.createBank({ name: 'x', id: 'b-1' });
    store.createQuestion('b-1', { id: 'q-1', type: 'single', stem: 's1', options: ['A', 'B'], answer: 'A' });

    // 答错：wrong_count +1、lifetime_wrong_count +1、streak 0、last_result false
    let w = store.touchWrong('q-1', false);
    assert.equal(w.wrongCount, 1);
    assert.equal(w.lifetimeWrongCount, 1);
    assert.equal(w.consecutiveCorrect, 0);
    assert.equal(w.lastResult, false);
    assert.equal(w.mastered, false);
    assert.equal(w.masterySource, null);

    // 再答错：lifetime_wrong_count 只增
    w = store.touchWrong('q-1', false);
    assert.equal(w.wrongCount, 2);
    assert.equal(w.lifetimeWrongCount, 2);

    // 答对 ×3 → streak 递增，第三次达标 → computed mastered
    w = store.touchWrong('q-1', true);
    assert.equal(w.consecutiveCorrect, 1);
    assert.equal(w.lastResult, true);
    assert.equal(w.mastered, false);
    w = store.touchWrong('q-1', true);
    assert.equal(w.consecutiveCorrect, 2);
    w = store.touchWrong('q-1', true);
    assert.equal(w.consecutiveCorrect, 3);
    assert.equal(w.mastered, true, '达标自动置位 mastered');
    assert.equal(w.masterySource, 'computed');
    assert.equal(w.lifetimeWrongCount, 2, '答对不改变 lifetime_wrong_count');

    // 答错重置 streak，但**不取消 mastered**（参考旧 masteryService 语义）
    w = store.touchWrong('q-1', false);
    assert.equal(w.consecutiveCorrect, 0);
    assert.equal(w.lastResult, false);
    assert.equal(w.mastered, true, '答错不取消已掌握（由用户手动管理）');
    assert.equal(w.masterySource, 'computed');
    assert.equal(w.lifetimeWrongCount, 3);

    // 手动标记 source='manual'；取消掌握 source=null
    w = store.setMastered('q-1', true);
    assert.equal(w.masterySource, 'manual');
    assert.equal(w.mastered, true);
    w = store.setMastered('q-1', false);
    assert.equal(w.mastered, false);
    assert.equal(w.masterySource, null);
  } finally {
    store.close();
  }
});

test('t9 计划条目可执行字段与状态机（doing/skipped）', async () => {
  const store = await openExamStore(':memory:');
  try {
    const plan = store.createStudyPlan({ id: 'p-1', title: '计划', source: 'manual' });
    const result = store.addPlanItems('p-1', [
      { title: '复习错题', actionType: 'practice', scope: { mode: 'wrong' }, priority: 1, note: '每天 20 分钟', dueAt: 123456, sourceDiagnosisId: 'dia-1', status: 'doing', sort: 0 },
      { title: '看讲义', actionType: 'read', priority: 2, sort: 1 },
      { title: '刷题', status: 'skipped', sort: 2 },
    ]);
    assert.equal(result.items.length, 3);

    // 按 sort 升序读回：note/actionType/scope/priority/status/dueAt/sourceDiagnosisId 全部持久化
    const items = store.listPlanItems('p-1');
    const item0 = items[0]!;
    assert.equal(item0.actionType, 'practice');
    assert.deepEqual(item0.scope, { mode: 'wrong' });
    assert.equal(item0.priority, 1);
    assert.equal(item0.note, '每天 20 分钟');
    assert.equal(item0.dueAt, 123456);
    assert.equal(item0.sourceDiagnosisId, 'dia-1');
    assert.equal(item0.status, 'doing');
    const item1 = items[1]!;
    assert.equal(item1.actionType, 'read');
    assert.equal(item1.priority, 2);
    assert.equal(item1.status, 'pending', '未指定 status 缺省 pending');
    const item2 = items[2]!;
    assert.equal(item2.status, 'skipped');

    // 状态机：计划含 doing/skipped（无 pending）→ 未完成；全 done/skipped → completed
    let planState = store.getStudyPlan('p-1')!;
    assert.equal(planState.status, 'active');
    store.setPlanItemDone('p-1', item1.id, true); // read → done；剩余 doing + skipped → active
    planState = store.getStudyPlan('p-1')!;
    assert.equal(planState.status, 'active', '仍有 doing 条目 → active');
    store.setPlanItemDone('p-1', item0.id, true); // doing → done；剩余 skipped → completed
    planState = store.getStudyPlan('p-1')!;
    assert.equal(planState.status, 'completed', '全部 done/skipped → completed');
  } finally {
    store.close();
  }
});
