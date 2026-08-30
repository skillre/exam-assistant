/**
 * tools.ts 工具注册面 + Tutor 历史路由测试（Node 内置 node:test，零依赖）。
 *
 * 覆盖：
 * ① 快照：createExamToolsPlugin 注册 10 个 exam_* 工具（名称/参数形态/
 *    output schema 子集/render）+ systemPrompt 引导节（tool:exam-coach）。
 * ② execute：对 fake ExamService 的调用与结果透传；ExamServiceError /
 *    未知错误 / 未挂载 / 非法参数 → { ok:false, code, message } 包络，不抛。
 * ③ 路由：GET /exam/api/tutor/sessions/:id 正常 200 { session, messages }、
 *    不存在 404、错误方法 405（真实 node:http server 驱动 registerExamRoutes）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { WebServer } from '@deepseek-ai/dsh-host-webserver';
import type { LlmRoute } from './index.ts';
import { registerExamRoutes } from './index.ts';
import { openExamStore, type ExamStore } from './store.ts';
import { createExamService, type ExamService } from './service.ts';
import { ExamServiceError } from './errors.ts';
import { createExamToolsPlugin, type ExamToolDefinition, type ExamToolsRuntime } from './tools.ts';

// ---------------------------------------------------------------------------
// fake runtime / fake ExamService
// ---------------------------------------------------------------------------

/** execute 的 exec 参数（工具不消费，仅占位）。 */
const EXEC = { signal: new AbortController().signal };

/** fake llm 路由：固定一个 provider 一个模型（resolveLlmRoute 缺省解析用）。 */
const FAKE_ROUTE = {
  listProviders: () => [{ id: 'fake-provider', name: 'Fake' }],
  listModels: async () => [{ id: 'fake-model', name: 'Fake Model' }],
} as unknown as LlmRoute;

interface FakeRuntimeState {
  registered: ExamToolDefinition[];
  sections: Array<{ name: string; order: number; text: string }>;
}

/** 构造可注入 createExamToolsPlugin 的 fake runtime（记录注册与回收）。 */
function fakeRuntime(services: { exam?: unknown; llm?: unknown } = {}): ExamToolsRuntime & FakeRuntimeState {
  const registered: ExamToolDefinition[] = [];
  const sections: Array<{ name: string; order: number; text: string }> = [];
  return {
    registered,
    sections,
    get(name) {
      if (name === 'exam') return services.exam;
      if (name === 'llm') return services.llm;
      return undefined;
    },
    tools: {
      register(def) {
        registered.push(def);
        return () => {
          const index = registered.indexOf(def);
          if (index >= 0) registered.splice(index, 1);
        };
      },
    },
    systemPrompt: {
      section(section) {
        sections.push(section);
        return () => {
          const index = sections.indexOf(section);
          if (index >= 0) sections.splice(index, 1);
        };
      },
    },
  };
}

/** 记录方法调用的 fake ExamService（Proxy 分派到 impl，未实现的方法调用即失败）。 */
function recordingExam(
  impl: Record<string, (...args: any[]) => unknown>,
): { exam: ExamService; calls: Array<{ method: string; args: unknown[] }> } {
  const calls: Array<{ method: string; args: unknown[] }> = [];
  const exam = new Proxy({} as ExamService, {
    get(_target, prop: string | symbol) {
      if (typeof prop !== 'string' || prop === 'then') return undefined;
      const fn = impl[prop];
      return (...args: unknown[]) => {
        calls.push({ method: prop, args });
        if (fn === undefined) throw new Error(`unexpected ExamService method call: ${prop}`);
        return fn(...args);
      };
    },
  });
  return { exam, calls };
}

const EXPECTED_TOOL_NAMES = [
  'exam_list_banks',
  'exam_get_questions',
  'exam_create_bank',
  'exam_create_question',
  'exam_import_from_text',
  'exam_tutor_ask',
  'exam_start_practice',
  'exam_get_insight',
  'exam_grade_essay',
  'exam_list_plans',
] as const;

function toolOf(runtime: ExamToolsRuntime & FakeRuntimeState, name: string): ExamToolDefinition {
  const def = runtime.registered.find((d) => d.name === name);
  assert.ok(def !== undefined, `tool ${name} should be registered`);
  return def!;
}

