/**
 * dsh-exam Host ↔ Client 契约类型（单端来源：Host `src/host/contract.ts`）。
 *
 * - 全部为纯 JSON 可序列化 DTO；不引用任何 Cordis/DSH live 对象。
 * - Client 侧 `src/client/types.ts` 为 type-only 再导出垫片（`export type *`），
 *   bundle 零运行时依赖；Host 路由/服务层直接引用本模块。
 * - 错误码词汇表与 `src/host/errors.ts` 的 ExamServiceErrorCode 对齐
 *   （HTTP 层映射状态码：400 / 404 / 405 / 500 / 503）。
 */

// ── Phase 0：健康 / 题库 / LLM 测试 ────────────────────────────────────────

/** Host 健康状态（ok:false 时 error 说明原因；503 同结构返回）。 */
export interface ExamHealthDto {
  ok: boolean;
  service: 'exam';
  store: {
    ok: boolean;
    path: string;
    closed: boolean;
    schemaVersion: number;
  };
  /** 题库数量（store 不可用时为 0）。 */
  banks: number;
  /** DSH llm 服务是否已接线。 */
  llmReady: boolean;
  /** 服务创建时间（epoch 毫秒）。 */
  startedAt: number;
  error?: string;
}

/** 题库行（与 @exam/shared.Bank 同构；createdAt 为 epoch 毫秒）。t9 增补生命周期字段。 */
export interface ExamBankDto {
  id: string;
  name: string;
  createdAt: number;
  /** 软删除时间戳；null = 未删除（t9 题库生命周期）。 */
  deletedAt: number | null;
  /** 软归档时间戳；null = 未归档（t9 题库生命周期）。 */
  archivedAt: number | null;
}

/** PATCH /exam/api/banks/:id 请求体（t9 重命名）。 */
export interface RenameBankRequest {
  name: string;
}

/** 统一错误体。 */
export interface ExamErrorDto {
  code: string;
  message: string;
}

/** Host 侧错误码词汇（未知码原样透传展示）。 */
export type ExamErrorCode =
  | 'EXAM_BANK_NAME_REQUIRED'
  | 'EXAM_BANK_NOT_FOUND'
  | 'EXAM_QUESTION_NOT_FOUND'
  | 'EXAM_INVALID_QUESTION'
  | 'EXAM_PRACTICE_NOT_FOUND'
  | 'EXAM_QUESTION_NOT_IN_PRACTICE'
  | 'EXAM_INVALID_SCOPE'
  // t1 领域正确性：会话状态与范围守卫
  | 'EXAM_PRACTICE_FINISHED'
  | 'EXAM_EMPTY_PRACTICE_SCOPE'
  | 'EXAM_INVALID_BODY'
  | 'EXAM_METHOD_NOT_ALLOWED'
  | 'EXAM_NOT_FOUND'
  | 'EXAM_STORE_CLOSED'
  | 'EXAM_STORE_UNAVAILABLE'
  | 'EXAM_STORE_FAILED'
  | 'EXAM_INTERNAL'
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
  | 'EXAM_EXPLANATION_NOT_FOUND';

/** /exam/api/llm/test SSE 事件（data 行 JSON）。 */
export type ExamLlmSseEvent =
  | { type: 'delta'; text: string }
  | {
      type: 'done';
      result: {
        text: string;
        usage?: unknown;
        finish: string;
        provider: string;
        model: string;
      };
    }
  | { type: 'error'; error: ExamErrorDto };

/** /exam/api/llm/test 请求体。 */
export interface ExamLlmTestRequest {
  prompt: string;
  provider?: string;
  model?: string;
}

/** POST /exam/api/banks 请求体。 */
export interface ExamCreateBankRequest {
  name: string;
}

// ── Phase 1：题目 ──────────────────────────────────────────────────────────

/** 客观题题型 + essay 主观题（essay：options 恒为 []，answer 恒为 null，由 AI 批改）。 */
export type ExamQuestionType = 'single' | 'multiple' | 'boolean' | 'essay';

