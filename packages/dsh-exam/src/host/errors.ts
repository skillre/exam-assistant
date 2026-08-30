/**
 * dsh-exam 领域错误（共享模块）：稳定机器码 + 统一异常类型。
 *
 * service.ts / practice.ts / 路由层共用同一错误词汇表；HTTP 层按 code
 * 映射状态码（见 index.ts mapServiceError）。本模块不依赖 Cordis 与
 * store/llm 业务模块（仅 llm.ts 的 ExamLlmError 用于错误透传）。
 */
import { ExamLlmError } from './llm.ts';

/** 稳定错误码。 */
export type ExamServiceErrorCode =
  // 题库 / 题目
  | 'EXAM_BANK_NAME_REQUIRED'
  | 'EXAM_BANK_NOT_FOUND'
  | 'EXAM_QUESTION_NOT_FOUND'
  | 'EXAM_INVALID_QUESTION'
  // 练习 / 作答
  | 'EXAM_PRACTICE_NOT_FOUND'
  | 'EXAM_QUESTION_NOT_IN_PRACTICE'
  | 'EXAM_INVALID_SCOPE'
  // t1 领域正确性：会话状态与范围守卫
  | 'EXAM_PRACTICE_FINISHED'
  | 'EXAM_EMPTY_PRACTICE_SCOPE'
  // 存储
  | 'EXAM_STORE_CLOSED'
  | 'EXAM_STORE_UNAVAILABLE'
  | 'EXAM_STORE_FAILED'
  // 请求 / LLM
  | 'EXAM_INVALID_BODY'
  | 'EXAM_LLM_NO_PROVIDER'
  | 'EXAM_LLM_NO_MODEL'
  | 'EXAM_LLM_UNAVAILABLE'
  | 'EXAM_LLM_TIMEOUT'
  | 'EXAM_LLM_ABORTED'
  | 'EXAM_LLM_TOOL_CALL'
  | 'EXAM_LLM_PROVIDER_ERROR'
  | 'EXAM_LLM_STREAM_FAILED'
  // Phase 2：essay 批改 / Tutor / AI 导入 / 学习计划
  | 'EXAM_NOT_ESSAY'
  | 'EXAM_ESSAY_ANSWER_REQUIRED'
  | 'EXAM_ESSAY_GRADING_NOT_FOUND'
  | 'EXAM_TUTOR_SESSION_NOT_FOUND'
  | 'EXAM_TUTOR_MESSAGE_REQUIRED'
  // t5：Tutor 状态机 / AI 导入幂等
  | 'EXAM_TUTOR_SESSION_CLOSED'
  | 'EXAM_TUTOR_TURN_IN_FLIGHT'
  | 'EXAM_TUTOR_TURN_CONFLICT'
  | 'EXAM_IMPORT_DRAFT_NOT_FOUND'
  | 'EXAM_IMPORT_DRAFT_CONSUMED'
  | 'EXAM_IMPORT_BATCH_CONFLICT'
  | 'EXAM_IMPORT_DUPLICATE_ITEM'
  | 'EXAM_IMPORT_EMPTY'
  | 'EXAM_IMPORT_PARSE_FAILED'
  | 'EXAM_PLAN_NOT_FOUND'
  | 'EXAM_PLAN_ITEM_NOT_FOUND'
  // Phase 4：题目 AI 解析（P 个性化 / G 通用）
  | 'EXAM_NOT_GRADED'
  | 'EXAM_EXPLANATION_NOT_FOUND'
  | 'EXAM_INTERNAL';

