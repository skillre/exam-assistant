/**
 * Phase 0 可复用 Host LLM 模块：DSH `llm` 服务之上的考试领域封装（ExamLlm）。
 *
 * 类型来源：本文件中的流式类型（LlmGenerateOptions / LlmStreamChunk /
 * LlmFinishReason / LlmMessage / LlmContentBlock / LlmTokenUsage）是对 DSH 安装包
 * `@deepseek-ai/dsh-llm@0.1.0-rc.7` 真实声明的结构化镜像（读取自
 * `lib/types/types.d.ts`、`lib/types/message.d.ts`、`lib/types/assembler.d.ts`），
 * 仅保留 Phase 0 需要的字段，运行时不依赖该包。真实 `ctx.llm`（LlmRuntime 实例）
 * 满足本模块的 `LlmStreamService` 结构接口，可直接注入。
 *
 * 消费方式与 DSH 官方消费者（dsh-session-title-llm）一致：
 * `for await (chunk of llm.stream(options))` → 收集 text-delta →
 * 终态 finish 的 done/error/aborted 归一化。
 *
 * 约束：
 * - 模块不访问 `ctx`，由 Host 传入一个真实 llm 服务对象（构造注入）。
 * - 不使用 @earendil-works/pi-coding-agent，不实现自有 provider SDK。
 * - 超时通过 AbortController 取消底层调用（signal 经 AbortSignal.any 与调用方
 *   signal 合并），超时后 `clearTimeout` 清理定时器。
 * - 只消费 `text-delta`；出现 tool-call 视为错误（与 dsh-session-title-llm 一致）。
 */
import type { LlmContentBlock, LlmFinishReason, LlmGenerateOptions, LlmMessage, LlmStreamChunk, LlmTokenUsage } from './llm-types.ts';

export type { LlmContentBlock, LlmFinishReason, LlmGenerateOptions, LlmMessage, LlmStreamChunk, LlmTokenUsage };

/** 可注入的底层 LLM 流服务（真实对象为 DSH `ctx.llm`，即 LlmRuntime）。 */
export interface LlmStreamService {
  stream(options: LlmGenerateOptions): AsyncIterable<LlmStreamChunk>;
}

/** 一次模型调用的输入。 */
export interface ExamLlmCallInput {
  /** 已注册 provider 路由（如 'deepseek'）。 */
  provider: string;
  /** 模型 id。 */
  model: string;
  /** 系统提示词（映射到 provider system slot）。 */
  system?: string;
  /** 对话消息（provider 视角，system slot 之后）。 */
  messages: LlmMessage[];
  temperature?: number;
  maxTokens?: number;
  /** 思考深度 id（透传底层 GenerateOptions.reasoningEffort；缺省 provider 默认）。 */
  reasoningEffort?: string;
  /** 超时毫秒；缺省为 60_000。 */
  timeoutMs?: number;
  /** 调用方取消信号；与超时信号合并。 */
  signal?: AbortSignal;
}

/** 流式调用结果。 */
export interface ExamLlmStreamResult {
  /** 拼接后的可见文本（仅 text-delta，不含 reasoning）。 */
  readonly text: string;
  /** usage chunk 的 token 统计；未收到时为 undefined。 */
  readonly usage?: LlmTokenUsage;
  /** 归一化终态；流结束未收到 finish 时视为 stop。 */
  readonly finish: LlmFinishReason;
  readonly provider: string;
  readonly model: string;
}

/** 领域 LLM 门面。 */
export interface ExamLlm {
  /** 流式调用一次：每段 text-delta 经 onDelta 回调（可选）；终态归一化为结果/错误。 */
  streamOnce(input: ExamLlmCallInput, onDelta?: (delta: string) => void): Promise<ExamLlmStreamResult>;
  /** 一次性调用：返回完整文本；等价于 streamOnce 后取 text。 */
  runOnce(input: ExamLlmCallInput): Promise<string>;
}

