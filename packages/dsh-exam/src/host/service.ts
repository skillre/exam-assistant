/**
 * Phase 1 最小考试领域服务（ExamService）：Host 侧路由/工具/Client RPC 共用的
 * 领域门面，以及 `createExamService` 工厂。
 *
 * 设计约束：
 * - 本模块不接触 Cordis `ctx`，不持有任何 live Cordis 对象；由 Host 插件
 *   （index.ts）把 `ExamStore` 与 `ExamLlm` 构造注入进来。
 * - 所有方法返回纯数据 DTO（JSON 可序列化），绝不把 live 对象暴露给调用方。
 * - 业务异常统一为 `ExamServiceError`（errors.ts，稳定机器码），由 HTTP 层
 *   映射状态码（400/404/405/500/503）。
 * - 题目 CRUD 直接映射 store（+输入校验）；练习/作答/错题本委托
 *   PracticeEngine（practice.ts）；Phase 2 AI 能力（essay 批改 / Tutor /
 *   导入 / 诊断 / 计划）委托 AiEngine（ai.ts）+ 纯统计 insights.ts。
 */
import { createHash, randomUUID } from 'node:crypto';
import { normalizeQueryLabel, type AttemptRow, type BankRow, type AddPlanItemInput, type DiagnosisRow, type EssayGradingRow, type ExamStore, type ExplanationRow, type ImportDraftRow, type PlanItemRow, type PracticeSessionRow, type QuestionRow, type StudyPlanRow, type TutorMessageRow, type TutorSessionRow, type TutorTurnRow } from './store.ts';
import type { ExamLlm, ExamLlmStreamResult } from './llm.ts';
import { ExamLlmError, EXAM_LLM_STREAM_FAILED, EXAM_LLM_ABORTED, userTextMessage } from './llm.ts';
import { ExamServiceError, toServiceError } from './errors.ts';
import { createPracticeEngine, toQuestionDto, type PracticeEngine } from './practice.ts';
import { buildInsightSummary } from './insights.ts';
import {
  buildTutorContext,
  computeTutorInputBudget,
  createAiEngine,
  estimateTokens,
  EXPLAIN_PROMPT_VERSION,
  normalizeAnswerNorm,
  renderTutorQuestion,
  trimTutorHistory,
  TUTOR_SYSTEM,
  type AiEngine,
  type ExplainContextDto,
  type TopicSuggestionSource,
  type TutorModelContextInfo,
} from './ai.ts';
import type { LlmMessage } from './llm-types.ts';
import type {
  ApplyTopicsResult,
  BulkQuestionOp,
  BulkQuestionsResult,
  ChatTutorResultDto,
  CommitImportResult,
  CreateQuestionRequest,
  DiagnosisDto,
  DiagnosisRecordDto,
  EssayGradingDto,
  EssayGradingResultDto,
  ExamAttemptDto,
  ExamQuestionDto,
  ExamQuestionType,
  ExplainDepth,
  ExplainResultDto,
  ExplanationDto,
  ImportedQuestionDto,
  ImportGenerateResultDto,
  InsightQueryInput,
  InsightSummaryDto,
  ListDiagnosesResult,
  ListPlansResult,
  ListQuestionsFilter,
  PlanDraft,
  PlanDto,
  PlanItemDto,
  PlanItemInput,
  PlanWithItemsDto,
  PracticeHistoryItemDto,
  PracticeScopeDto,
  PracticeSessionDto,
  ScorecardDto,
  TopicSuggestionsResultDto,
  TutorMessageDto,
  TutorSessionDto,
  UpdateQuestionRequest,
  WrongEntryDto,
} from './contract.ts';

// 复用导出（index.ts 等旧导入点不变）。
export { ExamServiceError } from './errors.ts';
export type { ExamServiceErrorCode } from './errors.ts';

/** 领域 DTO：题库（与 @exam/shared.Bank 同构）。 */
export type ExamBank = BankRow;

/** 服务健康信息（纯数据；store 部分由 ExamStore.health() 映射而来）。 */
export interface ExamServiceHealth {
  readonly ok: boolean;
  /** 服务标识，稳定字符串。 */
  readonly service: 'exam';
  readonly store: {
    readonly ok: boolean;
    readonly path: string;
    readonly closed: boolean;
    readonly schemaVersion: number;
  };
  /** 当前题库数量。 */
  readonly banks: number;
  /** llm 是否已接线。 */
  readonly llmReady: boolean;
  /** 服务创建时间（epoch 毫秒）。 */
  readonly startedAt: number;
  /** 失败原因（ok=false 时）。 */
  readonly error?: string;
}

/** 创建题库的输入。 */
export interface CreateBankInput {
  /** 题库名；去首尾空白后必须非空。 */
  name: string;
  /** 可选显式 id（缺省生成 randomUUID）。 */
  id?: string;
}

/** `bulkQuestions` 的 explain-generic 分支路由/取消参数（由路由层 resolveLlmRoute 后传入）。 */
export interface BulkExplainOpts {
  provider?: string;
  model?: string;
  reasoningEffort?: string;
  signal?: AbortSignal;
}

/** LLM 测试输入（provider/model 由路由层解析为具体值后传入）。 */
export interface ExamLlmTestInput {
  /** 测试提示词；非空。 */
  prompt: string;
  /** 已注册的 provider 路由（如 'deepseek'）。 */
  provider: string;
  /** 模型 id。 */
  model: string;
  /** 输出上限（透传底层调用）。 */
  maxTokens?: number;
  /** 超时毫秒（缺省 60s，透传底层调用）。 */
  timeoutMs?: number;
  /** 调用方取消信号（客户端断开时中止底层调用）。 */
  signal?: AbortSignal;
}

/** AI 文本导入的最小资料长度（字符）。 */
export const IMPORT_TEXT_MIN_LENGTH = 50;

/**
 * 导入提交输入（t5）：draftId 优先于 questions（二选一，二者都缺 → EXAM_INVALID_BODY）；
 * batchId 命中已提交批次 → 重放。
 */
export interface ImportCommitInput {
  questions?: CreateQuestionRequest[];
  batchId?: string;
  draftId?: string;
}

/** 最小考试领域服务。 */
export interface ExamService {
  /** 健康探测：200/503 语义由调用方（HTTP 层）决定。 */
  health(): ExamServiceHealth;

  /** 全部题库（按创建时间升序；t9：默认排除已归档/已删除，includeArchived/includeDeleted 可恢复查看）。 */
  listBanks(options?: { includeArchived?: boolean; includeDeleted?: boolean }): ExamBank[];

  /** 创建题库；name 非法抛 ExamServiceError(BANK_NAME_REQUIRED)。 */
  createBank(input: CreateBankInput): ExamBank;

  // ── t9：题库生命周期 ───────────────────────────────────────────────────

  /** 重命名题库；不存在 → EXAM_BANK_NOT_FOUND；name 非法 → EXAM_BANK_NAME_REQUIRED。 */
  renameBank(id: string, name: string): ExamBank;

  /** 软归档题库；不存在 → EXAM_BANK_NOT_FOUND。 */
  archiveBank(id: string): ExamBank;

  /** 恢复题库（清空归档/删除标记）；不存在 → EXAM_BANK_NOT_FOUND。 */
  restoreBank(id: string): ExamBank;

  /** 软删除题库；不存在 → EXAM_BANK_NOT_FOUND；已删除幂等。 */
  deleteBank(id: string): void;

  // ── Phase 1：题目 CRUD ────────────────────────────────────────────────

  /** 创建题目；输入非法 → EXAM_INVALID_QUESTION；题库不存在 → EXAM_BANK_NOT_FOUND。 */
  createQuestion(bankId: string, input: CreateQuestionRequest): ExamQuestionDto;

  /** 部分更新题目；不存在 → EXAM_QUESTION_NOT_FOUND。 */
  updateQuestion(id: string, patch: UpdateQuestionRequest): ExamQuestionDto;

  /** 删除题目（级联清理作答/错题本）；不存在 → EXAM_QUESTION_NOT_FOUND。 */
  deleteQuestion(id: string): void;

  /** 恢复已软删除题目；不存在 → EXAM_QUESTION_NOT_FOUND。 */
  restoreQuestion(id: string): void;

  /** 按 id 取题目；不存在返回 undefined。 */
  getQuestion(id: string): ExamQuestionDto | undefined;

  /** 题库题目列表（t9：支持 q/type/tags/hasExplanation/sort 过滤）。 */
  listQuestionsByBank(bankId: string, filter?: ListQuestionsFilter): ExamQuestionDto[];

  /** 批量题目操作（t9：tag/move/archive/restore/delete/explain-generic；explain-generic 需 LLM 路由）。 */
  bulkQuestions(input: BulkQuestionOp, opts?: BulkExplainOpts): Promise<BulkQuestionsResult>;

  // ── Phase 1：练习 / 作答 / 错题本（委托 PracticeEngine）────────────────

  /** 按范围解析题目 ID（可 shuffle；byType/byTag 缺筛选值回退 all+warn）。 */
  resolveQuestionIds(bankId: string, scope: PracticeScopeDto, shuffle?: boolean, seed?: string): string[];

  /** 建练习会话。 */
  startPractice(input: {
    bankId: string;
    scope: PracticeScopeDto;
    shuffle?: boolean;
    seed?: string;
    currentIndex?: number;
  }): PracticeSessionDto;

  /** 续做：会话 + 每题最新作答。 */
  resumePractice(id: string): { practice: PracticeSessionDto; latestAttempts: ExamAttemptDto[] };

  /** 更新进度下标。 */
  updatePracticeIndex(id: string, currentIndex: number): PracticeSessionDto;

  /** 删除练习会话（历史条目移除，作答记录保留）。不存在 → EXAM_PRACTICE_NOT_FOUND。 */
  deletePractice(id: string): void;

  /**
   * 判分 + 记录作答 + 更新错题本。**essay 题目在此抛 EXAM_INVALID_QUESTION**
   * （提示走批改接口 /exam/api/grading/essay），essay 判分见 gradeEssay。
   */
  gradeAnswer(input: { practiceId: string; questionId: string; answer: unknown }): {
    attempt: ExamAttemptDto;
    isCorrect: boolean;
  };

  /** 成绩单（每题最新作答聚合）。 */
  buildScorecard(id: string): ScorecardDto;

  /** 结束会话并返回成绩单。 */
  finishPractice(id: string): { practice: PracticeSessionDto; scorecard: ScorecardDto };

  /** 错题列表。 */
  listWrong(options: { bankId?: string; includeMastered?: boolean }): WrongEntryDto[];

  /** 设置/取消掌握标记。 */
  setMastered(questionId: string, mastered: boolean): WrongEntryDto;

  // ── Phase 0：LLM 测试 ─────────────────────────────────────────────────

  /**
   * 测试 LLM 链路：流式调用一次，每段 text-delta 经 onDelta 回调；
   * 终态归一化为结果/错误。未接线 llm 时抛
   * ExamServiceError('EXAM_LLM_UNAVAILABLE')。
   */
  testLlmStream(
    input: ExamLlmTestInput,
    onDelta?: (delta: string) => void,
  ): Promise<ExamLlmStreamResult>;

  // ── Phase 2：essay 批改 / Tutor / AI 导入 / 学情 / 计划 / 历史 ─────────

  /**
   * essay 主观题批改：校验题目存在且为 essay（否则 EXAM_NOT_ESSAY）、
   * 作答非空（EXAM_ESSAY_ANSWER_REQUIRED）、practiceId 合法（若给，
   * 否则 EXAM_PRACTICE_NOT_FOUND）→ ai.gradeEssay（onDelta 透传 LLM
   * 原文）→ 归一 isCorrect=score>=60 → recordAttempt + touchWrong +
   * saveEssayGrading（重批 upsert）→ 返回 { attemptId, grading }。
   * provider/model 缺省由路由层解析；本层缺省抛 EXAM_LLM_UNAVAILABLE。
   * signal：调用方取消信号（SSE 客户端断开时中止底层 LLM 调用）。
   */
  gradeEssay(
    input: {
      questionId: string;
      practiceId?: string;
      userAnswer: string;
      provider?: string;
      model?: string;
      signal?: AbortSignal;
    },
    onDelta?: (delta: string) => void,
  ): Promise<EssayGradingResultDto>;

  /** 按 attemptId 取 essay 批改结果（练习内回看用）；不存在返回 undefined。 */
  getEssayGrading(attemptId: string): EssayGradingDto | undefined;

  /** 按 id 取 Tutor 会话；不存在返回 undefined。 */
  getTutorSession(id: string): TutorSessionDto | undefined;

  /** Tutor 会话列表（created_at DESC, id DESC；缺省 30 条）。 */
  listTutorSessions(limit?: number): TutorSessionDto[];