const EXAM_SERVICE_ERROR_CODES: readonly ExamServiceErrorCode[] = [
  'EXAM_BANK_NAME_REQUIRED',
  'EXAM_BANK_NOT_FOUND',
  'EXAM_QUESTION_NOT_FOUND',
  'EXAM_INVALID_QUESTION',
  'EXAM_PRACTICE_NOT_FOUND',
  'EXAM_QUESTION_NOT_IN_PRACTICE',
  'EXAM_INVALID_SCOPE',
  'EXAM_PRACTICE_FINISHED',
  'EXAM_EMPTY_PRACTICE_SCOPE',
  'EXAM_STORE_CLOSED',
  'EXAM_STORE_UNAVAILABLE',
  'EXAM_STORE_FAILED',
  'EXAM_INVALID_BODY',
  'EXAM_LLM_NO_PROVIDER',
  'EXAM_LLM_NO_MODEL',
  'EXAM_LLM_UNAVAILABLE',
  'EXAM_LLM_TIMEOUT',
  'EXAM_LLM_ABORTED',
  'EXAM_LLM_TOOL_CALL',
  'EXAM_LLM_PROVIDER_ERROR',
  'EXAM_LLM_STREAM_FAILED',
  'EXAM_NOT_ESSAY',
  'EXAM_ESSAY_ANSWER_REQUIRED',
  'EXAM_ESSAY_GRADING_NOT_FOUND',
  'EXAM_TUTOR_SESSION_NOT_FOUND',
  'EXAM_TUTOR_MESSAGE_REQUIRED',
  'EXAM_TUTOR_SESSION_CLOSED',
  'EXAM_TUTOR_TURN_IN_FLIGHT',
  'EXAM_TUTOR_TURN_CONFLICT',
  'EXAM_IMPORT_DRAFT_NOT_FOUND',
  'EXAM_IMPORT_DRAFT_CONSUMED',
  'EXAM_IMPORT_BATCH_CONFLICT',
  'EXAM_IMPORT_DUPLICATE_ITEM',
  'EXAM_IMPORT_EMPTY',
  'EXAM_IMPORT_PARSE_FAILED',
  'EXAM_PLAN_NOT_FOUND',
  'EXAM_PLAN_ITEM_NOT_FOUND',
  'EXAM_NOT_GRADED',
  'EXAM_EXPLANATION_NOT_FOUND',
  'EXAM_INTERNAL',
];

/** 领域服务错误；message 面向人类，code 面向机器。 */
export class ExamServiceError extends Error {
  readonly code: ExamServiceErrorCode;
  /** 附加上下文（t5：Tutor SSE 错误携带 sessionId/turnId/retryable 等）；可空。 */
  readonly meta?: Record<string, unknown>;

  constructor(code: ExamServiceErrorCode, message: string, meta?: Record<string, unknown>) {
    super(message);
    this.name = 'ExamServiceError';
    this.code = code;
    this.meta = meta;
  }
}

export function isExamServiceErrorCode(value: string): value is ExamServiceErrorCode {
  return (EXAM_SERVICE_ERROR_CODES as readonly string[]).includes(value);
}

/**
 * 把任意未知错误映射为 ExamServiceError：ExamLlmError 的稳定码透传，
 * 其余走 fallbackCode（message 附带原始信息）。
 * meta 可选：提供时合并到结果的 meta（已携带 meta 的 ExamServiceError 会重建以保留）。
 */
export function toServiceError(
  error: unknown,
  fallbackCode: ExamServiceErrorCode,
  fallbackMessage: string,
  meta?: Record<string, unknown>,
): ExamServiceError {
  if (error instanceof ExamServiceError) {
    if (meta === undefined) return error;
    return new ExamServiceError(error.code, error.message, { ...error.meta, ...meta });
  }
  if (error instanceof ExamLlmError) {
    // llm.ts 的稳定错误码（EXAM_LLM_TIMEOUT / ABORTED / TOOL_CALL /
    // PROVIDER_ERROR / STREAM_FAILED）与 ExamServiceErrorCode 同词汇表，直接透传。
    if (isExamServiceErrorCode(error.code)) {
      return new ExamServiceError(error.code, error.message, meta);
    }
  }
  const message = error instanceof Error ? error.message : String(error);
  return new ExamServiceError(fallbackCode, `${fallbackMessage}: ${message}`, meta);
}