/** 执行工具并放宽返回类型（execute 返回 Record<string, unknown>，测试按 any 读字段）。 */
async function callTool(
  runtime: ExamToolsRuntime & FakeRuntimeState,
  name: string,
  args: unknown,
): Promise<Record<string, any>> {
  // 便捷：未显式创建插件时先注册（每个测试使用全新 runtime）。
  if (runtime.registered.length === 0) createExamToolsPlugin(runtime);
  return (await toolOf(runtime, name).execute(args, EXEC)) as Record<string, any>;
}

function propsOf(def: ExamToolDefinition): Record<string, Record<string, unknown>> {
  return def.parameters.properties as Record<string, Record<string, unknown>>;
}

// ---------------------------------------------------------------------------
// ① 注册快照
// ---------------------------------------------------------------------------

test('快照：注册 10 个 exam_* 工具（顺序/参数/输出形态）+ systemPrompt 引导节', () => {
  const runtime = fakeRuntime();
  const disposers = createExamToolsPlugin(runtime);

  assert.deepEqual(
    runtime.registered.map((d) => d.name),
    [...EXPECTED_TOOL_NAMES],
  );
  for (const def of runtime.registered) {
    assert.equal(def.parameters.type, 'object', `${def.name}: parameters 为对象根`);
    assert.ok(
      typeof def.parameters.properties === 'object' && def.parameters.properties !== null,
      `${def.name}: parameters.properties 存在`,
    );
    assert.equal(def.output.schema.type, 'object', `${def.name}: output.schema 为对象根`);
    assert.equal(typeof def.execute, 'function', `${def.name}: execute`);
    assert.equal(typeof def.output.render, 'function', `${def.name}: render`);
    // render 输出 text ContentBlock
    const blocks = def.output.render({}, { ok: true, banks: [] });
    assert.ok(Array.isArray(blocks) && blocks[0]?.type === 'text', `${def.name}: render → ContentBlock[]`);
  }

  // systemPrompt 引导节
  assert.equal(runtime.sections.length, 1);
  assert.equal(runtime.sections[0]?.name, 'tool:exam-coach');
  assert.equal(runtime.sections[0]?.order, 100);
  assert.ok(runtime.sections[0]!.text.includes('exam_'), '引导节提示工具前缀');

  // 参数形态抽查
  const byName = new Map(runtime.registered.map((d) => [d.name, d]));
  assert.deepEqual(byName.get('exam_list_banks')!.parameters.required, undefined, 'list_banks 无必填');
  assert.deepEqual(byName.get('exam_get_questions')!.parameters.required, ['bankId']);
  assert.deepEqual(byName.get('exam_create_bank')!.parameters.required, ['name']);
  assert.deepEqual(byName.get('exam_create_question')!.parameters.required, ['bankId', 'type', 'stem', 'answer']);
  assert.deepEqual(byName.get('exam_import_from_text')!.parameters.required, ['text']);
  assert.deepEqual(byName.get('exam_tutor_ask')!.parameters.required, ['message']);
  assert.deepEqual(byName.get('exam_grade_essay')!.parameters.required, ['questionId', 'userAnswer']);
  assert.deepEqual(byName.get('exam_list_plans')!.parameters.required, undefined);
  // scope 嵌套对象
  const scope = propsOf(byName.get('exam_start_practice')!).scope;
  assert.ok(scope, 'start_practice 有 scope 参数');
  assert.equal(scope.type, 'object');
  assert.deepEqual(scope.required, ['mode']);
  // 枚举形态（题型 / 范围）
  const typeEnum = propsOf(byName.get('exam_create_question')!).type?.enum;
  assert.deepEqual(typeEnum, ['single', 'multiple', 'boolean', 'essay']);
  const modeEnum = (scope.properties as Record<string, Record<string, unknown>>).mode?.enum;
  assert.deepEqual(modeEnum, ['all', 'undone', 'wrong', 'byType', 'byTag', 'byTopic']);

  // disposer 回收
  for (const dispose of disposers) dispose();
  assert.equal(runtime.registered.length, 0, 'dispose 后工具全部注销');
  assert.equal(runtime.sections.length, 0, 'dispose 后引导节注销');
});

// ---------------------------------------------------------------------------
// ② execute：调用与结果透传
// ---------------------------------------------------------------------------