  /** Tutor 会话消息列表（created_at ASC, id ASC；会话不存在返回空数组）。 */
  listTutorMessages(sessionId: string): TutorMessageDto[];

  /** 关闭 Tutor 会话（status→closed；幂等：已 closed 原样返回）；不存在 → EXAM_TUTOR_SESSION_NOT_FOUND。 */
  closeTutorSession(id: string): TutorSessionDto;

  /** 硬删除 Tutor 会话（级联删除消息与 turns）；不存在 → EXAM_TUTOR_SESSION_NOT_FOUND。 */
  deleteTutorSession(id: string): void;

  /**
   * Tutor 多轮对话（t5 状态机）：一次「用户提问 → AI 回复」为一个持久化 turn。
   * - clientMessageId 幂等：命中 done turn → 重放（零 LLM）；命中 pending/failed/
   *   cancelled/孤儿 streaming → 复用同一 turn 重试（user 消息不重复落库）；
   *   streaming 且进程内有在途 flight → 409 EXAM_TUTOR_TURN_IN_FLIGHT。
   * - closed 会话 → 409 EXAM_TUTOR_SESSION_CLOSED；sessionId 与 turn 归属不一致
   *   → 409 EXAM_TUTOR_TURN_CONFLICT。
   * - 历史按 modelInfo（contextWindow/defaultMaxTokens）做 token 预算裁剪。
   * - 失败/取消时抛错携带 meta：{ sessionId, turnId, retryable }（路由层转 SSE error 载荷）。
   * sessionId 缺省 = 新建会话（questionId 可选自由问答）；message 空 → EXAM_TUTOR_MESSAGE_REQUIRED。
   */
  chatTutor(
    input: {
      sessionId?: string;
      questionId?: string;
      bankId?: string;
      message: string;
      provider?: string;
      model?: string;
      signal?: AbortSignal;
      /** t5 幂等键：同一逻辑消息重试复用；缺省服务端生成 srv-* 占位（无幂等）。 */
      clientMessageId?: string;
      /** t5：模型上下文信息（路由层 resolveModelInfo 解析后传入，token 预算用）。 */
      modelInfo?: TutorModelContextInfo;
    },
    onDelta?: (delta: string) => void,
  ): Promise<ChatTutorResultDto>;

  /** AI 文本导入：资料（≥50 字符，否则 EXAM_IMPORT_EMPTY）→ 至多 8 道客观题草稿 + 持久化 draftId（不落题库）。 */
  listImportedQuestions(input: {
    text: string;
    provider?: string;
    model?: string;
    signal?: AbortSignal;
  }): Promise<ImportGenerateResultDto>;

  /**
   * 批量入库（t5 原子 + 幂等）：
   * - draftId 优先：从持久化草稿载入条目，与批次同事务；成功置 committed，再 commit → 409。
   * - batchId 命中已提交批次 → 重放（replayed:true，零写入）；bank 不一致 → 409。
   * - 否则 withTransaction 原子提交：逐题 createQuestion（服务端校验）+ 写入批次
   *   （同批次重复 item_key → EXAM_IMPORT_DUPLICATE_ITEM 整批回滚）；任何失败
   *   ROLLBACK，批次行不存在 → 客户端重试整批重跑，零残留。
   */
  importQuestions(bankId: string, input: ImportCommitInput): CommitImportResult;

  /** 按 id 取持久化导入草稿；不存在 → EXAM_IMPORT_DRAFT_NOT_FOUND；非 open → EXAM_IMPORT_DRAFT_CONSUMED。 */
  getImportDraft(id: string): ImportedQuestionDto[];

  /** 丢弃持久化导入草稿（置 discarded）；不存在 → EXAM_IMPORT_DRAFT_NOT_FOUND。 */
  discardImportDraft(id: string): void;

  /** 学情洞察摘要（纯统计聚合，不依赖 LLM；可选窗口 7/14/30 天与题库过滤）。 */
  listInsight(input?: InsightQueryInput): InsightSummaryDto;

  /** LLM 学情诊断：输入统计摘要 → 结构化结果；成功即落库（t13），返回携带 id 的诊断记录。 */
  diagnoseInsight(input: { provider?: string; model?: string; signal?: AbortSignal }): Promise<DiagnosisRecordDto>;

  /** 诊断历史（created_at DESC；缺省 10 条）。 */
  listDiagnoses(limit?: number): ListDiagnosesResult;

  /** LLM 生成学习计划（≤7 条）并落库，返回 { plan, items }。 */
  generatePlan(input: {
    provider?: string;
    model?: string;
    title?: string;
    signal?: AbortSignal;
  }): Promise<PlanWithItemsDto>;

  /** 计划列表（created_at DESC, id DESC；缺省 30 条）。 */
  listPlans(limit?: number): ListPlansResult;

  /** 计划及其全部条目；不存在 → EXAM_PLAN_NOT_FOUND。 */
  getPlan(id: string): PlanWithItemsDto;

  /** 追加计划条目（t9：接受结构化条目或旧版标题字符串）；计划不存在 → EXAM_PLAN_NOT_FOUND；非法 → EXAM_INVALID_BODY。 */
  addPlanItems(planId: string, items: Array<string | PlanItemInput>): PlanWithItemsDto;

  /** 设置条目完成状态；计划/条目不存在 → EXAM_PLAN_NOT_FOUND / EXAM_PLAN_ITEM_NOT_FOUND。 */
  setPlanItemDone(planId: string, itemId: string, done: boolean): PlanItemDto;

  /** 删除整个计划（级联删除条目）；不存在 → EXAM_PLAN_NOT_FOUND。 */
  deletePlan(id: string): void;

  /** 删除单条计划条目（同事务重算计划状态）；不存在 → EXAM_PLAN_NOT_FOUND / EXAM_PLAN_ITEM_NOT_FOUND。 */
  deletePlanItem(planId: string, itemId: string): void;

  /** 手动新建计划（source='manual'，含可选初始条目；t9 支持结构化条目）。 */
  createManualPlan(input: { title: string; items?: Array<string | PlanItemInput> }): PlanWithItemsDto;

  /** 练习历史（created_at DESC；finished 附 scorecard，active 附 answeredCount）。 */
  listPracticeHistory(limit?: number): PracticeHistoryItemDto[];

  // ── Phase 4：题目 AI 解析（P 个性化 / G 通用）──────────────────────────

  /**
   * 练习内个性化解析（P 形态，SSE 流式）。校验链有序：
   * practice 存在（404 EXAM_PRACTICE_NOT_FOUND）→ question 存在（404
   * EXAM_QUESTION_NOT_FOUND）且属于该会话题单（EXAM_QUESTION_NOT_IN_PRACTICE）→
   * 该 (practiceId, questionId) 已有 attempt（否则 **409 EXAM_NOT_GRADED**
   * ——防泄露硬边界，设计 §2.2）→ essay 题拒绝（400 EXAM_INVALID_QUESTION，
   * 解析复用既有批改反馈）。
   *
   * 缓存语义（设计 §5）：默认先按 (questionId, answerNorm(attempt.user_answer))
   * 探测缓存——**命中直接返回 cached:true，不解析 LLM 路由也不调用 LLM**；
   * `force:true`（「重新解析」）跳过缓存读取直调 LLM。未命中走
   * ai.explainOnce 流式（signal/onDelta 全透传），仅成功完成后 upsert 落库
   * （同键覆盖为单份最新）；取消/中止/失败零写入。
   */
  explainQuestion(
    input: {
      practiceId: string;
      questionId: string;
      provider?: string;
      model?: string;
      reasoningEffort?: string;
      /** 解析深度档；缺省 light。 */
      depth?: ExplainDepth;
      /** t1：模型上下文信息（路由层 resolveLlmRoute 解析后传入；deep 档 maxTokens 计算用）。 */
      modelInfo?: { contextWindow?: number; defaultMaxTokens?: number };
      force?: boolean;
      signal?: AbortSignal;
    },
    onDelta?: (delta: string) => void,
  ): Promise<ExplainResultDto>;

  /**
   * 解析缓存探测（GET /exam/api/practice/explain）。校验链与 explainQuestion
   * 完全一致（含 409 防泄露边界与 essay 400）；缓存未命中抛
   * **404 EXAM_EXPLANATION_NOT_FOUND**。路由层同时把它用作 POST SSE 的
   * 流前域校验（错误以 JSON 而非 SSE error 呈现，见 handlePracticeExplain）。
   */
  getPracticeExplanation(input: { practiceId: string; questionId: string; depth?: ExplainDepth }): ExplanationDto;

  /**
   * 题库通用解析（G 形态，JSON 非流式）：ai.explainOnce(generic) 一次生成 →
   * 写回 questions.explanation（覆盖旧值；再次调用即「重新解析」）→ 返回更新后
   * question DTO。essay 题拒绝（400 EXAM_INVALID_QUESTION，与 P 形态一致）；
   * 题目不存在 404。
   */
  explainGenericQuestion(input: {
    questionId: string;
    provider?: string;
    model?: string;
    reasoningEffort?: string;
    signal?: AbortSignal;
  }): Promise<ExamQuestionDto>;

  /**
   * P2 知识标注草稿（M5）：读该库活跃客观题（essay 跳过；优先 topics 为空的题），
   * 批量调用 LLM 生成知识点建议（ai.parseTopicSuggestions，8-10 题/批）；
   * 返回草稿 DTO（客户端确认后再经 applyTopics 写回）。limit 缺省 50，上限 100。
   * questionIds 提供时（字符串数组，1-20 个）：忽略「优先 topics 为空」的默认挑选，
   * 仅对这批题目生成建议（须存在且属于该库且为客观题，违规 4xx）。
   */
  explainTopicSuggestions(input: {
    bankId: string;
    limit?: number;
    questionIds?: string[];
    provider?: string;
    model?: string;
    signal?: AbortSignal;
  }): Promise<TopicSuggestionsResultDto>;

  /**
   * P2 用户确认后的批量写回（M5，POST /exam/api/questions/topics）：
   * 逐题校验存在（活跃）+ topics 1-4 个 + 不得与该题 tags 同项，whole batch
   * 事务内先全校验后应用（任一非法 → 整批回滚），写入 topicsSource='batch'。
   * 返回 { updated }。
   */
  applyTopics(items: { questionId: string; topics: string[] }[]): ApplyTopicsResult;

  /** 幂等关闭底层存储（路由层在插件卸载时调用）。 */
  close(): void;
}

/** `createExamService` 的构造依赖。 */
export interface ExamServiceDeps {
  /**
   * 可选：store 未打开（打开失败/降级模式）时缺省，服务仍可提供
   * health（503 可读错误）与 LLM 测试，bank/题目/练习操作抛
   * EXAM_STORE_UNAVAILABLE。
   */
  readonly store?: ExamStore;
  /** 可选：Phase 0 只接线，供后续工具/SSE 路由使用。 */
  readonly llm?: ExamLlm;
}

const QUESTION_TYPES: readonly ExamQuestionType[] = ['single', 'multiple', 'boolean', 'essay'];

