/**
 * Phase 2 AI 能力层单元测试（Node 内置 node:test，fake llm 注入）。
 * 运行：node --test packages/dsh-exam/src/host/ai.test.ts
 * 覆盖：gradeEssay JSON 容错（围栏/首对象/解析失败/结构失败/onDelta 透传）、
 * parseImportedQuestions 输出校验（过滤/上限/全无效抛错）、buildTutorContext 组装、
 * generateDiagnosis / generateStudyPlan 解析（缺省与上限）。
 * 覆盖（Phase 4）：normalizeAnswerNorm 归一化（含 multiple 顺序无关）、
 * buildExplainMessages 两形态消息构造、explainOnce 流式封装（onDelta/maxTokens/空输出/中止）。
 * 覆盖（t7 可靠性纯函数）：EXPLAIN_PROMPT_VERSION、trimTutorHistory（完整轮次裁剪/
 * 最大消息数/无预算兜底/保序）、computeTutorInputBudget（消费 DSH 模型配置不限制输出）、
 * AiCallOptions.signal 透传（导入/诊断/计划 runOnce）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createExamLlm,
  createFakeLlmService,
  textDelta,
  finishStop,
  ExamLlmError,
  EXAM_LLM_STREAM_FAILED,
  EXAM_LLM_ABORTED,
} from './llm.ts';
import type { LlmGenerateOptions } from './llm-types.ts';
import {
  buildExplainMessages,
  buildTutorContext,
  computeTutorInputBudget,
  createAiEngine,
  estimateTokens,
  EXPLAIN_PROMPT_VERSION,
  EXPLAIN_SYSTEM,
  EXPLAIN_SYSTEM_DEEP,
  EXPLAIN_SYSTEM_GENERIC,
  normalizeAnswerNorm,
  trimTutorHistory,
  type ExplainContextDto,
  type TopicSuggestionSource,
} from './ai.ts';
import type { QuestionRow, TutorMessageRow } from './store.ts';
import type { InsightSummary } from './contract.ts';

/** fake llm：一次性返回给定文本。 */
function llmReturning(text: string) {
  return createExamLlm(
    createFakeLlmService(async function* () {
      yield textDelta(text);
      yield finishStop();
    }),
  );
}

const ESSAY_QUESTION: QuestionRow = {
  id: 'q-1',
  bankId: 'b-1',
  // t1：QuestionRow.type 即 StoredQuestionType（含 'essay'），不再需要运行时扩宽。
  type: 'essay',
  stem: '谈谈你对极限的理解',
  options: [],
  answer: null,
  explanation: null,
  tags: null,
  topics: null,
  topicsSource: null,
  createdAt: 1,
  updatedAt: 1,
  deletedAt: null,
};

const OBJECTIVE_QUESTION: QuestionRow = {
  id: 'q-2',
  bankId: 'b-1',
  type: 'single',
  stem: '1+1=?',
  options: ['A. 1', 'B. 2'],
  answer: 'B',
  explanation: '加法常识',
  tags: ['数学'],
  topics: ['算术'],
  topicsSource: 'manual',
  createdAt: 1,
  updatedAt: 1,
  deletedAt: null,
};

const BASE_GRADE = {
  question: ESSAY_QUESTION,
  userAnswer: '极限就是不断逼近。',
  provider: 'deepseek',
  model: 'deepseek-chat',
};

// ---------------------------------------------------------------------------
// gradeEssay
// ---------------------------------------------------------------------------

test('gradeEssay：```json 围栏输出解析成功，onDelta 透传原文', async () => {
  const raw = '```json\n{"score": 85, "verdict": "correct", "feedback": "论证充分", "reference": "极限的 ε-δ 定义"}\n```';
  const engine = createAiEngine(llmReturning(raw));
  const deltas: string[] = [];
  const result = await engine.gradeEssay(BASE_GRADE, (delta) => deltas.push(delta));
  assert.equal(result.score, 85);
  assert.equal(result.verdict, 'correct');
  assert.equal(result.feedback, '论证充分');
  assert.equal(result.reference, '极限的 ε-δ 定义');
  assert.equal(result.model, 'deepseek-chat');
  assert.deepEqual(deltas, [raw], 'onDelta 收到 LLM 原文');
});

test('gradeEssay：前文 prose + 首个 {…} 容错；reference 缺省省略', async () => {
  const engine = createAiEngine(llmReturning('好的，批改如下：\n{"score": 42, "verdict": "partial", "feedback": "有思路但缺步骤"}'));
  const result = await engine.gradeEssay(BASE_GRADE);
  assert.equal(result.score, 42);
  assert.equal(result.verdict, 'partial');
  assert.equal(result.feedback, '有思路但缺步骤');
  assert.ok(!('reference' in result), 'reference 缺省时不输出');
});

test('gradeEssay：无法解析的输出 → ExamLlmError(EXAM_LLM_STREAM_FAILED)', async () => {
  const engine = createAiEngine(llmReturning('抱歉，我无法完成批改。'));
  await assert.rejects(
    () => engine.gradeEssay(BASE_GRADE),
    (error: unknown) => error instanceof ExamLlmError && error.code === EXAM_LLM_STREAM_FAILED,
  );
});

test('gradeEssay：JSON 结构非法（缺 score / verdict 非法 / feedback 空）→ EXAM_LLM_STREAM_FAILED', async () => {
  for (const raw of [
    '{"verdict": "correct", "feedback": "x"}',
    '{"score": 88, "verdict": "excellent", "feedback": "x"}',
    '{"score": 101, "verdict": "correct", "feedback": "x"}',
    '{"score": 60.5, "verdict": "correct", "feedback": "x"}',
    '{"score": 60, "verdict": "correct", "feedback": "  "}',
  ]) {
    const engine = createAiEngine(llmReturning(raw));
    await assert.rejects(
      () => engine.gradeEssay(BASE_GRADE),
      (error: unknown) => error instanceof ExamLlmError && error.code === EXAM_LLM_STREAM_FAILED,
      `应拒绝输出：${raw}`,
    );
  }
});

