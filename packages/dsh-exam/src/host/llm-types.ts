/**
 * DSH `@deepseek-ai/dsh-llm@0.1.0-rc.7` 真实类型的结构化镜像（Phase 0 子集）。
 *
 * 逐一对照 DSH 安装包内真实声明编写（不猜测 API）：
 * - `GenerateOptions` → `lib/types/types.d.ts`（provider/model/messages/system/
 *   temperature/maxTokens/stop/signal/purpose；本镜像省略 sessionId 等字段）
 * - `StreamChunk`     → 同上（block-start/text-delta/reasoning-delta/
 *   tool-call-delta/block-end/usage/finish 联合）
 * - `FinishReason`    → 同上（stop/tool-calls/max-tokens/aborted/error）
 * - `Message` / `ContentBlock` / `TokenUsage` → `lib/types/message.d.ts`、`types.d.ts`
 *
 * 镜像刻意不携带品牌类型（MessageId/SessionId，真实类型来自 dsh-brand）与完整
 * 字段，只保留 Phase 0 需要的结构；真实 DSH 对象满足这些结构（多余字段在非
 * 字面量赋值下兼容）。若未来需要更多字段，按真实声明逐个补齐即可。
 */

/** 可见文本块（真实：TextBlock）。 */
export interface LlmTextBlock {
  type: 'text';
  text: string;
}

/** 推理内容块（真实：ReasoningBlock），不计入可见文本。 */
export interface LlmReasoningBlock {
  type: 'reasoning';
  text: string;
}

/** 模型请求的工具调用块（真实：ToolCallBlock；id 为 CallId）。 */
export interface LlmToolCallBlock {
  type: 'tool-call';
  id: string;
  name: string;
  /** 原始 JSON 字符串。 */
  arguments: string;
}

/** 光栅图像引用块（真实：ImageBlock；attachment 为 dsh-attachment 引用）。 */
export interface LlmImageBlock {
  type: 'image';
  /** 本镜像不依赖 dsh-attachment，故以 unknown 占位；真实对象可赋值。 */
  attachment: unknown;
}

/** 工具结果块（真实：ToolResultBlock）。 */
export interface LlmToolResultBlock {
  type: 'tool-result';
  toolCallId: string;
  content: LlmContentBlock[];
  isError?: boolean;
}

/**
 * 内容块联合（真实：ContentBlock 合并可扩展）。
 * 与真实声明保持同宽，保证真实 StreamChunk 可赋值给本镜像类型。
 */
export type LlmContentBlock =
  | LlmTextBlock
  | LlmReasoningBlock
  | LlmImageBlock
  | LlmToolCallBlock
  | LlmToolResultBlock;

/** 一条对话消息（真实：Message；含 id/source，本镜像省略）。 */
export interface LlmMessage {
  role: 'system' | 'user' | 'assistant';
  content: LlmContentBlock[];
}

/** 序列化 provider/传输失败事实（真实：LlmFailure）。 */
export interface LlmFailure {
  readonly message: string;
  readonly code: string;
  readonly status?: number;
  readonly providerRetryAfterMs?: number;
  readonly requestId?: string;
}

/** 终态原因联合（真实：FinishReason，合并可扩展；本镜像为子集）。 */
export type LlmFinishReason =
  | { kind: 'stop' }
  | { kind: 'tool-calls' }
  | { kind: 'max-tokens' }
  | { kind: 'aborted'; failure: LlmFailure }
  | { kind: 'error'; failure: LlmFailure };

/** token 统计（真实：TokenUsage；计数互斥：inputTokens 不含 cache 命中）。 */
export interface LlmTokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  reasoningTokens?: number;
}

/** 原始流 chunk（真实：StreamChunk）。 */
export type LlmStreamChunk =
  | { type: 'block-start'; index: number; blockType: LlmContentBlock['type'] }
  | { type: 'text-delta'; index: number; text: string }
  | { type: 'reasoning-delta'; index: number; text: string }
  | { type: 'tool-call-delta'; index: number; id: string; name?: string; argumentsDelta: string }
  | { type: 'block-end'; index: number; block: LlmContentBlock }
  | { type: 'usage'; usage: LlmTokenUsage }
  | { type: 'finish'; reason: LlmFinishReason };

/** 一次完整模型请求（真实：GenerateOptions；本镜像为 Phase 0 子集）。 */
export interface LlmGenerateOptions {
  /** 已注册 provider 路由（真实文档：'Registered provider route selecting the adapter instance.'）。 */
  provider: string;
  model: string;
  /** 有序对话消息，provider 视角（system slot 之后）。 */
  messages: LlmMessage[];
  /** 系统提示词（adapter 映射到 provider system slot）。 */
  system?: string;
  temperature?: number;
  maxTokens?: number;
  /** 思考深度 id（真实类型为 branded ReasoningEffortId；本镜像放宽为 string，运行时原样透传）。 */
  reasoningEffort?: string;
  /** 停止序列（命中即结束生成，停止串本身不进入输出）。 */
  stop?: string[];
  signal?: AbortSignal;
  /** 辅助调用分类（真实：'compaction' | 'session-title'）。 */
  purpose?: 'compaction' | 'session-title';
}