/** 用 store（+可选 llm）构造最小 ExamService；模块自身不接触 ctx。 */
export function createExamService(deps: ExamServiceDeps): ExamService {
  const { store, llm } = deps;
  const startedAt = Date.now();
  const engine: PracticeEngine = createPracticeEngine(store);
  // Phase 2：AI 能力门面（llm 未接线时为 undefined，调用处抛 EXAM_LLM_UNAVAILABLE）。
  const ai: AiEngine | undefined = llm === undefined ? undefined : createAiEngine(llm);

  // t5 进程内状态（DSH 单进程部署假设成立；重启即清空，DB 无在途态）：
  // - inFlightTurns：Tutor turn 在途 flight（同键并发 → 409 EXAM_TUTOR_TURN_IN_FLIGHT）；
  //   进程重启后残留的 streaming（不在集合内）视为孤儿，允许重试。
  // - inFlightExplains：解析 single-flight（force/普通各自独立键）。
  const inFlightTurns = new Set<string>();
  const inFlightExplains = new Map<string, Promise<ExplainResultDto>>();

  // 题目创建内部路径：路由/导入共用；meta 携带 AI 导入批次字段（服务层单写方法
  // createQuestion 对外契约不变——CreateQuestionRequest 无批次字段）。
  const createQuestionInternal = (
    bankId: string,
    input: CreateQuestionRequest,
    meta?: { importBatchId: string; importItemKey: string },
  ): ExamQuestionDto => {
    assertStoreOpen(store);
    requireBankExists(store, bankId);
    validateQuestionInput(input);
    try {
      return toQuestionDto(
        store.createQuestion(bankId, {
          type: input.type,
          stem: input.stem,
          options: input.options,
          answer: input.answer,
          explanation: input.explanation ?? null,
          tags: input.tags ?? null,
          topics: input.topics ?? null,
          // 来源：手工创建 manual；AI 导入（meta 存在）import。
          topicsSource: meta === undefined ? 'manual' : 'import',
          importBatchId: meta?.importBatchId ?? null,
          importItemKey: meta?.importItemKey ?? null,
        }),
      );
    } catch (error) {
      throw toServiceError(error, 'EXAM_STORE_FAILED', 'failed to create question');
    }
  };

  // 导入 item_key：sha256(type|stem|JSON(options)|JSON(answer))——同批次内容相同即重复。
  const computeImportItemKey = (input: CreateQuestionRequest): string => {
    const serialized = `${input.type}|${input.stem}|${JSON.stringify(input.options ?? [])}|${JSON.stringify(input.answer)}`;
    return createHash('sha256').update(serialized).digest('hex');
  };

  // G 形态「通用解析」的实际执行体（单题与批量 bulk explain-generic 共用）：
  // provider/model/reasoningEffort/signal 由调用方（已 resolveLlmRoute）传入。
  const explainGenericCore = async (
    aiEngine: AiEngine,
    questionId: string,
    provider: string,
    model: string,
    reasoningEffort: string | undefined,
    signal: AbortSignal | undefined,
  ): Promise<ExamQuestionDto> => {
    assertStoreOpen(store);
    const question = requireQuestionRow(store, questionId);
    // G 形态与 P 一致拒绝 essay（裁决：批改 reference 已是解析，双源会漂移）。
    assertNotEssay(question);
    try {
      const result = await aiEngine.explainOnce({
        question,
        mode: 'generic',
        provider,
        model,
        reasoningEffort,
        signal,
      });
      if (signal?.aborted) {
        throw new ExamServiceError('EXAM_LLM_ABORTED', 'generic explanation generation aborted; nothing was persisted');
      }
      // 写回静态字段固化（再次调用即「重新解析」覆盖）；updated_at 随之刷新。
      return toQuestionDto(store.updateQuestion(question.id, { explanation: result.content }));
    } catch (error) {
      throw toServiceError(error, 'EXAM_LLM_STREAM_FAILED', 'generic explanation generation failed');
    }
  };

  // 解析生成实际执行体（single-flight 共享；force/普通由调用方键隔离）。
  const explainQuestionImpl = async (
    question: QuestionRow,
    attempt: AttemptRow,
    answerNorm: string,
    input: Parameters<ExamService['explainQuestion']>[0],
    onDelta?: (delta: string) => void,
  ): Promise<ExplainResultDto> => {
    assertStoreOpen(store);
    const { engine: aiEngine, provider, model } = requireLlmRoute(ai, llm, input.provider, input.model);
    const depth = input.depth ?? 'light';
    // t1 B：深档默认推理档位（high，读注册表配置——简单起见缺省 'high'）与显式
    // maxTokens = min(model support limit, contextWindow/3)；浅档跟随 DSH 默认。
    const reasoningEffort = depth === 'deep' ? (input.reasoningEffort ?? 'high') : input.reasoningEffort;
    const maxTokens = depth === 'deep' ? resolveDeepExplainMaxTokens(input.modelInfo) : undefined;
    // t1 M4：仅 deep 档组装个性化上下文（只读现有数据，无新端点；成本可控）。
    const context = depth === 'deep' ? buildExplainContext(store, question) : undefined;
    try {
      const result = await aiEngine.explainOnce(
        {
          question,
          mode: 'personalized',
          userAnswer: attempt.userAnswer,
          isCorrect: attempt.isCorrect,
          provider,
          model,
          reasoningEffort,
          ...(depth !== undefined ? { depth } : {}),
          ...(maxTokens !== undefined ? { maxTokens } : {}),
          ...(context !== undefined ? { context } : {}),
          signal: input.signal,
        },
        onDelta,
      );
      // 取消零落库（设计 §5）：即便底层流在 abort 后仍返回了文本（provider
      // 以正常 finish 收尾的行为差异），只要调用方 signal 已中止就绝不落库
      // ——非 force 的取消保持无缓存，force 的取消保留旧内容不动。
      if (input.signal?.aborted) {
        throw new ExamServiceError('EXAM_LLM_ABORTED', 'explanation generation aborted; nothing was persisted');
      }
      // t1 P3：deep 档剥离末尾 JSON topics 行（返回/落库的 content 不含该行），
      // 校验后合并写回（topicsSource='ai-deep'；浅档不产 topics 省成本）。
      const stripped = depth === 'deep' ? stripTrailingDeepTopics(result.content) : undefined;
      const content = stripped !== undefined ? stripped.content : result.content;
      if (stripped !== undefined) {
        applyDeepTopicWriteback(store, question, stripped.topics);
      }
      // 仅成功完成后落库（同键 INSERT OR REPLACE 覆盖为单份最新
      // （UNIQUE(question_id, answer_norm)，设计 §4）；t5 写入版本与 token 可追溯字段。
      const row = store.upsertExplanation({
        questionId: question.id,
        answerNorm,
        depth,
        content,
        model: result.model,
        provider,
        reasoningEffort: reasoningEffort ?? null,
        promptVersion: EXPLAIN_PROMPT_VERSION,
        questionUpdatedAt: question.updatedAt,
        inputTokens: result.usage?.inputTokens ?? null,
        outputTokens: result.usage?.outputTokens ?? null,
        finishReason: result.finish?.kind ?? null,
      });
      return toExplainResultDto(row, false);
    } catch (error) {
      throw toServiceError(error, 'EXAM_LLM_STREAM_FAILED', 'explanation generation failed');
    }
  };

  return {
    health() {
      // 降级模式：store 未打开（打开失败/初始化中）→ ok:false + 可读 error。
      if (store === undefined) {
        return {
          ok: false,
          service: 'exam',
          store: {
            ok: false,
            path: '(unopened)',
            closed: true,
            schemaVersion: 0,
          },
          banks: 0,
          llmReady: llm !== undefined,
          startedAt,
          error: 'exam store is not opened',
        };
      }
      const storeHealth = store.health();
      let banks = 0;
      let countError: string | undefined;
      if (storeHealth.ok) {
        try {
          banks = store.listBanks().length;
        } catch (error) {
          countError = error instanceof Error ? error.message : String(error);
        }
      }
      const ok = storeHealth.ok && countError === undefined;
      return {
        ok,
        service: 'exam',
        store: {
          ok: storeHealth.ok,
          path: storeHealth.path,
          closed: storeHealth.closed,
          schemaVersion: storeHealth.schemaVersion,
        },
        banks,
        llmReady: llm !== undefined,
        startedAt,
        error: countError ?? storeHealth.error,
      };
    },

    listBanks(options) {
      assertStoreOpen(store);
      try {
        return store.listBanks(options);
      } catch (error) {
        throw toServiceError(error, 'EXAM_STORE_FAILED', 'failed to list banks');
      }
    },

    createBank(input) {
      assertStoreOpen(store);
      const name = typeof input.name === 'string' ? input.name.trim() : '';
      if (name.length === 0) {
        throw new ExamServiceError('EXAM_BANK_NAME_REQUIRED', 'bank name must be a non-empty string');
      }
      try {
        return store.createBank({ name, id: input.id });
      } catch (error) {
        if (error instanceof ExamServiceError) throw error;
        throw toServiceError(error, 'EXAM_STORE_FAILED', 'failed to create bank');
      }
    },

    // ── t9：题库生命周期 ─────────────────────────────────────────────────

    renameBank(id, name) {
      assertStoreOpen(store);
      if (typeof name !== 'string' || name.trim().length === 0) {
        throw new ExamServiceError('EXAM_BANK_NAME_REQUIRED', 'bank name must be a non-empty string');
      }
      requireBankAnyState(store, id);
      try {
        return store.renameBank(id, name);
      } catch (error) {
        throw toServiceError(error, 'EXAM_STORE_FAILED', 'failed to rename bank');
      }
    },

    archiveBank(id) {
      assertStoreOpen(store);
      requireBankAnyState(store, id);
      try {
        return store.archiveBank(id);
      } catch (error) {
        throw toServiceError(error, 'EXAM_STORE_FAILED', 'failed to archive bank');
      }
    },

    restoreBank(id) {
      assertStoreOpen(store);
      requireBankAnyState(store, id);
      try {
        return store.restoreBank(id);
      } catch (error) {
        throw toServiceError(error, 'EXAM_STORE_FAILED', 'failed to restore bank');
      }
    },

    deleteBank(id) {
      assertStoreOpen(store);
      requireBankAnyState(store, id);
      try {
        store.deleteBank(id);
      } catch (error) {
        throw toServiceError(error, 'EXAM_STORE_FAILED', 'failed to delete bank');
      }
    },

    // ── 题目 CRUD ────────────────────────────────────────────────────────

    createQuestion(bankId, input) {
      return createQuestionInternal(bankId, input);
    },

    updateQuestion(id, patch) {
      assertStoreOpen(store);
      requireQuestionExists(store, id);
      if (Object.keys(patch).length === 0) {
        throw new ExamServiceError('EXAM_INVALID_QUESTION', 'update question requires at least one field');
      }
      validateQuestionPatch(patch);
      try {
        return toQuestionDto(store.updateQuestion(id, patch));
      } catch (error) {
        throw toServiceError(error, 'EXAM_STORE_FAILED', 'failed to update question');
      }
    },

    deleteQuestion(id) {
      assertStoreOpen(store);
      requireQuestionExists(store, id);
      try {
        store.deleteQuestion(id);
      } catch (error) {
        throw toServiceError(error, 'EXAM_STORE_FAILED', 'failed to delete question');
      }
    },

    restoreQuestion(id) {
      assertStoreOpen(store);
      if (store.getQuestionIncludingDeleted(id) === undefined) {
        throw new ExamServiceError('EXAM_QUESTION_NOT_FOUND', `question not found: ${id}`);
      }
      try {
        store.restoreQuestion(id);
      } catch (error) {
        throw toServiceError(error, 'EXAM_STORE_FAILED', 'failed to restore question');
      }
    },

    getQuestion(id) {
      assertStoreOpen(store);
      const row = store.getQuestion(id);
      return row === undefined ? undefined : toQuestionDto(row);
    },

    listQuestionsByBank(bankId, filter) {
      assertStoreOpen(store);
      requireBankExists(store, bankId);
      try {
        return store.listQuestionsByBank(bankId, filter).map(toQuestionDto);
      } catch (error) {
        throw toServiceError(error, 'EXAM_STORE_FAILED', 'failed to list questions');
      }
    },

    async bulkQuestions(input, opts) {
      assertStoreOpen(store);
      // explain-generic 为 LLM 批量解析（逐个生成并写回题目 explanation）；其余为存储层操作。
      if (input.op === 'explain-generic') {
        const { engine: aiEngine, provider, model } = requireLlmRoute(ai, llm, opts?.provider, opts?.model);
        const questions: ExamQuestionDto[] = [];
        for (const id of input.questionIds) {
          // 逐个生成：essay/已删除题目会被 explainGenericCore 拒绝（EXAM_INVALID_QUESTION / NOT_FOUND）。
          questions.push(await explainGenericCore(aiEngine, id, provider, model, opts?.reasoningEffort, opts?.signal));
        }
        return { applied: questions.length, questionIds: input.questionIds, questions };
      }
      return applyBulkQuestionOp(store, input);
    },

    // ── 练习 / 作答 / 错题本 ─────────────────────────────────────────────

    resolveQuestionIds(bankId, scope, shuffle, seed) {
      return engine.resolveQuestionIds(bankId, scope, shuffle, seed);
    },

    startPractice(input) {
      return engine.startPractice(input);
    },

    resumePractice(id) {
      return engine.resumePractice(id);
    },

    updatePracticeIndex(id, currentIndex) {
      return engine.updateIndex(id, currentIndex);
    },

    deletePractice(id) {
      engine.deletePractice(id);
    },

    gradeAnswer(input) {
      return engine.gradeAnswer(input);
    },

    buildScorecard(id) {
      return engine.buildScorecard(id);
    },

    finishPractice(id) {
      return engine.finishPractice(id);
    },

    listWrong(options) {
      return engine.listWrong(options);
    },

    setMastered(questionId, mastered) {
      return engine.setMastered(questionId, mastered);
    },

    // ── LLM 测试 ─────────────────────────────────────────────────────────

    testLlmStream(input, onDelta) {
      if (llm === undefined) {
        throw new ExamServiceError('EXAM_LLM_UNAVAILABLE', 'llm is not wired in this exam service');
      }
      const prompt = typeof input.prompt === 'string' ? input.prompt.trim() : '';
      if (prompt.length === 0) {
        throw new ExamServiceError('EXAM_INVALID_BODY', 'prompt must be a non-empty string');
      }
      return llm
        .streamOnce(
          {
            provider: input.provider,
            model: input.model,
            messages: [userTextMessage(prompt)],
            maxTokens: input.maxTokens,
            timeoutMs: input.timeoutMs,
            signal: input.signal,
          },
          onDelta,
        )
        .catch((error: unknown) => {
          throw toServiceError(error, 'EXAM_LLM_STREAM_FAILED', 'llm test call failed');
        });
    },

    // ── Phase 2：essay 批改 ──────────────────────────────────────────────

    async gradeEssay(input, onDelta) {
      assertStoreOpen(store);
      const question = requireQuestionRow(store, input.questionId);
      // QuestionRow.type 已含 'essay'（t1 类型修正），不再需要运行时扩宽。
      if (question.type !== 'essay') {
        throw new ExamServiceError(
          'EXAM_NOT_ESSAY',
          `question ${input.questionId} is not an essay question; use quiz/grade for objective questions`,
        );
      }
      const userAnswer = typeof input.userAnswer === 'string' ? input.userAnswer.trim() : '';
      if (userAnswer.length === 0) {
        throw new ExamServiceError('EXAM_ESSAY_ANSWER_REQUIRED', 'essay answer must be a non-empty string');
      }
      // t1：给定时校验 practice 存在、未 finished、且 question 属于该会话题单
      //（与客观判分同款守卫；防跨会话/会外批改污染成绩单）。
      if (input.practiceId !== undefined) {
        const practice = requirePracticeRow(store, input.practiceId);
        if (practice.status === 'finished') {
          throw new ExamServiceError(
            'EXAM_PRACTICE_FINISHED',
            `practice session ${input.practiceId} is finished; no further grading is allowed`,
          );
        }
        if (!practice.questionIds.includes(question.id)) {
          throw new ExamServiceError(
            'EXAM_QUESTION_NOT_IN_PRACTICE',
            `question ${question.id} is not part of practice ${input.practiceId}`,
          );
        }
      }
      const { engine: aiEngine, provider, model } = requireLlmRoute(ai, llm, input.provider, input.model);
      try {
        const grading = await aiEngine.gradeEssay(
          { question, userAnswer, provider, model, signal: input.signal },
          onDelta,
        );
        const isCorrect = grading.score >= 60;
        // t1：作答 + 错题本 + 批改同一事务（recordGradedEssay；attemptId 由事务内
        // 创建的 attempt 派生）——不再产生「有作答无批改」的孤儿中间态。
        // t5：批改落 provider/tokens/finish_reason 可追溯字段（P13）。
        const { grading: row } = store.recordGradedEssay({
          attempt: {
            questionId: question.id,
            practiceId: input.practiceId ?? null,
            userAnswer,
            isCorrect,
          },
          grading: {
            score: grading.score,
            verdict: grading.verdict,
            feedback: grading.feedback,
            reference: grading.reference ?? null,
            model: grading.model,
            provider: provider ?? null,
            inputTokens: grading.usage?.inputTokens ?? null,
            outputTokens: grading.usage?.outputTokens ?? null,
            finishReason: grading.finish?.kind ?? null,
          },
        });
        return {
          attemptId: row.attemptId,
          grading: {
            score: row.score,
            verdict: row.verdict,
            feedback: row.feedback,
            ...(row.reference !== null ? { reference: row.reference } : {}),
            isCorrect: row.isCorrect,
            ...(row.provider !== null ? { provider: row.provider } : {}),
          },
        };
      } catch (error) {
        throw toServiceError(error, 'EXAM_LLM_STREAM_FAILED', 'essay grading failed');
      }
    },

    getEssayGrading(attemptId) {
      assertStoreOpen(store);
      const row = store.getEssayGrading(attemptId);
      return row === undefined ? undefined : toEssayGradingDto(row);
    },

    // ── Phase 2：Tutor 多轮对话 ──────────────────────────────────────────

    getTutorSession(id) {
      assertStoreOpen(store);
      const row = store.getTutorSession(id);
      return row === undefined ? undefined : toTutorSessionDto(row);
    },

    listTutorSessions(limit = 30) {
      assertStoreOpen(store);
      return store.listTutorSessions(limit).map(toTutorSessionDto);
    },

    listTutorMessages(sessionId) {
      assertStoreOpen(store);
      return store.listTutorMessages(sessionId).map(toTutorMessageDto);
    },

    closeTutorSession(id) {
      assertStoreOpen(store);
      const session = store.getTutorSession(id);
      if (session === undefined) {
        throw new ExamServiceError('EXAM_TUTOR_SESSION_NOT_FOUND', `tutor session not found: ${id}`);
      }
      // 幂等：已 closed 原样返回（不刷新 updated_at，避免改变排序）。
      if (session.status === 'closed') return toTutorSessionDto(session);
      return toTutorSessionDto(store.closeTutorSession(id));
    },

    deleteTutorSession(id) {
      assertStoreOpen(store);
      if (store.getTutorSession(id) === undefined) {
        throw new ExamServiceError('EXAM_TUTOR_SESSION_NOT_FOUND', `tutor session not found: ${id}`);
      }
      store.deleteTutorSession(id);
    },

    async chatTutor(input, onDelta) {
      assertStoreOpen(store);
      const message = typeof input.message === 'string' ? input.message.trim() : '';
      if (message.length === 0) {
        throw new ExamServiceError('EXAM_TUTOR_MESSAGE_REQUIRED', 'tutor message must be a non-empty string');
      }
      const {
        engine: aiEngine,
        llm: llmService,
        provider,
        model,
      } = requireLlmRoute(ai, llm, input.provider, input.model);
      // 幂等键：显式 clientMessageId（新客户端/工具）或服务端 srv-* 占位（旧客户端退化为现状）。
      const clientMessageId = input.clientMessageId ?? `srv-${randomUUID()}`;

      // ── 会话解析（P3 closed guard + P2 重试复用）──────────────────────────
      let session: TutorSessionRow | undefined;
      if (input.sessionId !== undefined) {
        const existing = store.getTutorSession(input.sessionId);
        if (existing === undefined) {
          throw new ExamServiceError(
            'EXAM_TUTOR_SESSION_NOT_FOUND',
            `tutor session not found: ${input.sessionId}`,
          );
        }
        if (existing.status === 'closed') {
          throw new ExamServiceError(
            'EXAM_TUTOR_SESSION_CLOSED',
            `tutor session ${input.sessionId} is closed; start a new conversation`,
          );
        }
        session = existing;
      }

      // ── turn 幂等判定（t5 状态机）─────────────────────────────────────────
      let turn: TutorTurnRow | undefined = store.getTutorTurnByClientMessageId(clientMessageId);
      if (turn !== undefined) {
        if (input.sessionId !== undefined && turn.sessionId !== input.sessionId) {
          throw new ExamServiceError(
            'EXAM_TUTOR_TURN_CONFLICT',
            `clientMessageId ${clientMessageId} already belongs to session ${turn.sessionId}; reuse that session or generate a new id`,
          );
        }
        if (turn.state === 'done') {
          // 重放：零 LLM 调用，返回既有回复（幂等语义核心）。
          const assistant = store.getTutorMessage(turn.assistantMessageId ?? '');
          if (assistant !== undefined) {
            return {
              sessionId: turn.sessionId,
              messageId: assistant.id,
              reply: assistant.content,
              turnId: turn.id,
              replayed: true,
              ...(turn.model !== null ? { model: turn.model } : {}),
            };
          }
          // done 但 assistant 缺失（极端不一致）：视为 failed 允许重试。
          store.updateTutorTurnState(turn.id, 'failed');
        }
        if (turn.state === 'streaming' && inFlightTurns.has(turn.id)) {
          // 进程内有在途 flight → 并发同键 409（设计 §3.1）。
          throw new ExamServiceError(
            'EXAM_TUTOR_TURN_IN_FLIGHT',
            `turn ${turn.id} is already streaming; wait for it to finish or cancel first`,
          );
        }
        // pending | failed | cancelled | 孤儿 streaming（无在途 flight）→ 重试路径：
        // 复用 turn 的会话（幽灵治理主防线：不再新建会话，不再重复 user 消息）。
        session = store.getTutorSession(turn.sessionId) ?? session;
        if (session === undefined) {
          throw new ExamServiceError('EXAM_TUTOR_SESSION_NOT_FOUND', `tutor session not found: ${turn.sessionId}`);
        }
      }

      // 重试路径下再校验会话状态（服务层纵深；closed guard 全路径生效）。
      if (session !== undefined && session.status === 'closed') {
        throw new ExamServiceError(
          'EXAM_TUTOR_SESSION_CLOSED',
          `tutor session ${session.id} is closed; start a new conversation`,
        );
      }

      // 全新 turn：无 sessionId 时新建会话（questionId 可选 = 自由问答）。
      if (session === undefined) {
        let questionId: string | null = null;
        let bankId: string | null = null;
        if (input.questionId !== undefined) {
          const question = requireQuestionRow(store, input.questionId);
          questionId = question.id;
          bankId = question.bankId;
        } else if (input.bankId !== undefined) {
          requireBankExists(store, input.bankId);
          bankId = input.bankId;
        }
        session = store.createTutorSession({ questionId, bankId });
      }

      // 题目上下文：会话绑题时取题目 + 该题最近作答（供 AI 针对性讲解）。
      let question: QuestionRow | undefined;
      let userAnswer: string | undefined;
      if (session.questionId !== null) {
        question = store.getQuestion(session.questionId);
        const latest = store.listLatestAttemptByQuestion([session.questionId]).get(session.questionId);
        if (latest !== undefined && typeof latest.userAnswer === 'string') {
          userAnswer = latest.userAnswer;
        }
      }

      // ── user 消息落库（仅新 turn 一次；重试路径复用既有消息）──────────────
      let history: TutorMessageRow[];
      if (turn === undefined) {
        history = store.listTutorMessages(session.id);
        const created = store.withTransaction(() => {
          const userMsg = store.addTutorMessage({ sessionId: session.id, role: 'user', content: message });
          const newTurn = store.createTutorTurn({
            sessionId: session.id,
            clientMessageId,
            userMessageId: userMsg.id,
          });
          return { userMsg, newTurn };
        });
        turn = created.newTurn;
      } else {
        // 重试：历史排除本次 turn 的 user 消息（避免 LLM 看到重复提问）。
        history = store.listTutorMessages(session.id).filter((entry) => entry.id !== turn!.userMessageId);
      }

      // ── 历史 token 预算（t5 §3.4：只消费 DSH 模型配置，不另设输出限制）────
      const fixedOverhead =
        estimateTokens(TUTOR_SYSTEM) +
        estimateTokens(message) +
        (question !== undefined ? estimateTokens(renderTutorQuestion(question, userAnswer)) : 0);
      const budget = computeTutorInputBudget(input.modelInfo);
      const maxHistoryTokens = budget === undefined ? undefined : budget - fixedOverhead;
      const trimmedHistory = trimTutorHistory(history, { maxHistoryTokens });

      const messages: LlmMessage[] =
        question !== undefined
          ? buildTutorContext(question, userAnswer, trimmedHistory, message)
          : buildFreeChatMessages(trimmedHistory, message);

      // ── 置 streaming + 在途 flight（孤儿恢复：内存无 flight 的重启残留可重试）──
      store.updateTutorTurnState(turn.id, 'streaming');
      inFlightTurns.add(turn.id);

      try {
        const result = await llmService.streamOnce({ provider, model, messages, signal: input.signal }, onDelta);
        const reply = result.text.trim();
        if (reply.length === 0) {
          throw new ExamLlmError('tutor llm returned an empty reply', EXAM_LLM_STREAM_FAILED);
        }
        // 取消零落库：即便底层流在 abort 后仍以正常 finish 收尾，只要 signal 已中止就绝不落库。
        if (input.signal?.aborted) {
          throw new ExamLlmError('tutor chat aborted by caller', EXAM_LLM_ABORTED);
        }
        const assistantMsg = store.addTutorMessage({
          sessionId: session.id,
          role: 'assistant',
          content: reply,
          turnId: turn.id,
        });
        store.completeTutorTurn(turn.id, {
          assistantMessageId: assistantMsg.id,
          provider,
          model: result.model ?? null,
          inputTokens: result.usage?.inputTokens ?? null,
          outputTokens: result.usage?.outputTokens ?? null,
        });
        store.touchTutorSession(session.id);
        return {
          sessionId: session.id,
          messageId: assistantMsg.id,
          reply,
          turnId: turn.id,
          replayed: false,
          ...(result.model !== undefined && result.model !== null ? { model: result.model } : {}),
        };
      } catch (error) {
        // 状态机收尾：失败 → failed（可重试）；取消 → cancelled（不自动重试，可手动）。
        // 错误携带 meta（sessionId/turnId/retryable）供路由层写入 SSE error 载荷。
        const code = error instanceof ExamLlmError ? error.code : error instanceof ExamServiceError ? error.code : EXAM_LLM_STREAM_FAILED;
        try {
          store.setTurnError(turn.id, code);
        } catch {
          // 状态写入失败不影响错误上抛（连接可能已损坏）。
        }
        const meta = { sessionId: session.id, turnId: turn.id, retryable: code !== EXAM_LLM_ABORTED };
        throw toServiceError(error, 'EXAM_LLM_STREAM_FAILED', 'tutor chat failed', meta);
      } finally {
        inFlightTurns.delete(turn.id);
      }
    },

    // ── Phase 2：AI 文本导入 ─────────────────────────────────────────────

    async listImportedQuestions(input) {
      assertStoreOpen(store);
      const text = typeof input.text === 'string' ? input.text.trim() : '';
      if (text.length < IMPORT_TEXT_MIN_LENGTH) {
        throw new ExamServiceError(
          'EXAM_IMPORT_EMPTY',
          `import text must be at least ${IMPORT_TEXT_MIN_LENGTH} characters`,
        );
      }
      const { engine: aiEngine, provider, model } = requireLlmRoute(ai, llm, input.provider, input.model);
      try {
        const questions = await aiEngine.parseImportedQuestions(text, {
          provider,
          model,
          signal: input.signal,
        });
        // t5：草稿服务端持久化（刷新可恢复；source_hash = 来源文本 sha256）。
        const draft = store.saveImportDraft({
          sourceHash: createHash('sha256').update(text).digest('hex'),
          items: questions,
        });
        return { questions, draftId: draft.id };
      } catch (error) {
        // ai.ts 的输出解析失败抛 ExamLlmError(EXAM_LLM_STREAM_FAILED)；
        // 归一到稳定导入错误码 EXAM_IMPORT_PARSE_FAILED（UI 可区分）。
        if (error instanceof ExamLlmError && error.code === EXAM_LLM_STREAM_FAILED) {
          throw new ExamServiceError('EXAM_IMPORT_PARSE_FAILED', `imported questions parse failed: ${error.message}`);
        }
        throw toServiceError(error, 'EXAM_IMPORT_PARSE_FAILED', 'AI import failed');
      }
    },

    importQuestions(bankId, input) {
      assertStoreOpen(store);
      requireBankExists(store, bankId);
      // draftId 优先于 questions（服务端草稿为准，避免客户端改写过期草稿）。
      let items: CreateQuestionRequest[];
      if (input.draftId !== undefined) {
        const draft = store.getImportDraft(input.draftId);
        if (draft === undefined) {
          throw new ExamServiceError('EXAM_IMPORT_DRAFT_NOT_FOUND', `import draft not found: ${input.draftId}`);
        }
        if (draft.status !== 'open') {
          throw new ExamServiceError(
            'EXAM_IMPORT_DRAFT_CONSUMED',
            `import draft ${input.draftId} is already ${draft.status}`,
          );
        }
        items = normalizeDraftItems(draft);
        if (items.length === 0) {
          throw new ExamServiceError('EXAM_INVALID_BODY', 'import draft contains no valid questions');
        }
      } else {
        if (!Array.isArray(input.questions) || input.questions.length === 0) {
          throw new ExamServiceError('EXAM_INVALID_BODY', 'questions must be a non-empty array');
        }
        items = input.questions;
      }
      return commitImport(store, createQuestionInternal, computeImportItemKey, bankId, items, {
        batchId: input.batchId,
        draftId: input.draftId,
      });
    },

    getImportDraft(id) {
      assertStoreOpen(store);
      const draft = store.getImportDraft(id);
      if (draft === undefined) {
        throw new ExamServiceError('EXAM_IMPORT_DRAFT_NOT_FOUND', `import draft not found: ${id}`);
      }
      if (draft.status !== 'open') {
        throw new ExamServiceError('EXAM_IMPORT_DRAFT_CONSUMED', `import draft ${id} is already ${draft.status}`);
      }
      return normalizeDraftItems(draft);
    },

    discardImportDraft(id) {
      assertStoreOpen(store);
      const draft = store.getImportDraft(id);
      if (draft === undefined) {
        throw new ExamServiceError('EXAM_IMPORT_DRAFT_NOT_FOUND', `import draft not found: ${id}`);
      }
      if (draft.status !== 'open') return;
      store.updateImportDraftStatus(id, 'discarded');
    },

    // ── Phase 2：学情洞察 / 诊断 ─────────────────────────────────────────

    listInsight(input?: InsightQueryInput) {
      assertStoreOpen(store);
      // 窗口校验：限 7/14/30（防任意大窗口全表扫描）；bankId 存在性校验。
      const windowDays = input?.windowDays ?? 7;
      if (!(windowDays === 7 || windowDays === 14 || windowDays === 30)) {
        throw new ExamServiceError('EXAM_INVALID_BODY', 'windowDays must be one of 7, 14, 30');
      }
      const bankId = input?.bankId;
      if (bankId !== undefined && !store.listBanks().some((bank) => bank.id === bankId)) {
        throw new ExamServiceError('EXAM_BANK_NOT_FOUND', `bank not found: ${String(bankId)}`);
      }
      try {
        return buildInsightSummary(store, { windowDays, bankId });
      } catch (error) {
        throw toServiceError(error, 'EXAM_STORE_FAILED', 'failed to build insight summary');
      }
    },

    async diagnoseInsight(input) {
      assertStoreOpen(store);
      const { engine: aiEngine, provider, model } = requireLlmRoute(ai, llm, input.provider, input.model);
      const insight = buildInsightSummary(store);
      let diagnosis: DiagnosisDto;
      try {
        diagnosis = await aiEngine.generateDiagnosis(insight, { provider, model, signal: input.signal });
      } catch (error) {
        throw toServiceError(error, 'EXAM_LLM_STREAM_FAILED', 'insight diagnosis failed');
      }
      // t13：诊断成功即持久化（失败不落库）；返回携带 id/审计信息的记录。
      const saved = store.saveDiagnosis({
        summary: diagnosis.summary,
        weaknesses: diagnosis.weaknesses,
        suggestions: diagnosis.suggestions,
        provider,
        model,
      });
      return toDiagnosisRecordDto(saved);
    },

    listDiagnoses(limit = 10) {
      assertStoreOpen(store);
      try {
        return { diagnoses: store.listDiagnoses(limit).map(toDiagnosisRecordDto) };
      } catch (error) {
        throw toServiceError(error, 'EXAM_STORE_FAILED', 'failed to list diagnoses');
      }
    },

    // ── Phase 2：学习计划 ────────────────────────────────────────────────

    async generatePlan(input) {
      assertStoreOpen(store);
      const { engine: aiEngine, provider, model } = requireLlmRoute(ai, llm, input.provider, input.model);
      const insight = buildInsightSummary(store);
      let drafts: PlanDraft[];
      try {
        drafts = await aiEngine.generateStudyPlan(insight, { provider, model, signal: input.signal });
      } catch (error) {
        throw toServiceError(error, 'EXAM_LLM_STREAM_FAILED', 'study plan generation failed');
      }
      const title =
        typeof input.title === 'string' && input.title.trim().length > 0 ? input.title.trim() : 'AI 学习计划';
      const plan = store.createStudyPlan({ title, source: 'llm' });
      // t9：把 AI 生成的结构化草稿落库为可执行条目（note/actionType/scope/priority/dueAt/sourceDiagnosisId）。
      const result = store.addPlanItems(
        plan.id,
        drafts.map((draft, index) => normalizePlanItemInput(draft, index)),
      );
      return { plan: toPlanDto(result.plan), items: result.items.map(toPlanItemDto) };
    },

    listPlans(limit = 30) {
      assertStoreOpen(store);
      try {
        return { plans: store.listStudyPlans(limit).map(toPlanDto) };
      } catch (error) {
        throw toServiceError(error, 'EXAM_STORE_FAILED', 'failed to list study plans');
      }
    },

    getPlan(id) {
      assertStoreOpen(store);
      const result = store.getPlanWithItems(id);
      if (result === undefined) {
        throw new ExamServiceError('EXAM_PLAN_NOT_FOUND', `study plan not found: ${id}`);
      }
      return { plan: toPlanDto(result.plan), items: result.items.map(toPlanItemDto) };
    },

    addPlanItems(planId, items) {
      assertStoreOpen(store);
      if (store.getStudyPlan(planId) === undefined) {
        throw new ExamServiceError('EXAM_PLAN_NOT_FOUND', `study plan not found: ${planId}`);
      }
      const normalized = normalizePlanItemInputs(items);
      if (normalized.length === 0) {
        throw new ExamServiceError('EXAM_INVALID_BODY', 'plan items must be a non-empty array');
      }
      store.addPlanItems(planId, normalized);
      // PlanWithItemsDto 语义 = 计划及其全部条目；store 返回的 items 仅为本次新增，需回读全量。
      const full = store.getPlanWithItems(planId)!;
      return { plan: toPlanDto(full.plan), items: full.items.map(toPlanItemDto) };
    },

    setPlanItemDone(planId, itemId, done) {
      assertStoreOpen(store);
      if (typeof done !== 'boolean') {
        throw new ExamServiceError('EXAM_INVALID_BODY', 'done must be a boolean');
      }
      if (store.getStudyPlan(planId) === undefined) {
        throw new ExamServiceError('EXAM_PLAN_NOT_FOUND', `study plan not found: ${planId}`);
      }
      if (!store.listPlanItems(planId).some((item) => item.id === itemId)) {
        throw new ExamServiceError('EXAM_PLAN_ITEM_NOT_FOUND', `plan item not found: ${itemId} in plan ${planId}`);
      }
      return toPlanItemDto(store.setPlanItemDone(planId, itemId, done));
    },

    deletePlan(id) {
      assertStoreOpen(store);
      if (!store.deleteStudyPlan(id)) {
        throw new ExamServiceError('EXAM_PLAN_NOT_FOUND', `study plan not found: ${id}`);
      }
    },

    deletePlanItem(planId, itemId) {
      assertStoreOpen(store);
      if (store.getStudyPlan(planId) === undefined) {
        throw new ExamServiceError('EXAM_PLAN_NOT_FOUND', `study plan not found: ${planId}`);
      }
      if (!store.listPlanItems(planId).some((item) => item.id === itemId)) {
        throw new ExamServiceError('EXAM_PLAN_ITEM_NOT_FOUND', `plan item not found: ${itemId} in plan ${planId}`);
      }
      store.deletePlanItem(planId, itemId);
    },

    createManualPlan(input) {
      assertStoreOpen(store);
      const title = typeof input.title === 'string' ? input.title.trim() : '';
      if (title.length === 0) {
        throw new ExamServiceError('EXAM_INVALID_BODY', 'plan title must be a non-empty string');
      }
      const items = input.items === undefined ? [] : input.items;
      if (!Array.isArray(items)) {
        throw new ExamServiceError('EXAM_INVALID_BODY', 'plan items must be an array');
      }
      const normalized = normalizePlanItemInputs(items);
      const plan = store.createStudyPlan({ title, source: 'manual' });
      const result = store.addPlanItems(plan.id, normalized);
      return { plan: toPlanDto(result.plan), items: result.items.map(toPlanItemDto) };
    },

    // ── Phase 2：练习历史 / 续做 ──────────────────────────────────────────

    listPracticeHistory(limit = 30) {
      assertStoreOpen(store);
      return store.listPracticeHistory(limit).map((row) => {
        const practice = engine.resumePractice(row.id).practice;
        // t1：answeredCount 与会话域「每题最新」同口径（practice_id 精确匹配 +
        // 会话题单），跨会话重做不串味；同题多次判分/重批只计 1。
        const answeredCount = store.listLatestAttemptByPracticeQuestions(row.id, row.questionIds).size;
        if (practice.status === 'finished') {
          return { practice, answeredCount, scorecard: engine.buildScorecard(row.id) };
        }
        return { practice, answeredCount };
      });
    },

    // ── Phase 4：题目 AI 解析（P 个性化 / G 通用）──────────────────────────

    async explainQuestion(input, onDelta) {
      assertStoreOpen(store);
      const { question, attempt } = requireExplainContext(store, input.practiceId, input.questionId);
      const answerNorm = normalizeAnswerNorm(question.type, attempt.userAnswer);
      // 缓存短路（force=重新解析时跳过读取）：命中直接返回——不解析 LLM 路由、
      // 不调用 LLM（设计 §5「零 delta」语义，provider 未配置也不影响命中路径）。
      // t5：命中条件升级为「promptVersion 匹配 + questionUpdatedAt === 题目 updatedAt」
      //（题目编辑/提示词升级 → 自然失效，不再展示陈旧解析）。
      // t1：按 depth 分档读缓存——浅/深两档互不挤占（键 = question_id|answer_norm|depth）。
      if (input.force !== true) {
        const cached = store.getExplanation(question.id, answerNorm, input.depth ?? 'light');
        if (cached !== undefined && isExplanationHit(cached, question)) {
          return toExplainResultDto(cached, true);
        }
      }
      // t5 single-flight：同键（force/普通独立）并发请求共享一次 LLM 调用；
      // force 与普通各自独立，防止「普通命中在读、force 在写」竞态。
      const depth = input.depth ?? 'light';
      const key = `${input.force === true ? 'f' : 'p'}:${question.id}|${answerNorm}|${depth}`;
      const inFlight = inFlightExplains.get(key);
      if (inFlight !== undefined) return inFlight;
      const promise = explainQuestionImpl(question, attempt, answerNorm, input, onDelta).finally(() => {
        inFlightExplains.delete(key);
      });
      inFlightExplains.set(key, promise);
      return promise;
    },

    getPracticeExplanation(input) {
      assertStoreOpen(store);
      const { question, answerNorm } = requireExplainContext(store, input.practiceId, input.questionId);
      const cached = store.getExplanation(question.id, answerNorm, input.depth ?? 'light');
      // t5：版本命中条件与 explainQuestion 完全一致——过期缓存视为 miss。
      if (cached === undefined || !isExplanationHit(cached, question)) {
        throw new ExamServiceError(
          'EXAM_EXPLANATION_NOT_FOUND',
          `no cached explanation for question ${question.id} with this answer; generate one first`,
        );
      }
      return toExplanationDto(cached);
    },

    async explainGenericQuestion(input) {
      assertStoreOpen(store);
      const { engine: aiEngine, provider, model } = requireLlmRoute(ai, llm, input.provider, input.model);
      return explainGenericCore(aiEngine, input.questionId, provider, model, input.reasoningEffort, input.signal);
    },

    async explainTopicSuggestions(input) {
      assertStoreOpen(store);
      requireBankExists(store, input.bankId);
      const { engine: aiEngine, provider, model } = requireLlmRoute(ai, llm, input.provider, input.model);
      const limit = clampTopicSuggestLimit(input.limit);
      let objective: QuestionRow[];
      if (input.questionIds !== undefined) {
        // 显式指定题目：只对这批客观题生成建议（忽略「优先 topics 为空」的默认挑选）。
        objective = resolveTopicSuggestQuestions(store, input.bankId, input.questionIds);
      } else {
        // 缺省挑选：该库活跃客观题（essay 跳过）；优先 topics 为空的题
        //（未被标注者优先出建议），按 limit 截断。
        objective = store
          .listQuestionsByBank(input.bankId)
          .filter((q) => q.type !== 'essay')
          .sort((a, b) => {
            const aEmpty = (a.topics ?? []).length === 0 ? 0 : 1;
            const bEmpty = (b.topics ?? []).length === 0 ? 0 : 1;
            return aEmpty - bEmpty;
          })
          .slice(0, limit);
      }
      const sources: TopicSuggestionSource[] = objective.map((q) => ({
        questionId: q.id,
        stem: q.stem,
        currentTopics: q.topics,
        currentTags: q.tags,
      }));
      const items = await aiEngine.parseTopicSuggestions(sources, { provider, model, signal: input.signal });
      return { items };
    },

    applyTopics(items) {
      assertStoreOpen(store);
      if (!Array.isArray(items)) {
        throw new ExamServiceError('EXAM_INVALID_BODY', 'items must be an array');
      }
      const updated = store.withTransaction(() => {
        let count = 0;
        for (const item of items) {
          if (typeof item !== 'object' || item === null) {
            throw new ExamServiceError('EXAM_INVALID_BODY', 'each item must be an object');
          }
          const question = requireQuestionRow(store, item.questionId);
          const topics = validateApplyTopics(question, item.topics);
          store.updateQuestion(question.id, { topics, topicsSource: 'batch' });
          count += 1;
        }
        return count;
      });
      return { updated };
    },

    close() {
      store?.close();
    },
  };
}

