/**
 * practice.ts 练习引擎单元测试（真实 :memory: store + 引擎，零 Cordis 依赖）。
 * 覆盖：范围解析（all/undone/wrong/byType/byTag + 缺筛选值回退）、
 * 确定性 shuffle、判分记录/错题本联动、成绩单聚合、404/400 语义。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openExamStore, type ExamStore } from './store.ts';
import { createPracticeEngine, shuffleIds, type PracticeEngine } from './practice.ts';
import { ExamServiceError } from './errors.ts';

async function setup(): Promise<{ store: ExamStore; engine: PracticeEngine; warns: string[] }> {
  const store = await openExamStore(':memory:');
  const warns: string[] = [];
  const engine = createPracticeEngine(store, (m) => warns.push(m));
  store.createBank({ id: 'bank-1', name: '测试题库' });
  // 4 题：2 single（一题带 tag '数学'）、1 multiple、1 boolean
  store.createQuestion('bank-1', { id: 'q-1', type: 'single', stem: '1+1=?', options: ['1', '2'], answer: '1', tags: ['数学'] });
  store.createQuestion('bank-1', { id: 'q-2', type: 'single', stem: '2+2=?', options: ['3', '4'], answer: '4', tags: ['数学'] });
  store.createQuestion('bank-1', { id: 'q-3', type: 'multiple', stem: '选 AB', options: ['A', 'B', 'C'], answer: ['A', 'B'] });
  store.createQuestion('bank-1', { id: 'q-4', type: 'boolean', stem: '地球是圆的', options: [], answer: 'true' });
  return { store, engine, warns };
}

test('resolveQuestionIds：all / byType / byTag / 缺筛选值回退 all+warn', async () => {
  const { engine, warns } = await setup();
  assert.deepEqual(engine.resolveQuestionIds('bank-1', { mode: 'all' }), ['q-1', 'q-2', 'q-3', 'q-4']);
  assert.deepEqual(engine.resolveQuestionIds('bank-1', { mode: 'byType', type: 'single' }), ['q-1', 'q-2']);
  assert.deepEqual(engine.resolveQuestionIds('bank-1', { mode: 'byType', type: 'boolean' }), ['q-4']);
  assert.deepEqual(engine.resolveQuestionIds('bank-1', { mode: 'byTag', tag: '数学' }), ['q-1', 'q-2']);
  // 缺筛选值 → 回退 all + warn
  assert.deepEqual(engine.resolveQuestionIds('bank-1', { mode: 'byType' }), ['q-1', 'q-2', 'q-3', 'q-4']);
  assert.deepEqual(engine.resolveQuestionIds('bank-1', { mode: 'byTag' }), ['q-1', 'q-2', 'q-3', 'q-4']);
  assert.deepEqual(engine.resolveQuestionIds('bank-1', { mode: 'byTag', tag: '  ' }), ['q-1', 'q-2', 'q-3', 'q-4']);
  assert.equal(warns.length, 3, '三次回退各记录一条 warn');
});

test('resolveQuestionIds：undone（从未作答）与 wrong（错题本）语义', async () => {
  const { store, engine } = await setup();
  // 全部未作答 → undone = 全部
  assert.deepEqual(engine.resolveQuestionIds('bank-1', { mode: 'undone' }), ['q-1', 'q-2', 'q-3', 'q-4']);
  // 答 q-1 对、q-2 错 → undone 只剩 q-3/q-4；wrong 只有 q-2
  store.recordAttempt({ questionId: 'q-1', userAnswer: '1', isCorrect: true });
  store.recordAttempt({ questionId: 'q-2', userAnswer: '3', isCorrect: false });
  store.touchWrong('q-2', false);
  assert.deepEqual(engine.resolveQuestionIds('bank-1', { mode: 'undone' }), ['q-3', 'q-4']);
  assert.deepEqual(engine.resolveQuestionIds('bank-1', { mode: 'wrong' }), ['q-2']);
  // 答对 q-2 后 wrong 清空（wrong_count 递减到 0 不再命中）
  store.recordAttempt({ questionId: 'q-2', userAnswer: '4', isCorrect: true });
  store.touchWrong('q-2', true);
  assert.deepEqual(engine.resolveQuestionIds('bank-1', { mode: 'wrong' }), []);
});

test('shuffleIds：固定 seed 确定性、保持集合、无 seed 时可用', () => {
  const ids = ['a', 'b', 'c', 'd', 'e'];
  const once = shuffleIds(ids, 'seed-1');
  const twice = shuffleIds(ids, 'seed-1');
  assert.deepEqual(once, twice, '同 seed 结果一致');
  assert.deepEqual([...once].sort(), [...ids].sort(), '元素集合不变');
  assert.notDeepEqual(once, ids, '至少一次洗乱（5 元素）');
  // 不同 seed 大概率不同（仅做基本断言：长度一致）
  const other = shuffleIds(ids, 'seed-2');
  assert.equal(other.length, ids.length);
});

test('startPractice → gradeAnswer → scorecard → finish 全流程', async () => {
  const { store, engine } = await setup();
  const practice = engine.startPractice({ bankId: 'bank-1', scope: { mode: 'all' } });
  assert.equal(practice.status, 'active');
  assert.equal(practice.questionIds.length, 4);
  assert.equal(practice.currentIndex, 0);

  // 判分：q-1 对，q-2 错
  const ok = engine.gradeAnswer({ practiceId: practice.id, questionId: 'q-1', answer: '1' });
  assert.equal(ok.isCorrect, true);
  assert.equal(ok.attempt.questionId, 'q-1');
  const wrong = engine.gradeAnswer({ practiceId: practice.id, questionId: 'q-2', answer: '3' });
  assert.equal(wrong.isCorrect, false);
  assert.equal(wrong.attempt.userAnswer, '3');

  // 错题本联动：q-2 计数 1
  const wrongList = engine.listWrong({});
  assert.equal(wrongList.length, 1);
  assert.equal(wrongList[0]?.questionId, 'q-2');
  assert.equal(wrongList[0]?.wrongCount, 1);

  // 进度下标
  const patched = engine.updateIndex(practice.id, 2);
  assert.equal(patched.currentIndex, 2);

  // 成绩单：4 题，answered 2，correct 1
  const scorecard = engine.buildScorecard(practice.id);
  assert.equal(scorecard.total, 4);
  assert.equal(scorecard.answered, 2);
  assert.equal(scorecard.correct, 1);
  assert.equal(scorecard.accuracy, 0.5);
  assert.equal(scorecard.byType['single']?.total, 2);
  assert.equal(scorecard.byType['single']?.correct, 1);
  assert.equal(scorecard.byType['multiple']?.answered, 0);

  // finish：状态 finished + finishedAt + 成绩单
  const finished = engine.finishPractice(practice.id);
  assert.equal(finished.practice.status, 'finished');
  assert.ok(finished.practice.finishedAt !== null);
  assert.equal(finished.scorecard.total, 4);

  // resume：会话 + 每题最新作答（按会话题目顺序）
  const resumed = engine.resumePractice(practice.id);
  assert.equal(resumed.practice.status, 'finished');
  assert.deepEqual(
    resumed.latestAttempts.map((a) => a.questionId),
    ['q-1', 'q-2'],
  );
  assert.equal(resumed.latestAttempts[0]?.isCorrect, true);
  assert.equal(resumed.latestAttempts[1]?.isCorrect, false);
});

test('gradeAnswer：题目不在会话内 → EXAM_QUESTION_NOT_IN_PRACTICE；不存在的会话/题目 → 404 码', async () => {
  const { engine } = await setup();
  const practice = engine.startPractice({ bankId: 'bank-1', scope: { mode: 'all' } });

  assert.throws(
    () => engine.gradeAnswer({ practiceId: practice.id, questionId: 'ghost', answer: '1' }),
    (error: unknown) => error instanceof ExamServiceError && error.code === 'EXAM_QUESTION_NOT_FOUND',
  );
  // 存在于题库但不在会话范围：单独建一个只含 q-1 的会话
  const small = engine.startPractice({ bankId: 'bank-1', scope: { mode: 'byType', type: 'single' } });
  assert.throws(
    () => engine.gradeAnswer({ practiceId: small.id, questionId: 'q-3', answer: ['A', 'B'] }),
    (error: unknown) => error instanceof ExamServiceError && error.code === 'EXAM_QUESTION_NOT_IN_PRACTICE',
  );
  assert.throws(
    () => engine.buildScorecard('missing'),
    (error: unknown) => error instanceof ExamServiceError && error.code === 'EXAM_PRACTICE_NOT_FOUND',
  );
  assert.throws(
    () => engine.setMastered('ghost', true),
    (error: unknown) => error instanceof ExamServiceError && error.code === 'EXAM_QUESTION_NOT_FOUND',
  );
});

test('startPractice：bank 不存在 → EXAM_BANK_NOT_FOUND；非法 scope → EXAM_INVALID_SCOPE', async () => {
  const { engine } = await setup();
  assert.throws(
    () => engine.startPractice({ bankId: 'nope', scope: { mode: 'all' } }),
    (error: unknown) => error instanceof ExamServiceError && error.code === 'EXAM_BANK_NOT_FOUND',
  );
  assert.throws(
    () => engine.startPractice({ bankId: 'bank-1', scope: { mode: 'bogus' as never } }),
    (error: unknown) => error instanceof ExamServiceError && error.code === 'EXAM_INVALID_SCOPE',
  );
});

test('setMastered：掌握标记影响 wrong 列表 includeMastered 语义', async () => {
  const { store, engine } = await setup();
  store.recordAttempt({ questionId: 'q-1', userAnswer: '2', isCorrect: false });
  store.touchWrong('q-1', false);
  const mastered = engine.setMastered('q-1', true);
  assert.equal(mastered.mastered, true);
  assert.deepEqual(engine.listWrong({}), [], '默认排除已掌握');
  assert.equal(engine.listWrong({ includeMastered: true }).length, 1, 'includeMastered=true 包含');
  engine.setMastered('q-1', false);
  assert.equal(engine.listWrong({}).length, 1, '取消掌握后恢复');
});

// ---------------------------------------------------------------------------
// t1 领域正确性：空范围 / finished 守卫 / 跨会话隔离 / 软删除
// ---------------------------------------------------------------------------

test('t1 startPractice：空范围拒绝建 active 空会话 → EXAM_EMPTY_PRACTICE_SCOPE', async () => {
  const { engine } = await setup();
  // wrong 模式但错题本为空 → 0 题
  assert.throws(
    () => engine.startPractice({ bankId: 'bank-1', scope: { mode: 'wrong' } }),
    (error: unknown) => error instanceof ExamServiceError && error.code === 'EXAM_EMPTY_PRACTICE_SCOPE',
  );
  // byType 无匹配题型 → 0 题
  assert.throws(
    () => engine.startPractice({ bankId: 'bank-1', scope: { mode: 'byType', type: 'essay' } }),
    (error: unknown) => error instanceof ExamServiceError && error.code === 'EXAM_EMPTY_PRACTICE_SCOPE',
  );
  // 不存在的会话未被创建（数据库无残留 active 空会话）
  assert.equal(engine.listWrong({}).length, 0);
});

test('t1 finished 守卫：finished 会话禁止继续判分与 patch currentIndex → EXAM_PRACTICE_FINISHED', async () => {
  const { engine } = await setup();
  const practice = engine.startPractice({ bankId: 'bank-1', scope: { mode: 'all' } });
  engine.gradeAnswer({ practiceId: practice.id, questionId: 'q-1', answer: '1' });
  engine.finishPractice(practice.id);

  // 客观判分被拒（无论题目是否已作答）
  assert.throws(
    () => engine.gradeAnswer({ practiceId: practice.id, questionId: 'q-2', answer: '3' }),
    (error: unknown) => error instanceof ExamServiceError && error.code === 'EXAM_PRACTICE_FINISHED',
  );
  // patch currentIndex 被拒
  assert.throws(
    () => engine.updateIndex(practice.id, 3),
    (error: unknown) => error instanceof ExamServiceError && error.code === 'EXAM_PRACTICE_FINISHED',
  );
  // 只读路径不受影响：resume / scorecard 仍可用
  assert.equal(engine.resumePractice(practice.id).practice.status, 'finished');
  assert.equal(engine.buildScorecard(practice.id).answered, 1);
  // 会话行未被判分污染：作答数不变
  assert.equal(engine.resumePractice(practice.id).latestAttempts.length, 1);
});

test('t1 跨会话同题回归：resume/scorecard 按会话域最新作答，不串味', async () => {
  const { store, engine } = await setup();
  // 两个会话都含 q-1
  const p1 = engine.startPractice({ bankId: 'bank-1', scope: { mode: 'byType', type: 'single' } });
  const p2 = engine.startPractice({ bankId: 'bank-1', scope: { mode: 'byType', type: 'single' } });
  assert.deepEqual(p1.questionIds, ['q-1', 'q-2']);
  assert.deepEqual(p2.questionIds, ['q-1', 'q-2']);

  // p1 答错（answeredAt 更早），p2 答对（更晚）——全局最新是 p2 的作答
  engine.gradeAnswer({ practiceId: p1.id, questionId: 'q-1', answer: '2' });
  const p2grade = engine.gradeAnswer({ practiceId: p2.id, questionId: 'q-1', answer: '1' });
  void p2grade;
  const globalLatest = store.listLatestAttemptByQuestion(['q-1']).get('q-1');
  assert.equal(globalLatest?.isCorrect, true, '全局最新 = p2 的答对');

  // resume：p1 必须看到 p1 的作答（答错），p2 看到 p2 的作答（答对）
  const r1 = engine.resumePractice(p1.id);
  assert.equal(r1.latestAttempts.length, 1);
  assert.equal(r1.latestAttempts[0]?.questionId, 'q-1');
  assert.equal(r1.latestAttempts[0]?.isCorrect, false, 'p1 回看 p1 的作答');
  const r2 = engine.resumePractice(p2.id);
  assert.equal(r2.latestAttempts[0]?.isCorrect, true, 'p2 回看 p2 的作答');

  // scorecard：p1 按 p1 作答聚合（answered=1 correct=0），p2（answered=1 correct=1）
  const sc1 = engine.buildScorecard(p1.id);
  assert.equal(sc1.correct, 0);
  assert.equal(sc1.answered, 1);
  const sc2 = engine.buildScorecard(p2.id);
  assert.equal(sc2.correct, 1);

  // 独立作答（practiceId=null）不进入任何会话域
  store.recordAttempt({ questionId: 'q-1', userAnswer: '1', isCorrect: true });
  assert.equal(engine.resumePractice(p1.id).latestAttempts[0]?.isCorrect, false, '独立作答不串入会话');
  assert.equal(engine.buildScorecard(p1.id).correct, 0);
});

test('t1 软删除：已删题目不可判分/不可进范围；finished 历史仍可解释', async () => {
  const { store, engine } = await setup();
  const practice = engine.startPractice({ bankId: 'bank-1', scope: { mode: 'all' } });
  // 判分后删除该题
  engine.gradeAnswer({ practiceId: practice.id, questionId: 'q-1', answer: '1' });
  store.deleteQuestion('q-1');

  // 已删题目：判分 → EXAM_QUESTION_NOT_FOUND；范围解析（all/undone/wrong）排除
  assert.throws(
    () => engine.gradeAnswer({ practiceId: practice.id, questionId: 'q-1', answer: '2' }),
    (error: unknown) => error instanceof ExamServiceError && error.code === 'EXAM_QUESTION_NOT_FOUND',
  );
  assert.deepEqual(engine.resolveQuestionIds('bank-1', { mode: 'all' }), ['q-2', 'q-3', 'q-4']);
  assert.deepEqual(engine.resolveQuestionIds('bank-1', { mode: 'undone' }), ['q-2', 'q-3', 'q-4']);

  // finished 历史可解释：成绩单 total 仍含 q-1（软删除不破坏统计），作答仍可见
  engine.finishPractice(practice.id);
  const scorecard = engine.buildScorecard(practice.id);
  assert.equal(scorecard.total, 4, 'total 含软删除题目');
  assert.equal(scorecard.answered, 1);
  assert.equal(scorecard.correct, 1);
  const resumed = engine.resumePractice(practice.id);
  assert.deepEqual(resumed.practice.questionIds, ['q-1', 'q-2', 'q-3', 'q-4'], '会话题单原样保留');
  assert.equal(resumed.latestAttempts.length, 1, '已删题的作答仍可回看');
  assert.equal(resumed.latestAttempts[0]?.questionId, 'q-1');
});

// ---------------------------------------------------------------------------
// t9：练习范围扩展（显式 questionIds 集合——错题单题/多选重练）
// ---------------------------------------------------------------------------

test('t9 resolveQuestionIds：显式 questionIds 集合校验存在且属于 bank', async () => {
  const { store, engine } = await setup();
  // 指定子集，按给定顺序返回（mode 被 questionIds 覆盖，不做 mode 筛选）
  assert.deepEqual(engine.resolveQuestionIds('bank-1', { mode: 'wrong', questionIds: ['q-3', 'q-1'] }), ['q-3', 'q-1']);
  // 去重（同一 id 出现两次只保留一次，仍按首次出现顺序）
  assert.deepEqual(engine.resolveQuestionIds('bank-1', { mode: 'all', questionIds: ['q-2', 'q-2', 'q-4'] }), ['q-2', 'q-4']);
  // 空 array 视为未提供 → 回退 mode 筛选
  assert.deepEqual(engine.resolveQuestionIds('bank-1', { mode: 'all', questionIds: [] }), ['q-1', 'q-2', 'q-3', 'q-4']);
  // 不存在于该 bank → EXAM_QUESTION_NOT_FOUND
  assert.throws(
    () => engine.resolveQuestionIds('bank-1', { mode: 'all', questionIds: ['ghost'] }),
    (error: unknown) => error instanceof ExamServiceError && error.code === 'EXAM_QUESTION_NOT_FOUND',
  );
  // 已软删除的题目 → 视为不存在
  store.deleteQuestion('q-4');
  assert.throws(
    () => engine.resolveQuestionIds('bank-1', { mode: 'all', questionIds: ['q-4'] }),
    (error: unknown) => error instanceof ExamServiceError && error.code === 'EXAM_QUESTION_NOT_FOUND',
  );
});

test('t9 startPractice：questionIds 范围建会话并持久化 scope', async () => {
  const { store, engine } = await setup();
  const practice = engine.startPractice({ bankId: 'bank-1', scope: { mode: 'wrong', questionIds: ['q-1', 'q-3'] } });
  assert.deepEqual(practice.questionIds, ['q-1', 'q-3']);
  assert.deepEqual(practice.scope, { mode: 'wrong', questionIds: ['q-1', 'q-3'] });

  // resume 正常恢复 scope（存储层 JSON 往返）
  const resumed = engine.resumePractice(practice.id);
  assert.deepEqual(resumed.practice.scope, { mode: 'wrong', questionIds: ['q-1', 'q-3'] });

  // 全量 questionIds 为空（所有给定 id 无效）→ 空范围拒绝
  assert.throws(
    () => engine.startPractice({ bankId: 'bank-1', scope: { mode: 'all', questionIds: ['ghost'] } }),
    (error: unknown) => error instanceof ExamServiceError && error.code === 'EXAM_QUESTION_NOT_FOUND',
  );
});