test('gradeEssay：signal 透传底层 streamOnce，中止 → EXAM_LLM_ABORTED', async () => {
  let receivedSignal: AbortSignal | undefined;
  const llm = createExamLlm(
    createFakeLlmService(async function* (options: LlmGenerateOptions) {
      receivedSignal = options.signal;
      yield textDelta('{"score": 60, "verdict": "partial", "feedback": "x"}');
      // 等待中止（模拟 adapter 尊重 signal 的行为）。
      await new Promise<never>((_resolve, reject) => {
        const signal = options.signal;
        if (signal?.aborted) {
          reject(signal.reason ?? new Error('aborted'));
          return;
        }
        signal?.addEventListener('abort', () => reject(signal.reason ?? new Error('aborted')), {
          once: true,
        });
      });
    }),
  );
  const controller = new AbortController();
  const engine = createAiEngine(llm);
  const pending = engine.gradeEssay({ ...BASE_GRADE, signal: controller.signal });
  controller.abort();
  await assert.rejects(
    () => pending,
    (error: unknown) => error instanceof ExamLlmError && error.code === EXAM_LLM_ABORTED,
  );
  assert.ok(receivedSignal, '底层调用应收到 signal');
  assert.ok(receivedSignal!.aborted, '中止后底层 signal 应已 abort');
});

test('gradeEssay：调用前已中止 → fail-fast EXAM_LLM_ABORTED；未提供 signal 正常完成', async () => {
  const controller = new AbortController();
  controller.abort();
  const engine = createAiEngine(llmReturning('{"score": 90, "verdict": "correct", "feedback": "优秀"}'));
  await assert.rejects(
    () => engine.gradeEssay({ ...BASE_GRADE, signal: controller.signal }),
    (error: unknown) => error instanceof ExamLlmError && error.code === EXAM_LLM_ABORTED,
  );
  const result = await engine.gradeEssay(BASE_GRADE);
  assert.equal(result.score, 90);
  assert.equal(result.model, 'deepseek-chat');
});

// ---------------------------------------------------------------------------
// parseImportedQuestions
// ---------------------------------------------------------------------------

test('parseImportedQuestions：混合题型输出规范化（非法条目过滤）', async () => {
  const output = JSON.stringify([
    { type: 'single', stem: '1+1=?', options: ['A. 1', 'B. 2'], answer: 'B', explanation: '加法', tags: ['简单'] },
    { type: 'multiple', stem: '以下哪些是质数?', options: ['A. 2', 'B. 3', 'C. 4'], answer: ['A', 'B'] },
    { type: 'boolean', stem: '地球是圆的?', options: [], answer: 'true' },
    { type: 'essay', stem: '主观题不应出现', options: [], answer: null },
    { stem: '缺少 type' },
    { type: 'single', stem: '', options: ['A. x'], answer: 'A' },
  ]);
  const questions = await createAiEngine(llmReturning(output)).parseImportedQuestions('资料文本', {
    provider: 'p',
    model: 'm',
  });
  assert.equal(questions.length, 3);
  assert.deepEqual(questions[0], {
    type: 'single',
    stem: '1+1=?',
    options: ['A. 1', 'B. 2'],
    answer: 'B',
    explanation: '加法',
    tags: ['简单'],
  });
  assert.equal(questions[1]!.type, 'multiple');
  assert.deepEqual(questions[1]!.answer, ['A', 'B']);
  assert.equal(questions[2]!.type, 'boolean');
  assert.deepEqual(questions[2]!.options, []);
  assert.equal(questions[2]!.answer, 'true');
});

test('parseImportedQuestions：超过 8 条截断至 8 条', async () => {
  const items = Array.from({ length: 12 }, (_, i) => ({
    type: 'single',
    stem: `第${i + 1}题`,
    options: ['A. 对', 'B. 错'],
    answer: 'A',
  }));
  const questions = await createAiEngine(llmReturning(JSON.stringify(items))).parseImportedQuestions('x', {
    provider: 'p',
    model: 'm',
  });
  assert.equal(questions.length, 8);
  assert.equal(questions[0]!.stem, '第1题');
  assert.equal(questions[7]!.stem, '第8题');
});

test('parseImportedQuestions：全无效 → ExamLlmError(EXAM_LLM_STREAM_FAILED)', async () => {
  const engine = createAiEngine(llmReturning('[{"type": "essay", "stem": "x", "options": [], "answer": null}]'));
  await assert.rejects(
    () => engine.parseImportedQuestions('x', { provider: 'p', model: 'm' }),
    (error: unknown) => error instanceof ExamLlmError && error.code === EXAM_LLM_STREAM_FAILED,
  );
});

// ---------------------------------------------------------------------------
// buildTutorContext
// ---------------------------------------------------------------------------

const HISTORY: TutorMessageRow[] = [
  { id: 'm1', sessionId: 's-1', role: 'user', content: '第一步怎么做？', createdAt: 1 },
  { id: 'm2', sessionId: 's-1', role: 'assistant', content: '先看题干条件。', createdAt: 2 },
];

test('buildTutorContext：system + 题目上下文 + 历史轮次 + 新提问', () => {
  const messages = buildTutorContext(OBJECTIVE_QUESTION, 'B', HISTORY, '为什么选 B？');
  assert.equal(messages.length, 5, 'system + 题目 + 历史2条 + 新提问');
  assert.equal(messages[0]!.role, 'system');
  assert.ok(messages[0]!.content[0]!.type === 'text' && messages[0]!.content[0]!.text.includes('讲题助手'));

  const questionBlock = messages[1]!.content[0]! as { type: 'text'; text: string };
  assert.equal(messages[1]!.role, 'user');
  assert.ok(questionBlock.text.includes('1+1=?'), '含题干');
  assert.ok(questionBlock.text.includes('A. 1'), '含选项');
  assert.ok(questionBlock.text.includes('参考答案'), '含参考答案');
  assert.ok(questionBlock.text.includes('我的作答'), '含学生作答');

  assert.equal(messages[2]!.role, 'user');
  assert.equal((messages[2]!.content[0]! as { text: string }).text, '第一步怎么做？', '历史轮次原样拼入');
  assert.equal(messages[3]!.role, 'assistant');
  assert.equal((messages[3]!.content[0]! as { text: string }).text, '先看题干条件。');
  assert.equal(messages[4]!.role, 'user');
  assert.equal((messages[4]!.content[0]! as { text: string }).text, '为什么选 B？', '最后一轮为新提问');
});