/** 题目 DTO（answer 编码见 src/host/grading.ts 文档）。 */
export interface ExamQuestionDto {
  id: string;
  bankId: string;
  type: ExamQuestionType;
  stem: string;
  options: string[];
  /** single=标识字符串；multiple=字符串数组；boolean='true'|'false'。 */
  answer: unknown;
  explanation: string | null;
  /** 主题/章节级标签（展示、筛选、练习语义；字面规范化后存储，见 store normalizeLabels）。 */
  tags: string[] | null;
  /**
   * 知识点（知识单元级，粒度细于 tags：如「架构治理」「数据架构」）。
   * 统计/讲解/个性化上下文优先消费；null = 未标注（退化到 tags 统计）。
   */
  topics: string[] | null;
  /** 知识点来源（内部元数据：manual/import/batch/ai-deep）；null = 未标注/旧数据。 */
  topicsSource?: string | null;
  createdAt: number;
  updatedAt: number;
  /**
   * 软删除时间戳；null = 正常（t1 安全策略：删题只标记，历史/成绩单仍可解释）。
   * 新增字段，旧客户端可忽略。
   */
  deletedAt: number | null;
}

/** POST /exam/api/banks/:bankId/questions 请求体。 */
export interface CreateQuestionRequest {
  type: ExamQuestionType;
  stem: string;
  options: string[];
  answer: unknown;
  explanation?: string | null;
  tags?: string[] | null;
  /** 知识点（≤4 个；不允许与 tags 同项，服务层校验）。 */
  topics?: string[] | null;
  /** 知识点来源（内部元数据：manual/import/batch/ai-deep）；客户端不传。 */
  topicsSource?: string | null;
}

/** PUT /exam/api/questions/:id 请求体（仅提供的字段生效）。 */
export interface UpdateQuestionRequest {
  type?: ExamQuestionType;
  stem?: string;
  options?: string[];
  answer?: unknown;
  explanation?: string | null;
  tags?: string[] | null;
  /** 知识点（≤4 个；不允许与 tags 同项，服务层校验）。 */
  topics?: string[] | null;
}

/** GET /exam/api/banks/:id/questions 过滤选项（t9 题目管理；全部可选）。 */
export interface ListQuestionsFilter {
  /** 题干关键词（不区分大小写包含匹配）。 */
  q?: string;
  /** 题型过滤：单值或数组（任一匹配）。 */
  type?: ExamQuestionType | ExamQuestionType[];
  /** 标签包含：单值或数组；数组 = 全部包含（AND）。 */
  tags?: string | string[];
  /** true = 有解析；false = 无解析。 */
  hasExplanation?: boolean;
  /** true = 连同已软删除/已归档题目一起返回（供题库内"恢复"）；缺省 false。 */
  includeDeleted?: boolean;
  /** 排序（字段 + 方向）；缺省 createdAt ASC。 */
  sort?: { field: 'updatedAt' | 'createdAt'; dir: 'asc' | 'desc' };
}

/** `POST /exam/api/questions/bulk` 的批量操作（t9；逐个应用到给定题目 id 集合）。 */
export type BulkQuestionOp =
  /** 增/减主题标签。 */
  | { op: 'tag'; questionIds: string[]; tag: string; add: boolean }
  /** 覆盖设置知识点（≤4 个；规范化与校验同 createQuestion）。 */
  | { op: 'topics'; questionIds: string[]; topics: string[] }
  /** 移动到另一题库。 */
  | { op: 'move'; questionIds: string[]; bankId: string }
  /** 归档（软隐藏，可恢复；行级等价软删除）。 */
  | { op: 'archive'; questionIds: string[] }
  /** 恢复软删除/软归档的题目。 */
  | { op: 'restore'; questionIds: string[] }
  /** 软删除。 */
  | { op: 'delete'; questionIds: string[] }
  /** 逐个生成通用解析（LLM；成功覆盖题目 explanation）。 */
  | { op: 'explain-generic'; questionIds: string[] };

/** `POST /exam/api/questions/bulk` 响应。 */
export interface BulkQuestionsResult {
  /** 成功处理的题目数。 */
  applied: number;
  /** 处理的题目 id（与请求同序）。 */
  questionIds: string[];
  /** explain-generic 时附更新后的题目 DTO。 */
  questions?: ExamQuestionDto[];
}

// ── Phase 1：作答 / 练习 ───────────────────────────────────────────────────

