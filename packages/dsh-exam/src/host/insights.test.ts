/**
 * Phase 2 学情洞察单元测试（Node 内置 node:test，真实 store 构造数据）。
 * 运行：node --test packages/dsh-exam/src/host/insights.test.ts
 * 覆盖：空库全零、聚合正确性（总答/正确率/按题型/薄弱题型/练习次数）、
 * 近 7 天按本地日期归日（含跨日空档）、错题 Top10 排序与上限。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openExamStore, type ExamStore } from './store.ts';
import { buildInsightSummary } from './insights.ts';

/** 本地日期 → epoch 毫秒（当日 10:00，避免午夜 DST 边界）。 */
function localDayMs(year: number, month: number, day: number): number {
  return new Date(year, month - 1, day, 10, 0, 0).getTime();
}

/** 独立实现的本地日期 key（与实现同算法，用于期望值）。 */
function expectedKey(ms: number): string {
  const date = new Date(ms);
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${date.getFullYear()}-${month}-${day}`;
}

/** 建一个有 4 道题（single×2 / boolean / essay）的库。 */
function seedStore(store: ExamStore): void {
  store.createBank({ name: '学情', id: 'b1' });
  store.createQuestion('b1', { id: 'q1', type: 'single', stem: '单选题1', options: ['A. 1', 'B. 2'], answer: 'A' });
  store.createQuestion('b1', { id: 'q2', type: 'single', stem: '单选题2', options: ['A. 1', 'B. 2'], answer: 'B' });
  store.createQuestion('b1', { id: 'q3', type: 'boolean', stem: '判断题1', options: [], answer: 'true' });
  store.createQuestion('b1', { id: 'q4', type: 'essay', stem: '主观题1', options: [], answer: null });
}

test('insights：空库返回全零摘要（7 天空档日 + 空 byType/wrongTop/weakTypes）', async () => {
  const store = await openExamStore(':memory:');
  try {
    const summary = buildInsightSummary(store);
    assert.equal(summary.windowDays, 7);
    assert.equal(summary.totalAttempts, 0);
    assert.equal(summary.correctAttempts, 0);
    assert.equal(summary.accuracy, 0);
    assert.equal(summary.daily.length, 7);
    assert.ok(summary.daily.every((d) => d.total === 0 && d.correct === 0));
    assert.equal(summary.accuracyWindow, 0);
    assert.equal(summary.streakDays, 0);
    assert.deepEqual(summary.byType, {});
    assert.deepEqual(summary.wrongTop, []);
    assert.equal(summary.finishedPractices, 0);
    assert.deepEqual(summary.weakTypes, []);
    assert.deepEqual(summary.weakTags, []);
    assert.deepEqual(summary.weakTopics, []);
  } finally {
    store.close();
  }
});

test('insights：聚合正确性（总答/正确率/按题型/薄弱题型/练习次数/跨日空档）', async () => {
  const store = await openExamStore(':memory:');
  try {
    seedStore(store);
    const now = new Date();
    const today = localDayMs(now.getFullYear(), now.getMonth() + 1, now.getDate());
    const day3Ago = localDayMs(now.getFullYear(), now.getMonth() + 1, now.getDate() - 3);
    const day6Ago = localDayMs(now.getFullYear(), now.getMonth() + 1, now.getDate() - 6);

    // 作答：今天 q1 对 / q2 错；3 天前 q3 对；6 天前 q1 错（1/2/4/5 天前为空档）。
    store.recordAttempt({ id: 'a1', questionId: 'q1', userAnswer: 'A', isCorrect: true, answeredAt: today });
    store.recordAttempt({ id: 'a2', questionId: 'q2', userAnswer: 'A', isCorrect: false, answeredAt: today + 60_000 });
    store.recordAttempt({ id: 'a3', questionId: 'q3', userAnswer: 'true', isCorrect: true, answeredAt: day3Ago });
    store.recordAttempt({ id: 'a4', questionId: 'q1', userAnswer: 'B', isCorrect: false, answeredAt: day6Ago });

    // 错题本：q2 错 2 次、q1 错 1 次。
    store.touchWrong('q2', false);
    store.touchWrong('q2', false);
    store.touchWrong('q1', false);

    // 练习：1 个 finished + 1 个 active。
    store.createPracticeSession({ id: 'p1', bankId: 'b1', scope: {}, questionIds: ['q1', 'q2'], createdAt: 1 });
    store.finishPracticeSession('p1', ['q1', 'q2']);
    store.createPracticeSession({ id: 'p2', bankId: 'b1', scope: {}, questionIds: ['q3'], createdAt: 2 });

    const summary = buildInsightSummary(store);
    assert.equal(summary.totalAttempts, 4);
    assert.equal(summary.correctAttempts, 2);
    assert.equal(summary.accuracy, 0.5);

    // 近 7 天：今天 {2,1}、3 天前 {1,1}、6 天前 {1,0}，其余空档 {0,0}。
    const expectedDaily = Array.from({ length: 7 }, (_, i) => {
      const day = new Date(now.getFullYear(), now.getMonth(), now.getDate() - (6 - i));
      const ms = localDayMs(day.getFullYear(), day.getMonth() + 1, day.getDate());
      const key = expectedKey(ms);
      if (key === expectedKey(today)) return { date: key, total: 2, correct: 1 };
      if (key === expectedKey(day3Ago)) return { date: key, total: 1, correct: 1 };
      if (key === expectedKey(day6Ago)) return { date: key, total: 1, correct: 0 };
      return { date: key, total: 0, correct: 0 };
    });
    assert.deepEqual(summary.daily, expectedDaily);
    assert.equal(summary.daily[6]!.date, expectedKey(today), '最后一天为今天');

    // 按题型：single total=2 answered=3 correct=1（q1×2+q2×1）；boolean total=1 answered=1 correct=1；essay total=1 answered=0。
    assert.deepEqual(summary.byType['single']!, { total: 2, answered: 3, correct: 1, accuracy: 1 / 3 });
    assert.deepEqual(summary.byType['boolean']!, { total: 1, answered: 1, correct: 1, accuracy: 1 });
    assert.deepEqual(summary.byType['essay']!, { total: 1, answered: 0, correct: 0, accuracy: 0 });

    // 薄弱题型（t13 相对判定）：阈值 = max(0.5−0.15, 0.6)=0.6 → single（1/3，样本 3）入选；
    // boolean 样本 1 < 3 不参与判定。
    assert.deepEqual(summary.weakTypes, ['single']);
    // 连续学习：今天有作答 → streak 至少为 1（当日归日）。
    assert.equal(summary.streakDays, 1);
    // 窗口正确率：全部作答都在 7 天窗口内 → 与总正确率一致。
    assert.equal(summary.accuracyWindow, 0.5);

    // 错题 Top：q2(2) 在前，q1(1) 在后，附 stem/bankId/topics；lastWrongAt 为落库时间。
    assert.deepEqual(
      summary.wrongTop.map((w) => ({ questionId: w.questionId, bankId: w.bankId, wrongCount: w.wrongCount, stem: w.stem, topics: w.topics })),
      [
        { questionId: 'q2', bankId: 'b1', wrongCount: 2, stem: '单选题2', topics: [] },
        { questionId: 'q1', bankId: 'b1', wrongCount: 1, stem: '单选题1', topics: [] },
      ],
    );
    for (const w of summary.wrongTop) {
      assert.ok(typeof w.lastWrongAt === 'number' && w.lastWrongAt > 0, 'lastWrongAt 应为落库时间戳');
    }

    // 练习次数：仅 finished 计入。
    assert.equal(summary.finishedPractices, 1);
  } finally {
    store.close();
  }
});

test('insights：错题 Top10 按 wrong_count 降序截断；无作答时 weakTypes 为空', async () => {
  const store = await openExamStore(':memory:');
  try {
    store.createBank({ name: '错题库', id: 'b2' });
    for (let i = 1; i <= 12; i++) {
      store.createQuestion('b2', { id: `qw${i}`, type: 'single', stem: `错题${i}`, options: ['A. 1', 'B. 2'], answer: 'A' });
      for (let k = 0; k < i; k++) store.touchWrong(`qw${i}`, false);
    }

    const summary = buildInsightSummary(store);
    assert.equal(summary.wrongTop.length, 10, '截断至 10 条');
    const top = summary.wrongTop[0]!;
    assert.equal(top.questionId, 'qw12', 'wrong_count 最大在前');
    assert.equal(top.wrongCount, 12);
    assert.equal(summary.wrongTop[9]!.questionId, 'qw3', '第 10 名为 qw3');
    assert.equal(top.stem, '错题12', '附 stem 摘要');

    assert.deepEqual(summary.weakTypes, [], '无任何作答 → 无薄弱题型');
    assert.equal(summary.totalAttempts, 0);
    assert.equal(summary.finishedPractices, 0);
  } finally {
    store.close();
  }
});

test('t9/t13 学情新指标：firstAttemptAccuracy/currentMastery/coverage/accuracyWindow/weakTags/weakTopics', async () => {
  const store = await openExamStore(':memory:');
  try {
    store.createBank({ name: '学情', id: 'b1' });
    store.createQuestion('b1', { id: 'q1', type: 'single', stem: 'A', options: ['A. 1', 'B. 2'], answer: 'A', tags: ['代数'], topics: ['函数'] });
    store.createQuestion('b1', { id: 'q2', type: 'single', stem: 'B', options: ['A. 1', 'B. 2'], answer: 'B', tags: ['代数'], topics: ['函数'] });
    store.createQuestion('b1', { id: 'q3', type: 'boolean', stem: 'C', options: [], answer: 'true' });
    // q4：从未作答 → coverage < 1
    store.createQuestion('b1', { id: 'q4', type: 'single', stem: 'D', options: ['A. 1', 'B. 2'], answer: 'B' });

    const now = new Date();
    const today = localDayMs(now.getFullYear(), now.getMonth() + 1, now.getDate());
    const day3Ago = localDayMs(now.getFullYear(), now.getMonth() + 1, now.getDate() - 3);
    const day6Ago = localDayMs(now.getFullYear(), now.getMonth() + 1, now.getDate() - 6);

    // q1：首次（6 天前）答错，今天答对；q2：今天答错；q3：3 天前答对
    store.recordAttempt({ id: 'a1', questionId: 'q1', userAnswer: 'B', isCorrect: false, answeredAt: day6Ago });
    store.recordAttempt({ id: 'a2', questionId: 'q1', userAnswer: 'A', isCorrect: true, answeredAt: today });
    store.recordAttempt({ id: 'a3', questionId: 'q2', userAnswer: 'A', isCorrect: false, answeredAt: today });
    store.recordAttempt({ id: 'a4', questionId: 'q3', userAnswer: 'true', isCorrect: true, answeredAt: day3Ago });

    const summary = buildInsightSummary(store);
    // 已作答唯一题数 3 / 可用题数 4
    assert.equal(summary.coverage, 3 / 4);
    // 首次作答正确率：q1 首答错、q2 首答错、q3 首答对 → 1/3
    assert.equal(summary.firstAttemptAccuracy, 1 / 3);
    // 当前掌握率（每题最新作答正确率）：q1 最新对、q2 最新错、q3 最新对 → 2/3
    assert.equal(summary.currentMastery, 2 / 3);
    // 窗口正确率：4 次作答 2 次对 → 0.5
    assert.equal(summary.accuracyWindow, 0.5);
    // 标签级薄弱（t13 判定：样本 3 达门槛，1/3 < 阈值 0.6）
    assert.deepEqual(summary.weakTags, [{ tag: '代数', answered: 3, correct: 1, accuracy: 1 / 3 }]);
    // 知识点级薄弱（口径同 weakTags；t13 起供下钻/UI 消费）
    assert.deepEqual(summary.weakTopics, [{ topic: '函数', answered: 3, correct: 1, accuracy: 1 / 3 }]);
    // streak：今天有作答，昨天无 → 1
    assert.equal(summary.streakDays, 1);
  } finally {
    store.close();
  }
});

test('t13 窗口参数与题库过滤：windowDays=14 日数、bankId 收敛统计、大样本相对薄弱判定', async () => {
  const store = await openExamStore(':memory:');
  try {
    store.createBank({ name: '甲', id: 'bA' });
    store.createBank({ name: '乙', id: 'bB' });
    // 甲库 10 题答对 9 题（整体正确率 0.9）+ '几何' 标签 3 题答对 2 题（0.67 < 0.75 阈值）
    for (let i = 1; i <= 10; i++) {
      store.createQuestion('bA', { id: `qa${i}`, type: 'single', stem: `甲${i}`, options: ['A. 1', 'B. 2'], answer: 'A' });
      store.recordAttempt({ id: `aa${i}`, questionId: `qa${i}`, userAnswer: 'A', isCorrect: i !== 1, answeredAt: Date.now() });
    }
    for (let i = 1; i <= 3; i++) {
      store.createQuestion('bA', {
        id: `g${i}`, type: 'single', stem: `几何${i}`, options: ['A. 1', 'B. 2'], answer: 'A', tags: ['几何'], topics: ['立体几何'],
      });
      store.recordAttempt({ id: `ag${i}`, questionId: `g${i}`, userAnswer: i === 1 ? 'B' : 'A', isCorrect: i !== 1, answeredAt: Date.now() });
    }
    // 乙库 1 题答对（全库正确率 12/14=0.857 → 阈值 max(0.707,0.6)=0.707，几何 2/3 入选）
    store.createQuestion('bB', { id: 'qb1', type: 'single', stem: '乙1', options: ['A. 1', 'B. 2'], answer: 'A' });
    store.recordAttempt({ id: 'ab1', questionId: 'qb1', userAnswer: 'A', isCorrect: true, answeredAt: Date.now() });

    const all = buildInsightSummary(store);
    assert.ok(all.weakTags.some((w) => w.tag === '几何'), '正确率 2/3 低于阈值 0.707 → 几何为薄弱标签');
    assert.ok(all.weakTopics.some((w) => w.topic === '立体几何'), '知识点维度同规则');
    assert.ok(!all.weakTypes.includes('single'), 'single 整体 12/14=0.857 高于阈值 → 不薄弱');
    assert.ok(!all.weakTags.some((w) => w.tag === '不存在'), '无中生有的标签不存在');

    const byBank = buildInsightSummary(store, { bankId: 'bA' });
    assert.equal(byBank.totalAttempts, 13, 'bankId 过滤后仅统计甲库作答');
    assert.equal(byBank.coverage, 13 / 13);

    const w14 = buildInsightSummary(store, { windowDays: 14 });
    assert.equal(w14.windowDays, 14);
    assert.equal(w14.daily.length, 14);
    const w30 = buildInsightSummary(store, { windowDays: 30 });
    assert.equal(w30.daily.length, 30);
  } finally {
    store.close();
  }
});
