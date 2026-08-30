/**
 * ExamLlm 最小单元测试（Node 内置 node:test，零依赖，fake stream 注入）。
 * 运行：node --test packages/dsh-exam/src/host/llm.test.ts
 * 覆盖：文本拼接 + usage、onDelta 回调、finish error/aborted/tool-calls、
 * 超时（AbortController 取消底层调用）、调用方 signal 中止、流内 throw 归一化。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createExamLlm,
  createFakeLlmService,
  textDelta,
  usageChunk,
  finishStop,
  finishError,
  finishAborted,
  finishToolCalls,
  userTextMessage,
  ExamLlmError,
  EXAM_LLM_TIMEOUT,
  EXAM_LLM_ABORTED,
  EXAM_LLM_TOOL_CALL,
  EXAM_LLM_STREAM_FAILED,
} from './llm.ts';
import type { LlmGenerateOptions, LlmStreamChunk } from './llm-types.ts';

const BASE_INPUT = {
  provider: 'deepseek',
  model: 'deepseek-chat',
  system: '你是考试助手',
  messages: [userTextMessage('你好')],
};

test('runOnce 拼接 text-delta 并携带 usage', async () => {
  const llm = createExamLlm(
    createFakeLlmService(async function* () {
      yield textDelta('你好');
      yield textDelta('，');
      yield textDelta('世界');
      yield usageChunk({ inputTokens: 10, outputTokens: 5 });
      yield finishStop();
    }),
  );
  const text = await llm.runOnce({ ...BASE_INPUT });
  assert.equal(text, '你好，世界');

  const result = await llm.streamOnce({ ...BASE_INPUT });
  assert.equal(result.text, '你好，世界');
  assert.equal(result.finish.kind, 'stop');
  assert.deepEqual(result.usage, { inputTokens: 10, outputTokens: 5 });
});

test('onDelta 收到每个非空 text-delta', async () => {
  const llm = createExamLlm(
    createFakeLlmService(async function* () {
      yield textDelta('a');
      yield textDelta('');
      yield textDelta('b');
      yield finishStop();
    }),
  );
  const deltas: string[] = [];
  const result = await llm.streamOnce({ ...BASE_INPUT }, (d) => deltas.push(d));
  assert.equal(result.text, 'ab');
  assert.deepEqual(deltas, ['a', 'b']);
});

test('finish error 归一化为 ExamLlmError（保留 provider code）', async () => {
  const llm = createExamLlm(
    createFakeLlmService(async function* () {
      yield textDelta('partial');
      yield finishError('上游 429', 'RATE_LIMIT');
    }),
  );
  await assert.rejects(
    () => llm.runOnce({ ...BASE_INPUT }),
    (error: unknown) =>
      error instanceof ExamLlmError &&
      error.code === 'RATE_LIMIT' &&
      /上游 429/.test(error.message),
  );
});

test('finish aborted（非调用方、非超时）归一化为 EXAM_LLM_ABORTED', async () => {
  const llm = createExamLlm(
    createFakeLlmService(async function* () {
      yield finishAborted('provider cancelled');
    }),
  );
  await assert.rejects(
    () => llm.runOnce({ ...BASE_INPUT }),
    (error: unknown) =>
      error instanceof ExamLlmError && error.code === EXAM_LLM_ABORTED,
  );
});

test('finish tool-calls / tool-call-delta 视为错误', async () => {
  const llm = createExamLlm(
    createFakeLlmService(async function* () {
      yield { type: 'tool-call-delta', index: 0, id: 'c1', name: 'search', argumentsDelta: '{}' } satisfies LlmStreamChunk;
      yield finishToolCalls();
    }),
  );
  await assert.rejects(
    () => llm.runOnce({ ...BASE_INPUT }),
    (error: unknown) =>
      error instanceof ExamLlmError && error.code === EXAM_LLM_TOOL_CALL,
  );
});

test('流内 throw 归一化为 EXAM_LLM_STREAM_FAILED', async () => {
  const llm = createExamLlm(
    createFakeLlmService(async function* () {
      throw new Error('connection reset');
    }),
  );
  await assert.rejects(
    () => llm.runOnce({ ...BASE_INPUT }),
    (error: unknown) =>
      error instanceof ExamLlmError &&
      error.code === EXAM_LLM_STREAM_FAILED &&
      /connection reset/.test(error.message),
  );
});

test('超时：AbortController 取消底层调用并抛 EXAM_LLM_TIMEOUT', async () => {
  let receivedSignal: AbortSignal | undefined;
  const llm = createExamLlm(
    createFakeLlmService(async function* (options: LlmGenerateOptions) {
      receivedSignal = options.signal;
      yield textDelta('开始');
      // 永不结束：等待 signal 中止后抛错，模拟 adapter 尊重 signal 的行为。
      await new Promise<never>((_resolve, reject) => {
        const s = options.signal;
        if (s?.aborted) {
          reject(s.reason ?? new Error('aborted'));
          return;
        }
        s?.addEventListener('abort', () => reject(s.reason ?? new Error('aborted')), {
          once: true,
        });
      });
    }),
  );
  await assert.rejects(
    () => llm.runOnce({ ...BASE_INPUT, timeoutMs: 50 }),
    (error: unknown) =>
      error instanceof ExamLlmError && error.code === EXAM_LLM_TIMEOUT,
  );
  assert.ok(receivedSignal, '底层调用应收到 signal');
  assert.ok(receivedSignal!.aborted, '超时后底层 signal 应被 abort');
});

test('调用方 signal 中止 → EXAM_LLM_ABORTED', async () => {
  const controller = new AbortController();
  const llm = createExamLlm(
    createFakeLlmService(async function* (options: LlmGenerateOptions) {
      yield textDelta('x');
      // 模拟 adapter 尊重 signal：先检查已中止状态，再监听后续中止
      // （signal 在监听注册前已 aborted 时，addEventListener 不会触发）。
      await new Promise<never>((_resolve, reject) => {
        const s = options.signal;
        if (s?.aborted) {
          reject(s.reason ?? new Error('aborted'));
          return;
        }
        s?.addEventListener('abort', () => reject(s.reason ?? new Error('aborted')), {
          once: true,
        });
      });
    }),
  );
  const pending = llm.runOnce({ ...BASE_INPUT, signal: controller.signal });
  controller.abort();
  await assert.rejects(
    () => pending,
    (error: unknown) =>
      error instanceof ExamLlmError && error.code === EXAM_LLM_ABORTED,
  );
});

test('流未发 finish 即结束视为 stop', async () => {
  const llm = createExamLlm(
    createFakeLlmService(async function* () {
      yield textDelta('完成');
    }),
  );
  const result = await llm.streamOnce({ ...BASE_INPUT });
  assert.equal(result.finish.kind, 'stop');
  assert.equal(result.text, '完成');
});