/** 领域 LLM 错误；code 为稳定机器码。 */
export class ExamLlmError extends Error {
  readonly code: string;
  constructor(message: string, code: string) {
    super(message);
    this.name = 'ExamLlmError';
    this.code = code;
  }
}

/** 稳定错误码。 */
export const EXAM_LLM_TIMEOUT = 'EXAM_LLM_TIMEOUT';
export const EXAM_LLM_ABORTED = 'EXAM_LLM_ABORTED';
export const EXAM_LLM_PROVIDER_ERROR = 'EXAM_LLM_PROVIDER_ERROR';
export const EXAM_LLM_TOOL_CALL = 'EXAM_LLM_TOOL_CALL';
export const EXAM_LLM_STREAM_FAILED = 'EXAM_LLM_STREAM_FAILED';

const DEFAULT_TIMEOUT_MS = 60_000;

/** 用真实 llm 服务对象构造 ExamLlm；模块自身不接触 ctx。 */
export function createExamLlm(llm: LlmStreamService): ExamLlm {
  return {
    async streamOnce(input, onDelta) {
      return streamOnce(llm, input, onDelta);
    },
    async runOnce(input) {
      const result = await streamOnce(llm, input);
      return result.text;
    },
  };
}

async function streamOnce(
  llm: LlmStreamService,
  input: ExamLlmCallInput,
  onDelta?: (delta: string) => void,
): Promise<ExamLlmStreamResult> {
  const { provider, model, timeoutMs = DEFAULT_TIMEOUT_MS } = input;

  // 超时控制：timeoutMs 到达即 abort 底层流；与调用方 signal 合并。
  const timeoutController = new AbortController();
  const timer = setTimeout(() => {
    timeoutController.abort(new ExamLlmTimeoutError(timeoutMs));
  }, timeoutMs);
  timer.unref?.();

  const signal = input.signal
    ? AbortSignal.any([input.signal, timeoutController.signal])
    : timeoutController.signal;

  // fail-fast：调用方在发起前已中止时，不发起底层调用。
  if (input.signal?.aborted) {
    clearTimeout(timer);
    throw new ExamLlmError('LLM call aborted by caller', EXAM_LLM_ABORTED);
  }

  const options: LlmGenerateOptions = {
    provider,
    model,
    messages: input.messages,
    signal,
  };
  if (input.system !== undefined) options.system = input.system;
  if (input.temperature !== undefined) options.temperature = input.temperature;
  if (input.maxTokens !== undefined) options.maxTokens = input.maxTokens;
  if (input.reasoningEffort !== undefined) options.reasoningEffort = input.reasoningEffort;

  const parts: string[] = [];
  let usage: LlmTokenUsage | undefined;
  let finish: LlmFinishReason | undefined;
  let sawToolCall = false;

  try {
    for await (const chunk of llm.stream(options)) {
      if (chunk.type === 'text-delta') {
        if (chunk.text.length > 0) {
          parts.push(chunk.text);
          onDelta?.(chunk.text);
        }
      } else if (chunk.type === 'usage') {
        usage = chunk.usage;
      } else if (chunk.type === 'finish') {
        finish = chunk.reason;
        if (chunk.reason.kind === 'tool-calls') sawToolCall = true;
      } else if (chunk.type === 'tool-call-delta') {
        sawToolCall = true;
      } else if (chunk.type === 'block-end' && chunk.block.type === 'tool-call') {
        sawToolCall = true;
      }
    }
  } catch (error) {
    throw normalizeStreamError(error, { timeoutSignal: timeoutController.signal, callerSignal: input.signal, timeoutMs });
  } finally {
    clearTimeout(timer);
  }

  const terminal = finish ?? { kind: 'stop' as const };

  // 终态错误归一化（adapter 会把 dispatch/迭代失败归一为 error/aborted finish chunk）。
  if (terminal.kind === 'error') {
    throw new ExamLlmError(terminal.failure.message, terminal.failure.code || EXAM_LLM_PROVIDER_ERROR);
  }
  if (terminal.kind === 'aborted') {
    throw abortedError(timeoutController.signal, input.signal, timeoutMs);
  }
  if (terminal.kind === 'max-tokens') {
    throw new ExamLlmError(`LLM call exceeded maxTokens (${String(input.maxTokens ?? 'model default')})`, EXAM_LLM_PROVIDER_ERROR);
  }
  if (terminal.kind === 'tool-calls' || sawToolCall) {
    throw new ExamLlmError('LLM call unexpectedly produced a tool call', EXAM_LLM_TOOL_CALL);
  }

  return {
    text: parts.join(''),
    usage,
    finish: terminal,
    provider,
    model,
  };
}

class ExamLlmTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`LLM call timed out after ${timeoutMs}ms`);
    this.name = 'ExamLlmTimeoutError';
  }
}

function abortedError(
  timeoutSignal: AbortSignal,
  callerSignal: AbortSignal | undefined,
  timeoutMs: number,
): ExamLlmError {
  if (timeoutSignal.aborted) {
    return new ExamLlmError(`LLM call timed out after ${timeoutMs}ms`, EXAM_LLM_TIMEOUT);
  }
  if (callerSignal?.aborted) {
    return new ExamLlmError('LLM call aborted by caller', EXAM_LLM_ABORTED);
  }
  return new ExamLlmError('LLM call aborted', EXAM_LLM_ABORTED);
}

function normalizeStreamError(
  error: unknown,
  ctx: { timeoutSignal: AbortSignal; callerSignal: AbortSignal | undefined; timeoutMs: number },
): ExamLlmError {
  if (ctx.timeoutSignal.aborted) {
    return new ExamLlmError(`LLM call timed out after ${ctx.timeoutMs}ms`, EXAM_LLM_TIMEOUT);
  }
  if (ctx.callerSignal?.aborted) {
    return new ExamLlmError('LLM call aborted by caller', EXAM_LLM_ABORTED);
  }
  if (error instanceof ExamLlmError) return error;
  const message = error instanceof Error ? error.message : String(error);
  return new ExamLlmError(message, EXAM_LLM_STREAM_FAILED);
}

// ---------------------------------------------------------------------------
// 测试辅助：可注入 fake stream 的构造器与 chunk 构造函数。
// 让 Host 单测/冒烟无需真实 provider 即可驱动 streamOnce 的全部分支。
// ---------------------------------------------------------------------------

/** 用自定义 stream 实现构造 fake LlmStreamService。 */
export function createFakeLlmService(
  stream: (options: LlmGenerateOptions) => AsyncIterable<LlmStreamChunk>,
): LlmStreamService {
  return { stream };
}

/** 构造一个 text-delta chunk。 */
export function textDelta(text: string, index = 0): LlmStreamChunk {
  return { type: 'text-delta', index, text };
}

/** 构造一个 usage chunk。 */
export function usageChunk(usage: LlmTokenUsage): LlmStreamChunk {
  return { type: 'usage', usage };
}

/** 构造终态 stop chunk。 */
export function finishStop(): LlmStreamChunk {
  return { type: 'finish', reason: { kind: 'stop' } };
}

/** 构造终态 error chunk。 */
export function finishError(message: string, code = 'PROVIDER_UPSTREAM'): LlmStreamChunk {
  return { type: 'finish', reason: { kind: 'error', failure: { message, code } } };
}

/** 构造终态 aborted chunk。 */
export function finishAborted(message: string, code = 'CANCELLED'): LlmStreamChunk {
  return { type: 'finish', reason: { kind: 'aborted', failure: { message, code } } };
}

/** 构造终态 tool-calls chunk。 */
export function finishToolCalls(): LlmStreamChunk {
  return { type: 'finish', reason: { kind: 'tool-calls' } };
}

/** 构造一个用户文本消息（LlmMessage）。 */
export function userTextMessage(text: string): LlmMessage {
  return { role: 'user', content: [{ type: 'text', text }] };
}