test('execute：exam_list_banks 调用 listBanks 并透传', async () => {
  const { exam, calls } = recordingExam({
    listBanks: () => [{ id: 'b1', name: '题库A', createdAt: 1 }],
  });
  const runtime = fakeRuntime({ exam });
  const result = await callTool(runtime, 'exam_list_banks', {});
  assert.deepEqual(calls, [{ method: 'listBanks', args: [] }]);
  assert.equal(result.ok, true);
  assert.equal(result.banks.length, 1);
  assert.equal(result.banks[0].id, 'b1');
});

test('execute：exam_get_questions 传 bankId 并支持 type/tag 过滤', async () => {
  const { exam, calls } = recordingExam({
    listQuestionsByBank: (bankId: string) => [
      { id: 'q1', bankId, type: 'single', stem: '1+1', options: ['1', '2'], answer: '1', explanation: null, tags: ['数学'], createdAt: 1, updatedAt: 1 },
      { id: 'q2', bankId, type: 'multiple', stem: '选', options: ['A', 'B'], answer: ['A'], explanation: null, tags: ['英语'], createdAt: 1, updatedAt: 1 },
    ],
  });
  const runtime = fakeRuntime({ exam });
  const result = await callTool(runtime, 'exam_get_questions', { bankId: 'b1', type: 'single', tag: '数学' });
  assert.deepEqual(calls, [{ method: 'listQuestionsByBank', args: ['b1'] }]);
  assert.equal(result.ok, true);
  assert.equal(result.count, 1);
  assert.equal(result.questions[0].id, 'q1');
  assert.equal(result.questions[0].bankId, undefined, '题目投影取最小字段（不含 bankId）');
});

test('execute：exam_get_questions 支持 topic 过滤（topics 包含匹配）且输出含知识点', async () => {
  const { exam, calls } = recordingExam({
    listQuestionsByBank: (bankId: string) => [
      { id: 'q1', bankId, type: 'single', stem: 's1', options: ['A'], answer: 'A', explanation: null, tags: ['数学'], topics: ['算术'], createdAt: 1, updatedAt: 1 },
      { id: 'q2', bankId, type: 'single', stem: 's2', options: ['A'], answer: 'A', explanation: null, tags: ['英语'], topics: ['语法'], createdAt: 1, updatedAt: 1 },
    ],
  });
  const runtime = fakeRuntime({ exam });
  const result = await callTool(runtime, 'exam_get_questions', { bankId: 'b1', topic: '算术' });
  assert.deepEqual(calls, [{ method: 'listQuestionsByBank', args: ['b1'] }]);
  assert.equal(result.count, 1);
  assert.equal(result.questions[0].id, 'q1');
  assert.deepEqual(result.questions[0].topics, ['算术'], '输出包含知识点');
});

test('execute：exam_create_bank 调用 createBank', async () => {
  const { exam, calls } = recordingExam({
    createBank: (input: { name: string }) => ({ id: 'b9', name: input.name, createdAt: 1 }),
  });
  const runtime = fakeRuntime({ exam });
  const result = await callTool(runtime, 'exam_create_bank', { name: '新题库' });
  assert.deepEqual(calls, [{ method: 'createBank', args: [{ name: '新题库' }] }]);
  assert.equal(result.ok, true);
  assert.equal(result.bank.id, 'b9');
});

test('execute：exam_create_question 组装输入并调用 createQuestion（含 tags/topics 透传）', async () => {
  const { exam, calls } = recordingExam({
    createQuestion: (bankId: string, input: Record<string, unknown>) => ({
      id: 'q-new',
      bankId,
      type: input.type,
      stem: input.stem,
      answer: input.answer,
      tags: input.tags ?? null,
      topics: input.topics ?? null,
    }),
  });
  const runtime = fakeRuntime({ exam });
  const result = await callTool(runtime, 'exam_create_question', {
    bankId: 'b1', type: 'single', stem: '题干', options: ['A', 'B'], answer: 'A', explanation: '解析', tags: ['数学'], topics: ['算术'],
  });
  assert.deepEqual(calls, [
    {
      method: 'createQuestion',
      args: ['b1', { type: 'single', stem: '题干', options: ['A', 'B'], answer: 'A', explanation: '解析', tags: ['数学'], topics: ['算术'] }],
    },
  ]);
  assert.equal(result.ok, true);
  assert.equal(result.question.id, 'q-new');
  assert.equal(result.question.answer, 'A');
});