/** 作答 DTO。 */
export interface ExamAttemptDto {
  id: string;
  questionId: string;
  practiceId: string | null;
  userAnswer: unknown;
  isCorrect: boolean;
  answeredAt: number;
}

/** 练习范围 mode（byTopic 为 t1 知识点维度，topics 包含匹配）。 */
export type PracticeScopeMode = 'all' | 'undone' | 'wrong' | 'byType' | 'byTag' | 'byTopic';

/** 练习范围（byType/byTag/byTopic 需要筛选值；缺省回退 all 并记录 warn）。t9 支持显式题目集合。 */
export interface PracticeScopeDto {
  mode: PracticeScopeMode;
  /** byType 筛选值。 */
  type?: ExamQuestionType;
  /** byTag 筛选值（按 tags 包含匹配）。 */
  tag?: string;
  /** byTopic 筛选值（按 topics 包含匹配）。 */
  topic?: string;
  /**
   * t9：显式指定题目集合（供错题单题/多选重练）。给定时按此列表解析，
   * 不做 mode 筛选；校验每道题存在且属于 bank（任一不存在则拒绝）。
   */
  questionIds?: string[];
}

/** 练习会话 DTO。 */
export interface PracticeSessionDto {
  id: string;
  bankId: string;
  scope: PracticeScopeDto;
  questionIds: string[];
  currentIndex: number;
  status: 'active' | 'finished';
  createdAt: number;
  finishedAt: number | null;
}

/** 单题型聚合。 */
export interface ScorecardTypeStat {
  total: number;
  answered: number;
  correct: number;
  /** 0..1；answered=0 时为 0。 */
  accuracy: number;
}

/** 成绩单（按每题最新作答聚合）。 */
export interface ScorecardDto {
  practiceId: string;
  total: number;
  answered: number;
  correct: number;
  accuracy: number;
  byType: Record<string, ScorecardTypeStat>;
}

/** 掌握判定来源：computed=连续答对达标自动置位；manual=用户手动标记/取消。 */
export type MasterySource = 'computed' | 'manual';

/** 错题本条目 DTO（t9 增补掌握模型字段；向后兼容，旧客户端忽略新增字段）。 */
export interface WrongEntryDto {
  questionId: string;
  wrongCount: number;
  lastWrongAt: number | null;
  mastered: boolean;
  /** 连续答对次数（答对递增、答错清零；达 MASTERY_THRESHOLD 按 computed 置 mastered）。 */
  consecutiveCorrect: number;
  /** 最近一次判分结果（true=对，false=错，null=无作答）。 */
  lastResult: boolean | null;
  /** 累计答错次数（只增不减，区别于会递减的 wrong_count）。 */
  lifetimeWrongCount: number;
  /** 掌握来源；未掌握为 null。 */
  masterySource: MasterySource | null;
  /**
   * 最近一次作答的用户答案（JSON 可序列化原值：单/多选为字母/字母数组，
   * 判断为 'true'/'false'，essay 为正文）；无作答为 null。
   * 用途：错题本回顾时标记「当时选错」的选项。
   */
  lastAnswer: unknown | null;
}

// ── Phase 1：请求/响应体 ───────────────────────────────────────────────────

/** POST /exam/api/practice/start 请求体。 */
export interface StartPracticeRequest {
  bankId: string;
  scope: PracticeScopeDto;
  /** 可选：Fisher-Yates 洗牌。 */
  shuffle?: boolean;
  /** 可选：固定随机种子（确定性洗牌）。 */
  seed?: string;
}

/** PATCH /exam/api/practice/:id 请求体。 */
export interface UpdatePracticeIndexRequest {
  currentIndex: number;
}

/** POST /exam/api/quiz/grade 请求体。 */
export interface GradeAnswerRequest {
  practiceId: string;
  questionId: string;
  answer: unknown;
}

/** POST /exam/api/wrong/:questionId/master 请求体。 */
export interface SetMasteredRequest {
  mastered: boolean;
}

/** GET /exam/api/practice/:id 响应（续做态）。 */
export interface ResumePracticeResponse {
  practice: PracticeSessionDto;
  latestAttempts: ExamAttemptDto[];
}