// ---------------------------------------------------------------------------
// 校验与守卫
// ---------------------------------------------------------------------------

/** store 未打开时抛稳定错误码 EXAM_STORE_UNAVAILABLE；已关闭抛 EXAM_STORE_CLOSED。 */
function assertStoreOpen(store: ExamStore | undefined): asserts store is ExamStore {
  if (store === undefined) {
    throw new ExamServiceError('EXAM_STORE_UNAVAILABLE', 'exam store is not opened');
  }
  const health = store.health();
  if (health.closed) {
    throw new ExamServiceError('EXAM_STORE_CLOSED', 'exam store is closed');
  }
}

function requireBankExists(store: ExamStore, bankId: string): void {
  if (!store.listBanks().some((b) => b.id === bankId)) {
    throw new ExamServiceError('EXAM_BANK_NOT_FOUND', `bank not found: ${bankId}`);
  }
}

/**
 * t9：题库生命周期操作的「任意状态」存在性校验（含已归档/已删除）——重命名/归档/
 * 恢复/删除均需命中真实存在的题库行。不存在 → EXAM_BANK_NOT_FOUND。
 */
function requireBankAnyState(store: ExamStore, bankId: string): void {
  if (store.getBank(bankId) === undefined) {
    throw new ExamServiceError('EXAM_BANK_NOT_FOUND', `bank not found: ${bankId}`);
  }
}