test('buildTutorContext：essay 题无参考答案、无作答时不渲染对应行', () => {
  const messages = buildTutorContext(ESSAY_QUESTION, null, [], '讲讲思路');
  assert.equal(messages.length, 3, 'system + 题目 + 新提问');
  const questionBlock = (messages[1]!.content[0]! as { text: string }).text;
  assert.ok(questionBlock.includes('谈谈你对极限的理解'));
  assert.ok(!questionBlock.includes('参考答案'), 'answer=null 不渲染参考答案');
  assert.ok(!questionBlock.includes('我的作答'), '无作答不渲染学生作答');
  assert.equal(messages[2]!.role, 'user');
});

// ---------------------------------------------------------------------------
// generateDiagnosis / generateStudyPlan
// ---------------------------------------------------------------------------

const INSIGHT: InsightSummary = {
  windowDays: 7,
  totalAttempts: 10,
  correctAttempts: 6,
  accuracy: 0.6,
  daily: [],
  byType: {},
  wrongTop: [],
  finishedPractices: 2,
  weakTypes: ['multiple'],
  firstAttemptAccuracy: 0.6,
  currentMastery: 0.7,
  coverage: 0.5,
  accuracyWindow: 0.6,
  streakDays: 2,
  weakTags: [],
  weakTopics: [],
};

test('generateDiagnosis：解析为 { summary, weaknesses, suggestions }（建议兼容字符串与结构化）', async () => {
  const engine = createAiEngine(
    llmReturning(
      '```json\n{"summary": "整体中等偏上", "weaknesses": ["计算粗心"], "suggestions": ["每日一练", {"text": "多选题薄弱", "action": {"mode": "byType", "type": "multiple"}}, {"text": "重练错题", "action": {"mode": "wrong"}}]}\n```',
    ),
  );
  const diagnosis = await engine.generateDiagnosis(INSIGHT, { provider: 'p', model: 'm' });
  assert.deepEqual(diagnosis, {
    summary: '整体中等偏上',
    weaknesses: ['计算粗心'],
    suggestions: [
      { text: '每日一练' },
      { text: '多选题薄弱', action: { mode: 'byType', type: 'multiple' } },
      { text: '重练错题', action: { mode: 'wrong' } },
    ],
  });
});

test('generateDiagnosis：缺失 weaknesses/suggestions 缺省为空数组；解析失败抛错', async () => {
  const engine = createAiEngine(llmReturning('{"summary": "只有概述"}'));
  const diagnosis = await engine.generateDiagnosis(INSIGHT, { provider: 'p', model: 'm' });
  assert.deepEqual(diagnosis, { summary: '只有概述', weaknesses: [], suggestions: [] });

  const bad = createAiEngine(llmReturning('{"weaknesses": ["x"]}'));
  await assert.rejects(
    () => bad.generateDiagnosis(INSIGHT, { provider: 'p', model: 'm' }),
    (error: unknown) => error instanceof ExamLlmError && error.code === EXAM_LLM_STREAM_FAILED,
  );
});

test('generateStudyPlan：{ title, note? } 解析；无效条目过滤', async () => {
  const engine = createAiEngine(
    llmReturning(JSON.stringify([
      { title: '复习第一章', note: '重点：极限' },
      { title: '刷错题本' },
      { title: '  ' },
      'junk',
      { title: '做模拟卷', note: 123 },
    ])),
  );
  const drafts = await engine.generateStudyPlan(INSIGHT, { provider: 'p', model: 'm' });
  assert.deepEqual(drafts, [
    { title: '复习第一章', note: '重点：极限' },
    { title: '刷错题本' },
  ]);
});

test('generateStudyPlan：超过 7 条截断；全无效抛错', async () => {
  const items = Array.from({ length: 9 }, (_, i) => ({ title: `计划${i + 1}` }));
  const engine = createAiEngine(llmReturning(JSON.stringify(items)));
  const drafts = await engine.generateStudyPlan(INSIGHT, { provider: 'p', model: 'm' });
  assert.equal(drafts.length, 7);
  assert.equal(drafts[0]!.title, '计划1');

  const empty = createAiEngine(llmReturning('[]'));
  await assert.rejects(
    () => empty.generateStudyPlan(INSIGHT, { provider: 'p', model: 'm' }),
    (error: unknown) => error instanceof ExamLlmError && error.code === EXAM_LLM_STREAM_FAILED,
  );
});

// ---------------------------------------------------------------------------
// Phase 4：normalizeAnswerNorm（解析缓存键归一化）
// ---------------------------------------------------------------------------

const MULTIPLE_QUESTION: QuestionRow = {
  id: 'q-3',
  bankId: 'b-1',
  type: 'multiple',
  stem: '以下哪些是质数？',
  options: ['A. 2', 'B. 3', 'C. 4'],
  answer: ['A', 'B'],
  explanation: null,
  tags: ['数论', '质数'],
  topics: null,
  topicsSource: null,
  createdAt: 1,
  updatedAt: 1,
  deletedAt: null,
};

test('normalizeAnswerNorm：single 字母/数字标识 → 索引串，未识别标识原样保留', () => {
  assert.equal(normalizeAnswerNorm('single', 'A'), '0');
  assert.equal(normalizeAnswerNorm('single', 'C'), '2');
  assert.equal(normalizeAnswerNorm('single', 'Z'), '25');
  assert.equal(normalizeAnswerNorm('single', '3'), '3');
  assert.equal(normalizeAnswerNorm('single', 'x'), 'x', '无法解析索引的标识原样作为键');
});