test('execute：exam_create_question 未传 topics 时不透传该字段（保持 undefined）', async () => {
  const { exam, calls } = recordingExam({
    createQuestion: (bankId: string, input: Record<string, unknown>) => ({
      id: 'q-new', bankId, type: input.type, stem: input.stem, answer: input.answer, tags: null,
    }),
  });
  const runtime = fakeRuntime({ exam });
  const result = await callTool(runtime, 'exam_create_question', {
    bankId: 'b1', type: 'single', stem: '题干', options: ['A', 'B'], answer: 'A',
  });
  assert.equal((calls[0]!.args[1] as Record<string, unknown>).topics, undefined, '未传 topics 时不带该字段');
  assert.equal(result.ok, true);
});

test('render：题目回显缺答案时不出现 "答案: undefined"，有答案时正常渲染', async () => {
  const runtime = fakeRuntime({ exam: recordingExam({}).exam });
  createExamToolsPlugin(runtime);
  const def = toolOf(runtime, 'exam_create_question');
  // 裁剪形状（无 answer 字段）→ 不渲染答案段
  const missing = def.output.render({}, { ok: true, question: { id: 'q1', type: 'single', stem: '题干', tags: null } });
  assert.equal(missing[0]?.type === 'text' && !missing[0].text.includes('undefined'), true, JSON.stringify(missing));
  // 含 answer → 正常渲染
  const present = def.output.render({}, { ok: true, question: { id: 'q2', type: 'single', stem: '题干', answer: 'A', tags: null } });
  assert.equal(present[0]?.type === 'text' && present[0].text.includes('答案: "A"'), true, JSON.stringify(present));
});

test('execute：exam_import_from_text commit=false 仅生成草稿（provider/model 自动解析）', async () => {
  const { exam, calls } = recordingExam({
    listImportedQuestions: async () => [
      { type: 'single', stem: '草稿题', options: ['a'], answer: 'a', explanation: null, tags: null },
    ],
  });
  const runtime = fakeRuntime({ exam, llm: FAKE_ROUTE });
  const text = 'x'.repeat(60);
  const result = await callTool(runtime, 'exam_import_from_text', { text, commit: false });
  assert.equal(result.ok, true);
  assert.equal(result.commit, false);
  assert.equal(result.drafts.length, 1);
  assert.deepEqual(calls, [
    { method: 'listImportedQuestions', args: [{ text, provider: 'fake-provider', model: 'fake-model' }] },
  ]);
});

test('execute：exam_import_from_text commit 缺省=true 生成并入库', async () => {
  const { exam, calls } = recordingExam({
    listImportedQuestions: async () => [
      { type: 'single', stem: '草稿题', options: ['a'], answer: 'a', explanation: null, tags: null },
    ],
    importQuestions: (bankId: string, questions: Array<Record<string, unknown>>) => ({
      count: questions.length,
      questions: questions.map((q, i) => ({ id: `c${i}`, bankId, type: q.type, stem: q.stem, tags: null })),
    }),
  });
  const runtime = fakeRuntime({ exam, llm: FAKE_ROUTE });
  const result = await callTool(runtime, 'exam_import_from_text', { text: 'x'.repeat(60), bankId: 'b1' });
  assert.equal(result.ok, true);
  assert.equal(result.commit, true);
  assert.equal(result.imported.count, 1);
  assert.deepEqual(
    calls.map((c) => c.method),
    ['listImportedQuestions', 'importQuestions'],
  );
  assert.deepEqual(calls[1]?.args, [
    'b1',
    [{ type: 'single', stem: '草稿题', options: ['a'], answer: 'a', explanation: null, tags: null }],
  ]);
});

test('execute：exam_tutor_ask 聚合完整回复', async () => {
  const { exam, calls } = recordingExam({
    chatTutor: async () => ({ sessionId: 's1', messageId: 'm1', reply: '完整回复', model: 'fake-model' }),
  });
  const runtime = fakeRuntime({ exam, llm: FAKE_ROUTE });
  const result = await callTool(runtime, 'exam_tutor_ask', { message: '这题怎么做？', questionId: 'q1' });
  assert.equal(result.ok, true);
  assert.equal(result.reply, '完整回复');
  assert.equal(result.sessionId, 's1');
  assert.equal(result.messageId, 'm1');
  assert.deepEqual(calls, [
    {
      method: 'chatTutor',
      args: [
        {
          sessionId: undefined,
          questionId: 'q1',
          bankId: undefined,
          message: '这题怎么做？',
          provider: 'fake-provider',
          model: 'fake-model',
        },
      ],
    },
  ]);
});