function requireQuestionExists(store: ExamStore, id: string): void {
  if (store.getQuestion(id) === undefined) {
    throw new ExamServiceError('EXAM_QUESTION_NOT_FOUND', `question not found: ${id}`);
  }
}

/** 取题目行；不存在 → EXAM_QUESTION_NOT_FOUND。 */
function requireQuestionRow(store: ExamStore, id: string): QuestionRow {
  const row = store.getQuestion(id);
  if (row === undefined) {
    throw new ExamServiceError('EXAM_QUESTION_NOT_FOUND', `question not found: ${id}`);
  }
  return row;
}

/** 练习会话存在性校验；不存在 → EXAM_PRACTICE_NOT_FOUND；返回会话行。 */
function requirePracticeRow(store: ExamStore, id: string): PracticeSessionRow {
  const row = store.getPracticeSession(id);
  if (row === undefined) {
    throw new ExamServiceError('EXAM_PRACTICE_NOT_FOUND', `practice session not found: ${id}`);
  }
  return row;
}

/**
 * 服务层 LLM 路由守卫：llm 未接线 → EXAM_LLM_UNAVAILABLE；
 * provider/model 缺省（应由路由层 resolveLlmRoute 解析后传入）→ EXAM_LLM_UNAVAILABLE。
 */