test('normalizeAnswerNorm：boolean 双态归一（接受原生布尔与字符串）', () => {
  assert.equal(normalizeAnswerNorm('boolean', true), 'true');
  assert.equal(normalizeAnswerNorm('boolean', 'true'), 'true');
  assert.equal(normalizeAnswerNorm('boolean', false), 'false');
  assert.equal(normalizeAnswerNorm('boolean', 'false'), 'false');
});

test('normalizeAnswerNorm：multiple 索引升序逗号串，顺序无关 + 去重 + 数值序', () => {
  assert.equal(normalizeAnswerNorm('multiple', ['A']), '0');
  assert.equal(normalizeAnswerNorm('multiple', ['C', 'A']), '0,2');
  assert.equal(
    normalizeAnswerNorm('multiple', ['A', 'C']),
    normalizeAnswerNorm('multiple', ['C', 'A']),
    '顺序无关',
  );
  assert.equal(normalizeAnswerNorm('multiple', ['A', 'A', 'C']), '0,2', '去重（集合语义同判分）');
  assert.equal(normalizeAnswerNorm('multiple', ['10', '2']), '2,10', '按数值序而非字典序');
});

test('normalizeAnswerNorm：非法编码走 json: 兜底且互不碰撞', () => {
  assert.equal(normalizeAnswerNorm('single', 42), 'json:42');
  assert.equal(normalizeAnswerNorm('single', 42), normalizeAnswerNorm('single', 42), '确定性');
  assert.notEqual(
    normalizeAnswerNorm('single', 42),
    normalizeAnswerNorm('single', '42'),
    '数字 42 与字符串 "42" 判分语义不同，键不得碰撞',
  );
  assert.equal(normalizeAnswerNorm('boolean', 'yes'), 'json:"yes"');
  assert.equal(normalizeAnswerNorm('multiple', []), 'json:[]');
  assert.equal(normalizeAnswerNorm('multiple', ['A', 3]), 'json:["A",3]', '含非法元素整体兜底');
  assert.notEqual(normalizeAnswerNorm('boolean', 'yes'), '', '兜底键不与 G 形态空键冲突');
});

// ---------------------------------------------------------------------------
// Phase 4：buildExplainMessages（两形态消息构造）
// ---------------------------------------------------------------------------

test('buildExplainMessages：personalized 注入作答+判定，system 为完整四节结构', () => {
  const messages = buildExplainMessages(OBJECTIVE_QUESTION, {
    mode: 'personalized',
    userAnswer: 'A',
    isCorrect: false,
  });
  assert.equal(messages.length, 2, 'system + user 题目上下文');

  const system = (messages[0]!.content[0]! as { type: 'text'; text: string }).text;
  assert.equal(messages[0]!.role, 'system');
  assert.equal(system, EXPLAIN_SYSTEM);
  assert.ok(system.includes('【你的作答分析】'), 'P 形态含作答分析节');
  assert.ok(system.includes('纯文本') && system.includes('400 字软引导'), '纯文本与长度软引导在提示词内');
  assert.ok(!system.includes('350 字'), '浅档不再设硬字数上限');

  const user = (messages[1]!.content[0]! as { type: 'text'; text: string }).text;
  assert.ok(user.startsWith('题型：单选'));
  assert.ok(user.includes('题干：1+1=?'));
  assert.ok(user.includes('- A. 1'), '选项列表逐行渲染');
  assert.ok(user.includes('标准答案："B"'));
  assert.ok(user.includes('学生作答：A'));
  assert.ok(user.includes('判定结果：错误'));
  assert.ok(user.includes('标签：数学'));
});

test('buildExplainMessages：personalized 支持数组作答（multiple）渲染为 JSON', () => {
  const messages = buildExplainMessages(MULTIPLE_QUESTION, {
    mode: 'personalized',
    userAnswer: ['C', 'A'],
    isCorrect: true,
  });
  const user = (messages[1]!.content[0]! as { text: string }).text;
  assert.ok(user.includes('题型：多选'));
  assert.ok(user.includes('学生作答：["C","A"]'));
  assert.ok(user.includes('判定结果：正确'));
  assert.ok(user.includes('标签：数论, 质数'));
});

test('buildExplainMessages：generic 省略作答行，system 无【你的作答分析】节', () => {
  const messages = buildExplainMessages(MULTIPLE_QUESTION, { mode: 'generic' });
  assert.equal(messages.length, 2);

  const system = (messages[0]!.content[0]! as { type: 'text'; text: string }).text;
  assert.equal(messages[0]!.role, 'system');
  assert.equal(system, EXPLAIN_SYSTEM_GENERIC);
  assert.ok(!system.includes('你的作答分析'), 'G 形态省略该节');
  assert.ok(system.includes('【考点】') && system.includes('【易错提示】'));

  const user = (messages[1]!.content[0]! as { text: string }).text;
  assert.ok(!user.includes('学生作答'), 'G 形态不传作答');
  assert.ok(!user.includes('判定结果'));
  assert.ok(user.includes('标准答案：["A","B"]'));
  assert.ok(user.includes('题干：以下哪些是质数？'));
});

test('buildExplainMessages：personalized 缺作答或缺判定 → 抛错（编程期契约）', () => {
  assert.throws(() =>
    buildExplainMessages(OBJECTIVE_QUESTION, {
      mode: 'personalized',
      userAnswer: undefined,
      isCorrect: true,
    } as never),
  );
  assert.throws(() =>
    buildExplainMessages(OBJECTIVE_QUESTION, {
      mode: 'personalized',
      userAnswer: 'A',
      isCorrect: undefined as never,
    }),
  );
});