/** POST /exam/api/practice/:id/finish 响应。 */
export interface FinishPracticeResponse {
  practice: PracticeSessionDto;
  scorecard: ScorecardDto;
}

// ── Phase 2：AI 导入 / 学情 / 计划（存储层已先行定义，此处补充请求/响应 DTO）──────

/** AI 导入的题目草稿（仅客观题三型；answer 编码同 CreateQuestionRequest）。 */
export interface ImportedQuestion {
  type: ExamQuestionType;
  stem: string;
  options: string[];
  answer: unknown;
  explanation?: string | null;
  tags?: string[] | null;
  /** 知识点（P1 导入提示词要求必产 2~4 个知识单元级中文短语；解析容忍缺失/非法形态）。 */
  topics?: string[] | null;
}

/** AI 导入草稿 DTO（与 ImportedQuestion 同形；t3 路由/服务层使用）。 */
export type ImportedQuestionDto = ImportedQuestion;

/** 学情洞察查询输入（均可选；windowDays 限 7/14/30，service 层校验）。 */
export interface InsightQueryInput {
  /** 趋势窗口天数（7/14/30；缺省 7）。 */
  windowDays?: number;
  /** 题库维度过滤（缺省全部活跃题库；不存在抛 EXAM_BANK_NOT_FOUND）。 */
  bankId?: string;
}

/** 学情洞察摘要（纯统计聚合；趋势窗口按本地日期归日，含空档日）。t13 增补窗口/streak/相对薄弱判定。 */
export interface InsightSummary {
  /** 本次聚合的趋势窗口天数（回显，供 UI 标题）。 */
  windowDays: number;
  /** 总答题数。 */
  totalAttempts: number;
  /** 正确数。 */
  correctAttempts: number;
  /** 0..1；无作答时为 0。 */
  accuracy: number;
  /** 趋势窗口内每日答题/正确（升序，含空档日，key 为本地日期 'YYYY-MM-DD'）。 */
  daily: { date: string; total: number; correct: number }[];
  /** 按题型聚合（key=题型；total=题目数，answered/correct=作答数）。 */
  byType: Record<string, ScorecardTypeStat>;
  /**
   * 错题 Top10（按 wrong_count 降序；附 stem 摘要 / 最近错误时间 / 所属题库 /
   * 知识点 chips：topics 优先，无 topics 回退 tags，均无则为空数组）。
   */
  wrongTop: {
    questionId: string;
    bankId: string;
    wrongCount: number;
    lastWrongAt: number | null;
    stem: string;
    topics: string[];
  }[];
  /** 已结束练习会话数。 */
  finishedPractices: number;
  /**
   * 薄弱题型（t13 相对判定：accuracy < max(整体−15pp, 60%) 且 answered ≥ 3，
   * 升序 Top 5；采样数可从 byType 取；无满足项时为空数组）。
   */
  weakTypes: string[];
  /**
   * t9：每题**首次**作答的正确率（chronologically 首次 attempt，按 answered_at 取首条；
   * 仅统计有过首次作答的题目；无作答时为 0）。
   */
  firstAttemptAccuracy: number;
  /**
   * t9：每题**最新一次**作答的正确率（「当前掌握率」——最新作答正确即视为掌握）；
   * 仅统计有过作答的题目；无作答时为 0。
   */
  currentMastery: number;
  /** t9：已作答唯一题数 / 可用题数（活跃题库的活跃题目；可用为 0 时为 0）。 */
  coverage: number;
  /** t13：窗口正确率（daily 全窗口 total/correct 汇总；无作答时为 0）。 */
  accuracyWindow: number;
  /** t13：连续学习天数（从今天/昨天起连续有作答的天数）。 */
  streakDays: number;
  /** t13：薄弱标签（相对判定 + 采样门槛，升序 Top 5，附采样数；无满足项时为空数组）。 */
  weakTags: { tag: string; answered: number; correct: number; accuracy: number }[];
  /**
   * t1/t13：薄弱知识点（口径同 weakTags；题目无 topics 时不参与，无满足项返回空数组）。
   */
  weakTopics: WeakTopicStat[];
}

/** 知识点级薄弱统计条目（topics 维度聚合；口径同 weakTags）。 */
export interface WeakTopicStat {
  topic: string;
  answered: number;
  correct: number;
  /** 0..1；answered=0 时为 0。 */
  accuracy: number;
}