function requireLlmRoute(
  ai: AiEngine | undefined,
  llm: ExamLlm | undefined,
  provider: string | undefined,
  model: string | undefined,
): { engine: AiEngine; llm: ExamLlm; provider: string; model: string } {
  if (llm === undefined || ai === undefined) {
    throw new ExamServiceError('EXAM_LLM_UNAVAILABLE', 'llm is not wired in this exam service');
  }
  if (provider === undefined || model === undefined) {
    throw new ExamServiceError(
      'EXAM_LLM_UNAVAILABLE',
      'cannot resolve LLM route: provider/model must be provided (default resolution happens in the route layer)',
    );
  }
  return { engine: ai, llm, provider, model };
}

// ---------------------------------------------------------------------------
// Phase 4：解析上下文校验与 DTO 映射
// ---------------------------------------------------------------------------

/** essay 题统一拒绝（P/G 共用；essay 的解析语义已由批改 feedback/reference 承担）。 */
function assertNotEssay(question: QuestionRow): void {
  // QuestionRow.type 已含 'essay'（t1 类型修正），不再需要运行时扩宽。
  if (question.type === 'essay') {
    throw new ExamServiceError(
      'EXAM_INVALID_QUESTION',
      `question ${question.id} is an essay question; its grading feedback already serves as the explanation`,
    );
  }
}

/**
 * P 形态共享校验链（explainQuestion 与 getPracticeExplanation 完全一致；顺序即
 * 任务契约）：practice 存在 → question 存在 → 属于会话题单 → 该
 * (practiceId, questionId) 已有 attempt（**409 EXAM_NOT_GRADED 防泄露硬边界**
 * ——解析必含正确答案，未判分不可见）→ 非 essay。返回题目行、会话内该题最新
 * 作答与归一化缓存键。
 */
function requireExplainContext(
  store: ExamStore,
  practiceId: string,
  questionId: string,
): { session: PracticeSessionRow; question: QuestionRow; attempt: AttemptRow; answerNorm: string } {
  const session = store.getPracticeSession(practiceId);
  if (session === undefined) {
    throw new ExamServiceError('EXAM_PRACTICE_NOT_FOUND', `practice session not found: ${practiceId}`);
  }
  const question = requireQuestionRow(store, questionId);
  if (!session.questionIds.includes(questionId)) {
    throw new ExamServiceError(
      'EXAM_QUESTION_NOT_IN_PRACTICE',
      `question ${questionId} is not part of practice ${practiceId}`,
    );
  }
  const attempt = store.getLatestAttemptByPracticeQuestion(practiceId, questionId);
  if (attempt === undefined) {
    throw new ExamServiceError(
      'EXAM_NOT_GRADED',
      `question ${questionId} has no graded attempt in practice ${practiceId}; explanations unlock after grading`,
    );
  }
  assertNotEssay(question);
  return { session, question, attempt, answerNorm: normalizeAnswerNorm(question.type, attempt.userAnswer) };
}

/**
 * 会话内某题的最新作答：直接走 store.getLatestAttemptByPracticeQuestion
 * （answered_at DESC, id DESC LIMIT 1，practice_id 精确匹配）。「会话内」口径：
 * 跨会话重做的更新作答不串味——缓存键跟随本会话作答，旧会话回看仍解析当时的答案。
 */

/** ExplanationRow → ExplainResultDto（cached=true 时省略 explanationId；t5 附带版本与 token 字段）。 */
function toExplainResultDto(row: ExplanationRow, cached: boolean): ExplainResultDto {
  return {
    cached,
    ...(cached ? {} : { explanationId: row.id }),
    content: row.content,
    depth: row.depth,
    ...(row.model !== null ? { model: row.model } : {}),
    ...(row.provider !== null ? { provider: row.provider } : {}),
    ...(row.reasoningEffort !== null ? { reasoningEffort: row.reasoningEffort } : {}),
    promptVersion: row.promptVersion,
    questionUpdatedAt: row.questionUpdatedAt,
    ...(row.inputTokens !== null ? { inputTokens: row.inputTokens } : {}),
    ...(row.outputTokens !== null ? { outputTokens: row.outputTokens } : {}),
    ...(row.finishReason !== null ? { finishReason: row.finishReason } : {}),
  };
}

/** ExplanationRow → ExplanationDto（GET 探测响应体；t5 附带版本字段）。 */
function toExplanationDto(row: ExplanationRow): ExplanationDto {
  return {
    content: row.content,
    model: row.model,
    provider: row.provider,
    reasoningEffort: row.reasoningEffort,
    depth: row.depth,
    promptVersion: row.promptVersion,
    questionUpdatedAt: row.questionUpdatedAt,
    createdAt: row.createdAt,
  };
}

/**
 * t5 解析缓存命中条件（P11）：promptVersion 匹配当前模板 + 题目未编辑
 *（questionUpdatedAt === 题目 updatedAt）。任一不满足 → miss（按需再生成）。
 */
function isExplanationHit(row: ExplanationRow, question: QuestionRow): boolean {
  return row.promptVersion === EXPLAIN_PROMPT_VERSION && row.questionUpdatedAt === question.updatedAt;
}

/**
 * 深档 maxTokens（设计 §2 决策 4）：min(模型支持上限, contextWindow × 1/3)；
 * defaultMaxTokens 仅兜底——模型未声明 contextWindow 时缺省返回 undefined
 * （调用方不显式抬升，退回 DSH 材质化默认输出上限）。
 */
function resolveDeepExplainMaxTokens(modelInfo?: { contextWindow?: number; defaultMaxTokens?: number }): number | undefined {
  if (modelInfo === undefined) return undefined;
  const contextWindow = modelInfo.contextWindow;
  if (typeof contextWindow !== 'number' || contextWindow <= 0) return undefined;
  const oneThird = Math.floor(contextWindow / 3);
  const supportLimit = modelInfo.defaultMaxTokens;
  return typeof supportLimit === 'number' && supportLimit > 0 ? Math.min(supportLimit, oneThird) : oneThird;
}

/**
 * M4 深档个性化上下文（设计 §3.4 D）：只读现有数据组装（无新端点），仅 deep 档调用。
 * - wrongCountOnQuestion：该题历史答错次数（全量 attempts 按 questionId 聚合）；
 * - topicAccuracy：该题各知识点 topc 维度的正确率聚合（同库池内同 topics 题目，仅 answered>0）；
 * - similarStems：同 topics 且题干关键词重叠≥2 的相似题 stem（≤3 条，规则匹配无 embedding）。
 * 数据量大时仅做前两级亦可接受（取舍见报告）；此处全量三字段实现。
 */