test('buildExplainMessages：deep 档选 EXPLAIN_SYSTEM_DEEP 且注入个性化上下文；浅档不注入', () => {
  const context: ExplainContextDto = {
    wrongCountOnQuestion: 2,
    topicAccuracy: [{ topic: '算术', answered: 5, correct: 3, accuracy: 0.6 }],
    similarStems: ['1+2=?', '2+2=?'],
  };
  const deep = buildExplainMessages(OBJECTIVE_QUESTION, {
    mode: 'personalized',
    userAnswer: 'A',
    isCorrect: false,
    depth: 'deep',
    context,
  });
  const deepSystem = (deep[0]!.content[0]! as { type: 'text'; text: string }).text;
  assert.equal(deep[0]!.role, 'system');
  assert.equal(deepSystem, EXPLAIN_SYSTEM_DEEP, 'deep 档选中深档提示词');
  assert.ok(deepSystem.includes('【思路拆解】') && deepSystem.includes('【易错陷阱】'), '深档五节结构');
  assert.ok(deepSystem.includes('{"topics"'), '深档提示词要求末尾输出 JSON topics');// "{"topics"" 字样
  const deepUser = (deep[1]!.content[0]! as { type: 'text'; text: string }).text;
  assert.ok(deepUser.includes('个性化上下文：'), 'deep 档注入上下文段');
  assert.ok(deepUser.includes('该题历史答错 2 次'));
  assert.ok(deepUser.includes('知识点「算术」正确率 60%'));
  assert.ok(deepUser.includes('作答 5 题，对 3 题'));
  assert.ok(deepUser.includes('相似题：「1+2=?」、「2+2=?」'));
  assert.ok(deepUser.includes('知识点：算术'), '题目渲染注入知识点行');

  const light = buildExplainMessages(OBJECTIVE_QUESTION, {
    mode: 'personalized',
    userAnswer: 'A',
    isCorrect: false,
  });
  const lightSystem = (light[0]!.content[0]! as { type: 'text'; text: string }).text;
  assert.equal(lightSystem, EXPLAIN_SYSTEM, '浅档缺省选中浅档提示词');
  const lightUser = (light[1]!.content[0]! as { type: 'text'; text: string }).text;
  assert.ok(!lightUser.includes('个性化上下文：'), '浅档不注入个性化上下文');
});

test('buildExplainMessages：deep 档无 context 时不注入上下文段（缺省容忍）', () => {
  const deep = buildExplainMessages(OBJECTIVE_QUESTION, {
    mode: 'personalized',
    userAnswer: 'A',
    isCorrect: false,
    depth: 'deep',
  });
  const deepSystem = (deep[0]!.content[0]! as { type: 'text'; text: string }).text;
  assert.equal(deepSystem, EXPLAIN_SYSTEM_DEEP);
  const deepUser = (deep[1]!.content[0]! as { type: 'text'; text: string }).text;
  assert.ok(!deepUser.includes('个性化上下文：'), '无 context 则不注入');
});

// ---------------------------------------------------------------------------
// Phase 4：explainOnce（流式解析封装）
// ---------------------------------------------------------------------------

/** fake llm：一次性返回给定文本并捕获底层调用 options。 */
function llmCapturing(text: string) {
  let captured: LlmGenerateOptions | undefined;
  const engine = createAiEngine(
    createExamLlm(
      createFakeLlmService(async function* (options: LlmGenerateOptions) {
        captured = options;
        yield textDelta(text);
        yield finishStop();
      }),
    ),
  );
  return { engine, getOptions: () => captured };
}

test('explainOnce：流式输出透传 onDelta，不设 maxTokens（交给 DSH 复用模型配置）', async () => {
  const raw = '【正确答案解析】因为 1+1=2。\n\n【你的作答分析】选 A 混淆了进位。\n\n【考点】加法\n\n【易错提示】看清运算符';
  const { engine, getOptions } = llmCapturing(raw);
  const deltas: string[] = [];
  const result = await engine.explainOnce(
    {
      question: OBJECTIVE_QUESTION,
      mode: 'personalized',
      userAnswer: 'A',
      isCorrect: false,
      provider: 'deepseek',
      model: 'deepseek-chat',
    },
    (delta) => deltas.push(delta),
  );
  assert.equal(result.content, raw);
  assert.equal(result.model, 'deepseek-chat');
  assert.deepEqual(deltas, [raw], 'onDelta 收到 LLM 原文');

  const options = getOptions();
  assert.equal(options?.provider, 'deepseek');
  assert.equal(options?.model, 'deepseek-chat');
  assert.equal(options?.maxTokens, undefined, '不设 maxTokens：DSH 按模型配置材质化默认上限');
  assert.equal(options!.messages[0]!.role, 'system', '消息首条为 system 提示词');
});

test('explainOnce：思考档位/off/缺省均不设 maxTokens，仅透传 reasoningEffort', async () => {
  const reasoning = llmCapturing('【正确答案解析】思考档位解析。');
  await reasoning.engine.explainOnce({
    question: OBJECTIVE_QUESTION,
    mode: 'personalized',
    userAnswer: 'A',
    isCorrect: false,
    provider: 'p',
    model: 'm',
    reasoningEffort: 'max',
  });
  assert.equal(reasoning.getOptions()?.maxTokens, undefined, '思考档位不设 maxTokens');
  assert.equal(reasoning.getOptions()?.reasoningEffort, 'max', '思考档位透传');

  const off = llmCapturing('【正确答案解析】off 档。');
  await off.engine.explainOnce({
    question: OBJECTIVE_QUESTION,
    mode: 'personalized',
    userAnswer: 'A',
    isCorrect: false,
    provider: 'p',
    model: 'm',
    reasoningEffort: 'off',
  });
  assert.equal(off.getOptions()?.maxTokens, undefined, 'off 档不设 maxTokens');
  assert.equal(off.getOptions()?.reasoningEffort, 'off', 'off 档透传');

  const bare = llmCapturing('【正确答案解析】默认档。');
  await bare.engine.explainOnce({
    question: OBJECTIVE_QUESTION,
    mode: 'personalized',
    userAnswer: 'A',
    isCorrect: false,
    provider: 'p',
    model: 'm',
  });
  assert.equal(bare.getOptions()?.maxTokens, undefined, '未指定思考档位不设 maxTokens');
  assert.equal(bare.getOptions()?.reasoningEffort, undefined, '未指定思考档位不传 reasoningEffort');
});