/** 学情摘要 DTO（与 InsightSummary 同形；t3 服务/路由层使用）。 */
export type InsightSummaryDto = InsightSummary;

/** LLM 学情诊断建议的可执行动作（结构化建议；客户端渲染直达按钮）。 */
export interface DiagnosisSuggestionActionDto {
  /** 练习范围模式（all/wrong 直达；byType/byTag 需筛选值）。 */
  mode: 'all' | 'wrong' | 'byType' | 'byTag';
  /** byType 筛选值（题型）。 */
  type?: string;
  /** byTag 筛选值（标签）。 */
  tag?: string;
}

/** 诊断建议条目：文本 + 可选动作（兼容 LLM 输出纯字符串 → 仅 text）。 */
export interface DiagnosisSuggestionDto {
  text: string;
  action?: DiagnosisSuggestionActionDto;
}

/** LLM 学情诊断结果（t13：suggestions 结构化，可携带直达动作）。 */
export interface DiagnosisDto {
  summary: string;
  weaknesses: string[];
  suggestions: DiagnosisSuggestionDto[];
}

/** 持久化诊断记录（t13：diagnose 成功即落库；历史可回看）。 */
export interface DiagnosisRecordDto extends DiagnosisDto {
  id: string;
  /** 生成所用 provider 路由 id（审计用）；可空。 */
  provider: string | null;
  /** 生成所用模型 id（审计用）；可空。 */
  model: string | null;
  createdAt: number;
}

/** GET /exam/api/insights/diagnoses 响应。 */
export interface ListDiagnosesResult {
  diagnoses: DiagnosisRecordDto[];
}

/** 学习计划草稿条目（t9 增补可执行字段：actionType/scope/priority/dueAt/sourceDiagnosisId）。 */
export interface PlanDraft {
  title: string;
  note?: string;
  /** 执行类型（practice/reviewError/read/tutor）。 */
  actionType?: PlanItemActionType;
  /** 执行范围（供一键开始练习）。 */
  scope?: PracticeScopeDto;
  /** 优先级（越小越优先；缺省 0）。 */
  priority?: number;
  /** 到期时间（epoch 毫秒）。 */
  dueAt?: number;
  /** 来源学情诊断 id（可追溯）。 */
  sourceDiagnosisId?: string;
}

// ── Phase 2：essay 批改 ───────────────────────────────────────────────────

/** 批改结论（LLM 输出，与 store.GradingVerdict 对齐）。 */
export type GradingVerdictDto = 'correct' | 'partial' | 'incorrect';

/** essay 批改结果 DTO（reference 缺省省略；isCorrect 由 score>=60 归一）。 */
export interface EssayGradingDto {
  attemptId: string;
  /** 0..100 整数。 */
  score: number;
  verdict: GradingVerdictDto;
  /** 批改评语（LLM 输出）。 */
  feedback: string;
  /** 参考答案要点（LLM 输出；可省略）。 */
  reference?: string;
  isCorrect: boolean;
  /** 批改所用 provider 路由 id（t5 可追溯；旧行为缺省）。 */
  provider?: string;
}

/** POST /exam/api/grading/essay 响应（SSE done 事件 result）。 */
export interface EssayGradingResultDto {
  attemptId: string;
  grading: Omit<EssayGradingDto, 'attemptId'>;
}

/** POST /exam/api/grading/essay 请求体。 */
export interface GradeEssayRequest {
  questionId: string;
  /** 可选：所属练习会话（给定时必须存在）。 */
  practiceId?: string;
  /** 学生作答（非空字符串）。 */
  userAnswer: string;
  provider?: string;
  model?: string;
}

// ── Phase 2：Tutor 多轮对话 ───────────────────────────────────────────────

/** Tutor 会话 DTO（questionId/bankId 缺省省略 = 自由问答会话）。 */
/** Tutor 会话 DTO。title 为服务端生成的显示标题（绑定题 → 题干摘要；否则首条用户消息摘要）。 */
export interface TutorSessionDto {
  id: string;
  questionId?: string;
  bankId?: string;
  status: 'active' | 'closed';
  createdAt: number;
  updatedAt: number;
  title: string;
}