test('execute：exam_start_practice 传 scope/shuffle（缺省 seed 为 undefined）', async () => {
  const { exam, calls } = recordingExam({
    startPractice: (input: Record<string, unknown>) => ({
      id: 'p1',
      bankId: input.bankId,
      scope: input.scope,
      questionIds: ['q1'],
      currentIndex: 0,
      status: 'active',
      createdAt: 1,
      finishedAt: null,
    }),
  });
  const runtime = fakeRuntime({ exam });
  const result = await callTool(runtime, 'exam_start_practice', {
    bankId: 'b1', scope: { mode: 'byType', type: 'single' }, shuffle: true,
  });
  assert.equal(result.ok, true);
  assert.equal(result.practice.id, 'p1');
  assert.deepEqual(calls, [
    {
      method: 'startPractice',
      args: [{ bankId: 'b1', scope: { mode: 'byType', type: 'single' }, shuffle: true, seed: undefined }],
    },
  ]);
});

test('execute：exam_start_practice 支持 byTopic/topic scope', async () => {
  const { exam, calls } = recordingExam({
    startPractice: (input: Record<string, unknown>) => ({
      id: 'p1',
      bankId: input.bankId,
      scope: input.scope,
      questionIds: ['q1'],
      currentIndex: 0,
      status: 'active',
      createdAt: 1,
      finishedAt: null,
    }),
  });
  const runtime = fakeRuntime({ exam });
  const result = await callTool(runtime, 'exam_start_practice', {
    bankId: 'b1', scope: { mode: 'byTopic', topic: ' 架构治理 ' },
  });
  assert.equal(result.ok, true);
  assert.deepEqual(calls, [
    {
      method: 'startPractice',
      args: [{ bankId: 'b1', scope: { mode: 'byTopic', topic: ' 架构治理 ' }, shuffle: undefined, seed: undefined }],
    },
  ]);
});

test('execute：exam_get_insight 默认仅统计；diagnose=true 附带诊断', async () => {
  const plain = recordingExam({ listInsight: () => ({ totalAttempts: 3 }) });
  const plainRuntime = fakeRuntime({ exam: plain.exam });
  const plainResult = await callTool(plainRuntime, 'exam_get_insight', {});
  assert.equal(plainResult.ok, true);
  assert.equal(plainResult.insight.totalAttempts, 3);
  assert.equal(plainResult.diagnosis, undefined);
  // t13：无 window/bankId 参数时仍传空输入对象（listInsight(input?)）
  assert.deepEqual(plain.calls, [{ method: 'listInsight', args: [{}] }]);

  // 显式 window/bankId 透传
  const filtered = recordingExam({ listInsight: () => ({ totalAttempts: 3 }) });
  const filteredRuntime = fakeRuntime({ exam: filtered.exam });
  const filteredResult = await callTool(filteredRuntime, 'exam_get_insight', { window: 14, bankId: 'b1' });
  assert.equal(filteredResult.ok, true);
  assert.deepEqual(filtered.calls, [{ method: 'listInsight', args: [{ windowDays: 14, bankId: 'b1' }] }]);

  const diag = recordingExam({
    listInsight: () => ({ totalAttempts: 3 }),
    diagnoseInsight: async () => ({ id: 'd1', summary: 's', weaknesses: ['w'], suggestions: [{ text: 'g' }], provider: null, model: null, createdAt: 1 }),
  });
  const diagRuntime = fakeRuntime({ exam: diag.exam, llm: FAKE_ROUTE });
  const diagResult = await callTool(diagRuntime, 'exam_get_insight', { diagnose: true });
  assert.equal(diagResult.ok, true);
  assert.deepEqual(diagResult.diagnosis, { id: 'd1', summary: 's', weaknesses: ['w'], suggestions: [{ text: 'g' }], provider: null, model: null, createdAt: 1 });
  assert.deepEqual(diag.calls, [
    { method: 'listInsight', args: [{}] },
    { method: 'diagnoseInsight', args: [{ provider: 'fake-provider', model: 'fake-model' }] },
  ]);
});