function buildExplainContext(store: ExamStore, question: QuestionRow): ExplainContextDto {
  const attempts = store.listAllAttempts();
  const wrongCountOnQuestion = attempts.reduce((sum, a) => (a.questionId === question.id && !a.isCorrect ? sum + 1 : sum), 0);

  const pool = store.listQuestionsByBank(question.bankId).filter((q) => q.type !== 'essay');
  const attemptByQuestion = new Map<string, { answered: number; correct: number }>();
  for (const attempt of attempts) {
    let entry = attemptByQuestion.get(attempt.questionId);
    if (entry === undefined) {
      entry = { answered: 0, correct: 0 };
      attemptByQuestion.set(attempt.questionId, entry);
    }
    entry.answered += 1;
    if (attempt.isCorrect) entry.correct += 1;
  }

  const topics = question.topics ?? [];
  const topicAccuracy: ExplainContextDto['topicAccuracy'] = [];
  for (const topic of topics) {
    const same = pool.filter((q) => (q.topics ?? []).includes(topic));
    let answered = 0;
    let correct = 0;
    for (const q of same) {
      const entry = attemptByQuestion.get(q.id);
      if (entry !== undefined) {
        answered += entry.answered;
        correct += entry.correct;
      }
    }
    // 无作答样本的知识点不注入（避免误导性的 0%）。
    if (answered > 0) {
      topicAccuracy.push({ topic, answered, correct, accuracy: correct / answered });
    }
  }

  const similarStems = topics.length > 0 ? buildSimilarStems(pool, question, topics) : [];
  return { wrongCountOnQuestion, topicAccuracy, similarStems };
}

/** 相似题：pool 内与该题共享 topic 且题干关键词（2-gram）重叠≥2 的其他题，取重叠度最高的 ≤3 条。 */
function buildSimilarStems(pool: QuestionRow[], question: QuestionRow, topics: string[]): string[] {
  const stemTokens = stemKeywords(question.stem);
  return pool
    .filter((q) => q.id !== question.id && (q.topics ?? []).some((t) => topics.includes(t)))
    .map((q) => ({ stem: q.stem, overlap: countOverlap(stemTokens, stemKeywords(q.stem)) }))
    .filter((entry) => entry.overlap >= 2)
    .sort((a, b) => b.overlap - a.overlap)
    .slice(0, 3)
    .map((entry) => entry.stem);
}

/** 题干关键词集（轻量 2-gram：连续 2 个汉字/字母/数字，不含标点与空白）。 */
function stemKeywords(stem: string): Set<string> {
  const cleaned = stem.replace(/[^\p{L}\p{N}]/gu, '');
  const tokens = new Set<string>();
  for (let i = 0; i + 2 <= cleaned.length; i++) tokens.add(cleaned.slice(i, i + 2));
  return tokens;
}

/** 两个关键词集的交集大小。 */
function countOverlap(left: Set<string>, right: Set<string>): number {
  let count = 0;
  for (const token of left) {
    if (right.has(token)) count += 1;
  }
  return count;
}

/**
 * P3：从 deep 档 content 末尾剥离「最后单独一行」的 `{"topics":[...]}` JSON。
 * 成功：返回剥离后的正文 + topics 数组；无 JSON / 结尾无法解析 → undefined（跳过 P3，
 * 不影响正文展示——返回/落库的 content 即为原文，仅少一个写回副产物）。
 */
function stripTrailingDeepTopics(content: string): { content: string; topics: string[] } | undefined {
  const lines = content.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!.trim();
    if (line.length === 0) continue;
    const topics = tryParseTopicsObject(line);
    if (topics !== undefined) {
      const body = lines
        .slice(0, i)
        .join('\n')
        .replace(/[ \t]*\n+$/, '')
        .trimEnd();
      // 正文为空（LLM 只输出 JSON 行）→ 不剥离，避免落库/返回空内容。
      if (body.length === 0) break;
      return { content: body, topics };
    }
    // 末尾最后一个非空行不是 topics JSON → 不剥离。
    break;
  }
  return undefined;
}

/** 尝试把单行解析为 `{"topics": string[]}`；成功返回 topics，失败 undefined。 */
function tryParseTopicsObject(line: string): string[] | undefined {
  const trimmed = line.trim();
  if (!trimmed.startsWith('{') || !trimmed.endsWith('}')) return undefined;
  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return undefined;
    const topics = (parsed as Record<string, unknown>).topics;
    if (Array.isArray(topics) && topics.every((t) => typeof t === 'string')) {
      return topics as string[];
    }
  } catch {
    // fall through
  }
  return undefined;
}

/**
 * P3 写回：校验 deep 档 LLM 给出的 topics 候选后与现有 topics 合并，
 * topicsSource='ai-deep'。频次保护（简单合并策略）：仅当新增候选与现有 topics
 * 不同才写（merged===existing 时跳过）；过滤与主题 tag 重叠项；≤4；规范化去重。
 */
function applyDeepTopicWriteback(store: ExamStore, question: QuestionRow, rawTopics: string[]): void {
  const normalized = [...new Set(rawTopics.map((t) => normalizeQueryLabel(t)).filter((t) => t.length > 0))];
  if (normalized.length === 0) return;
  const tagSet = new Set((question.tags ?? []).map((t) => normalizeQueryLabel(t)));
  const fresh = normalized.filter((t) => !tagSet.has(t));
  if (fresh.length === 0) return;
  const existing = question.topics ?? [];
  const merged = [...existing, ...fresh.filter((t) => !existing.includes(t))].slice(0, 4);
  if (merged.length === existing.length && merged.every((t, idx) => t === existing[idx]!)) return;
  store.updateQuestion(question.id, { topics: merged, topicsSource: 'ai-deep' });
}

/** P2 建议题量上限（设计 §4：缺省 50，单次最多 100；非法输入按缺省）。 */
function clampTopicSuggestLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isInteger(limit) || limit < 1) return 50;
  return Math.min(limit, 100);
}

/**
 * P2 显式指定题目的建议挑选（M5）：questionIds 校验为字符串数组、长度 1-20
 * （非法 → EXAM_INVALID_BODY）；每道题须存在且属于该库（缺失/跨库 →
 * EXAM_QUESTION_NOT_FOUND）且为客观题（essay → EXAM_INVALID_QUESTION，
 * 与解析路径 assertNotEssay 语义一致）。返回按传入顺序的题目行。
 */
function resolveTopicSuggestQuestions(store: ExamStore, bankId: string, questionIds: string[]): QuestionRow[] {
  if (!Array.isArray(questionIds) || !questionIds.every((id) => typeof id === 'string')) {
    throw new ExamServiceError('EXAM_INVALID_BODY', 'questionIds must be a string array');
  }
  if (questionIds.length < 1 || questionIds.length > 20) {
    throw new ExamServiceError('EXAM_INVALID_BODY', 'questionIds must have 1-20 entries');
  }
  return questionIds.map((id) => {
    const row = store.getQuestion(id);
    if (row === undefined) {
      throw new ExamServiceError('EXAM_QUESTION_NOT_FOUND', `question not found: ${id}`);
    }
    if (row.bankId !== bankId) {
      throw new ExamServiceError(
        'EXAM_QUESTION_NOT_FOUND',
        `question ${id} does not belong to bank ${bankId}`,
      );
    }
    // essay 拒绝（默认挑选路径同样跳过 essay，语义一致）。
    assertNotEssay(row);
    return row;
  });
}

/**
 * P2 applyTopics 单题校验（非法 → EXAM_INVALID_BODY）：topics 1-4 个（规范化去重后）、
 * 不得与该题主题 tag 同项。返回规范化后的 topics。
 */
function validateApplyTopics(question: QuestionRow, rawTopics: unknown): string[] {
  if (!Array.isArray(rawTopics) || !rawTopics.every((t) => typeof t === 'string')) {
    throw new ExamServiceError('EXAM_INVALID_BODY', 'topics must be a string array');
  }
  const deduped = [...new Set((rawTopics as string[]).map((t) => normalizeQueryLabel(t)).filter((t) => t.length > 0))];
  if (deduped.length < 1 || deduped.length > 4) {
    throw new ExamServiceError('EXAM_INVALID_BODY', 'topics must have 1-4 non-empty entries');
  }
  const tagSet = new Set((question.tags ?? []).map((t) => normalizeQueryLabel(t)));
  const overlap = deduped.find((t) => tagSet.has(t));
  if (overlap !== undefined) {
    throw new ExamServiceError('EXAM_INVALID_BODY', `topic overlaps a tag: ${overlap}`);
  }
  return deduped;
}

/** 创建题目的输入校验（非法 → EXAM_INVALID_QUESTION）。 */
function validateQuestionInput(input: CreateQuestionRequest): void {
  if (!isQuestionType(input.type)) {
    throw new ExamServiceError('EXAM_INVALID_QUESTION', `invalid question type: ${String(input.type)}`);
  }
  if (typeof input.stem !== 'string' || input.stem.trim().length === 0) {
    throw new ExamServiceError('EXAM_INVALID_QUESTION', 'question stem must be a non-empty string');
  }
  if (!isStringArray(input.options)) {
    throw new ExamServiceError('EXAM_INVALID_QUESTION', 'question options must be a string array');
  }
  if (input.answer === undefined) {
    throw new ExamServiceError('EXAM_INVALID_QUESTION', 'question answer is required');
  }
  validateOptionalMeta(input.explanation, input.tags, input.topics);
}

/** 部分更新校验（仅校验出现的字段）。 */
function validateQuestionPatch(patch: UpdateQuestionRequest): void {
  if (patch.type !== undefined && !isQuestionType(patch.type)) {
    throw new ExamServiceError('EXAM_INVALID_QUESTION', `invalid question type: ${String(patch.type)}`);
  }
  if (patch.stem !== undefined && (typeof patch.stem !== 'string' || patch.stem.trim().length === 0)) {
    throw new ExamServiceError('EXAM_INVALID_QUESTION', 'question stem must be a non-empty string');
  }
  if (patch.options !== undefined && !isStringArray(patch.options)) {
    throw new ExamServiceError('EXAM_INVALID_QUESTION', 'question options must be a string array');
  }
  validateOptionalMeta(patch.explanation, patch.tags, patch.topics);
}

function validateOptionalMeta(explanation: unknown, tags: unknown, topics?: unknown): void {
  if (explanation !== undefined && explanation !== null && typeof explanation !== 'string') {
    throw new ExamServiceError('EXAM_INVALID_QUESTION', 'question explanation must be a string or null');
  }
  if (tags !== undefined && tags !== null && !isStringArray(tags)) {
    throw new ExamServiceError('EXAM_INVALID_QUESTION', 'question tags must be a string array or null');
  }
  if (topics !== undefined && topics !== null) {
    if (!isStringArray(topics)) {
      throw new ExamServiceError('EXAM_INVALID_QUESTION', 'question topics must be a string array or null');
    }
    // 规范化视图（与 store.normalizeLabels 同规则：trim/小写/去全部空白）后校验数量与主题冲突。
    const normalized = topics.map((t) => normalizeQueryLabel(t)).filter((t) => t.length > 0);
    if (normalized.length > 4) {
      throw new ExamServiceError('EXAM_INVALID_QUESTION', 'question topics must have at most 4 entries');
    }
    if (tags !== undefined && tags !== null && isStringArray(tags)) {
      const tagSet = new Set(tags.map((t) => normalizeQueryLabel(t)));
      const overlap = normalized.find((t) => tagSet.has(t));
      if (overlap !== undefined) {
        throw new ExamServiceError('EXAM_INVALID_QUESTION', `question topic overlaps a tag: ${overlap}`);
      }
    }
  }
}