/** Tutor 消息 DTO。 */
export interface TutorMessageDto {
  id: string;
  sessionId: string;
  role: 'user' | 'assistant';
  content: string;
  createdAt: number;
}

/** POST /exam/api/tutor/chat 请求体（sessionId 缺省 = 新建会话；questionId 可选自由问答）。 */
export interface ChatTutorRequest {
  sessionId?: string;
  questionId?: string;
  bankId?: string;
  message: string;
  provider?: string;
  model?: string;
  /**
   * t5 幂等键：同一「逻辑消息」的重试必须复用同一 id（服务端按它幂等重放/续跑）。
   * 每次新逻辑消息生成新 UUID；缺省（旧客户端/旧工具）服务端生成 srv-* 占位，无幂等。
   */
  clientMessageId?: string;
}

/** POST /exam/api/tutor/chat 响应（SSE done 事件 result；model 缺省省略）。 */
export interface ChatTutorResultDto {
  sessionId: string;
  messageId: string;
  reply: string;
  model?: string;
  /** t5：本次 turn 的 id（失败重试/审计用）。 */
  turnId?: string;
  /** t5：true = 同 clientMessageId 命中已完成 turn，零 LLM 重放。 */
  replayed?: boolean;
}

/**
 * t5：Tutor SSE error 事件载荷扩展（新类型 TutorErrorEvent）。
 * 与既有 `{ type:'error', error }` 事件兼容——新增字段全部可选，旧客户端忽略。
 */
export interface TutorErrorEvent {
  type: 'error';
  error: ExamErrorDto;
  /** 失败/取消时返回会话 id（新建会话的重试由此接管，不再产生第二个幽灵会话）。 */
  sessionId?: string;
  /** 失败/取消时返回 turn id（重试沿用）。 */
  turnId?: string;
  /**
   * true = 可重试（failed：LLM 错误/超时）；false = 用户主动取消（cancelled，
   * 客户端不自动重试，「重新发送」可用同一 clientMessageId）。
   */
  retryable?: boolean;
}

// ── Phase 2：AI 导入 ──────────────────────────────────────────────────────

/** POST /exam/api/import/generate 请求体。 */
export interface ImportGenerateRequest {
  /** 资料纯文本（长度 ≥50 字符）。 */
  text: string;
  provider?: string;
  model?: string;
}

/** POST /exam/api/import/generate 响应（t5：草稿服务端持久化，响应携带 draftId 供刷新恢复）。 */
export interface ImportGenerateResultDto {
  questions: ImportedQuestion[];
  /** 持久化草稿 id（可经 GET /exam/api/import/drafts/:id 恢复）。 */
  draftId: string;
}

/**
 * POST /exam/api/import/commit 请求体（t5 幂等）。
 * draftId 与 questions 二选一（draftId 优先，服务端从草稿载入条目）；
 * batchId 可选：命中已提交批次 → 重放（replayed:true，零写入）。
 */
export interface CommitImportRequest {
  bankId: string;
  questions?: CreateQuestionRequest[];
  /** 提交批次幂等键（同批重试复用；缺省服务端生成）。 */
  batchId?: string;
  /** 持久化草稿 id（优先于 questions）。 */
  draftId?: string;
}

/** POST /exam/api/import/commit 响应。 */
export interface CommitImportResult {
  /** 成功入库题目数。 */
  count: number;
  questions: ExamQuestionDto[];
  /** t5：本次提交的批次 id（客户端保存，重试复用）。 */
  batchId?: string;
  /** t5：true = 命中既有批次重放（零写入）。 */
  replayed?: boolean;
}

// ── Phase 2：学情 / 诊断 ──────────────────────────────────────────────────

/** POST /exam/api/insights/diagnose 请求体。 */
export interface DiagnoseInsightRequest {
  provider?: string;
  model?: string;
}

// ── Phase 2：学习计划 ─────────────────────────────────────────────────────

/** 学习计划 DTO。 */
export interface PlanDto {
  id: string;
  title: string;
  source: 'llm' | 'manual';
  status: 'active' | 'completed';
  createdAt: number;
  updatedAt: number;
}