test('execute：exam_grade_essay 批改透传', async () => {
  const { exam, calls } = recordingExam({
    gradeEssay: async () => ({
      attemptId: 'a1',
      grading: { score: 85, verdict: 'correct', feedback: '好', reference: '要点', isCorrect: true },
    }),
  });
  const runtime = fakeRuntime({ exam, llm: FAKE_ROUTE });
  const result = await callTool(runtime, 'exam_grade_essay', {
    questionId: 'q9', practiceId: 'p1', userAnswer: '我的答案',
  });
  assert.equal(result.ok, true);
  assert.equal(result.attemptId, 'a1');
  assert.equal(result.grading.score, 85);
  assert.deepEqual(calls, [
    {
      method: 'gradeEssay',
      args: [
        { questionId: 'q9', practiceId: 'p1', userAnswer: '我的答案', provider: 'fake-provider', model: 'fake-model' },
      ],
    },
  ]);
});

test('execute：exam_list_plans 透传 plans', async () => {
  const { exam, calls } = recordingExam({
    listPlans: () => ({
      plans: [{ id: 'pl1', title: '计划', source: 'manual', status: 'active', createdAt: 1, updatedAt: 1 }],
    }),
  });
  const runtime = fakeRuntime({ exam });
  const result = await callTool(runtime, 'exam_list_plans', {});
  assert.equal(result.ok, true);
  assert.equal(result.plans.length, 1);
  assert.equal(result.plans[0].id, 'pl1');
  assert.deepEqual(calls, [{ method: 'listPlans', args: [] }]);
});

// ---------------------------------------------------------------------------
// ② execute：错误映射（包络，不抛）
// ---------------------------------------------------------------------------

test('execute 错误映射：ExamServiceError → { ok:false, code, message }，不抛', async () => {
  const { exam } = recordingExam({
    createBank: () => {
      throw new ExamServiceError('EXAM_BANK_NAME_REQUIRED', 'bank name must be a non-empty string');
    },
  });
  const runtime = fakeRuntime({ exam });
  const result = await callTool(runtime, 'exam_create_bank', { name: '  ' });
  assert.deepEqual(result, {
    ok: false,
    code: 'EXAM_BANK_NAME_REQUIRED',
    message: 'bank name must be a non-empty string',
  });
});

test('execute 错误映射：未知错误 → EXAM_INTERNAL 包络', async () => {
  const { exam } = recordingExam({
    listBanks: () => {
      throw new Error('boom');
    },
  });
  const runtime = fakeRuntime({ exam });
  const result = await callTool(runtime, 'exam_list_banks', {});
  assert.equal(result.ok, false);
  assert.equal(result.code, 'EXAM_INTERNAL');
  assert.ok(String(result.message).includes('boom'));
});

test('execute 错误映射：exam 服务未挂载 → EXAM_STORE_UNAVAILABLE', async () => {
  const runtime = fakeRuntime();
  const result = await callTool(runtime, 'exam_list_banks', {});
  assert.equal(result.ok, false);
  assert.equal(result.code, 'EXAM_STORE_UNAVAILABLE');
});

test('execute 错误映射：非法参数 → EXAM_INVALID_BODY，服务不被调用', async () => {
  const { exam, calls } = recordingExam({ listQuestionsByBank: () => [] });
  const runtime = fakeRuntime({ exam });
  const result = await callTool(runtime, 'exam_get_questions', { bankId: 42 });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'EXAM_INVALID_BODY');
  assert.equal(calls.length, 0, '参数非法时不得调用服务');

  const scopeResult = await callTool(runtime, 'exam_start_practice', {
    bankId: 'b1', scope: { mode: 'bogus' },
  });
  assert.equal(scopeResult.ok, false);
  assert.equal(scopeResult.code, 'EXAM_INVALID_BODY');
  assert.equal(calls.length, 0);
});

// ---------------------------------------------------------------------------
// ③ 路由：GET /exam/api/tutor/sessions/:id
// ---------------------------------------------------------------------------