test('explainOnce：deep 档透传 maxTokens + reasoningEffort，浅档不设 maxTokens', async () => {
  const deep = llmCapturing('【思路拆解】深档解析。');
  await deep.engine.explainOnce({
    question: OBJECTIVE_QUESTION,
    mode: 'personalized',
    userAnswer: 'A',
    isCorrect: false,
    provider: 'p',
    model: 'm',
    depth: 'deep',
    reasoningEffort: 'high',
    maxTokens: 3000,
  });
  assert.equal(deep.getOptions()?.maxTokens, 3000, '深档显式 maxTokens 透传 GenerateOptions');
  assert.equal(deep.getOptions()?.reasoningEffort, 'high', '深档高思考档透传');
  const deepSystem = (deep.getOptions()!.messages[0]!.content[0]! as { type: 'text'; text: string }).text;
  assert.equal(deepSystem, EXPLAIN_SYSTEM_DEEP, '深档选中深档提示词');

  const shallow = llmCapturing('【正确答案解析】浅档。');
  await shallow.engine.explainOnce({
    question: OBJECTIVE_QUESTION,
    mode: 'personalized',
    userAnswer: 'A',
    isCorrect: false,
    provider: 'p',
    model: 'm',
  });
  assert.equal(shallow.getOptions()?.maxTokens, undefined, '浅档不设 maxTokens');
});

test('parseTopicSuggestions：批量生成、规范化去重、缺失兜底 [首个 tag] / 无 tag → []', async () => {
  const engine = createAiEngine(
    llmReturning(
      JSON.stringify([
        { index: 0, topics: [' 架构治理 ', '数据架构'] },
        { index: 1, topics: [] },
        { index: 2, topics: ['  ', ''] },
        { index: 3, topics: ['识别 架构 领域', '识别架构领域'] },
      ]),
    ),
  );
  const sources: TopicSuggestionSource[] = [
    { questionId: 'q1', stem: '题干1', currentTopics: null, currentTags: ['togaf'] },
    { questionId: 'q2', stem: '题干2', currentTopics: null, currentTags: ['架构'] },
    { questionId: 'q3', stem: '题干3', currentTopics: null, currentTags: ['数据'] },
    { questionId: 'q4', stem: '题干4', currentTopics: null, currentTags: ['主题A', '主题B'] },
    { questionId: 'q5', stem: '题干5', currentTopics: null, currentTags: [] },
  ];
  const result = await engine.parseTopicSuggestions(sources, { provider: 'p', model: 'm' });
  assert.equal(result.length, 5, '逐题输出，LLM 缺失 index 也回退');
  assert.deepEqual(result[0]!.suggestedTopics, ['架构治理', '数据架构'], '规范化+去重');
  assert.deepEqual(result[1]!.suggestedTopics, ['架构'], '空 topics 回退 [首个 tag]');
  assert.deepEqual(result[2]!.suggestedTopics, ['数据'], '全空字符串回退 [首个 tag]');
  assert.deepEqual(result[3]!.suggestedTopics, ['识别架构领域'], '去空白+去重');
  assert.deepEqual(result[4]!.suggestedTopics, [], '无 tag 且 LLM 未给出 → []');
  assert.equal(result[0]!.questionId, 'q1');
  assert.equal(result[0]!.stem, '题干1');
  assert.equal(result[0]!.currentTags?.join(','), 'togaf');
});

test('parseTopicSuggestions：整批解析失败 → 全部回退兜底，不抛错', async () => {
  const engine = createAiEngine(llmReturning('抱歉，无法标注。'));
  const sources: TopicSuggestionSource[] = [
    { questionId: 'q1', stem: '题干1', currentTopics: null, currentTags: ['tag-a'] },
    { questionId: 'q2', stem: '题干2', currentTopics: null, currentTags: [] },
  ];
  const result = await engine.parseTopicSuggestions(sources, { provider: 'p', model: 'm' });
  assert.deepEqual(result[0]!.suggestedTopics, ['tag-a'], '解析失败回退 [首个 tag]');
  assert.deepEqual(result[1]!.suggestedTopics, [], '解析失败且无 tag → []');
});

test('explainOnce：generic 形态走 GENERIC 提示词；空输出 → EXAM_LLM_STREAM_FAILED', async () => {
  const ok = llmCapturing('【正确答案解析】2 是质数。');
  const genericResult = await ok.engine.explainOnce({
    question: MULTIPLE_QUESTION,
    mode: 'generic',
    provider: 'p',
    model: 'm-1',
  });
  assert.equal(genericResult.content, '【正确答案解析】2 是质数。');
  const systemText = (ok.getOptions()!.messages[0]!.content[0]! as { type: 'text'; text: string }).text;
  assert.ok(systemText.includes('根据题目与标准答案'), 'G 形态系统提示词生效');
  const genericUserText = (ok.getOptions()!.messages[1]!.content[0]! as { type: 'text'; text: string }).text;
  assert.ok(!genericUserText.includes('学生作答'), 'G 形态不渲染作答行');

  const blank = llmCapturing('   ');
  await assert.rejects(
    () =>
      blank.engine.explainOnce({
        question: MULTIPLE_QUESTION,
        mode: 'generic',
        provider: 'p',
        model: 'm',
      }),
    (error: unknown) => error instanceof ExamLlmError && error.code === EXAM_LLM_STREAM_FAILED,
  );
});

test('explainOnce：personalized 缺 isCorrect → 抛错；调用前已中止 → EXAM_LLM_ABORTED', async () => {
  const missingVerdict = createAiEngine(llmReturning('x'));
  await assert.rejects(
    () =>
      missingVerdict.explainOnce({
        question: OBJECTIVE_QUESTION,
        mode: 'personalized',
        userAnswer: 'A',
        provider: 'p',
        model: 'm',
      }),
    /requires userAnswer and isCorrect/,
  );

  const controller = new AbortController();
  controller.abort();
  const aborted = createAiEngine(llmReturning('x'));
  await assert.rejects(
    () =>
      aborted.explainOnce({
        question: OBJECTIVE_QUESTION,
        mode: 'personalized',
        userAnswer: 'A',
        isCorrect: true,
        provider: 'p',
        model: 'm',
        signal: controller.signal,
      }),
    (error: unknown) => error instanceof ExamLlmError && error.code === EXAM_LLM_ABORTED,
  );
});