/** 计划条目执行类型（t9 可执行计划）。 */
export type PlanItemActionType = 'practice' | 'reviewError' | 'read' | 'tutor';

/** 计划条目状态（t9 扩展：doing=进行中，skipped=已跳过）。 */
export type PlanItemStatus = 'pending' | 'doing' | 'done' | 'skipped';

/** 计划条目 DTO（t9 增补可执行字段；向后兼容，旧客户端忽略新增字段）。 */
export interface PlanItemDto {
  id: string;
  title: string;
  status: PlanItemStatus;
  sort: number;
  completedAt: number | null;
  /** 补充说明。 */
  note?: string;
  /** 执行类型（practice/reviewError/read/tutor）。 */
  actionType?: PlanItemActionType;
  /** 执行范围（供一键开始练习）。 */
  scope?: PracticeScopeDto;
  /** 到期时间（epoch 毫秒）。 */
  dueAt?: number;
  /** 优先级（越小越优先；缺省 0）。 */
  priority: number;
  /** 来源学情诊断 id（可追溯）。 */
  sourceDiagnosisId?: string;
}

/** 计划条目输入（t9：addPlanItems/createManualPlan 接受结构化条目；旧客户端仍可用字符串标题）。 */
export interface PlanItemInput {
  title: string;
  note?: string | null;
  actionType?: PlanItemActionType;
  scope?: PracticeScopeDto;
  dueAt?: number;
  priority?: number;
  status?: PlanItemStatus;
  sourceDiagnosisId?: string;
}

/** 计划及其全部条目。 */
export interface PlanWithItemsDto {
  plan: PlanDto;
  items: PlanItemDto[];
}

/** GET /exam/api/plans 响应。 */
export interface ListPlansResult {
  plans: PlanDto[];
}

/** POST /exam/api/plans/generate 请求体。 */
export interface GeneratePlanRequest {
  provider?: string;
  model?: string;
  /** 可选计划标题（缺省 'AI 学习计划'）。 */
  title?: string;
}

/** POST /exam/api/plans（手动新建）请求体（t9：items 兼容旧标题字符串数组与结构化条目）。 */
export interface CreateManualPlanRequest {
  title: string;
  /** 可选初始条目标题（旧版字符串）或结构化条目（t9）。 */
  items?: Array<string | PlanItemInput>;
}

/** POST /exam/api/plans/:id/items 请求体（t9：titles 旧版兼容 + items 结构化新增）。 */
export interface AddPlanItemsRequest {
  /** 旧版：仅条目标题数组。 */
  titles?: string[];
  /** t9：结构化条目（含 note/actionType/scope/priority/status/sourceDiagnosisId）。 */
  items?: Array<string | PlanItemInput>;
}

/** PATCH /exam/api/plans/:id/items/:itemId 请求体。 */
export interface SetPlanItemDoneRequest {
  done: boolean;
}

// ── Phase 2：练习历史 / 续做 ──────────────────────────────────────────────

/** GET /exam/api/practice/history 条目（finished 附 scorecard，active 附 answeredCount）。 */
export interface PracticeHistoryItemDto {
  practice: PracticeSessionDto;
  /** 该会话内已作答数（按 practice_id 归属统计；与 scorecard.answered 口径不同）。 */
  answeredCount: number;
  scorecard?: ScorecardDto;
}

// ── Phase 4：题目 AI 解析（P 个性化 / G 通用）─────────────────────────────

/**
 * 解析深度档（B 档位设计）：
 * - light（默认）：快速、凝练（≤400 字软引导），跟随模型默认思考档，缓存键含 depth；
 * - deep：「⚡ 深入讲解」，无字数限制、完整推理链 + 逐项排除 + 考点延伸，
 *   高思考档（reasoningEffort high/max）+ 显式抬升 maxTokens；独立缓存键互不挤占。
 */
export type ExplainDepth = 'light' | 'deep';

/**
 * POST /exam/api/practice/explain 请求体（SSE）。
 *
 * 防泄露硬边界（设计 §2.2）：服务端强制校验该 (practiceId, questionId) 已有
 * attempt（即已判分），否则 409 EXAM_NOT_GRADED；essay 题 400 EXAM_INVALID_QUESTION
 * （essay 解析复用批改反馈，不重叠建设）。
 */