function isQuestionType(value: unknown): value is ExamQuestionType {
  return typeof value === 'string' && (QUESTION_TYPES as readonly string[]).includes(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

function isNonEmptyStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.length > 0 && value.every((item) => typeof item === 'string' && item.length > 0);
}

// ---------------------------------------------------------------------------
// t9：批量题目操作与计划条目归一化
// ---------------------------------------------------------------------------

/**
 * 批量题目操作（tag/move/archive/delete/restore；explain-generic 由服务方法先行处理。
 * 在单个事务内先整体校验（任一 id 不存在/非活跃 → 整批回滚），再逐个应用；返回处理的 id 列表。
 */
function applyBulkQuestionOp(store: ExamStore, input: BulkQuestionOp): BulkQuestionsResult {
  if (!isNonEmptyStringArray(input.questionIds)) {
    throw new ExamServiceError('EXAM_INVALID_BODY', 'questionIds must be a non-empty string array');
  }
  const ids = [...new Set(input.questionIds)];
  const applied = store.withTransaction(() => {
    switch (input.op) {
      case 'tag': {
        const tag = typeof input.tag === 'string' ? normalizeQueryLabel(input.tag) : '';
        if (tag.length === 0) throw new ExamServiceError('EXAM_INVALID_BODY', 'tag must be a non-empty string');
        for (const id of ids) requireQuestionRow(store, id);
        for (const id of ids) {
          const question = requireQuestionRow(store, id);
          const tags = new Set(question.tags ?? []);
          if (input.add) tags.add(tag);
          else tags.delete(tag);
          store.updateQuestion(id, { tags: [...tags] });
        }
        return ids;
      }
      case 'topics': {
        if (!isNonEmptyStringArray(input.topics)) {
          throw new ExamServiceError('EXAM_INVALID_BODY', 'topics must be a non-empty string array');
        }
        const normalized = input.topics.map((t) => normalizeQueryLabel(t)).filter((t) => t.length > 0);
        if (normalized.length === 0 || normalized.length > 4) {
          throw new ExamServiceError('EXAM_INVALID_BODY', 'topics must have 1-4 non-empty entries');
        }
        // 覆盖式写回（规范化与去重由 store.updateQuestion 收口）；不得与现有主题 tag 同项。
        for (const id of ids) {
          const question = requireQuestionRow(store, id);
          const tagSet = new Set((question.tags ?? []).map((t) => normalizeQueryLabel(t)));
          const overlap = normalized.find((t) => tagSet.has(t));
          if (overlap !== undefined) {
            throw new ExamServiceError('EXAM_INVALID_BODY', `topic overlaps a tag: ${overlap}`);
          }
        }
        for (const id of ids) store.updateQuestion(id, { topics: input.topics });
        return ids;
      }
      case 'move': {
        requireBankExists(store, input.bankId);
        for (const id of ids) requireQuestionRow(store, id);
        for (const id of ids) store.moveQuestion(id, input.bankId);
        return ids;
      }
      case 'archive':
      case 'delete': {
        for (const id of ids) requireQuestionRow(store, id);
        for (const id of ids) store.deleteQuestion(id);
        return ids;
      }
      case 'restore': {
        for (const id of ids) {
          if (store.getQuestionIncludingDeleted(id) === undefined) {
            throw new ExamServiceError('EXAM_QUESTION_NOT_FOUND', `question not found: ${id}`);
          }
        }
        for (const id of ids) store.restoreQuestion(id);
        return ids;
      }
      default:
        throw new ExamServiceError('EXAM_INVALID_BODY', `unsupported bulk operation: ${String((input as { op?: string }).op)}`);
    }
  });
  return { applied: applied.length, questionIds: applied };
}

/** 把一条结构化计划条目（PlanDraft / PlanItemInput）归一化为 store 写入输入。 */
function normalizePlanItemInput(input: PlanItemInput, index: number): AddPlanItemInput {
  const title = typeof input.title === 'string' ? input.title.trim() : '';
  if (title.length === 0) {
    throw new ExamServiceError('EXAM_INVALID_BODY', 'plan item title must be a non-empty string');
  }
  const normalized: AddPlanItemInput = { title, sort: index };
  normalized.note = input.note === undefined ? null : input.note;
  if (input.actionType !== undefined) normalized.actionType = input.actionType;
  if (input.scope !== undefined) normalized.scope = input.scope;
  if (input.dueAt !== undefined) normalized.dueAt = input.dueAt;
  if (input.priority !== undefined) normalized.priority = input.priority;
  if (input.status !== undefined) normalized.status = input.status;
  if (input.sourceDiagnosisId !== undefined) normalized.sourceDiagnosisId = input.sourceDiagnosisId;
  return normalized;
}

/** 归一化条目数组（兼容旧版纯标题字符串与结构化 PlanItemInput），赋予 sort=index。 */
function normalizePlanItemInputs(items: Array<string | PlanItemInput>): AddPlanItemInput[] {
  if (!Array.isArray(items) || items.length === 0) {
    throw new ExamServiceError('EXAM_INVALID_BODY', 'plan items must be a non-empty array');
  }
  const result: AddPlanItemInput[] = [];
  for (let index = 0; index < items.length; index++) {
    const item = items[index]!;
    if (typeof item === 'string') {
      const title = item.trim();
      if (title.length === 0) {
        throw new ExamServiceError('EXAM_INVALID_BODY', 'plan item title must be a non-empty string');
      }
      result.push({ title, sort: index });
    } else {
      result.push(normalizePlanItemInput(item, index));
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// Phase 2 DTO 映射
// ---------------------------------------------------------------------------

/** 自由问答（无绑定题目）的 Tutor 消息组装：system + 历史轮次 + 新提问。 */
function buildFreeChatMessages(history: readonly TutorMessageRow[], newMessage: string): LlmMessage[] {
  const messages: LlmMessage[] = [{ role: 'system', content: [{ type: 'text', text: TUTOR_SYSTEM }] }];
  for (const entry of history) {
    messages.push({ role: entry.role, content: [{ type: 'text', text: entry.content }] });
  }
  messages.push({ role: 'user', content: [{ type: 'text', text: newMessage }] });
  return messages;
}

/** EssayGradingRow → DTO（reference/provider 缺省省略）。 */
function toEssayGradingDto(row: EssayGradingRow): EssayGradingDto {
  return {
    attemptId: row.attemptId,
    score: row.score,
    verdict: row.verdict,
    feedback: row.feedback,
    ...(row.reference !== null ? { reference: row.reference } : {}),
    isCorrect: row.isCorrect,
    ...(row.provider !== null ? { provider: row.provider } : {}),
  };
}

/** 文本截断（按字符，末尾加 …；用于会话标题等摘要展示）。 */
function truncateText(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}…`;
}

/** 会话列表标题：绑定题 → 题干摘要；否则首条用户消息摘要；兜底「自由问答」。 */
function tutorSessionTitle(row: TutorSessionRow): string {
  if (row.questionId !== null && row.questionStem !== null && row.questionStem !== undefined) {
    const stem = row.questionStem.replace(/\s+/g, ' ').trim();
    return `题目讲解 · ${truncateText(stem, 24)}`;
  }
  if (row.firstUserMessage !== null && row.firstUserMessage !== undefined) {
    const preview = row.firstUserMessage.replace(/\s+/g, ' ').trim();
    return preview.length > 0 ? truncateText(preview, 20) : '自由问答';
  }
  return '自由问答';
}

function toTutorSessionDto(row: TutorSessionRow): TutorSessionDto {
  return {
    id: row.id,
    ...(row.questionId !== null ? { questionId: row.questionId } : {}),
    ...(row.bankId !== null ? { bankId: row.bankId } : {}),
    status: row.status,    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    title: tutorSessionTitle(row),
  };
}

function toTutorMessageDto(row: TutorMessageRow): TutorMessageDto {
  return {
    id: row.id,
    sessionId: row.sessionId,
    role: row.role,
    content: row.content,
    createdAt: row.createdAt,
  };
}

function toPlanDto(row: StudyPlanRow): PlanDto {
  return {
    id: row.id,
    title: row.title,
    source: row.source,
    status: row.status,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function toPlanItemDto(row: PlanItemRow): PlanItemDto {
  return {
    id: row.id,
    title: row.title,
    status: row.status,
    sort: row.sort,
    completedAt: row.completedAt,
    ...(row.note !== null ? { note: row.note } : {}),
    ...(row.actionType !== null ? { actionType: row.actionType } : {}),
    ...(row.scope !== null && typeof row.scope === 'object' ? { scope: row.scope as PracticeScopeDto } : {}),
    ...(row.dueAt !== null ? { dueAt: row.dueAt } : {}),
    priority: row.priority,
    ...(row.sourceDiagnosisId !== null ? { sourceDiagnosisId: row.sourceDiagnosisId } : {}),
  };
}

/** store 诊断行 → 持久化诊断记录 DTO（t13；suggestions 为结构化条目）。 */
function toDiagnosisRecordDto(row: DiagnosisRow): DiagnosisRecordDto {
  return {
    id: row.id,
    summary: row.summary,
    weaknesses: [...row.weaknesses],
    suggestions: row.suggestions.map((item) => ({
      text: item.text,
      ...(item.action !== undefined ? { action: item.action } : {}),
    })),
    provider: row.provider,
    model: row.model,
    createdAt: row.createdAt,
  };
}

// ---------------------------------------------------------------------------
// t5：AI 导入原子提交与草稿条目规范化
// ---------------------------------------------------------------------------

/**
 * 导入提交核心（原子 + 幂等，设计 §16 §3.6）：
 * - batchId 命中已提交批次 → 重放（按 question_ids 回读题目，零写入）；bank 不一致 → 409。
 * - 否则 withTransaction 内逐题创建（服务端校验）+ 写批次行；同批次重复 item_key →
 *   EXAM_IMPORT_DUPLICATE_ITEM 整批回滚；任何失败 ROLLBACK——批次行不存在，
 *   客户端重试整批重跑，零残留。draftId 与批次同一事务置 committed。
 * 说明：本函数全程同步（node:sqlite 同步 API + 无 await），同一连接上事务天然原子。
 */
function commitImport(
  store: ExamStore,
  createQuestionInternal: (
    bankId: string,
    input: CreateQuestionRequest,
    meta?: { importBatchId: string; importItemKey: string },
  ) => ExamQuestionDto,
  computeImportItemKey: (input: CreateQuestionRequest) => string,
  bankId: string,
  items: CreateQuestionRequest[],
  opts: { batchId?: string; draftId?: string },
): CommitImportResult {
  if (opts.batchId !== undefined) {
    const batch = store.getImportBatch(opts.batchId);
    if (batch !== undefined) {
      if (batch.bankId !== bankId) {
        throw new ExamServiceError(
          'EXAM_IMPORT_BATCH_CONFLICT',
          `import batch ${opts.batchId} belongs to bank ${batch.bankId}, not ${bankId}`,
        );
      }
      const questions = batch.questionIds
        .map((id) => store.getQuestion(id))
        .filter((q): q is QuestionRow => q !== undefined)
        .map(toQuestionDto);
      return { count: questions.length, questions, batchId: batch.id, replayed: true };
    }
  }
  const batchId = opts.batchId ?? randomUUID();
  const created: ExamQuestionDto[] = [];
  const seenKeys = new Set<string>();
  store.withTransaction(() => {
    for (const item of items) {
      const key = computeImportItemKey(item);
      if (seenKeys.has(key)) {
        throw new ExamServiceError(
          'EXAM_IMPORT_DUPLICATE_ITEM',
          `duplicate question in import batch (item key ${key.slice(0, 12)}…)`,
        );
      }
      seenKeys.add(key);
      created.push(createQuestionInternal(bankId, item, { importBatchId: batchId, importItemKey: key }));
    }
    store.saveImportBatch({ id: batchId, bankId, questionIds: created.map((q) => q.id) });
    if (opts.draftId !== undefined) {
      store.updateImportDraftStatus(opts.draftId, 'committed');
    }
  });
  return { count: created.length, questions: created, batchId, replayed: false };
}

/** 持久化草稿 items（unknown[]）→ 合法 CreateQuestionRequest[]（结构过滤；服务端 createQuestion 再校验）。 */
function normalizeDraftItems(draft: ImportDraftRow): CreateQuestionRequest[] {
  const items: CreateQuestionRequest[] = [];
  for (const item of draft.items) {
    if (typeof item !== 'object' || item === null) continue;
    const record = item as Record<string, unknown>;
    const type = record.type;
    if (type !== 'single' && type !== 'multiple' && type !== 'boolean') continue;
    const stem = record.stem;
    if (typeof stem !== 'string') continue;
    const options = record.options;
    if (!Array.isArray(options) || !options.every((entry) => typeof entry === 'string')) continue;
    const question: CreateQuestionRequest = {
      type: type as ExamQuestionType,
      stem,
      options,
      answer: record.answer,
    };
    if (
      record.explanation !== undefined &&
      record.explanation !== null &&
      typeof record.explanation === 'string'
    ) {
      question.explanation = record.explanation;
    }
    if (
      record.tags !== undefined &&
      record.tags !== null &&
      Array.isArray(record.tags) &&
      record.tags.every((entry) => typeof entry === 'string')
    ) {
      question.tags = record.tags as string[];
    }
    // 导入路径透传 topics（topicsSource 由 createQuestionInternal 按 import 置位）。
    if (
      record.topics !== undefined &&
      record.topics !== null &&
      Array.isArray(record.topics) &&
      record.topics.every((entry) => typeof entry === 'string')
    ) {
      question.topics = record.topics as string[];
    }
    items.push(question);
  }
  return items;
}