// ---------------------------------------------------------------------------
// t7：可靠性纯函数 —— EXPLAIN_PROMPT_VERSION / token 估计 / 输入预算 / 历史裁剪
// ---------------------------------------------------------------------------

/** 构造一条 Tutor 消息（测试辅助）。 */
function tutorMsg(id: string, role: 'user' | 'assistant', content: string, createdAt = 0): TutorMessageRow {
  return { id, sessionId: 's-1', role, content, createdAt };
}

/** 构造 n 个完整轮次（user+assistant 交替，id 为 u1/a1…；createdAt 递增）。 */
function tutorTurns(n: number): TutorMessageRow[] {
  const messages: TutorMessageRow[] = [];
  for (let i = 1; i <= n; i++) {
    messages.push(tutorMsg(`u${i}`, 'user', `轮次${i}-user`, i * 2 - 1));
    messages.push(tutorMsg(`a${i}`, 'assistant', `轮次${i}-assistant`, i * 2));
  }
  return messages;
}

test('EXPLAIN_PROMPT_VERSION：导出且当前为 2（A 提示词两档重写，存量缓存失效）', () => {
  assert.equal(EXPLAIN_PROMPT_VERSION, 2);
});

test('estimateTokens：默认 1 字符 ≈ 1 token（向上取整）', () => {
  assert.equal(estimateTokens(''), 0);
  assert.equal(estimateTokens('abc'), 3);
  assert.equal(estimateTokens('中文内容'), 4);
});

test('computeTutorInputBudget：contextWindow − 输出预留 − 安全余量', () => {
  // 显式 defaultMaxTokens：8000 − 2000 − 512。
  assert.equal(computeTutorInputBudget({ contextWindow: 8000, defaultMaxTokens: 2000 }), 5488);
  // defaultMaxTokens 缺省：按 contextWindow/4（2000）预留（≤4096 上限）。
  assert.equal(computeTutorInputBudget({ contextWindow: 8000 }), 5488);
  // contextWindow 更大时缺省预留取 min(4096, floor(16000/4)=4000) = 4000。
  assert.equal(computeTutorInputBudget({ contextWindow: 16_000 }), 16_000 - 4000 - 512);
  // defaultMaxTokens 显式时原样使用（不自行裁剪模型配置）：16000 − 5000 − 512。
  assert.equal(computeTutorInputBudget({ contextWindow: 16_000, defaultMaxTokens: 5000 }), 16_000 - 5000 - 512);
});

test('computeTutorInputBudget：无法预算/预算 ≤0 → undefined（调用方兜底）', () => {
  assert.equal(computeTutorInputBudget(undefined), undefined);
  assert.equal(computeTutorInputBudget({}), undefined, 'contextWindow 缺失');
  assert.equal(computeTutorInputBudget({ contextWindow: 0 }), undefined, 'contextWindow 非正');
  assert.equal(computeTutorInputBudget({ contextWindow: -1 }), undefined);
  assert.equal(computeTutorInputBudget({ defaultMaxTokens: 2000 }), undefined, '仅 defaultMaxTokens 无法预算');
  assert.equal(computeTutorInputBudget({ contextWindow: 500 }), undefined, '500−125−512 ≤0 → undefined');
  assert.equal(
    computeTutorInputBudget({ contextWindow: 8000, defaultMaxTokens: 10_000 }),
    undefined,
    'defaultMaxTokens 不小于窗口时无法预算（模型配置矛盾，调用方退回兜底裁剪，不自行限制）',
  );
});

test('trimTutorHistory：空历史与预算充足时全保留、保序', () => {
  assert.deepEqual(trimTutorHistory([]), [], '空历史');
  const history = tutorTurns(3);
  const trimmed = trimTutorHistory(history, { maxHistoryTokens: 10_000 });
  assert.deepEqual(trimmed, history, '预算充足全保留');
  assert.deepEqual(
    trimmed.map((m) => m.id),
    ['u1', 'a1', 'u2', 'a2', 'u3', 'a3'],
    '保序（旧 → 新）',
  );
});

test('trimTutorHistory：预算按完整轮次裁剪，最新轮优先保留', () => {
  // 每消息 10 字符（estimateTokens 默认 1 字符/token）→ 每轮 20 token。
  const history = tutorTurns(5).map((m) => ({ ...m, content: 'x'.repeat(10) }));
  // 预算 50：最新轮（20）+ 次新轮（20）= 40 ≤ 50；第 3 轮加入 = 60 > 50 → 停。
  const trimmed = trimTutorHistory(history, { maxHistoryTokens: 50 });
  assert.deepEqual(
    trimmed.map((m) => m.id),
    ['u4', 'a4', 'u5', 'a5'],
    '保留最新 2 个完整轮次，不拆散轮次',
  );
  // 预算恰好等于 2 轮：40 ≤ 40 全保留。
  const exact = trimTutorHistory(history, { maxHistoryTokens: 40 });
  assert.deepEqual(exact.map((m) => m.id), ['u4', 'a4', 'u5', 'a5']);
});

test('trimTutorHistory：最新一轮单独超预算仍保留（尽力而为）', () => {
  const history = tutorTurns(3).map((m) => ({ ...m, content: 'x'.repeat(100) })); // 每轮 200 token
  const trimmed = trimTutorHistory(history, { maxHistoryTokens: 50 });
  assert.deepEqual(trimmed.map((m) => m.id), ['u3', 'a3'], '仅最新一轮');
});

test('trimTutorHistory：maxMessages 硬上限（预算充足时仍截尾）', () => {
  const history = tutorTurns(10); // 20 条
  const trimmed = trimTutorHistory(history, { maxHistoryTokens: 10_000, maxMessages: 6 });
  assert.deepEqual(trimmed.map((m) => m.id), ['u8', 'a8', 'u9', 'a9', 'u10', 'a10'], '取最近 6 条');
});