export interface ExplainRequest {
  practiceId: string;
  questionId: string;
  provider?: string;
  model?: string;
  /** 思考深度 id（透传底层 GenerateOptions.reasoningEffort）；缺省 = provider 默认。 */
  reasoningEffort?: string;
  /** 解析深度档；缺省 light。 */
  depth?: ExplainDepth;
  /**
   * true = 「重新解析」：跳过缓存读取直接调 LLM，成功后覆盖同键旧行
   * （单份最新）；取消/失败零写入，旧内容原样保留。
   */
  force?: boolean;
}

/**
 * POST /exam/api/practice/explain 的 done.result：
 * - cached=true：缓存命中直接返回（未调 LLM，零 delta），无 explanationId；
 * - cached=false：本次流式新生成并在 done 时落库，附 explanationId。
 */
export interface ExplainResultDto {
  cached: boolean;
  explanationId?: string;
  content: string;
  model?: string;
  /** 生成所用 provider 路由 id；v5 前旧行缺省。 */
  provider?: string;
  /** 生成请求的思考深度 id；未指定（provider 默认）缺省。 */
  reasoningEffort?: string;
  /** 解析深度档（light/deep；v9 迁移旧行回填 light）。 */
  depth: ExplainDepth;
  /** 生成所用提示词版本（t5 缓存失效键）。 */
  promptVersion: number;
  /** 生成时题目 updated_at（题目编辑 → 命中条件失效，t5）。 */
  questionUpdatedAt: number;
  /** token 用量 / 终态（t5 可追溯；可省略）。 */
  inputTokens?: number;
  outputTokens?: number;
  finishReason?: string;
}

/** GET /exam/api/practice/explain 命中缓存时响应中的 explanation 对象。 */
export interface ExplanationDto {
  content: string;
  /** 生成所用模型 id（审计用）；早期数据可能为 null。 */
  model: string | null;
  /** 生成所用 provider 路由 id；v5 前旧行为 null。 */
  provider: string | null;
  /** 生成请求的思考深度 id；未指定（provider 默认）为 null。 */
  reasoningEffort: string | null;
  /** 解析深度档（light/deep）。 */
  depth: ExplainDepth;
  /** 生成所用提示词版本（t5 缓存失效键；存量行回填 1）。 */
  promptVersion: number;
  /** 生成时题目 updated_at（题目编辑 → 命中条件失效，t5）。 */
  questionUpdatedAt: number;
  createdAt: number;
}

/** POST /exam/api/questions/:id/explain-generic 请求体（G 形态，JSON 非流式）。 */
export interface ExplainGenericRequest {
  provider?: string;
  model?: string;
  /** 思考深度 id；缺省 = provider 默认。 */
  reasoningEffort?: string;
}

// ── t1：知识标注（P2 批量标注 / P3 深解析副产品）──────────────────────────

/**
 * POST /exam/api/banks/:bankId/topic-suggestions —— AI 知识标注草稿。
 * 请求：{ limit?: number }（缺省 50；单次最多 100）。
 * 响应：{ items: TopicSuggestionDto[] } —— 仅含"可生成建议"的客观题（essay 跳过），
 * 逐题 LLM 判别 topics（输入题干 + 现有 tags/topics）；LLM 无把握时建议沿用主题 tag。
 */
export interface TopicSuggestionDto {
  questionId: string;
  stem: string;
  /** 现有知识点（规范化后）。 */
  currentTopics: string[] | null;
  /** 现有主题标签。 */
  currentTags: string[] | null;
  /** LLM 建议知识点（1~4 个，规范化后；无把握时退化为 [主题 tag]）。 */
  suggestedTopics: string[];
}

/** POST /exam/api/banks/:bankId/topic-suggestions 响应。 */
export interface TopicSuggestionsResultDto {
  items: TopicSuggestionDto[];
}

/** POST /exam/api/questions/topics —— 用户确认后的批量写回（覆盖式）。 */
export interface ApplyTopicsRequest {
  items: { questionId: string; topics: string[] }[];
}

/** POST /exam/api/questions/topics 响应。 */
export interface ApplyTopicsResult {
  /** 成功写回的题目数。 */
  updated: number;
}