/** 最小 fake WebServer（同 smoke.test.ts 语义：exact 优先，prefix 最长优先）。 */
function fakeWebServer(): Server & { register: WebServer['register'] } {
  const exact = new Map<string, (req: any, res: any) => void | Promise<void>>();
  const prefixes = new Map<string, (req: any, res: any) => void | Promise<void>>();
  const register: WebServer['register'] = (route) => {
    const path = route.path;
    if (route.kind === 'exact') exact.set(path, route.handler);
    else prefixes.set(path, route.handler);
    return () => {
      if (route.kind === 'exact') exact.delete(path);
      else prefixes.delete(path);
    };
  };
  const server = createServer((req, res) => {
    const pathname = new URL(req.url ?? '/', 'http://localhost').pathname;
    const exactHandler = exact.get(pathname);
    if (exactHandler) {
      void exactHandler(req, res);
      return;
    }
    let best: { path: string; handler: (req: any, res: any) => void | Promise<void> } | undefined;
    for (const [path, handler] of prefixes) {
      if (pathname === path || pathname.startsWith(`${path}/`)) {
        if (!best || path.length > best.path.length) best = { path, handler };
      }
    }
    if (best) void best.handler(req, res);
    else {
      res.writeHead(404);
      res.end('not found');
    }
  });
  return Object.assign(server, { register });
}

const fakeLogger = { info() {}, warn() {} } as unknown as Parameters<typeof registerExamRoutes>[3];

async function withRoutes(
  run: (base: string, service: ExamService, store: ExamStore) => Promise<void>,
): Promise<void> {
  const store = await openExamStore(':memory:');
  const service = createExamService({ store });
  const webServer = fakeWebServer();
  const disposers = registerExamRoutes(
    webServer as unknown as WebServer,
    service,
    { listProviders: () => [], listModels: async () => [] },
    fakeLogger,
  );
  await new Promise<void>((resolveListen) => webServer.listen(0, '127.0.0.1', resolveListen));
  const { port } = webServer.address() as AddressInfo;
  try {
    await run(`http://127.0.0.1:${port}`, service, store);
  } finally {
    await new Promise<void>((resolveClose) => webServer.close(() => resolveClose()));
    for (const dispose of disposers.reverse()) dispose();
    service.close();
  }
}

async function fetchJson(base: string, path: string, init?: RequestInit): Promise<{ status: number; body: any }> {
  const res = await fetch(`${base}${path}`, init);
  const text = await res.text();
  let body: unknown;
  try {
    body = text.length > 0 ? JSON.parse(text) : undefined;
  } catch {
    body = text;
  }
  return { status: res.status, body };
}

test('GET /exam/api/tutor/sessions/:id → 200 { session, messages }（升序全量消息）', async () => {
  await withRoutes(async (base, _service, store) => {
    store.createTutorSession({ id: 'ts-1' });
    store.addTutorMessage({ sessionId: 'ts-1', role: 'user', content: '你好', createdAt: 1 });
    store.addTutorMessage({ sessionId: 'ts-1', role: 'assistant', content: '你好，有什么问题？', createdAt: 2 });

    const res = await fetchJson(base, '/exam/api/tutor/sessions/ts-1');
    assert.equal(res.status, 200);
    assert.equal(res.body.session.id, 'ts-1');
    assert.equal(res.body.session.status, 'active');
    assert.equal(res.body.messages.length, 2);
    assert.equal(res.body.messages[0].role, 'user');
    assert.equal(res.body.messages[0].content, '你好');
    assert.equal(res.body.messages[1].role, 'assistant');
    assert.equal(res.body.messages[1].content, '你好，有什么问题？');
    assert.ok(typeof res.body.messages[0].createdAt === 'number');

    // 列表端点（exact）不受 prefix 分派影响
    const list = await fetchJson(base, '/exam/api/tutor/sessions');
    assert.equal(list.status, 200);
    assert.equal(list.body.sessions.length, 1);
    assert.equal(list.body.sessions[0].id, 'ts-1');
  });
});

test('GET /exam/api/tutor/sessions/:id 不存在 → 404 EXAM_TUTOR_SESSION_NOT_FOUND', async () => {
  await withRoutes(async (base) => {
    const res = await fetchJson(base, '/exam/api/tutor/sessions/ghost');
    assert.equal(res.status, 404);
    assert.equal(res.body.error.code, 'EXAM_TUTOR_SESSION_NOT_FOUND');
  });
});

test('POST /exam/api/tutor/sessions/:id → 405（仅 GET）', async () => {
  await withRoutes(async (base, _service, store) => {
    store.createTutorSession({ id: 'ts-2' });
    const res = await fetchJson(base, '/exam/api/tutor/sessions/ts-2', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    assert.equal(res.status, 405);
    assert.equal(res.body.error.code, 'EXAM_METHOD_NOT_ALLOWED');
  });
});