test('trimTutorHistory：无预算兜底保留最近 maxMessages 条（保序）', () => {
  const history = tutorTurns(40); // 80 条
  const trimmed = trimTutorHistory(history); // 缺省 maxMessages=60
  assert.equal(trimmed.length, 60);
  assert.equal(trimmed[0]!.id, 'u11', '80−60=20 → 从第 11 轮首条起');
  assert.equal(trimmed[trimmed.length - 1]!.id, 'a40', '尾部保留');

  const custom = trimTutorHistory(history, { maxMessages: 4 });
  assert.deepEqual(custom.map((m) => m.id), ['u39', 'a39', 'u40', 'a40'], '自定义条数');
});

test('trimTutorHistory：自定义 estimateTokens 生效', () => {
  const history = tutorTurns(4);
  // 每条恒定 1 token → 每轮 2 token；预算 4 = 最新 2 轮。
  const trimmed = trimTutorHistory(history, { maxHistoryTokens: 4, estimateTokens: () => 1 });
  assert.deepEqual(trimmed.map((m) => m.id), ['u3', 'a3', 'u4', 'a4']);
});

test('trimTutorHistory：孤儿 assistant 并入前组；末尾未完成 user 自成最新轮', () => {
  const history: TutorMessageRow[] = [
    tutorMsg('a0', 'assistant', '孤立回复'), // 历史以 assistant 开头
    tutorMsg('u1', 'user', '提问1'),
    tutorMsg('a1', 'assistant', '回答1'),
    tutorMsg('u2', 'user', '提问2（未回复）'),
  ];
  const opts = { estimateTokens: () => 1 }; // 每条 1 token
  // 预算 1：最新组 = [u2]（未完成轮）保留。
  assert.deepEqual(trimTutorHistory(history, { maxHistoryTokens: 1, ...opts }).map((m) => m.id), ['u2']);
  // 预算 3：u2(1) + [u1,a1](2) = 3 ≤ 3 → 两组合保留。
  assert.deepEqual(trimTutorHistory(history, { maxHistoryTokens: 3, ...opts }).map((m) => m.id), ['u1', 'a1', 'u2']);
  // 预算 4：再加孤儿组 [a0](1) = 4 ≤ 4 → 全保留（孤儿并入逻辑不丢消息）。
  assert.deepEqual(trimTutorHistory(history, { maxHistoryTokens: 4, ...opts }).map((m) => m.id), ['a0', 'u1', 'a1', 'u2']);
});

// ---------------------------------------------------------------------------
// t7：AiCallOptions.signal 透传（导入/诊断/计划 runOnce；t5 JSON 端点取消预留）
// ---------------------------------------------------------------------------

test('AiCallOptions.signal：调用前已中止 → 三个 runOnce 路径均抛 EXAM_LLM_ABORTED', async () => {
  const controller = new AbortController();
  controller.abort();
  const engine = createAiEngine(llmReturning('[]'));
  await assert.rejects(
    () => engine.parseImportedQuestions('x'.repeat(50), { provider: 'p', model: 'm', signal: controller.signal }),
    (error: unknown) => error instanceof ExamLlmError && error.code === EXAM_LLM_ABORTED,
  );
  await assert.rejects(
    () => engine.generateDiagnosis(INSIGHT, { provider: 'p', model: 'm', signal: controller.signal }),
    (error: unknown) => error instanceof ExamLlmError && error.code === EXAM_LLM_ABORTED,
  );
  await assert.rejects(
    () => engine.generateStudyPlan(INSIGHT, { provider: 'p', model: 'm', signal: controller.signal }),
    (error: unknown) => error instanceof ExamLlmError && error.code === EXAM_LLM_ABORTED,
  );
});

test('AiCallOptions.signal：未中止时合并进底层调用，中止后传播到底层（合并信号）', async () => {
  const controller = new AbortController();
  let capturedSignal: AbortSignal | undefined;
  const engine = createAiEngine(
    createExamLlm(
      createFakeLlmService(async function* (options: LlmGenerateOptions) {
        capturedSignal = options.signal;
        // 模拟真实 adapter：挂起直到信号中止（证明调用方 signal 被合并进底层）。
        await new Promise<void>((_resolve, reject) => {
          if (options.signal?.aborted) {
            reject(new DOMException('aborted', 'AbortError'));
            return;
          }
          options.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), {
            once: true,
          });
        });
        yield textDelta('[]');
        yield finishStop();
      }),
    ),
  );
  const pending = engine.parseImportedQuestions('x'.repeat(50), {
    provider: 'p',
    model: 'm',
    signal: controller.signal,
  });
  // fake llm 的首个 next() 在调用返回前已同步执行到挂起点 → capturedSignal 已赋值。
  assert.ok(capturedSignal !== undefined, 'signal 已合并进底层调用（AbortSignal.any 复合信号）');
  controller.abort();
  await assert.rejects(
    () => pending,
    (error: unknown) => error instanceof ExamLlmError && error.code === EXAM_LLM_ABORTED,
    '调用方中止传播到底层 → 归一为 EXAM_LLM_ABORTED',
  );
});

test('t9 generateStudyPlan：结构化条目（actionType/scope/priority/dueAt/sourceDiagnosisId）解析', async () => {
  const engine = createAiEngine(llmReturning(JSON.stringify([
    { title: '错题复盘', actionType: 'reviewError', scope: { mode: 'wrong' }, priority: 1, dueAt: 1700000000000, sourceDiagnosisId: 'dia-9', note: '每周' },
    { title: '看讲义', actionType: 'read', priority: 2 },
    { title: '坏条目', actionType: 'bogus', priority: 99 }, // 非法 actionType/priority → 忽略，仅保留 title
  ])));
  const drafts = await engine.generateStudyPlan(INSIGHT, { provider: 'p', model: 'm' });
  assert.deepEqual(drafts, [
    { title: '错题复盘', note: '每周', actionType: 'reviewError', scope: { mode: 'wrong' }, priority: 1, dueAt: 1700000000000, sourceDiagnosisId: 'dia-9' },
    { title: '看讲义', actionType: 'read', priority: 2 },
    { title: '坏条目' },
  ]);
});
