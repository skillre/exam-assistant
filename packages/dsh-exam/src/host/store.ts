/**
 * Phase 0 可复用 Host 存储模块：Node 24 内置 `node:sqlite`（DatabaseSync）之上的
 * 最小考试领域存储（ExamStore）。
 *
 * 设计约束（Phase 0 贯通样板）：
 * - 只依赖 Node 内置模块（node:sqlite / node:fs / node:path / node:crypto），
 *   不引入 better-sqlite3，不依赖 Fastify，不读写全局 process 状态。
 * - 数据文件路径完全由 `openExamStore(path)` 工厂参数决定；`:memory:` 亦支持。
 * - 开启 WAL 与 foreign_keys；全部 SQL 走参数化 prepared statement。
 * - `close()` 幂等；关闭后的调用抛出带清晰信息的错误。
 * - Schema 用 `PRAGMA user_version` 做最小迁移跟踪：v1 banks；v2（Phase 1）
 *   questions / attempts / practice_sessions / wrong_book_state 及索引；v3（Phase 2）
 *   questions 重建（type CHECK 扩为含 essay）+ essay_gradings / tutor_sessions /
 *   tutor_messages / study_plans / plan_items 及索引；v4（Phase 4）explanations
 *   表（AI 解析缓存，UNIQUE(question_id, answer_norm)）及索引；v6（t1 修复）
 *   questions 增列 deleted_at（软删除安全策略，见 deleteQuestion 文档）；
 *   v7（t5 AI 可靠性与幂等）tutor_turns / import_batches / import_drafts 新表 +
 *   questions 导入批次列 / tutor_messages.turn_id / explanations 版本与 token 列 /
 *   essay_gradings 可追溯列（详见各方法文档）；v10（t13 学情治理）diagnoses
 *   诊断持久化表。
 *   后续表按 MIGRATIONS 数组追加即可。
 * - **`openExamStore` 为 async 工厂**：`node:sqlite` 延迟加载（首次调用时
 *   `await import('node:sqlite')` 并缓存构造器），配合模块顶部幂等的
 *   ExperimentalWarning 过滤器，消除启动时的
 *   `ExperimentalWarning: SQLite is an experimental feature`（静态 import 会在
 *   模块求值期、任何代码可干预之前就触发警告）。
 *
 * 行值来自 node:sqlite 的 `Record<string, SQLOutputValue>`，一律经显式映射
 * （toBankRow）转换为领域类型，避免类型谎报。
 */
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { DatabaseSync, SQLInputValue, SQLOutputValue } from 'node:sqlite';

// ---------------------------------------------------------------------------
// ExperimentalWarning 过滤器（必须在任何 node:sqlite 动态导入之前安装）
// ---------------------------------------------------------------------------

let warningFilterInstalled = false;

/**
 * 幂等安装 node:sqlite ExperimentalWarning 过滤器。
 *
 * Node 的默认 warning 打印器是运行时在 bootstrap 期注册到 `process` 'warning'
 * 事件上的监听器（位于监听器列表首位）；仅追加监听器不会阻止默认打印（实测
 * Node v24.13.0 两者都会输出），因此这里移除该默认监听器，改由本过滤器转发：
 * SQLite 的 ExperimentalWarning 静默，其余警告按近似默认格式 console.warn。
 *
 * 幂等性：模块实例内由 flag 保证只装一次；模块重新求值（如 HMR 热更）时默认
 * 打印器已被移除、列表首位即上次安装的过滤器，再次"移除首位 + 重装"后仍恰好
 * 只有一个过滤器生效，行为不变。
 */
function installWarningFilter(): void {
  if (warningFilterInstalled) return;
  warningFilterInstalled = true;
  const defaultPrinter = process.listeners('warning')[0];
  if (defaultPrinter !== undefined) process.removeListener('warning', defaultPrinter);
  process.on('warning', (warning: Error) => {
    if (warning.name === 'ExperimentalWarning' && warning.message.includes('SQLite')) {
      return;
    }
    console.warn(`(${process.pid}) ${warning.name}: ${warning.message}`);
  });
}

installWarningFilter();

/**
 * 掌握阈值：连续答对次数达到该值即按 computed 自动置位 mastered（t9，
 * 参考旧 masteryService 的 MASTERY_THRESHOLD=3 语义）。
 */
export const MASTERY_THRESHOLD = 3;

/** 领域行：题库。createdAt 为 epoch 毫秒；deletedAt/archivedAt 为软删除/软归档时间戳（null=正常）。 */
export interface BankRow {
  readonly id: string;
  readonly name: string;
  readonly createdAt: number;
  /** 软删除时间戳；null = 未删除（t9：bank 生命周期）。 */
  readonly deletedAt: number | null;
  /** 软归档时间戳；null = 未归档（t9：bank 生命周期）。 */
  readonly archivedAt: number | null;
}

/** `listBanks` 过滤选项（t9：默认返回未删除且未归档的活跃题库）。 */
export interface ListBanksOptions {
  /** true = 连同已归档的一起返回（仍排除已删除）；缺省 false。 */
  includeArchived?: boolean;
  /** true = 连同已删除的一起返回；缺省 false。 */
  includeDeleted?: boolean;
}

/** `listQuestionsByBank` 过滤选项（t9 题目管理）。 */
export interface QuestionListFilter {
  /** 题干关键词（不区分大小写包含匹配）。 */
  q?: string;
  /** 题型过滤：单值或数组（任一匹配）。 */
  type?: StoredQuestionType | readonly StoredQuestionType[];
  /** 标签包含：单值或数组；数组 = 题目标签需包含全部给定标签（AND）。 */
  tags?: string | readonly string[];
  /** true = 有解析（explanation 非空）；false = 无解析。 */
  hasExplanation?: boolean;
  /** true = 连同已软删除/已归档的题目一起返回（供题库内"恢复"）；缺省 false。 */
  includeDeleted?: boolean;
  /** 排序字段与方向；缺省 created_at ASC。 */
  sort?: { field: 'updatedAt' | 'createdAt'; dir: 'asc' | 'desc' };
}

// ---------------------------------------------------------------------------
// Phase 1 领域类型：题目 / 作答 / 练习会话 / 错题本
// ---------------------------------------------------------------------------

/**
 * 题型（导出类型保持与 ExamQuestionType 一致，避免 practice.ts 的 toQuestionDto 直赋失配；
 * essay 属存储层放行题型，见 StoredQuestionType；契约四处同步见 Phase 2 设计 §1）。
 */
export type QuestionType = 'single' | 'multiple' | 'boolean';

/**
 * 存储层接受的题型：客观题三型 + essay 主观题（essay 无标准答案、由 AI 批改）。
 * `QuestionRow.type` 即此联合（**不再把运行时存在的 'essay' 谎报为客观三型**）。
 */
export type StoredQuestionType = QuestionType | 'essay';

/** 领域行：题目。options/tags 为 JSON 数组；answer 为任意 JSON（判分态由路由层解释）。 */
export interface QuestionRow {
  readonly id: string;
  readonly bankId: string;
  readonly type: StoredQuestionType;
  readonly stem: string;
  /** JSON 数组（如 ['A. …','B. …']）；essay 恒为 []。 */
  readonly options: string[];
  /** 任意 JSON（single=string；multiple=string[]；boolean='true'|'false'；essay=null）。 */
  readonly answer: unknown;
  readonly explanation: string | null;
  /** JSON 数组；null = 无标签。入库经 normalizeLabels 规范化（trim/小写/空白归一）。 */
  readonly tags: string[] | null;
  /**
   * 知识点（知识单元级，细于 tags；统计/讲解/个性化上下文优先消费）。
   * JSON 数组；null = 未标注。入库经 normalizeLabels 规范化。
   */
  readonly topics: string[] | null;
  /** 知识点来源（manual/import/batch/ai-deep）；未标注/旧数据为 null。 */
  readonly topicsSource: string | null;
  readonly createdAt: number;
  readonly updatedAt: number;
  /**
   * 软删除时间戳；null = 正常。**安全策略（t1）**：deleteQuestion 只做软删除——
   * 题目行、作答、批改、解析缓存、错题本状态与 practice_sessions.question_ids 全部
   * 保留（active 会话不被破坏、finished 历史仍可解释）；仅新建/更新/判分/列表等
   * 活跃操作把已删题目视为不存在（getQuestion 缺省排除，见 getQuestionIncludingDeleted）。
   */
  readonly deletedAt: number | null;
}

/** 创建题目的输入。 */
export interface CreateQuestionInput {
  id?: string;
  type: StoredQuestionType;
  stem: string;
  options: string[];
  answer: unknown;
  explanation?: string | null;
  tags?: string[] | null;
  /** 知识点（≤4 个；与 tags 同项冲突由服务层校验，store 只负责规范化与存储）。 */
  topics?: string[] | null;
  /** 知识点来源（manual/import/batch/ai-deep）；缺省 null。 */
  topicsSource?: string | null;
  /** t5：AI 导入批次的归属 id（批次幂等记录）；缺省 null。 */
  importBatchId?: string | null;
  /** t5：AI 导入批次内逐题幂等键（sha256(type|stem|options|answer)）；缺省 null。 */
  importItemKey?: string | null;
}

/** 题目部分更新（仅提供的字段生效；updated_at 自动刷新）。 */
export interface QuestionPatch {
  type?: StoredQuestionType;
  stem?: string;
  options?: string[];
  answer?: unknown;
  explanation?: string | null;
  tags?: string[] | null;
  /** 知识点（覆盖式；规范化后存储）。 */
  topics?: string[] | null;
  /**
   * 知识点来源（随 topics 一起生效）：topics 提供非空时缺省 'manual'；
   * topics 置空（null）时强制 null；topics 未提供时忽略本字段。
   */
  topicsSource?: string | null;
}

/** 领域行：作答记录。userAnswer 为任意 JSON；practiceId null = 独立作答。 */
export interface AttemptRow {
  readonly id: string;
  readonly questionId: string;
  readonly practiceId: string | null;
  readonly userAnswer: unknown;
  readonly isCorrect: boolean;
  readonly answeredAt: number;
}

/** 记录作答的输入。 */
export interface CreateAttemptInput {
  id?: string;
  questionId: string;
  practiceId?: string | null;
  userAnswer: unknown;
  isCorrect: boolean;
  answeredAt?: number;
}

/** 练习会话状态。 */
export type PracticeStatus = 'active' | 'finished';

/** 领域行：练习会话。scope 为任意 JSON（如范围描述）；questionIds 为 JSON 数组。 */
export interface PracticeSessionRow {
  readonly id: string;
  readonly bankId: string;
  readonly scope: unknown;
  readonly questionIds: string[];
  readonly currentIndex: number;
  readonly status: PracticeStatus;
  readonly createdAt: number;
  readonly finishedAt: number | null;
}

/** 创建练习会话的输入（status 恒为 'active'）。 */
export interface CreatePracticeSessionInput {
  id?: string;
  bankId: string;
  scope: unknown;
  questionIds: string[];
  currentIndex?: number;
  createdAt?: number;
}

/** 掌握判定来源：computed=连续答对达标自动置位；manual=用户手动标记/取消。 */
export type MasterySource = 'computed' | 'manual';

/**
 * 领域行：错题本状态。mastered 为掌握软标记（不动 attempts）。
 * t9 掌握模型升级：新增连续答对 streak / 最近一次判分结果 / 累计答错次数 / 掌握来源。
 */
export interface WrongBookRow {
  readonly questionId: string;
  readonly wrongCount: number;
  readonly lastWrongAt: number | null;
  readonly mastered: boolean;
  /** 连续答对次数（答对递增、答错清零；达 MASTERY_THRESHOLD 按 computed 置 mastered）。 */
  readonly consecutiveCorrect: number;
  /** 最近一次判分结果（true=对，false=错，null=无作答）。 */
  readonly lastResult: boolean | null;
  /** 累计答错次数（只增不减，区别于会递减的 wrong_count）。 */
  readonly lifetimeWrongCount: number;
  /** 掌握来源；未掌握为 null。 */
  readonly masterySource: MasterySource | null;
  /**
   * 最近一次作答的用户答案（JSON 反序列化后的原值：单/多选为字母/字母数组，
   * 判断为 'true'/'false'，essay 为正文）；无作答为 null。
   * 用途：错题本回顾时标记「当时选错」的选项。
   */
  readonly lastAnswer: unknown | null;
}

// ---------------------------------------------------------------------------
// Phase 2 领域类型：essay 批改 / Tutor 对话 / 学习计划
// ---------------------------------------------------------------------------

/** 批改结论（LLM 输出）。 */
export type GradingVerdict = 'correct' | 'partial' | 'incorrect';

/** 领域行：essay 批改结果。attempt_id 唯一（重批 upsert）；isCorrect 由 score>=60 归一。 */
export interface EssayGradingRow {
  readonly attemptId: string;
  readonly score: number;
  readonly verdict: GradingVerdict;
  readonly feedback: string;
  /** 参考答案要点（LLM 输出）；可空。 */
  readonly reference: string | null;
  readonly isCorrect: boolean;
  /** 批改所用模型 id；可空。 */
  readonly model: string | null;
  /** 批改所用 provider 路由 id（t5 可追溯）；可空。 */
  readonly provider: string | null;
  /** 调用 token 用量（t5 可追溯）；可空。 */
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  /** 归一化终态（stop/error/aborted/max-tokens）；可空。 */
  readonly finishReason: string | null;
  readonly createdAt: number;
}

/** 保存/重批 essay 批改的输入。 */
export interface SaveEssayGradingInput {
  attemptId: string;
  /** 0..100 整数。 */
  score: number;
  verdict: GradingVerdict;
  feedback: string;
  reference?: string | null;
  model?: string | null;
  /** t5 可追溯字段（provider/tokens/finish_reason）；缺省 null。 */
  provider?: string | null;
  inputTokens?: number | null;
  outputTokens?: number | null;
  finishReason?: string | null;
}

/** Tutor 对话会话状态。 */
export type TutorSessionStatus = 'active' | 'closed';

/** 领域行：Tutor 对话会话。questionId 可空（自由问答）；bankId 为冗余便于列表展示。 */
export interface TutorSessionRow {
  readonly id: string;
  readonly questionId: string | null;
  readonly bankId: string | null;
  readonly status: TutorSessionStatus;
  readonly createdAt: number;
  readonly updatedAt: number;
  /** 仅 listTutorSessions JOIN 提供：绑定题题干（无题或非列表路径为 undefined）。 */
  readonly questionStem?: string | null;
  /** 仅 listTutorSessions JOIN 提供：首条用户消息内容。 */
  readonly firstUserMessage?: string | null;
}

/** 创建 Tutor 会话的输入（status 缺省 'active'；updatedAt=createdAt）。 */
export interface CreateTutorSessionInput {
  id?: string;
  questionId?: string | null;
  bankId?: string | null;
  status?: TutorSessionStatus;
  createdAt?: number;
}

/** Tutor 消息角色。 */
export type TutorMessageRole = 'user' | 'assistant';

/** 领域行：Tutor 消息。turnId 为 t5 状态机关联（可空，旧行为 null）。 */
export interface TutorMessageRow {
  readonly id: string;
  readonly sessionId: string;
  readonly role: TutorMessageRole;
  readonly content: string;
  readonly createdAt: number;
  /** 关联的 turn id（可空；仅 assistant 消息由状态机落此字段）。 */
  readonly turnId?: string | null;
}

/** 追加 Tutor 消息的输入。 */
export interface AddTutorMessageInput {
  id?: string;
  sessionId: string;
  role: TutorMessageRole;
  content: string;
  createdAt?: number;
  /** 关联的 turn id（t5 状态机：assistant 消息归属其 turn）；可空。 */
  turnId?: string | null;
}

/** Tutor turn 状态（t5 状态机，设计 §16 §3.1）。 */
export type TutorTurnState = 'pending' | 'streaming' | 'done' | 'failed' | 'cancelled';

/**
 * 领域行：Tutor 一次「用户提问 → AI 回复」的 turn（跨请求持久化的状态机）。
 * clientMessageId 可空（旧客户端无幂等键；SQLite UNIQUE 允许多 NULL）。
 */
export interface TutorTurnRow {
  readonly id: string;
  readonly sessionId: string;
  readonly clientMessageId: string | null;
  readonly userMessageId: string;
  readonly assistantMessageId: string | null;
  readonly state: TutorTurnState;
  /** 失败/取消的错误码（EXAM_LLM_ABORTED 等）；可空。 */
  readonly errorCode: string | null;
  /** 生成所用 provider 路由 id（可追溯）；可空。 */
  readonly provider: string | null;
  /** 生成所用模型 id（可追溯）；可空。 */
  readonly model: string | null;
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  readonly createdAt: number;
  readonly updatedAt: number;
}

/** 创建 Tutor turn 的输入。 */
export interface CreateTutorTurnInput {
  id?: string;
  sessionId: string;
  /** 幂等键；缺省 null（旧客户端由服务层生成 srv-* 占位）。 */
  clientMessageId?: string | null;
  userMessageId: string;
  /** 初始状态；缺省 'pending'（user 消息已落库、LLM 未开始）。 */
  state?: TutorTurnState;
  createdAt?: number;
}

/** AI 导入批次（commit 原子幂等记录）。 */
export interface ImportBatchRow {
  readonly id: string;
  readonly bankId: string;
  readonly status: 'committed';
  /** JSON 数组（本批次入库的题目 id）。 */
  readonly questionIds: string[];
  readonly createdAt: number;
}

/** 持久化 AI 导入草稿（刷新可恢复；状态机 open → committed/discarded）。 */
export interface ImportDraftRow {
  readonly id: string;
  /** 来源文本 sha256（去重/恢复键）；可空。 */
  readonly sourceHash: string | null;
  /** JSON 数组（ImportedQuestion[]，服务层解释）。 */
  readonly items: unknown[];
  readonly status: 'open' | 'committed' | 'discarded';
  readonly createdAt: number;
  readonly updatedAt: number;
}

/** 学习计划来源：llm=AI 生成 / manual=手动新建。 */
export type StudyPlanSource = 'llm' | 'manual';

/** 学习计划状态。 */
export type StudyPlanStatus = 'active' | 'completed';

/** 领域行：学习计划。 */
export interface StudyPlanRow {
  readonly id: string;
  readonly title: string;
  readonly source: StudyPlanSource;
  readonly status: StudyPlanStatus;
  readonly createdAt: number;
  readonly updatedAt: number;
}

/** 创建学习计划的输入（status 缺省 'active'；updatedAt=createdAt）。 */
export interface CreateStudyPlanInput {
  id?: string;
  title: string;
  source: StudyPlanSource;
  status?: StudyPlanStatus;
  createdAt?: number;
}

/** 计划条目状态（t9 扩展：doing=进行中，skipped=已跳过）。 */
export type PlanItemStatus = 'pending' | 'doing' | 'done' | 'skipped';

/** 计划条目的执行类型（t9 可执行计划）。 */
export type PlanItemActionType = 'practice' | 'reviewError' | 'read' | 'tutor';

/** 领域行：计划条目（t9 增补 note/actionType/scope/dueAt/priority/sourceDiagnosisId）。 */
export interface PlanItemRow {
  readonly id: string;
  readonly planId: string;
  readonly title: string;
  readonly status: PlanItemStatus;
  readonly sort: number;
  readonly createdAt: number;
  readonly completedAt: number | null;
  /** 补充说明。 */
  readonly note: string | null;
  /** 执行类型（practice/reviewError/read/tutor）；可空。 */
  readonly actionType: PlanItemActionType | null;
  /** 执行范围（PracticeScopeDto JSON）；可空。 */
  readonly scope: unknown;
  /** 到期时间（epoch 毫秒）；可空。 */
  readonly dueAt: number | null;
  /** 优先级（越小越优先；缺省 0）。 */
  readonly priority: number;
  /** 来源学情诊断 id（可追溯）；可空。 */
  readonly sourceDiagnosisId: string | null;
}

/** 追加计划条目的输入（sort 缺省 0；status 缺省 'pending'；t9 增补可执行字段）。 */
export interface AddPlanItemInput {
  title: string;
  sort?: number;
  note?: string | null;
  actionType?: PlanItemActionType | null;
  scope?: unknown;
  dueAt?: number | null;
  priority?: number;
  sourceDiagnosisId?: string | null;
  status?: PlanItemStatus;
}

// ---------------------------------------------------------------------------
// t13 领域类型：学情诊断持久化
// ---------------------------------------------------------------------------

/** 诊断建议的可执行动作（结构化建议；客户端渲染直达按钮）。 */
export interface DiagnosisSuggestionAction {
  /** 练习范围模式（all/wrong 直达；byType/byTag 需筛选值）。 */
  mode: 'all' | 'wrong' | 'byType' | 'byTag';
  /** byType 筛选值（题型）。 */
  type?: string;
  /** byTag 筛选值（标签）。 */
  tag?: string;
}

/** 诊断建议条目：文本 + 可选动作（LLM 输出兼容纯字符串 → 仅 text）。 */
export interface DiagnosisSuggestionRecord {
  readonly text: string;
  readonly action?: DiagnosisSuggestionAction;
}

/** 领域行：学情诊断记录（t13 持久化；weaknesses/suggestions 落库为 JSON 数组）。 */
export interface DiagnosisRow {
  readonly id: string;
  readonly summary: string;
  readonly weaknesses: readonly string[];
  readonly suggestions: readonly DiagnosisSuggestionRecord[];
  /** 生成所用 provider 路由 id（审计用）；可空。 */
  readonly provider: string | null;
  /** 生成所用模型 id（审计用）；可空。 */
  readonly model: string | null;
  readonly createdAt: number;
}

/** 保存诊断记录的输入（id 缺省 randomUUID；createdAt 取当前时间）。 */
export interface SaveDiagnosisInput {
  id?: string;
  summary: string;
  weaknesses?: readonly string[];
  suggestions?: readonly DiagnosisSuggestionRecord[];
  provider?: string | null;
  model?: string | null;
  createdAt?: number;
}

// ---------------------------------------------------------------------------
// Phase 4 领域类型：AI 解析缓存
// ---------------------------------------------------------------------------

/**
 * 领域行：AI 解析缓存。键 = (questionId, answerNorm, depth)（UNIQUE 约束，同键仅单份最新）；
 * answerNorm 为归一化用户答案（ai.ts normalizeAnswerNorm 产出），'' 为 G 通用形态。
 * depth：解析深度档（light/deep）——浅/深两档缓存互不挤占（t1 设计 §3.2）。
 */
export interface ExplanationRow {
  readonly id: string;
  readonly questionId: string;
  readonly answerNorm: string;
  /** 解析深度档；v9 迁移旧行回填 light。 */
  readonly depth: 'light' | 'deep';
  /** 生成的解析全文（纯文本小节）。 */
  readonly content: string;
  /** 生成所用模型 id（审计用）；可空。 */
  readonly model: string | null;
  /** 生成所用 provider 路由 id（审计用）；v5 前旧行为 null。 */
  readonly provider: string | null;
  /** 生成请求的思考深度 id；未指定（provider 默认）为 null。 */
  readonly reasoningEffort: string | null;
  /** 生成所用提示词版本（缓存失效键，t5）；存量行迁移回填 1。 */
  readonly promptVersion: number;
  /** 生成时题目 updated_at（题目编辑 → 命中条件失效，t5）；存量行回填 questions.updated_at。 */
  readonly questionUpdatedAt: number;
  /** 调用 token 用量（可追溯，t5）；可空。 */
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  /** 归一化终态（stop/error/aborted/max-tokens）；可空。 */
  readonly finishReason: string | null;
  readonly createdAt: number;
}

/** 保存 AI 解析的输入（INSERT OR REPLACE 落 UNIQUE 键，覆盖为最新；created_at 取当前时间）。 */
export interface SaveExplanationInput {
  questionId: string;
  /** 归一化答案缓存键；G 通用形态恒 ''。 */
  answerNorm: string;
  /** 解析深度档；缺省 light。 */
  depth?: 'light' | 'deep';
  content: string;
  model?: string | null;
  /** 生成所用 provider 路由 id；缺省 null（旧行兼容）。 */
  provider?: string | null;
  /** 请求的思考深度 id；缺省 null = provider 默认。 */
  reasoningEffort?: string | null;
  /** 生成所用提示词版本；缺省 EXPLAIN_PROMPT_VERSION（t5 服务层接线）。 */
  promptVersion?: number;
  /** 生成时题目 updated_at（题目编辑 → 命中条件失效）；缺省 0。 */
  questionUpdatedAt?: number;
  /** token 用量 / 终态（可追溯，t5）；缺省 null。 */
  inputTokens?: number | null;
  outputTokens?: number | null;
  finishReason?: string | null;
}

/** listWrong 过滤选项。 */
export interface ListWrongOptions {
  bankId?: string;
  /** true = 连已掌握的一起返回；缺省 false（只返回未掌握）。 */
  includeMastered?: boolean;
}

/** `openExamStore` 工厂选项。 */
export interface OpenExamStoreOptions {
  /**
   * 自动创建数据库文件的父目录（默认 true）。
   * 对 `:memory:` 无影响。
   */
  createDir?: boolean;
}

/** health/readiness 共享的探测结果。 */
export interface ExamStoreHealth {
  /** 打开且可执行查询时为 true。 */
  readonly ok: boolean;
  readonly path: string;
  readonly closed: boolean;
  /** 已应用的 schema 迁移版本（MIGRATIONS.length）。 */
  readonly schemaVersion: number;
  /** 打开时间（epoch 毫秒）；从未打开过的实例为 undefined。 */
  readonly openedAt?: number;
  /** health 探测失败原因（ok=false 时）。 */
  readonly error?: string;
}

/** 只读就绪探测结果。 */
export interface ExamStoreReadiness {
  readonly ready: boolean;
  readonly reason?: string;
}

export interface ExamStore {
  /** 打开时传入的数据文件路径（原样保留，含 ':memory:'）。 */
  readonly path: string;

  /** 连接健康状态；关闭后仍可调用（closed=true, ok=false）。 */
  health(): ExamStoreHealth;

  /** 就绪探测：打开且能执行查询。 */
  readiness(): ExamStoreReadiness;

  /** 按创建时间升序返回题库（t9：默认排除已归档与已删除；includeArchived/includeDeleted 可恢复查看）。 */
  listBanks(options?: ListBanksOptions): BankRow[];

  /** 按 id 取题库（**含已归档/已删除**，供归档/恢复/重命名/删除等生命周期操作）；不存在返回 undefined。 */
  getBank(id: string): BankRow | undefined;

  /** 重命名题库（去首尾空白后非空校验）；不存在抛 Error。 */
  renameBank(id: string, name: string): BankRow;

  /**
   * 软归档题库：置 `archived_at`（归档后默认列表/练习/错题选择器排除）。
   * 不存在抛 Error；已归档幂等（刷新 archived_at）。
   */
  archiveBank(id: string): BankRow;

  /**
   * 恢复题库：清空 `archived_at` 与 `deleted_at`（归档或删除后的题库均可恢复为活跃）。
   * 不存在抛 Error；已活跃幂等（原样返回）。
   */
  restoreBank(id: string): BankRow;

  /**
   * 软删除题库：置 `deleted_at`。题库行与全部关联数据（题目/作答/会话）保留，
   * 历史仍可解释；仅默认列表/练习/错题选择器排除。不存在抛 Error；已删除幂等（刷新 deleted_at）。
   * 返回 false 表示此前已删除（本次未产生新状态变化）。
   */
  deleteBank(id: string): boolean;

  /**
   * 创建题库。`id` 缺省时生成 randomUUID；`createdAt` 取当前时间。
   * name 去首尾空白后必须非空，否则抛 Error。
   */
  createBank(input: { name: string; id?: string }): BankRow;

  // ── Phase 1：题目 ──────────────────────────────────────────────────────

  /** 创建题目（bankId 必须存在，FK 校验）；id 缺省 randomUUID；created/updated_at 取当前时间。 */
  createQuestion(bankId: string, input: CreateQuestionInput): QuestionRow;

  /** 部分更新题目（仅提供的字段生效；updated_at 自动刷新）。不存在则抛 Error。 */
  updateQuestion(id: string, patch: QuestionPatch): QuestionRow;

  /**
   * 删除题目（**软删除**，t1 安全策略）：置 `deleted_at` 而非物理删除。题目行与全部
   * 关联数据（作答/批改/解析/错题本/会话 question_ids 引用）保留，active 会话与
   * finished 历史保持可解释。已删题目对活跃操作不可见：getQuestion /
   * listQuestionsByBank / countQuestions / listWrong 一律排除，更新/判分/解析抛
   * 「不存在」；读历史路径用 getQuestionIncludingDeleted 仍可取回题干与题型。
   * 幂等：不存在或已删时返回 false（不抛错）；首次删除返回 true。
   */
  deleteQuestion(id: string): boolean;

  /**
   * 按 id 取题目；不存在**或已软删除**返回 undefined（活跃操作语义）。
   * 读历史/成绩单路径请用 getQuestionIncludingDeleted。
   */
  getQuestion(id: string): QuestionRow | undefined;

  /** 按 id 取题目（**含已软删除**，供成绩单/续做/历史等"可解释"路径使用）；不存在返回 undefined。 */
  getQuestionIncludingDeleted(id: string): QuestionRow | undefined;

  /** 按 id 取题库行（供 moveQuestion 移动题目用）；不存在返回 undefined（含已归档/已删除的题库）。 */
  getBank(id: string): BankRow | undefined;

  /** 移动题目到另一题库（校验目标题库存在，FK 校验；updated_at 刷新）；题目不存在抛 Error。 */
  moveQuestion(id: string, bankId: string): QuestionRow;

  /** 恢复已软删除的题目：清空 `deleted_at`。不存在或未删除返回 false；首次恢复返回 true。 */
  restoreQuestion(id: string): boolean;

  /** 按题库列出题目（created_at ASC, id ASC；t9 支持 q/type/tags/hasExplanation/sort 过滤）。 */
  listQuestionsByBank(bankId: string, filter?: QuestionListFilter): QuestionRow[];

  /** 题库内题目数量。 */
  countQuestions(bankId: string): number;

  // ── Phase 1：作答 ──────────────────────────────────────────────────────

  /** 记录一次作答（questionId 必须存在）；id 缺省 randomUUID；answeredAt 缺省当前时间。 */
  recordAttempt(input: CreateAttemptInput): AttemptRow;

  /**
   * 判分链路的最小事务（t1）：一次作答 + 错题本 touchWrong **同一事务**提交
   * （任一步失败整体回滚，不留「有作答无错题计数」的中间态）。
   */
  recordGradedAttempt(input: CreateAttemptInput): { attempt: AttemptRow; wrong: WrongBookRow };

  /**
   * 每题返回最新一条作答（answered_at DESC，同毫秒按插入序 rowid DESC 取首条——
   * 「后写者胜」，确定性）。
   * 返回 Map<questionId, AttemptRow>；无作答的题目不在 Map 中。
   */
  listLatestAttemptByQuestion(questionIds: readonly string[]): Map<string, AttemptRow>;

  /**
   * **会话域**每题最新一条作答（t1）：仅匹配 practice_id 精确相等且 question_id
   * 在给定列表中的行（answered_at DESC，同毫秒按插入序 rowid DESC 取首条）。跨会话重做同一题不串味
   * ——resume/scorecard/history 的「每题最新」以本会话作答为准。
   * 返回 Map<questionId, AttemptRow>；无作答的题目不在 Map 中。
   */
  listLatestAttemptByPracticeQuestions(
    practiceId: string,
    questionIds: readonly string[],
  ): Map<string, AttemptRow>;

  /**
   * 定向取某次练习内某题的最新一条作答（answered_at DESC，同毫秒按插入序 rowid DESC 取首条；
   * 仅匹配 practice_id 精确相等的行）。不存在返回 undefined。
   * 用途：Phase 4 解析的已判分校验（EXAM_NOT_GRADED）与由 user_answer 推导 answer_norm。
   */
  getLatestAttemptByPracticeQuestion(practiceId: string, questionId: string): AttemptRow | undefined;

  /** 全部作答（answered_at ASC, id ASC；供学情聚合全量扫描，数据量可接受）。 */
  listAllAttempts(): AttemptRow[];

  // ── Phase 1：练习会话 ──────────────────────────────────────────────────

  /** 创建练习会话（status='active'，currentIndex 缺省 0）。 */
  createPracticeSession(input: CreatePracticeSessionInput): PracticeSessionRow;

  /** 按 id 取会话；不存在返回 undefined。 */
  getPracticeSession(id: string): PracticeSessionRow | undefined;

  /** 更新进度下标（非负整数校验）；会话不存在抛 Error。 */
  updatePracticeIndex(id: string, index: number): PracticeSessionRow;

  /** 结束会话：status='finished' + finished_at；questionIds 允许更新以处理动态范围。 */
  finishPracticeSession(id: string, questionIds: readonly string[]): PracticeSessionRow;

  /** 练习历史：created_at DESC, id DESC，limit 条（缺省 30）；含 active 会话（供续做）。 */
  listPracticeHistory(limit?: number): PracticeSessionRow[];

  /** 删除练习会话（仅会话行；attempts 保留——无外键约束，孤儿作答合法且继续计入学情/错题本）。返回是否存在。 */
  deletePracticeSession(id: string): boolean;

  /** 已结束（status='finished'）练习会话数（学情聚合用）。 */
  countFinishedPractices(): number;

  // ── Phase 1：错题本 ────────────────────────────────────────────────────

  /**
   * 判分后更新错题计数（upsert）：答错 +1 并记 last_wrong_at；答对递减至 0（不清行，
   * 保留 mastered 状态）。questionId 不存在时 FK 抛错。
   */
  touchWrong(questionId: string, isCorrect: boolean): WrongBookRow;

  /** 错题列表（wrong_count > 0；includeMastered=false 时排除 mastered=1），按 last_wrong_at 倒序。 */
  listWrong(options?: ListWrongOptions): WrongBookRow[];

  /** 设置/取消掌握软标记（upsert，不动 wrong_count）；questionId 不存在时 FK 抛错。 */
  setMastered(questionId: string, mastered: boolean): WrongBookRow;

  // ── Phase 2：essay 批改 ────────────────────────────────────────────────

  /**
   * 保存 essay 批改结果（upsert：同 attempt 重批覆盖 score/verdict/feedback/reference/model，
   * 保留首次 created_at；isCorrect 由 score>=60 归一）。attemptId 必须对应已存在的 attempts 行。
   */
  saveEssayGrading(input: SaveEssayGradingInput): EssayGradingRow;

  /**
   * essay 判分链路的最小事务（t1）：作答 + 错题本 touchWrong + 批改结果 upsert
   * **同一事务**提交（任一步失败整体回滚，不留「有作答无批改」的孤儿作答）。
   * grading.attemptId 由事务内创建的 attempt.id 派生（无需调用方预知）。
   * 批改（LLM 调用）在事务外完成，本方法只原子化落库部分。
   */
  recordGradedEssay(input: {
    attempt: CreateAttemptInput;
    grading: Omit<SaveEssayGradingInput, 'attemptId'>;
  }): { attempt: AttemptRow; wrong: WrongBookRow; grading: EssayGradingRow };

  /** 按 attemptId 取批改结果；不存在返回 undefined。 */
  getEssayGrading(attemptId: string): EssayGradingRow | undefined;

  /**
   * 批量取批改结果（attempt_id 唯一，每题至多一条），返回 Map<attemptId, EssayGradingRow>；
   * 无批改的 attempt 不在 Map 中。
   */
  listLatestGradingByAttempt(attemptIds: readonly string[]): Map<string, EssayGradingRow>;

  // ── Phase 2：Tutor 对话 ────────────────────────────────────────────────

  /** 创建 Tutor 会话（status 缺省 'active'；updatedAt=createdAt）。 */
  createTutorSession(input: CreateTutorSessionInput): TutorSessionRow;

  /** 按 id 取会话；不存在返回 undefined。 */
  getTutorSession(id: string): TutorSessionRow | undefined;

  /** 追加一条 Tutor 消息（sessionId 必须存在，FK 校验；role/content 校验）。 */
  addTutorMessage(input: AddTutorMessageInput): TutorMessageRow;

  /** 按会话列出消息（created_at ASC, id ASC）。 */
  listTutorMessages(sessionId: string): TutorMessageRow[];

  /** 关闭会话：status='closed' + updated_at 刷新；会话不存在抛 Error。 */
  closeTutorSession(id: string): TutorSessionRow;

  /** 刷新会话 updated_at（不改 status；供 chatTutor 每轮对话后调用）；会话不存在抛 Error。 */
  touchTutorSession(id: string): TutorSessionRow;

  /** 会话列表（created_at DESC, id DESC），limit 条（缺省 30）。 */
  listTutorSessions(limit?: number): TutorSessionRow[];

  /** 按 id 取单条 Tutor 消息；不存在返回 undefined（t5 重放读取 assistant 内容用）。 */
  getTutorMessage(id: string): TutorMessageRow | undefined;

  /** 硬删除 Tutor 会话（级联删除 messages/turns）；返回是否存在。 */
  deleteTutorSession(id: string): boolean;

  // ── t5：Tutor turn 状态机 ──────────────────────────────────────────────

  /** 创建 Tutor turn（与 user 消息同事务由服务层编排）；初始 state='pending'。 */
  createTutorTurn(input: CreateTutorTurnInput): TutorTurnRow;

  /** 按幂等键取 turn；不存在（或 clientMessageId 为 null 不匹配）返回 undefined。 */
  getTutorTurnByClientMessageId(clientMessageId: string): TutorTurnRow | undefined;

  /** 按 id 取 turn；不存在返回 undefined。 */
  getTutorTurn(id: string): TutorTurnRow | undefined;

  /** 更新 turn 状态（state/updated_at）；不存在抛 Error。 */
  updateTutorTurnState(id: string, state: TutorTurnState): TutorTurnRow;

  /**
   * 完成 turn（终态 done）：写入 assistant_message_id + provider/model + token 用量，
   * state→done、error_code 清空。不存在抛 Error。
   */
  completeTutorTurn(
    id: string,
    patch: {
      assistantMessageId: string;
      provider?: string | null;
      model?: string | null;
      inputTokens?: number | null;
      outputTokens?: number | null;
    },
  ): TutorTurnRow;

  /**
   * 置 turn 错误（终态）：errorCode=EXAM_LLM_ABORTED → state='cancelled'，
   * 其余 → state='failed'（可重试）；写入 error_code + updated_at。
   */
  setTurnError(id: string, errorCode: string): TutorTurnRow;

  /**
   * 幽灵会话清扫（t5 设计 §3.2）：把「无任何 done turn 且 updated_at 早于
   * now−ttlMs」的会话置 status='closed'（不动消息，可读）。返回受影响行数。
   */
  sweepGhostSessions(ttlMs: number): number;

  // ── t5：AI 导入批次 / 草稿 ─────────────────────────────────────────────

  /** 保存导入批次（commit 幂等记录；status 恒 'committed'）。 */
  saveImportBatch(input: { id: string; bankId: string; questionIds: string[] }): ImportBatchRow;

  /** 按 id 取导入批次；不存在返回 undefined。 */
  getImportBatch(id: string): ImportBatchRow | undefined;

  /** 保存导入草稿（status 缺省 'open'；items 为 JSON 数组）。 */
  saveImportDraft(input: { sourceHash?: string | null; items: unknown[] }): ImportDraftRow;

  /** 按 id 取导入草稿；不存在返回 undefined。 */
  getImportDraft(id: string): ImportDraftRow | undefined;

  /** 更新草稿状态（open → committed/discarded；状态校验）；不存在抛 Error。 */
  updateImportDraftStatus(id: string, status: ImportDraftRow['status']): ImportDraftRow;

  /**
   * 过期草稿清扫（status='open' 且 updated_at 早于 now−ttlMs → 'discarded'）。
   * 返回受影响行数。
   */
  sweepImportDrafts(ttlMs: number): number;

  // ── t5：事务原语（服务层 AI 导入原子提交复用；不得嵌套调用）────────────

  /**
   * 最小事务能力（t1 实现，t5 公开）：同步执行 fn 内全部写语句并整体 COMMIT；
   * 任一步抛错则 ROLLBACK 后原样重抛。DatabaseSync 为同步连接，无并发交错。
   */
  withTransaction<T>(fn: () => T): T;

  // ── Phase 2：学习计划 ──────────────────────────────────────────────────

  /** 创建学习计划（title/source/status 校验；updatedAt=createdAt）。 */
  createStudyPlan(input: CreateStudyPlanInput): StudyPlanRow;

  /** 按 id 取计划；不存在返回 undefined。 */
  getStudyPlan(id: string): StudyPlanRow | undefined;

  /** 计划列表（created_at DESC, id DESC），limit 条（缺省 30）。 */
  listStudyPlans(limit?: number): StudyPlanRow[];

  /** 一次追加多条计划条目（status='pending'，sort 缺省 0）；计划不存在抛 Error。 */
  addPlanItems(planId: string, items: AddPlanItemInput[]): { plan: StudyPlanRow; items: PlanItemRow[] };

  /** 按计划列出条目（sort ASC, created_at ASC, id ASC）。 */
  listPlanItems(planId: string): PlanItemRow[];

  /**
   * 设置条目完成状态：done=true → status='done' + completed_at=now；
   * done=false → status='pending' + completed_at=null。计划或条目不存在抛 Error。
   */
  setPlanItemDone(planId: string, itemId: string, done: boolean): PlanItemRow;

  /** 取计划及其全部条目；计划不存在返回 undefined。 */
  getPlanWithItems(id: string): { plan: StudyPlanRow; items: PlanItemRow[] } | undefined;

  /** 硬删除计划（plan_items ON DELETE CASCADE 级联清理条目）；返回是否存在。 */
  deleteStudyPlan(id: string): boolean;

  /**
   * 删除单条计划条目，并在同事务内按 t12 自动机重算计划状态
   * （全部条目删空 → 'active'；剩余全部 done/skipped → 'completed'）。
   * 计划或条目不存在抛 Error。
   */
  deletePlanItem(planId: string, itemId: string): void;

  // ── t13：学情诊断持久化 ────────────────────────────────────────────────

  /** 保存诊断记录（summary 非空校验；id 缺省 randomUUID，createdAt 取当前时间）。 */
  saveDiagnosis(input: SaveDiagnosisInput): DiagnosisRow;

  /** 诊断记录列表（created_at DESC, id DESC），limit 条（缺省 10）。 */
  listDiagnoses(limit?: number): DiagnosisRow[];

  // ── Phase 4：AI 解析缓存 ───────────────────────────────────────────────

  /** 按 (questionId, answerNorm, depth) 取缓存解析；不存在返回 undefined。 */
  getExplanation(questionId: string, answerNorm: string, depth?: 'light' | 'deep'): ExplanationRow | undefined;

  /**
   * 保存解析（upsert）：INSERT OR REPLACE 落到 UNIQUE(question_id, answer_norm, depth) 键上，
   * 同键仅保留最新一份（id/created_at 均为新值）；content 去首尾空白后必须非空，
   * answerNorm 必须为字符串；questionId 不存在时 FK 抛错。
   */
  upsertExplanation(input: SaveExplanationInput): ExplanationRow;

  /** 该题全部缓存解析（created_at DESC, id ASC；含 P 各答案键与 G 的 '' 键，供 WrongView 探测）。 */
  listExplanationsByQuestion(questionId: string): ExplanationRow[];

  /** 幂等关闭底层连接。 */
  close(): void;
}

/**
 * 最小迁移列表：**按逻辑版本分组**，组索引 +1 = schema 版本（user_version）。
 * v1：banks；v2（Phase 1）：题目 / 作答 / 练习会话 / 错题本 + 索引。
 * v3（Phase 2）：重建 questions（type CHECK 扩为含 essay，其余列不变，保留既有数据）+
 * essay_gradings / tutor_sessions / tutor_messages / study_plans / plan_items + 索引。
 * v4（Phase 4）：explanations（AI 解析缓存，UNIQUE(question_id, answer_norm)）+ 索引。
 * v5（Phase 4.1）：explanations 增列 provider / reasoning_effort（解析卡完整模型信息）。
 * v6（t1 修复）：questions 增列 deleted_at（题目软删除安全策略）。
 * JSON 字段（options/answer/tags/user_answer/scope/question_ids）统一 TEXT 存
 * JSON.stringify 结果，领域映射在 toXxxRow 显式 JSON.parse。
 *
 * 迁移条目可以是 SQL 字符串，也可以是 `(db) => void` 函数（用于无法用纯 SQL
 * 表达的条件迁移，如 v6 的 ADD COLUMN 幂等守卫——崩溃/回拨后重放不炸库）。
 */
type MigrationEntry = string | ((db: DatabaseSync) => void);
type MigrationGroup = readonly MigrationEntry[];

const MIGRATIONS: readonly MigrationGroup[] = [
  // v1：题库。
  [
    `CREATE TABLE IF NOT EXISTS banks (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      created_at INTEGER NOT NULL
    )`,
  ],
  // v2（Phase 1）。
  [
    `CREATE TABLE IF NOT EXISTS questions (
      id TEXT PRIMARY KEY,
      bank_id TEXT NOT NULL REFERENCES banks(id) ON DELETE CASCADE,
      type TEXT NOT NULL CHECK(type IN ('single','multiple','boolean')),
      stem TEXT NOT NULL,
      options TEXT NOT NULL,
      answer TEXT NOT NULL,
      explanation TEXT,
      tags TEXT,
      created_at INTEGER,
      updated_at INTEGER
    )`,
    `CREATE TABLE IF NOT EXISTS attempts (
      id TEXT PRIMARY KEY,
      question_id TEXT NOT NULL REFERENCES questions(id) ON DELETE CASCADE,
      practice_id TEXT,
      user_answer TEXT NOT NULL,
      is_correct INTEGER NOT NULL,
      answered_at INTEGER NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS practice_sessions (
      id TEXT PRIMARY KEY,
      bank_id TEXT NOT NULL REFERENCES banks(id) ON DELETE CASCADE,
      scope TEXT NOT NULL,
      question_ids TEXT NOT NULL,
      current_index INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL CHECK(status IN ('active','finished')),
      created_at INTEGER,
      finished_at INTEGER
    )`,
    `CREATE TABLE IF NOT EXISTS wrong_book_state (
      question_id TEXT PRIMARY KEY REFERENCES questions(id) ON DELETE CASCADE,
      wrong_count INTEGER NOT NULL DEFAULT 0,
      last_wrong_at INTEGER,
      mastered INTEGER NOT NULL DEFAULT 0
    )`,
    `CREATE INDEX IF NOT EXISTS idx_questions_bank_id ON questions(bank_id)`,
    `CREATE INDEX IF NOT EXISTS idx_attempts_question_id ON attempts(question_id)`,
    `CREATE INDEX IF NOT EXISTS idx_attempts_answered_at ON attempts(answered_at)`,
    `CREATE INDEX IF NOT EXISTS idx_practice_sessions_bank_id ON practice_sessions(bank_id)`,
  ],
  // v3（Phase 2）：questions 重建（SQLite 无法 ALTER CHECK → 新表→复制→删旧→改名→重建索引，
  // 以 PRAGMA foreign_keys=OFF 包裹；attempts/wrong_book_state/tutor_sessions 的 FK 在
  // 重建后由 migrate() 的 PRAGMA foreign_key_check 验证）。五张新表 + 三个索引。
  // 幂等：DROP TABLE IF EXISTS questions_new 前置，中途失败（user_version 未更新）重试不卡死。
  [
    `PRAGMA foreign_keys = OFF`,
    `DROP TABLE IF EXISTS questions_new`,
    `CREATE TABLE questions_new (
      id TEXT PRIMARY KEY,
      bank_id TEXT NOT NULL REFERENCES banks(id) ON DELETE CASCADE,
      type TEXT NOT NULL CHECK(type IN ('single','multiple','boolean','essay')),
      stem TEXT NOT NULL,
      options TEXT NOT NULL,
      answer TEXT NOT NULL,
      explanation TEXT,
      tags TEXT,
      created_at INTEGER,
      updated_at INTEGER
    )`,
    `INSERT INTO questions_new (id, bank_id, type, stem, options, answer, explanation, tags, created_at, updated_at)
     SELECT id, bank_id, type, stem, options, answer, explanation, tags, created_at, updated_at FROM questions`,
    `DROP TABLE questions`,
    `ALTER TABLE questions_new RENAME TO questions`,
    `CREATE INDEX IF NOT EXISTS idx_questions_bank_id ON questions(bank_id)`,
    `PRAGMA foreign_keys = ON`,
    `CREATE TABLE IF NOT EXISTS essay_gradings (
      attempt_id TEXT PRIMARY KEY REFERENCES attempts(id) ON DELETE CASCADE,
      score INTEGER NOT NULL,
      verdict TEXT NOT NULL,
      feedback TEXT NOT NULL,
      reference TEXT,
      is_correct INTEGER NOT NULL,
      model TEXT,
      created_at INTEGER NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS tutor_sessions (
      id TEXT PRIMARY KEY,
      question_id TEXT REFERENCES questions(id) ON DELETE SET NULL,
      bank_id TEXT,
      status TEXT NOT NULL CHECK(status IN ('active','closed')),
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS tutor_messages (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL REFERENCES tutor_sessions(id) ON DELETE CASCADE,
      role TEXT NOT NULL CHECK(role IN ('user','assistant')),
      content TEXT NOT NULL,
      created_at INTEGER NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS study_plans (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      source TEXT NOT NULL CHECK(source IN ('llm','manual')),
      status TEXT NOT NULL CHECK(status IN ('active','completed')),
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS plan_items (
      id TEXT PRIMARY KEY,
      plan_id TEXT NOT NULL REFERENCES study_plans(id) ON DELETE CASCADE,
      title TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('pending','done')),
      sort INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      completed_at INTEGER
    )`,
    `CREATE INDEX IF NOT EXISTS idx_tutor_messages_session ON tutor_messages(session_id, created_at)`,
    `CREATE INDEX IF NOT EXISTS idx_essay_gradings_created ON essay_gradings(created_at)`,
    `CREATE INDEX IF NOT EXISTS idx_plan_items_plan ON plan_items(plan_id, sort)`,
  ],
  // v4（Phase 4）：AI 解析缓存表 + 索引（设计 §4 原文）。缓存键 = (question_id, answer_norm)，
  // UNIQUE 约束保证同键单份最新（「重新解析」以 INSERT OR REPLACE 覆盖同键旧行）；
  // answer_norm='' 为 G 通用形态。纯增量 DDL，v3 存量数据不动。
  [
    `CREATE TABLE IF NOT EXISTS explanations (
      id TEXT PRIMARY KEY,
      question_id TEXT NOT NULL REFERENCES questions(id) ON DELETE CASCADE,
      answer_norm TEXT NOT NULL,
      content TEXT NOT NULL,
      model TEXT,
      created_at INTEGER NOT NULL,
      UNIQUE(question_id, answer_norm)
    )`,
    `CREATE INDEX IF NOT EXISTS idx_explanations_question ON explanations(question_id)`,
  ],
  // v5（Phase 4.1）：解析缓存补全模型信息（供应商 / 思考级别）。ADD COLUMN 纯增量，
  // v4 旧行两列为 NULL（DTO 以 null 透出，UI 显示「默认」）。
  [
    `ALTER TABLE explanations ADD COLUMN provider TEXT`,
    `ALTER TABLE explanations ADD COLUMN reasoning_effort TEXT`,
  ],
  // v6（t1 修复）：题目软删除列。ADD COLUMN 纯增量；旧行 deleted_at=NULL = 正常。
  // 安全策略见 deleteQuestion 文档：软删除保住 active 会话与 finished 历史的可解释性。
  // 幂等守卫：SQLite 无 ADD COLUMN IF NOT EXISTS；崩溃于「已 ALTER、未更新
  // user_version」或测试回拨版本后重放，会撞 duplicate column——先查列再执行。
  [
    (db: DatabaseSync) => {
      const columns = db
        .prepare('PRAGMA table_info(questions)')
        .all()
        .map((row) => String(row.name));
      if (!columns.includes('deleted_at')) {
        db.exec('ALTER TABLE questions ADD COLUMN deleted_at INTEGER');
      }
    },
  ],
  // v7（t5 AI 可靠性与幂等，设计 §16 §4）：tutor_turns / import_batches /
  // import_drafts 三张新表 + questions/tutor_messages/explanations/essay_gradings
  // 增列。全部纯增量；存量数据不动；ADD COLUMN 用「查列再执行」守卫保证
  // 崩溃/回拨重放幂等；一次性 UPDATE 回填在组内（user_version 不推进则重跑安全）。
  [
    `CREATE TABLE IF NOT EXISTS tutor_turns (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL REFERENCES tutor_sessions(id) ON DELETE CASCADE,
      client_message_id TEXT UNIQUE,
      user_message_id TEXT NOT NULL,
      assistant_message_id TEXT,
      state TEXT NOT NULL CHECK(state IN ('pending','streaming','done','failed','cancelled')),
      error_code TEXT,
      provider TEXT,
      model TEXT,
      input_tokens INTEGER,
      output_tokens INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )`,
    `CREATE INDEX IF NOT EXISTS idx_tutor_turns_session ON tutor_turns(session_id, created_at)`,
    (db: DatabaseSync) => {
      const columns = db
        .prepare('PRAGMA table_info(tutor_messages)')
        .all()
        .map((row) => String(row.name));
      if (!columns.includes('turn_id')) {
        db.exec('ALTER TABLE tutor_messages ADD COLUMN turn_id TEXT');
      }
    },
    `CREATE INDEX IF NOT EXISTS idx_tutor_messages_turn ON tutor_messages(turn_id)`,
    `CREATE TABLE IF NOT EXISTS import_batches (
      id TEXT PRIMARY KEY,
      bank_id TEXT NOT NULL REFERENCES banks(id) ON DELETE CASCADE,
      status TEXT NOT NULL CHECK(status IN ('committed')),
      question_ids TEXT NOT NULL,
      created_at INTEGER NOT NULL
    )`,
    (db: DatabaseSync) => {
      const columns = db
        .prepare('PRAGMA table_info(questions)')
        .all()
        .map((row) => String(row.name));
      if (!columns.includes('import_batch_id')) {
        db.exec('ALTER TABLE questions ADD COLUMN import_batch_id TEXT');
      }
      if (!columns.includes('import_item_key')) {
        db.exec('ALTER TABLE questions ADD COLUMN import_item_key TEXT');
      }
    },
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_questions_import_key
      ON questions(import_batch_id, import_item_key) WHERE import_batch_id IS NOT NULL`,
    `CREATE TABLE IF NOT EXISTS import_drafts (
      id TEXT PRIMARY KEY,
      source_hash TEXT,
      items TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('open','committed','discarded')),
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )`,
    (db: DatabaseSync) => {
      const columns = db
        .prepare('PRAGMA table_info(explanations)')
        .all()
        .map((row) => String(row.name));
      if (!columns.includes('prompt_version')) {
        db.exec('ALTER TABLE explanations ADD COLUMN prompt_version INTEGER NOT NULL DEFAULT 1');
      }
      if (!columns.includes('question_updated_at')) {
        db.exec('ALTER TABLE explanations ADD COLUMN question_updated_at INTEGER NOT NULL DEFAULT 0');
      }
      if (!columns.includes('input_tokens')) {
        db.exec('ALTER TABLE explanations ADD COLUMN input_tokens INTEGER');
      }
      if (!columns.includes('output_tokens')) {
        db.exec('ALTER TABLE explanations ADD COLUMN output_tokens INTEGER');
      }
      if (!columns.includes('finish_reason')) {
        db.exec('ALTER TABLE explanations ADD COLUMN finish_reason TEXT');
      }
    },
    // 存量缓存行回填 question_updated_at（题目编辑后自然失效；prompt_version 默认 1 =
    // 当前模板，迁移后仍命中不触发全量失效）。UPDATE 幂等，重跑安全。
    `UPDATE explanations
       SET question_updated_at = COALESCE(
         (SELECT updated_at FROM questions WHERE questions.id = explanations.question_id),
         question_updated_at)`,
    (db: DatabaseSync) => {
      const columns = db
        .prepare('PRAGMA table_info(essay_gradings)')
        .all()
        .map((row) => String(row.name));
      if (!columns.includes('provider')) {
        db.exec('ALTER TABLE essay_gradings ADD COLUMN provider TEXT');
      }
      if (!columns.includes('input_tokens')) {
        db.exec('ALTER TABLE essay_gradings ADD COLUMN input_tokens INTEGER');
      }
      if (!columns.includes('output_tokens')) {
        db.exec('ALTER TABLE essay_gradings ADD COLUMN output_tokens INTEGER');
      }
      if (!columns.includes('finish_reason')) {
        db.exec('ALTER TABLE essay_gradings ADD COLUMN finish_reason TEXT');
      }
    },
  ],
  // v8（t9 题库管理与学情计划产品升级）：
  //  - banks 增列 deleted_at / archived_at（题库生命周期：软删除 / 软归档，均为 null=正常）。
  //  - wrong_book_state 增列 consecutive_correct / last_result / lifetime_wrong_count /
  //    mastery_source（掌握模型升级：连续答对 streak、最近判分结果、只增的累计答错、来源）。
  //  - plan_items 重建（CHECK 扩为含 doing/skipped）+ 增列 note/action_type/scope/due_at/
  //    priority/source_diagnosis_id（可执行计划：行动类型、范围、到期、优先级、来源诊断）。
  // 全部纯增量/幂等：ADD COLUMN 用「查列再执行」守卫；plan_items 用 v3 同款的
  // 「新表→复制→删旧→改名→重建索引」流程（PRAGMA foreign_keys=OFF 包裹），
  // 崩溃/回拨后重放安全（v3 幂等模式复用，migrate() 末尾的 foreign_key_check 兜底）。
  [
    (db: DatabaseSync) => {
      const columns = db
        .prepare('PRAGMA table_info(banks)')
        .all()
        .map((row) => String(row.name));
      if (!columns.includes('deleted_at')) {
        db.exec('ALTER TABLE banks ADD COLUMN deleted_at INTEGER');
      }
      if (!columns.includes('archived_at')) {
        db.exec('ALTER TABLE banks ADD COLUMN archived_at INTEGER');
      }
    },
    (db: DatabaseSync) => {
      const columns = db
        .prepare('PRAGMA table_info(wrong_book_state)')
        .all()
        .map((row) => String(row.name));
      if (!columns.includes('consecutive_correct')) {
        db.exec('ALTER TABLE wrong_book_state ADD COLUMN consecutive_correct INTEGER NOT NULL DEFAULT 0');
      }
      if (!columns.includes('last_result')) {
        db.exec('ALTER TABLE wrong_book_state ADD COLUMN last_result INTEGER');
      }
      if (!columns.includes('lifetime_wrong_count')) {
        db.exec('ALTER TABLE wrong_book_state ADD COLUMN lifetime_wrong_count INTEGER NOT NULL DEFAULT 0');
      }
      if (!columns.includes('mastery_source')) {
        db.exec('ALTER TABLE wrong_book_state ADD COLUMN mastery_source TEXT');
      }
    },
    (db: DatabaseSync) => {
      const columns = db
        .prepare('PRAGMA table_info(plan_items)')
        .all()
        .map((row) => String(row.name));
      // 需要扩 CHECK（doing/skipped）且新增交互列：SQLite 无法 ALTER CHECK → 重建。
      if (!columns.includes('note') && !columns.includes('action_type')) {
        db.exec('PRAGMA foreign_keys = OFF');
        db.exec('DROP TABLE IF EXISTS plan_items_new');
        db.exec(`CREATE TABLE plan_items_new (
          id TEXT PRIMARY KEY,
          plan_id TEXT NOT NULL REFERENCES study_plans(id) ON DELETE CASCADE,
          title TEXT NOT NULL,
          status TEXT NOT NULL CHECK(status IN ('pending','doing','done','skipped')),
          sort INTEGER NOT NULL DEFAULT 0,
          created_at INTEGER NOT NULL,
          completed_at INTEGER,
          note TEXT,
          action_type TEXT,
          scope TEXT,
          due_at INTEGER,
          priority INTEGER NOT NULL DEFAULT 0,
          source_diagnosis_id TEXT
        )`);
        db.exec(`INSERT INTO plan_items_new
          (id, plan_id, title, status, sort, created_at, completed_at, note, action_type, scope, due_at, priority, source_diagnosis_id)
          SELECT id, plan_id, title, status, sort, created_at, completed_at, NULL, NULL, NULL, NULL, 0, NULL
          FROM plan_items`);
        db.exec('DROP TABLE plan_items');
        db.exec('ALTER TABLE plan_items_new RENAME TO plan_items');
        db.exec(`CREATE INDEX IF NOT EXISTS idx_plan_items_plan ON plan_items(plan_id, sort)`);
        db.exec('PRAGMA foreign_keys = ON');
      }
    },
  ],
  // v9（t1 知识标注与解析分档）：
  //  - questions 增列 topics（知识点 JSON 数组）+ topics_source（manual/import/batch/ai-deep）；
  //    存量行两列为 NULL = 未标注（统计/讲解退化到 tags）。
  //  - explanations 增列 depth（解析深度档 light/deep；存量行回填 light），并重建
  //    UNIQUE(question_id, answer_norm) → UNIQUE(question_id, answer_norm, depth)：
  //    浅/深两档缓存互不挤占（设计 §3.2）。
  //  全程幂等：ADD COLUMN 用「查列再执行」守卫；UNIQUE 重建用 v8 同款
  //  「新表→复制→删旧→改名→重建索引」流程（PRAGMA foreign_keys=OFF 包裹）。
  [
    (db: DatabaseSync) => {
      const columns = db
        .prepare('PRAGMA table_info(questions)')
        .all()
        .map((row) => String(row.name));
      if (!columns.includes('topics')) {
        db.exec('ALTER TABLE questions ADD COLUMN topics TEXT');
      }
      if (!columns.includes('topics_source')) {
        db.exec('ALTER TABLE questions ADD COLUMN topics_source TEXT');
      }
    },
    (db: DatabaseSync) => {
      const columns = db
        .prepare('PRAGMA table_info(explanations)')
        .all()
        .map((row) => String(row.name));
      if (!columns.includes('depth')) {
        db.exec("ALTER TABLE explanations ADD COLUMN depth TEXT NOT NULL DEFAULT 'light'");
      }
      // UNIQUE 约束需要含 depth：SQLite 无法 ALTER UNIQUE → 重建表（v8 同款流程）。
      const existsNew = db
        .prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name='explanations_new'")
        .get() as { n: number };
      if (existsNew.n > 0) return;
      db.exec('PRAGMA foreign_keys = OFF');
      db.exec(`CREATE TABLE explanations_new (
        id TEXT PRIMARY KEY,
        question_id TEXT NOT NULL REFERENCES questions(id) ON DELETE CASCADE,
        answer_norm TEXT NOT NULL,
        depth TEXT NOT NULL DEFAULT 'light',
        content TEXT NOT NULL,
        provider TEXT,
        reasoning_effort TEXT,
        model TEXT,
        prompt_version INTEGER NOT NULL DEFAULT 1,
        question_updated_at INTEGER NOT NULL DEFAULT 0,
        input_tokens INTEGER,
        output_tokens INTEGER,
        finish_reason TEXT,
        created_at INTEGER NOT NULL,
        UNIQUE(question_id, answer_norm, depth)
      )`);
      db.exec(`INSERT INTO explanations_new
        (id, question_id, answer_norm, depth, content, provider, reasoning_effort, model,
         prompt_version, question_updated_at, input_tokens, output_tokens, finish_reason, created_at)
        SELECT id, question_id, answer_norm, depth, content, provider, reasoning_effort, model,
         prompt_version, question_updated_at, input_tokens, output_tokens, finish_reason, created_at
        FROM explanations`);
      db.exec('DROP TABLE explanations');
      db.exec('ALTER TABLE explanations_new RENAME TO explanations');
      db.exec('CREATE INDEX IF NOT EXISTS idx_explanations_question ON explanations(question_id)');
      db.exec('PRAGMA foreign_keys = ON');
    },
  ],
  // v10（t13 学情治理）：diagnoses 诊断持久化表。纯新增表；此前诊断结果不落库，
  // 无存量数据需要迁移。weaknesses/suggestions 为 JSON 数组文本（读取端宽容解析）。
  [
    `CREATE TABLE IF NOT EXISTS diagnoses (
      id TEXT PRIMARY KEY,
      summary TEXT NOT NULL,
      weaknesses TEXT NOT NULL,
      suggestions TEXT NOT NULL,
      provider TEXT,
      model TEXT,
      created_at INTEGER NOT NULL
    )`,
    `CREATE INDEX IF NOT EXISTS idx_diagnoses_created ON diagnoses(created_at)`,
  ],
];

const IN_MEMORY = ':memory:';

class SqliteExamStore implements ExamStore {
  readonly path: string;
  readonly #db: DatabaseSync;
  readonly #openedAt: number;
  #closed = false;

  constructor(path: string, db: DatabaseSync) {
    this.path = path;
    this.#db = db;
    this.#openedAt = Date.now();
  }

  health(): ExamStoreHealth {
    if (this.#closed) {
      return {
        ok: false,
        path: this.path,
        closed: true,
        schemaVersion: MIGRATIONS.length,
        error: 'ExamStore is closed',
      };
    }
    try {
      this.#db.prepare('SELECT 1').get();
      return {
        ok: true,
        path: this.path,
        closed: false,
        schemaVersion: MIGRATIONS.length,
        openedAt: this.#openedAt,
      };
    } catch (error) {
      return {
        ok: false,
        path: this.path,
        closed: false,
        schemaVersion: MIGRATIONS.length,
        openedAt: this.#openedAt,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  readiness(): ExamStoreReadiness {
    if (this.#closed) return { ready: false, reason: 'ExamStore is closed' };
    try {
      this.#db.prepare('SELECT 1').get();
      return { ready: true };
    } catch (error) {
      return {
        ready: false,
        reason: error instanceof Error ? error.message : String(error),
      };
    }
  }

  listBanks(options: ListBanksOptions = {}): BankRow[] {
    this.#assertOpen();
    const conditions: string[] = [];
    const params: SQLInputValue[] = [];
    if (options.includeDeleted !== true) conditions.push('deleted_at IS NULL');
    if (options.includeArchived !== true) conditions.push('archived_at IS NULL');
    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const rows = this.#db
      .prepare(`SELECT id, name, created_at, deleted_at, archived_at FROM banks ${where} ORDER BY created_at ASC, id ASC`)
      .all(...params);
    return rows.map(toBankRow);
  }

  getBank(id: string): BankRow | undefined {
    this.#assertOpen();
    const row = this.#db
      .prepare('SELECT id, name, created_at, deleted_at, archived_at FROM banks WHERE id = ?')
      .get(id);
    return row === undefined ? undefined : toBankRow(row);
  }

  renameBank(id: string, name: string): BankRow {
    this.#assertOpen();
    const trimmed = name.trim();
    if (trimmed.length === 0) throw new Error('ExamStore: bank name must not be empty');
    const exists = this.#db.prepare('SELECT 1 FROM banks WHERE id = ?').get(id);
    if (exists === undefined) throw new Error(`ExamStore: bank not found: ${id}`);
    this.#db.prepare('UPDATE banks SET name = ? WHERE id = ?').run(trimmed, id);
    return this.getBank(id)!;
  }

  archiveBank(id: string): BankRow {
    this.#assertOpen();
    const exists = this.#db.prepare('SELECT 1 FROM banks WHERE id = ?').get(id);
    if (exists === undefined) throw new Error(`ExamStore: bank not found: ${id}`);
    this.#db.prepare('UPDATE banks SET archived_at = ? WHERE id = ?').run(Date.now(), id);
    return this.getBank(id)!;
  }

  restoreBank(id: string): BankRow {
    this.#assertOpen();
    const exists = this.#db.prepare('SELECT 1 FROM banks WHERE id = ?').get(id);
    if (exists === undefined) throw new Error(`ExamStore: bank not found: ${id}`);
    this.#db
      .prepare('UPDATE banks SET archived_at = NULL, deleted_at = NULL WHERE id = ?')
      .run(id);
    return this.getBank(id)!;
  }

  deleteBank(id: string): boolean {
    this.#assertOpen();
    const exists = this.#db.prepare('SELECT 1 FROM banks WHERE id = ?').get(id);
    if (exists === undefined) throw new Error(`ExamStore: bank not found: ${id}`);
    const info = this.#db
      .prepare('UPDATE banks SET deleted_at = ? WHERE id = ? AND deleted_at IS NULL')
      .run(Date.now(), id);
    return Number(info.changes) > 0;
  }

  createBank(input: { name: string; id?: string }): BankRow {
    this.#assertOpen();
    const name = input.name.trim();
    if (name.length === 0) throw new Error('ExamStore: bank name must not be empty');
    const id = input.id !== undefined ? input.id : randomUUID();
    const createdAt = Date.now();
    this.#db
      .prepare('INSERT INTO banks (id, name, created_at) VALUES (?, ?, ?)')
      .run(id, name, createdAt);
    return this.getBank(id)!;
  }

  // ── Phase 1：题目 ──────────────────────────────────────────────────────

  createQuestion(bankId: string, input: CreateQuestionInput): QuestionRow {
    this.#assertOpen();
    const type = validateQuestionType(input.type);
    const stem = input.stem.trim();
    if (stem.length === 0) throw new Error('ExamStore: question stem must not be empty');
    // essay 放行（Phase 2）：options 允许空数组、answer 允许 null（JSON 序列化为 'null'）；
    // 其余题型校验不变（options 必须为数组、answer 必须提供）。
    if (!Array.isArray(input.options)) throw new Error('ExamStore: question options must be an array');
    if (input.answer === undefined) throw new Error('ExamStore: question answer is required');
    const id = input.id !== undefined ? input.id : randomUUID();
    const now = Date.now();
    const tags = normalizeLabels(input.tags);
    const topics = normalizeLabels(input.topics);
    this.#db
      .prepare(
        `INSERT INTO questions
           (id, bank_id, type, stem, options, answer, explanation, tags, topics, topics_source,
            created_at, updated_at, import_batch_id, import_item_key)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        bankId,
        type,
        stem,
        jsonStringify(input.options, 'options'),
        jsonStringify(input.answer, 'answer'),
        input.explanation ?? null,
        tags === null ? null : jsonStringify(tags, 'tags'),
        topics === null ? null : jsonStringify(topics, 'topics'),
        input.topicsSource ?? null,
        now,
        now,
        input.importBatchId ?? null,
        input.importItemKey ?? null,
      );
    return this.getQuestion(id)!;
  }

  updateQuestion(id: string, patch: QuestionPatch): QuestionRow {
    this.#assertOpen();
    const existing = this.getQuestion(id);
    if (existing === undefined) throw new Error(`ExamStore: question not found: ${id}`);
    const type = patch.type === undefined ? existing.type : validateQuestionType(patch.type);
    const stem = patch.stem === undefined ? existing.stem : patch.stem.trim();
    if (stem.length === 0) throw new Error('ExamStore: question stem must not be empty');
    // essay 放行（Phase 2）：options 允许空数组、answer 允许 null；其余题型校验不变。
    const options = patch.options === undefined ? existing.options : patch.options;
    if (!Array.isArray(options)) throw new Error('ExamStore: question options must be an array');
    const answer = patch.answer === undefined ? existing.answer : patch.answer;
    if (answer === undefined) throw new Error('ExamStore: question answer is required');
    const explanation =
      patch.explanation === undefined ? existing.explanation : patch.explanation;
    const tags = patch.tags === undefined ? existing.tags : normalizeLabels(patch.tags);
    const topics = patch.topics === undefined ? existing.topics : normalizeLabels(patch.topics);
    // 来源随 topics 联动：置空 → null；覆盖式设置 → 显式传入或 'manual'；未动 topics → 保留。
    const topicsSource =
      patch.topics === undefined
        ? existing.topicsSource
        : topics === null
          ? null
          : (patch.topicsSource ?? 'manual');
    this.#db
      .prepare(
        `UPDATE questions
         SET type = ?, stem = ?, options = ?, answer = ?, explanation = ?, tags = ?, topics = ?, topics_source = ?, updated_at = ?
         WHERE id = ?`,
      )
      .run(
        type,
        stem,
        jsonStringify(options, 'options'),
        jsonStringify(answer, 'answer'),
        explanation,
        tags === null ? null : jsonStringify(tags, 'tags'),
        topics === null ? null : jsonStringify(topics, 'topics'),
        topicsSource,
        Date.now(),
        id,
      );
    return this.getQuestion(id)!;
  }

  deleteQuestion(id: string): boolean {
    this.#assertOpen();
    const info = this.#db
      .prepare('UPDATE questions SET deleted_at = ? WHERE id = ? AND deleted_at IS NULL')
      .run(Date.now(), id);
    return Number(info.changes) > 0;
  }

  getQuestion(id: string): QuestionRow | undefined {
    this.#assertOpen();
    const row = this.#db
      .prepare('SELECT * FROM questions WHERE id = ? AND deleted_at IS NULL')
      .get(id);
    return row === undefined ? undefined : toQuestionRow(row);
  }

  getQuestionIncludingDeleted(id: string): QuestionRow | undefined {
    this.#assertOpen();
    const row = this.#db.prepare('SELECT * FROM questions WHERE id = ?').get(id);
    return row === undefined ? undefined : toQuestionRow(row);
  }

  restoreQuestion(id: string): boolean {
    this.#assertOpen();
    const info = this.#db
      .prepare('UPDATE questions SET deleted_at = NULL WHERE id = ? AND deleted_at IS NOT NULL')
      .run(id);
    return Number(info.changes) > 0;
  }

  moveQuestion(id: string, bankId: string): QuestionRow {
    this.#assertOpen();
    const exists = this.#db.prepare('SELECT 1 FROM questions WHERE id = ? AND deleted_at IS NULL').get(id);
    if (exists === undefined) throw new Error(`ExamStore: question not found: ${id}`);
    // FK(questions.bank_id → banks.id) 校验目标题库存在；更新 updated_at 反映移动。
    this.#db
      .prepare('UPDATE questions SET bank_id = ?, updated_at = ? WHERE id = ?')
      .run(bankId, Date.now(), id);
    return this.getQuestion(id)!;
  }

  listQuestionsByBank(bankId: string, filter: QuestionListFilter = {}): QuestionRow[] {
    this.#assertOpen();
    const conditions: string[] = ['q.bank_id = ?'];
    const params: SQLInputValue[] = [bankId];
    // t9.1：缺省排除已软删除/已归档题目；includeDeleted=true 时连同可见（供题库内"恢复"）。
    if (filter.includeDeleted !== true) conditions.push('q.deleted_at IS NULL');
    const order = buildQuestionListOrder(filter);
    const filterSql = buildQuestionListFilter(filter, conditions, params);
    const rows = this.#db
      .prepare(`SELECT q.* FROM questions q WHERE ${filterSql} ORDER BY ${order}`)
      .all(...params);
    return rows.map(toQuestionRow);
  }

  countQuestions(bankId: string): number {
    this.#assertOpen();
    const row = this.#db
      .prepare('SELECT COUNT(*) AS n FROM questions WHERE bank_id = ? AND deleted_at IS NULL')
      .get(bankId);
    return Number(row?.n ?? 0);
  }

  // ── Phase 1：作答 ──────────────────────────────────────────────────────

  recordAttempt(input: CreateAttemptInput): AttemptRow {
    this.#assertOpen();
    return this.#insertAttemptRow(input);
  }

  recordGradedAttempt(input: CreateAttemptInput): { attempt: AttemptRow; wrong: WrongBookRow } {
    this.#assertOpen();
    return this.#withTransaction(() => ({
      attempt: this.#insertAttemptRow(input),
      wrong: this.#touchWrongRow(input.questionId, input.isCorrect),
    }));
  }

  listLatestAttemptByQuestion(questionIds: readonly string[]): Map<string, AttemptRow> {
    this.#assertOpen();
    const result = new Map<string, AttemptRow>();
    if (questionIds.length === 0) return result;
    const placeholders = questionIds.map(() => '?').join(', ');
    const rows = this.#db
      .prepare(
        `SELECT id, question_id, practice_id, user_answer, is_correct, answered_at
         FROM (
           SELECT a.*, ROW_NUMBER() OVER (
             PARTITION BY question_id ORDER BY answered_at DESC, rowid DESC
           ) AS rn
           FROM attempts a
           WHERE question_id IN (${placeholders})
         )
         WHERE rn = 1`,
      )
      .all(...questionIds);
    for (const row of rows) {
      const attempt = toAttemptRow(row);
      result.set(attempt.questionId, attempt);
    }
    return result;
  }

  listLatestAttemptByPracticeQuestions(
    practiceId: string,
    questionIds: readonly string[],
  ): Map<string, AttemptRow> {
    this.#assertOpen();
    const result = new Map<string, AttemptRow>();
    if (questionIds.length === 0) return result;
    const placeholders = questionIds.map(() => '?').join(', ');
    const rows = this.#db
      .prepare(
        `SELECT id, question_id, practice_id, user_answer, is_correct, answered_at
         FROM (
           SELECT a.*, ROW_NUMBER() OVER (
             PARTITION BY question_id ORDER BY answered_at DESC, rowid DESC
           ) AS rn
           FROM attempts a
           WHERE practice_id = ? AND question_id IN (${placeholders})
         )
         WHERE rn = 1`,
      )
      .all(practiceId, ...questionIds);
    for (const row of rows) {
      const attempt = toAttemptRow(row);
      result.set(attempt.questionId, attempt);
    }
    return result;
  }

  listAllAttempts(): AttemptRow[] {
    this.#assertOpen();
    const rows = this.#db
      .prepare('SELECT * FROM attempts ORDER BY answered_at ASC, id ASC')
      .all();
    return rows.map(toAttemptRow);
  }

  getLatestAttemptByPracticeQuestion(practiceId: string, questionId: string): AttemptRow | undefined {
    this.#assertOpen();
    const row = this.#db
      .prepare(
        `SELECT * FROM attempts
         WHERE practice_id = ? AND question_id = ?
         ORDER BY answered_at DESC, rowid DESC
         LIMIT 1`,
      )
      .get(practiceId, questionId);
    return row === undefined ? undefined : toAttemptRow(row);
  }

  // ── Phase 1：练习会话 ──────────────────────────────────────────────────

  createPracticeSession(input: CreatePracticeSessionInput): PracticeSessionRow {
    this.#assertOpen();
    if (!Array.isArray(input.questionIds)) {
      throw new Error('ExamStore: practice questionIds must be an array');
    }
    const id = input.id !== undefined ? input.id : randomUUID();
    const currentIndex = input.currentIndex ?? 0;
    validateNonNegativeIndex(currentIndex);
    const createdAt = input.createdAt ?? Date.now();
    this.#db
      .prepare(
        `INSERT INTO practice_sessions (id, bank_id, scope, question_ids, current_index, status, created_at, finished_at)
         VALUES (?, ?, ?, ?, ?, 'active', ?, NULL)`,
      )
      .run(
        id,
        input.bankId,
        jsonStringify(input.scope, 'scope'),
        jsonStringify(input.questionIds, 'questionIds'),
        currentIndex,
        createdAt,
      );
    return this.getPracticeSession(id)!;
  }

  getPracticeSession(id: string): PracticeSessionRow | undefined {
    this.#assertOpen();
    const row = this.#db.prepare('SELECT * FROM practice_sessions WHERE id = ?').get(id);
    return row === undefined ? undefined : toPracticeSessionRow(row);
  }

  updatePracticeIndex(id: string, index: number): PracticeSessionRow {
    this.#assertOpen();
    this.#requirePracticeSession(id);
    validateNonNegativeIndex(index);
    this.#db.prepare('UPDATE practice_sessions SET current_index = ? WHERE id = ?').run(index, id);
    return this.getPracticeSession(id)!;
  }

  finishPracticeSession(id: string, questionIds: readonly string[]): PracticeSessionRow {
    this.#assertOpen();
    this.#requirePracticeSession(id);
    if (!Array.isArray(questionIds)) {
      throw new Error('ExamStore: practice questionIds must be an array');
    }
    this.#db
      .prepare(
        `UPDATE practice_sessions
         SET status = 'finished', finished_at = ?, question_ids = ?
         WHERE id = ?`,
      )
      .run(Date.now(), jsonStringify(questionIds, 'questionIds'), id);
    return this.getPracticeSession(id)!;
  }

  deletePracticeSession(id: string): boolean {
    this.#assertOpen();
    const info = this.#db.prepare('DELETE FROM practice_sessions WHERE id = ?').run(id);
    return Number(info.changes) > 0;
  }

  listPracticeHistory(limit = 30): PracticeSessionRow[] {
    this.#assertOpen();
    if (!Number.isInteger(limit) || limit <= 0) {
      throw new Error('ExamStore: practice history limit must be a positive integer');
    }
    const rows = this.#db
      .prepare(
        `SELECT * FROM practice_sessions
         ORDER BY created_at DESC, id DESC
         LIMIT ?`,
      )
      .all(limit);
    return rows.map(toPracticeSessionRow);
  }

  countFinishedPractices(): number {
    this.#assertOpen();
    const row = this.#db
      .prepare("SELECT COUNT(*) AS n FROM practice_sessions WHERE status = 'finished'")
      .get();
    return Number(row?.n ?? 0);
  }

  // ── Phase 1：错题本 ────────────────────────────────────────────────────

  touchWrong(questionId: string, isCorrect: boolean): WrongBookRow {
    this.#assertOpen();
    return this.#touchWrongRow(questionId, isCorrect);
  }

  listWrong(options: ListWrongOptions = {}): WrongBookRow[] {
    this.#assertOpen();
    // t9：归入已归档/已删除题库的错题在默认错题选择器中排除（与列表/练习口径一致）。
    const conditions: string[] = ['w.wrong_count > 0', 'q.deleted_at IS NULL', 'bk.deleted_at IS NULL', 'bk.archived_at IS NULL'];
    const params: SQLInputValue[] = [];
    if (options.includeMastered !== true) conditions.push('w.mastered = 0');
    if (options.bankId !== undefined) {
      conditions.push('q.bank_id = ?');
      params.push(options.bankId);
    }
    const rows = this.#db
      .prepare(
        `SELECT w.question_id, w.wrong_count, w.last_wrong_at, w.mastered,
                w.consecutive_correct, w.last_result, w.lifetime_wrong_count, w.mastery_source,
                (SELECT a.user_answer FROM attempts a
                  WHERE a.question_id = w.question_id
                  ORDER BY a.answered_at DESC, a.rowid DESC LIMIT 1) AS last_answer
         FROM wrong_book_state w
         JOIN questions q ON q.id = w.question_id
         JOIN banks bk ON bk.id = q.bank_id
         WHERE ${conditions.join(' AND ')}
         ORDER BY w.last_wrong_at IS NULL, w.last_wrong_at DESC, w.question_id ASC`,
      )
      .all(...params);
    return rows.map(toWrongBookRow);
  }

  setMastered(questionId: string, mastered: boolean): WrongBookRow {
    this.#assertOpen();
    // 手动标记：mastered=true → source='manual'；mastered=false → source=null（取消掌握）。
    // 其余字段（wrong_count/last_wrong_at/streak/累计答错）在冲突时保持不动。
    const source: MasterySource | null = mastered ? 'manual' : null;
    this.#db
      .prepare(
        `INSERT INTO wrong_book_state
           (question_id, wrong_count, last_wrong_at, mastered, consecutive_correct, last_result, lifetime_wrong_count, mastery_source)
         VALUES (?, 0, NULL, ?, 0, NULL, 0, ?)
         ON CONFLICT(question_id) DO UPDATE SET
           mastered = excluded.mastered,
           mastery_source = excluded.mastery_source`,
      )
      .run(questionId, mastered ? 1 : 0, source);
    return this.#getWrongRow(questionId);
  }

  /** 取错题行（附最近一次作答的 user_answer：与 listWrong/latestAttempt 同序，供「你的作答」标记）。 */
  #getWrongRow(questionId: string): WrongBookRow {
    const row = this.#db
      .prepare(
        `SELECT w.*,
                (SELECT a.user_answer FROM attempts a
                  WHERE a.question_id = w.question_id
                  ORDER BY a.answered_at DESC, a.rowid DESC LIMIT 1) AS last_answer
         FROM wrong_book_state w WHERE w.question_id = ?`,
      )
      .get(questionId);
    return toWrongBookRow(row!);
  }

  // ── Phase 2：essay 批改 ────────────────────────────────────────────────

  saveEssayGrading(input: SaveEssayGradingInput): EssayGradingRow {
    this.#assertOpen();
    return this.#upsertEssayGradingRow(input);
  }

  recordGradedEssay(input: {
    attempt: CreateAttemptInput;
    grading: Omit<SaveEssayGradingInput, 'attemptId'>;
  }): { attempt: AttemptRow; wrong: WrongBookRow; grading: EssayGradingRow } {
    this.#assertOpen();
    return this.#withTransaction(() => {
      const attempt = this.#insertAttemptRow(input.attempt);
      const wrong = this.#touchWrongRow(input.attempt.questionId, input.attempt.isCorrect);
      const grading = this.#upsertEssayGradingRow({ ...input.grading, attemptId: attempt.id });
      return { attempt, wrong, grading };
    });
  }

  getEssayGrading(attemptId: string): EssayGradingRow | undefined {
    this.#assertOpen();
    const row = this.#db
      .prepare('SELECT * FROM essay_gradings WHERE attempt_id = ?')
      .get(attemptId);
    return row === undefined ? undefined : toEssayGradingRow(row);
  }

  listLatestGradingByAttempt(attemptIds: readonly string[]): Map<string, EssayGradingRow> {
    this.#assertOpen();
    const result = new Map<string, EssayGradingRow>();
    if (attemptIds.length === 0) return result;
    // attempt_id 为 PK：每题至多一条批改，天然即"最新"。
    const placeholders = attemptIds.map(() => '?').join(', ');
    const rows = this.#db
      .prepare(`SELECT * FROM essay_gradings WHERE attempt_id IN (${placeholders})`)
      .all(...attemptIds);
    for (const row of rows) {
      const grading = toEssayGradingRow(row);
      result.set(grading.attemptId, grading);
    }
    return result;
  }

  // ── Phase 2：Tutor 对话 ────────────────────────────────────────────────

  createTutorSession(input: CreateTutorSessionInput): TutorSessionRow {
    this.#assertOpen();
    const status = input.status ?? 'active';
    if (status !== 'active' && status !== 'closed') {
      throw new Error(`ExamStore: invalid tutor session status "${status}"`);
    }
    const id = input.id !== undefined ? input.id : randomUUID();
    const createdAt = input.createdAt ?? Date.now();
    this.#db
      .prepare(
        `INSERT INTO tutor_sessions (id, question_id, bank_id, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(id, input.questionId ?? null, input.bankId ?? null, status, createdAt, createdAt);
    return this.getTutorSession(id)!;
  }

  getTutorSession(id: string): TutorSessionRow | undefined {
    this.#assertOpen();
    const row = this.#db.prepare('SELECT * FROM tutor_sessions WHERE id = ?').get(id);
    return row === undefined ? undefined : toTutorSessionRow(row);
  }

  addTutorMessage(input: AddTutorMessageInput): TutorMessageRow {
    this.#assertOpen();
    // t5 纵深防御（P3）：closed 会话禁止写入——即便服务层漏检也不会写穿归档会话。
    const sessionRow = this.#db
      .prepare('SELECT status FROM tutor_sessions WHERE id = ?')
      .get(input.sessionId);
    if (sessionRow === undefined) {
      throw new Error(`ExamStore: tutor session not found: ${input.sessionId}`);
    }
    if (String(sessionRow.status) === 'closed') {
      throw new Error(`ExamStore: tutor session ${input.sessionId} is closed; messages cannot be appended`);
    }
    const role = validateTutorRole(input.role);
    const content = input.content.trim();
    if (content.length === 0) throw new Error('ExamStore: tutor message content must not be empty');
    const id = input.id !== undefined ? input.id : randomUUID();
    const createdAt = input.createdAt ?? Date.now();
    this.#db
      .prepare(
        `INSERT INTO tutor_messages (id, session_id, role, content, created_at, turn_id)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(id, input.sessionId, role, content, createdAt, input.turnId ?? null);
    const row = this.#db.prepare('SELECT * FROM tutor_messages WHERE id = ?').get(id);
    return toTutorMessageRow(row!);
  }

  listTutorMessages(sessionId: string): TutorMessageRow[] {
    this.#assertOpen();
    const rows = this.#db
      .prepare(
        `SELECT * FROM tutor_messages
         WHERE session_id = ?
         ORDER BY created_at ASC, id ASC`,
      )
      .all(sessionId);
    return rows.map(toTutorMessageRow);
  }

  closeTutorSession(id: string): TutorSessionRow {
    this.#assertOpen();
    this.#requireTutorSession(id);
    this.#db
      .prepare(`UPDATE tutor_sessions SET status = 'closed', updated_at = ? WHERE id = ?`)
      .run(Date.now(), id);
    return this.getTutorSession(id)!;
  }

  touchTutorSession(id: string): TutorSessionRow {
    this.#assertOpen();
    this.#requireTutorSession(id);
    this.#db.prepare(`UPDATE tutor_sessions SET updated_at = ? WHERE id = ?`).run(Date.now(), id);
    return this.getTutorSession(id)!;
  }

  listTutorSessions(limit = 30): TutorSessionRow[] {
    this.#assertOpen();
    validatePositiveLimit(limit, 'tutor sessions');
    const rows = this.#db
      .prepare(
        `SELECT s.*,
                q.stem AS question_stem,
                (SELECT m.content FROM tutor_messages m
                  WHERE m.session_id = s.id AND m.role = 'user'
                  ORDER BY m.created_at ASC, m.id ASC LIMIT 1) AS first_user_message
         FROM tutor_sessions s
         LEFT JOIN questions q ON q.id = s.question_id
         ORDER BY s.created_at DESC, s.id DESC
         LIMIT ?`,
      )
      .all(limit);
    return rows.map(toTutorSessionRow);
  }

  getTutorMessage(id: string): TutorMessageRow | undefined {
    this.#assertOpen();
    const row = this.#db.prepare('SELECT * FROM tutor_messages WHERE id = ?').get(id);
    return row === undefined ? undefined : toTutorMessageRow(row);
  }

  deleteTutorSession(id: string): boolean {
    this.#assertOpen();
    // tutor_messages / tutor_turns 均 ON DELETE CASCADE，单条 DELETE 即级联清理。
    const info = this.#db.prepare('DELETE FROM tutor_sessions WHERE id = ?').run(id);
    return Number(info.changes) > 0;
  }

  // ── t5：Tutor turn 状态机 ──────────────────────────────────────────────

  createTutorTurn(input: CreateTutorTurnInput): TutorTurnRow {
    this.#assertOpen();
    const state = validateTutorTurnState(input.state ?? 'pending');
    const id = input.id !== undefined ? input.id : randomUUID();
    const now = Date.now();
    const createdAt = input.createdAt ?? now;
    this.#db
      .prepare(
        `INSERT INTO tutor_turns
           (id, session_id, client_message_id, user_message_id, assistant_message_id,
            state, error_code, provider, model, input_tokens, output_tokens, created_at, updated_at)
         VALUES (?, ?, ?, ?, NULL, ?, NULL, NULL, NULL, NULL, NULL, ?, ?)`,
      )
      .run(
        id,
        input.sessionId,
        input.clientMessageId ?? null,
        input.userMessageId,
        state,
        createdAt,
        createdAt,
      );
    return this.getTutorTurn(id)!;
  }

  getTutorTurnByClientMessageId(clientMessageId: string): TutorTurnRow | undefined {
    this.#assertOpen();
    const row = this.#db
      .prepare('SELECT * FROM tutor_turns WHERE client_message_id = ?')
      .get(clientMessageId);
    return row === undefined ? undefined : toTutorTurnRow(row);
  }

  getTutorTurn(id: string): TutorTurnRow | undefined {
    this.#assertOpen();
    const row = this.#db.prepare('SELECT * FROM tutor_turns WHERE id = ?').get(id);
    return row === undefined ? undefined : toTutorTurnRow(row);
  }

  updateTutorTurnState(id: string, state: TutorTurnState): TutorTurnRow {
    this.#assertOpen();
    validateTutorTurnState(state);
    this.#requireTutorTurn(id);
    this.#db
      .prepare('UPDATE tutor_turns SET state = ?, updated_at = ? WHERE id = ?')
      .run(state, Date.now(), id);
    return this.getTutorTurn(id)!;
  }

  completeTutorTurn(
    id: string,
    patch: {
      assistantMessageId: string;
      provider?: string | null;
      model?: string | null;
      inputTokens?: number | null;
      outputTokens?: number | null;
    },
  ): TutorTurnRow {
    this.#assertOpen();
    this.#requireTutorTurn(id);
    this.#db
      .prepare(
        `UPDATE tutor_turns
         SET state = 'done', error_code = NULL, assistant_message_id = ?,
             provider = ?, model = ?, input_tokens = ?, output_tokens = ?, updated_at = ?
         WHERE id = ?`,
      )
      .run(
        patch.assistantMessageId,
        patch.provider ?? null,
        patch.model ?? null,
        patch.inputTokens ?? null,
        patch.outputTokens ?? null,
        Date.now(),
        id,
      );
    return this.getTutorTurn(id)!;
  }

  setTurnError(id: string, errorCode: string): TutorTurnRow {
    this.#assertOpen();
    this.#requireTutorTurn(id);
    // EXAM_LLM_ABORTED → cancelled（用户主动停，可手动重试）；其余 → failed（可重试）。
    const state: TutorTurnState = errorCode === 'EXAM_LLM_ABORTED' ? 'cancelled' : 'failed';
    this.#db
      .prepare(
        `UPDATE tutor_turns SET state = ?, error_code = ?, updated_at = ? WHERE id = ?`,
      )
      .run(state, errorCode, Date.now(), id);
    return this.getTutorTurn(id)!;
  }

  sweepGhostSessions(ttlMs: number): number {
    this.#assertOpen();
    if (!Number.isFinite(ttlMs) || ttlMs < 0) {
      throw new Error('ExamStore: ghost sweep ttlMs must be a non-negative number');
    }
    const cutoff = Date.now() - ttlMs;
    const info = this.#db
      .prepare(
        `UPDATE tutor_sessions
         SET status = 'closed', updated_at = ?
         WHERE status = 'active'
           AND updated_at < ?
           AND NOT EXISTS (
             SELECT 1 FROM tutor_turns t
             WHERE t.session_id = tutor_sessions.id AND t.state = 'done'
           )`,
      )
      .run(Date.now(), cutoff);
    return Number(info.changes);
  }

  // ── t5：AI 导入批次 / 草稿 ─────────────────────────────────────────────

  saveImportBatch(input: { id: string; bankId: string; questionIds: string[] }): ImportBatchRow {
    this.#assertOpen();
    if (!Array.isArray(input.questionIds)) {
      throw new Error('ExamStore: import batch questionIds must be an array');
    }
    this.#db
      .prepare(
        `INSERT INTO import_batches (id, bank_id, status, question_ids, created_at)
         VALUES (?, ?, 'committed', ?, ?)`,
      )
      .run(
        input.id,
        input.bankId,
        jsonStringify(input.questionIds, 'questionIds'),
        Date.now(),
      );
    return this.getImportBatch(input.id)!;
  }

  getImportBatch(id: string): ImportBatchRow | undefined {
    this.#assertOpen();
    const row = this.#db.prepare('SELECT * FROM import_batches WHERE id = ?').get(id);
    return row === undefined ? undefined : toImportBatchRow(row);
  }

  saveImportDraft(input: { sourceHash?: string | null; items: unknown[] }): ImportDraftRow {
    this.#assertOpen();
    if (!Array.isArray(input.items)) {
      throw new Error('ExamStore: import draft items must be an array');
    }
    const id = randomUUID();
    const now = Date.now();
    this.#db
      .prepare(
        `INSERT INTO import_drafts (id, source_hash, items, status, created_at, updated_at)
         VALUES (?, ?, ?, 'open', ?, ?)`,
      )
      .run(id, input.sourceHash ?? null, jsonStringify(input.items, 'items'), now, now);
    return this.getImportDraft(id)!;
  }

  getImportDraft(id: string): ImportDraftRow | undefined {
    this.#assertOpen();
    const row = this.#db.prepare('SELECT * FROM import_drafts WHERE id = ?').get(id);
    return row === undefined ? undefined : toImportDraftRow(row);
  }

  updateImportDraftStatus(id: string, status: ImportDraftRow['status']): ImportDraftRow {
    this.#assertOpen();
    if (status !== 'open' && status !== 'committed' && status !== 'discarded') {
      throw new Error(`ExamStore: invalid import draft status "${String(status)}"`);
    }
    const exists = this.#db.prepare('SELECT 1 FROM import_drafts WHERE id = ?').get(id);
    if (exists === undefined) throw new Error(`ExamStore: import draft not found: ${id}`);
    this.#db
      .prepare('UPDATE import_drafts SET status = ?, updated_at = ? WHERE id = ?')
      .run(status, Date.now(), id);
    return this.getImportDraft(id)!;
  }

  sweepImportDrafts(ttlMs: number): number {
    this.#assertOpen();
    if (!Number.isFinite(ttlMs) || ttlMs < 0) {
      throw new Error('ExamStore: import draft sweep ttlMs must be a non-negative number');
    }
    const cutoff = Date.now() - ttlMs;
    const info = this.#db
      .prepare(
        `UPDATE import_drafts SET status = 'discarded', updated_at = ?
         WHERE status = 'open' AND updated_at < ?`,
      )
      .run(Date.now(), cutoff);
    return Number(info.changes);
  }

  withTransaction<T>(fn: () => T): T {
    this.#assertOpen();
    return this.#withTransaction(fn);
  }

  // ── Phase 2：学习计划 ──────────────────────────────────────────────────

  createStudyPlan(input: CreateStudyPlanInput): StudyPlanRow {
    this.#assertOpen();
    const title = input.title.trim();
    if (title.length === 0) throw new Error('ExamStore: study plan title must not be empty');
    if (input.source !== 'llm' && input.source !== 'manual') {
      throw new Error(`ExamStore: invalid study plan source "${String(input.source)}"`);
    }
    const status = input.status ?? 'active';
    if (status !== 'active' && status !== 'completed') {
      throw new Error(`ExamStore: invalid study plan status "${status}"`);
    }
    const id = input.id !== undefined ? input.id : randomUUID();
    const createdAt = input.createdAt ?? Date.now();
    this.#db
      .prepare(
        `INSERT INTO study_plans (id, title, source, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(id, title, input.source, status, createdAt, createdAt);
    return this.getStudyPlan(id)!;
  }

  getStudyPlan(id: string): StudyPlanRow | undefined {
    this.#assertOpen();
    const row = this.#db.prepare('SELECT * FROM study_plans WHERE id = ?').get(id);
    return row === undefined ? undefined : toStudyPlanRow(row);
  }

  listStudyPlans(limit = 30): StudyPlanRow[] {
    this.#assertOpen();
    validatePositiveLimit(limit, 'study plans');
    const rows = this.#db
      .prepare(
        `SELECT * FROM study_plans
         ORDER BY created_at DESC, id DESC
         LIMIT ?`,
      )
      .all(limit);
    return rows.map(toStudyPlanRow);
  }

  addPlanItems(
    planId: string,
    items: AddPlanItemInput[],
  ): { plan: StudyPlanRow; items: PlanItemRow[] } {
    this.#assertOpen();
    const plan = this.getStudyPlan(planId);
    if (plan === undefined) throw new Error(`ExamStore: study plan not found: ${planId}`);
    if (!Array.isArray(items)) throw new Error('ExamStore: plan items must be an array');
    const now = Date.now();
    const created: PlanItemRow[] = [];
    for (const item of items) {
      const title = item.title.trim();
      if (title.length === 0) throw new Error('ExamStore: plan item title must not be empty');
      const sort = item.sort ?? 0;
      validateNonNegativeIndex(sort);
      const status = validatePlanItemStatus(item.status ?? 'pending');
      const priority = item.priority ?? 0;
      if (!Number.isInteger(priority) || priority < 0) {
        throw new Error(`ExamStore: plan item priority must be a non-negative integer, got ${String(item.priority)}`);
      }
      const actionType = item.actionType ?? null;
      if (actionType !== null && !isPlanItemActionType(actionType)) {
        throw new Error(`ExamStore: invalid plan item actionType "${String(item.actionType)}"`);
      }
      const completedAt = status === 'done' ? now : null;
      const id = randomUUID();
      this.#db
        .prepare(
          `INSERT INTO plan_items
             (id, plan_id, title, status, sort, created_at, completed_at,
              note, action_type, scope, due_at, priority, source_diagnosis_id)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          id,
          planId,
          title,
          status,
          sort,
          now,
          completedAt,
          item.note ?? null,
          actionType,
          item.scope === undefined || item.scope === null ? null : jsonStringify(item.scope, 'scope'),
          item.dueAt ?? null,
          priority,
          item.sourceDiagnosisId ?? null,
        );
      const row = this.#db.prepare('SELECT * FROM plan_items WHERE id = ?').get(id);
      created.push(toPlanItemRow(row!));
    }
    return { plan, items: created };
  }

  listPlanItems(planId: string): PlanItemRow[] {
    this.#assertOpen();
    const rows = this.#db
      .prepare(
        `SELECT * FROM plan_items
         WHERE plan_id = ?
         ORDER BY sort ASC, created_at ASC, id ASC`,
      )
      .all(planId);
    return rows.map(toPlanItemRow);
  }

  setPlanItemDone(planId: string, itemId: string, done: boolean): PlanItemRow {
    this.#assertOpen();
    const plan = this.getStudyPlan(planId);
    if (plan === undefined) throw new Error(`ExamStore: study plan not found: ${planId}`);
    const exists = this.#db
      .prepare('SELECT 1 FROM plan_items WHERE id = ? AND plan_id = ?')
      .get(itemId, planId);
    if (exists === undefined) throw new Error(`ExamStore: plan item not found: ${itemId}`);
    // t12 计划状态自动机（M0）：条目翻转与计划状态重算在同一事务内原子提交。
    // 条目更新后重算该计划全部条目：无 pending/doing（全部 done/skipped）→
    // plan.status='completed'，存在 pending/doing → 'active'；两种情况都刷新 updated_at=now。
    // t9：状态机口径随新状态扩展——doing（进行中）视为未完成、skipped（跳过）视为终态。
    return this.#withTransaction(() => {
      const now = Date.now();
      if (done) {
        this.#db
          .prepare(`UPDATE plan_items SET status = 'done', completed_at = ? WHERE id = ?`)
          .run(now, itemId);
      } else {
        this.#db
          .prepare(`UPDATE plan_items SET status = 'pending', completed_at = NULL WHERE id = ?`)
          .run(itemId);
      }
      const open = this.#db
        .prepare(
          `SELECT COUNT(*) AS n FROM plan_items WHERE plan_id = ? AND status IN ('pending','doing')`,
        )
        .get(planId) as { n: number };
      const nextStatus: StudyPlanStatus = open.n === 0 ? 'completed' : 'active';
      this.#db
        .prepare(`UPDATE study_plans SET status = ?, updated_at = ? WHERE id = ?`)
        .run(nextStatus, now, planId);
      const row = this.#db.prepare('SELECT * FROM plan_items WHERE id = ?').get(itemId);
      return toPlanItemRow(row!);
    });
  }

  getPlanWithItems(id: string): { plan: StudyPlanRow; items: PlanItemRow[] } | undefined {
    this.#assertOpen();
    const plan = this.getStudyPlan(id);
    if (plan === undefined) return undefined;
    return { plan, items: this.listPlanItems(id) };
  }

  deleteStudyPlan(id: string): boolean {
    this.#assertOpen();
    // plan_items ON DELETE CASCADE → 单条 DELETE 即级联清理全部条目（与 deleteTutorSession 同模式）。
    const info = this.#db.prepare('DELETE FROM study_plans WHERE id = ?').run(id);
    return Number(info.changes) > 0;
  }

  deletePlanItem(planId: string, itemId: string): void {
    this.#assertOpen();
    const plan = this.getStudyPlan(planId);
    if (plan === undefined) throw new Error(`ExamStore: study plan not found: ${planId}`);
    const exists = this.#db
      .prepare('SELECT 1 FROM plan_items WHERE id = ? AND plan_id = ?')
      .get(itemId, planId);
    if (exists === undefined) throw new Error(`ExamStore: plan item not found: ${itemId} in plan ${planId}`);
    // 删除与状态重算同事务（t12 自动机口径）：剩余条目全 done/skipped → completed；
    // 删空（total=0）→ active（与手动新建计划的空计划初始态一致）。
    this.#withTransaction(() => {
      this.#db.prepare('DELETE FROM plan_items WHERE id = ?').run(itemId);
      const counts = this.#db
        .prepare(
          `SELECT COUNT(*) AS total,
                  SUM(CASE WHEN status IN ('pending','doing') THEN 1 ELSE 0 END) AS open
             FROM plan_items WHERE plan_id = ?`,
        )
        .get(planId) as { total: number; open: number | null };
      const nextStatus: StudyPlanStatus =
        counts.total > 0 && (counts.open ?? 0) === 0 ? 'completed' : 'active';
      this.#db
        .prepare(`UPDATE study_plans SET status = ?, updated_at = ? WHERE id = ?`)
        .run(nextStatus, Date.now(), planId);
    });
  }

  // ── t13：学情诊断持久化 ────────────────────────────────────────────────

  saveDiagnosis(input: SaveDiagnosisInput): DiagnosisRow {
    this.#assertOpen();
    const summary = input.summary.trim();
    if (summary.length === 0) throw new Error('ExamStore: diagnosis summary must not be empty');
    const id = input.id !== undefined ? input.id : randomUUID();
    const createdAt = input.createdAt ?? Date.now();
    this.#db
      .prepare(
        `INSERT INTO diagnoses (id, summary, weaknesses, suggestions, provider, model, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        summary,
        jsonStringify([...(input.weaknesses ?? [])], 'weaknesses'),
        jsonStringify([...(input.suggestions ?? [])], 'suggestions'),
        input.provider ?? null,
        input.model ?? null,
        createdAt,
      );
    const row = this.#db.prepare('SELECT * FROM diagnoses WHERE id = ?').get(id);
    return toDiagnosisRow(row!);
  }

  listDiagnoses(limit = 10): DiagnosisRow[] {
    this.#assertOpen();
    validatePositiveLimit(limit, 'diagnoses');
    const rows = this.#db
      .prepare('SELECT * FROM diagnoses ORDER BY created_at DESC, id DESC LIMIT ?')
      .all(limit);
    return rows.map(toDiagnosisRow);
  }

  // ── Phase 4：AI 解析缓存 ───────────────────────────────────────────────

  getExplanation(questionId: string, answerNorm: string, depth: 'light' | 'deep' = 'light'): ExplanationRow | undefined {
    this.#assertOpen();
    const row = this.#db
      .prepare('SELECT * FROM explanations WHERE question_id = ? AND answer_norm = ? AND depth = ?')
      .get(questionId, answerNorm, depth);
    return row === undefined ? undefined : toExplanationRow(row);
  }

  upsertExplanation(input: SaveExplanationInput): ExplanationRow {
    this.#assertOpen();
    if (typeof input.answerNorm !== 'string') {
      throw new Error('ExamStore: explanation answerNorm must be a string');
    }
    const content = input.content.trim();
    if (content.length === 0) {
      throw new Error('ExamStore: explanation content must not be empty');
    }
    const id = randomUUID();
    const now = Date.now();
    // INSERT OR REPLACE：命中 UNIQUE(question_id, answer_norm, depth) 时删旧行插新行
    //（单份最新，id/created_at/model 同步刷新），无版本历史（设计 §4）；
    // depth 分档（t1）：浅/深两档各一份，互不覆盖。
    this.#db
      .prepare(
        `INSERT OR REPLACE INTO explanations
           (id, question_id, answer_norm, depth, content, model, provider, reasoning_effort,
            prompt_version, question_updated_at, input_tokens, output_tokens, finish_reason, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.questionId,
        input.answerNorm,
        input.depth ?? 'light',
        content,
        input.model ?? null,
        input.provider ?? null,
        input.reasoningEffort ?? null,
        input.promptVersion ?? 1,
        input.questionUpdatedAt ?? 0,
        input.inputTokens ?? null,
        input.outputTokens ?? null,
        input.finishReason ?? null,
        now,
      );
    const row = this.#db.prepare('SELECT * FROM explanations WHERE id = ?').get(id);
    return toExplanationRow(row!);
  }

  listExplanationsByQuestion(questionId: string): ExplanationRow[] {
    this.#assertOpen();
    const rows = this.#db
      .prepare(
        'SELECT * FROM explanations WHERE question_id = ? ORDER BY created_at DESC, id DESC',
      )
      .all(questionId);
    return rows.map(toExplanationRow);
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#db.close();
  }

  #requirePracticeSession(id: string): void {
    const exists = this.#db.prepare('SELECT 1 FROM practice_sessions WHERE id = ?').get(id);
    if (exists === undefined) throw new Error(`ExamStore: practice session not found: ${id}`);
  }

  #requireTutorSession(id: string): void {
    const exists = this.#db.prepare('SELECT 1 FROM tutor_sessions WHERE id = ?').get(id);
    if (exists === undefined) throw new Error(`ExamStore: tutor session not found: ${id}`);
  }

  #requireTutorTurn(id: string): void {
    const exists = this.#db.prepare('SELECT 1 FROM tutor_turns WHERE id = ?').get(id);
    if (exists === undefined) throw new Error(`ExamStore: tutor turn not found: ${id}`);
  }

  #assertOpen(): void {
    if (this.#closed) throw new Error('ExamStore: store is closed');
  }

  /**
   * 最小事务能力（t1）：同步执行 fn 内全部写语句并整体 COMMIT；任一步抛错则
   * ROLLBACK 后原样重抛。DatabaseSync 为同步连接，同一连接上无并发交错，
   * BEGIN/COMMIT 包裹即原子。**不得嵌套调用**（内部方法不互相进入事务）。
   */
  #withTransaction<T>(fn: () => T): T {
    this.#db.exec('BEGIN');
    try {
      const result = fn();
      this.#db.exec('COMMIT');
      return result;
    } catch (error) {
      try {
        this.#db.exec('ROLLBACK');
      } catch {
        // 连接已损坏时 ROLLBACK 可能失败；保留原始错误。
      }
      throw error;
    }
  }

  /** recordAttempt 的实际写入（供单写与事务路径共用）。 */
  #insertAttemptRow(input: CreateAttemptInput): AttemptRow {
    if (input.userAnswer === undefined) {
      throw new Error('ExamStore: attempt userAnswer is required');
    }
    const id = input.id !== undefined ? input.id : randomUUID();
    const answeredAt = input.answeredAt ?? Date.now();
    this.#db
      .prepare(
        `INSERT INTO attempts (id, question_id, practice_id, user_answer, is_correct, answered_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.questionId,
        input.practiceId ?? null,
        jsonStringify(input.userAnswer, 'userAnswer'),
        input.isCorrect ? 1 : 0,
        answeredAt,
      );
    const row = this.#db.prepare('SELECT * FROM attempts WHERE id = ?').get(id);
    return toAttemptRow(row!);
  }

  /**
   * touchWrong 的实际写入（供单写与事务路径共用）——t9 掌握模型升级：
   * - 答对：wrong_count 递减至 0；consecutive_correct +1（streak）；last_result=1；
   *   lifetime_wrong_count 不变。streak 达 MASTERY_THRESHOLD 且未掌握 → mastered=1 +
   *   mastery_source='computed'（自动达标）。
   * - 答错：wrong_count +1、last_wrong_at=now、lifetime_wrong_count +1（只增）、
   *   consecutive_correct=0（streak 清零）、last_result=0。**不取消 mastered**（决策：
   *   参考旧 masteryService 语义——掌握后偶尔错一次不应立即取消，由用户手动管理；
   *   computed/manual 的掌握在答错后均保留）。
   */
  #touchWrongRow(questionId: string, isCorrect: boolean): WrongBookRow {
    if (isCorrect) {
      this.#db
        .prepare(
          `INSERT INTO wrong_book_state
             (question_id, wrong_count, last_wrong_at, mastered, consecutive_correct, last_result, lifetime_wrong_count, mastery_source)
           VALUES (?, 0, NULL, 0, 1, 1, 0, NULL)
           ON CONFLICT(question_id) DO UPDATE SET
             wrong_count = MAX(wrong_count - 1, 0),
             consecutive_correct = consecutive_correct + 1,
             last_result = 1`,
        )
        .run(questionId);
      // streak 达标自动置位 mastered（computed；幂等：未达标或已掌握不产生变更）。
      this.#db
        .prepare(
          `UPDATE wrong_book_state
           SET mastered = 1, mastery_source = 'computed'
           WHERE question_id = ? AND mastered = 0 AND consecutive_correct >= ?`,
        )
        .run(questionId, MASTERY_THRESHOLD);
    } else {
      this.#db
        .prepare(
          `INSERT INTO wrong_book_state
             (question_id, wrong_count, last_wrong_at, mastered, consecutive_correct, last_result, lifetime_wrong_count, mastery_source)
           VALUES (?, 1, ?, 0, 0, 0, 1, NULL)
           ON CONFLICT(question_id) DO UPDATE SET
             wrong_count = wrong_count + 1,
             last_wrong_at = excluded.last_wrong_at,
             consecutive_correct = 0,
             last_result = 0,
             lifetime_wrong_count = lifetime_wrong_count + 1`,
        )
        .run(questionId, Date.now());
    }
    return this.#getWrongRow(questionId);
  }

  /** saveEssayGrading 的实际写入（供单写与事务路径共用）。 */
  #upsertEssayGradingRow(input: SaveEssayGradingInput): EssayGradingRow {
    const attemptId = input.attemptId.trim();
    if (attemptId.length === 0) throw new Error('ExamStore: grading attemptId must not be empty');
    if (!Number.isInteger(input.score) || input.score < 0 || input.score > 100) {
      throw new Error(
        `ExamStore: grading score must be an integer in 0..100, got ${String(input.score)}`,
      );
    }
    const verdict = validateGradingVerdict(input.verdict);
    const feedback = input.feedback.trim();
    if (feedback.length === 0) throw new Error('ExamStore: grading feedback must not be empty');
    const now = Date.now();
    this.#db
      .prepare(
        `INSERT INTO essay_gradings
           (attempt_id, score, verdict, feedback, reference, is_correct, model,
            provider, input_tokens, output_tokens, finish_reason, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(attempt_id) DO UPDATE SET
           score = excluded.score,
           verdict = excluded.verdict,
           feedback = excluded.feedback,
           reference = excluded.reference,
           is_correct = excluded.is_correct,
           model = excluded.model,
           provider = excluded.provider,
           input_tokens = excluded.input_tokens,
           output_tokens = excluded.output_tokens,
           finish_reason = excluded.finish_reason`,
      )
      .run(
        attemptId,
        input.score,
        verdict,
        feedback,
        input.reference ?? null,
        input.score >= 60 ? 1 : 0,
        input.model ?? null,
        input.provider ?? null,
        input.inputTokens ?? null,
        input.outputTokens ?? null,
        input.finishReason ?? null,
        now,
      );
    const row = this.#db
      .prepare('SELECT * FROM essay_gradings WHERE attempt_id = ?')
      .get(attemptId);
    return toEssayGradingRow(row!);
  }
}

type DatabaseSyncCtor = typeof import('node:sqlite').DatabaseSync;

let databaseSyncCtor: DatabaseSyncCtor | undefined;

/**
 * 延迟加载 node:sqlite 的 DatabaseSync 构造器并缓存。
 * 模块求值时过滤器已安装，首次动态导入触发的 ExperimentalWarning 会被静默。
 */
async function getDatabaseSync(): Promise<DatabaseSyncCtor> {
  if (databaseSyncCtor === undefined) {
    const mod = await import('node:sqlite');
    databaseSyncCtor = mod.DatabaseSync;
  }
  return databaseSyncCtor;
}

/** 打开（并按需初始化）一个 ExamStore。async：node:sqlite 延迟加载。close 幂等。 */
export async function openExamStore(
  path: string,
  options: OpenExamStoreOptions = {},
): Promise<ExamStore> {
  if (typeof path !== 'string' || path.length === 0) {
    throw new Error('ExamStore: path must be a non-empty string');
  }
  if (path !== IN_MEMORY && options.createDir !== false) {
    mkdirSync(dirname(path), { recursive: true });
  }
  const DatabaseSync = await getDatabaseSync();
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  migrate(db);
  return new SqliteExamStore(path, db);
}

/** 按 MIGRATIONS（逻辑版本分组）把 schema 从当前 user_version 推进到最新。 */
function migrate(db: DatabaseSync): void {
  const row = db.prepare('PRAGMA user_version').get();
  const current = Number(row?.user_version ?? 0);
  let applied = false;
  for (const [version, statements] of MIGRATIONS.entries()) {
    if (version >= current) {
      applied = true;
      for (const entry of statements) {
        if (typeof entry === 'function') entry(db);
        else db.exec(entry);
      }
    }
  }
  if (applied) {
    // 迁移后完整性验证（v3 重建 questions 后确认外部 FK 无悬挂引用）：
    // 违规即抛错，且 user_version 未更新，下次打开会重试迁移。
    const violations = db.prepare('PRAGMA foreign_key_check').all();
    if (violations.length > 0) {
      throw new Error(
        `ExamStore: foreign key check failed after migration (${violations.length} violation(s))`,
      );
    }
  }
  if (MIGRATIONS.length > current) {
    db.exec(`PRAGMA user_version = ${MIGRATIONS.length}`);
  }
}

function toBankRow(raw: Record<string, SQLOutputValue>): BankRow {
  return {
    id: String(raw.id),
    name: String(raw.name),
    createdAt: Number(raw.created_at),
    deletedAt: raw.deleted_at === null || raw.deleted_at === undefined ? null : Number(raw.deleted_at),
    archivedAt: raw.archived_at === null || raw.archived_at === undefined ? null : Number(raw.archived_at),
  };
}

/**
 * 构造题目列表的 WHERE 过滤片段（t9）。仅使用参数化占位符与固定的列名映射，
 * 无任何外部字符串拼接进 SQL 正文。
 */
function buildQuestionListFilter(
  filter: QuestionListFilter,
  conditions: string[],
  params: SQLInputValue[],
): string {
  if (filter.q !== undefined && typeof filter.q === 'string' && filter.q.trim().length > 0) {
    conditions.push('LOWER(q.stem) LIKE ?');
    params.push(`%${filter.q.trim().toLowerCase()}%`);
  }
  if (filter.type !== undefined) {
    const types = Array.isArray(filter.type) ? filter.type : [filter.type];
    if (types.length > 0) {
      conditions.push(`q.type IN (${types.map(() => '?').join(', ')})`);
      params.push(...types.map((t) => String(t)));
    }
  }
  if (filter.tags !== undefined) {
    const tags = Array.isArray(filter.tags) ? filter.tags : [filter.tags];
    for (const tag of tags) {
      if (typeof tag !== 'string' || tag.trim().length === 0) continue;
      conditions.push('EXISTS (SELECT 1 FROM json_each(q.tags) je WHERE je.value = ?)');
      params.push(tag.trim());
    }
  }
  if (filter.hasExplanation !== undefined) {
    if (filter.hasExplanation) {
      conditions.push(`q.explanation IS NOT NULL AND q.explanation != ''`);
    } else {
      conditions.push(`(q.explanation IS NULL OR q.explanation = '')`);
    }
  }
  return conditions.join(' AND ');
}

/** 构造题目列表的 ORDER BY 片段（t9）。field/dir 受 QuestionListFilter 联合约束，映射为固定列名。 */
function buildQuestionListOrder(filter: QuestionListFilter): string {
  const field = filter.sort?.field === 'updatedAt' ? 'q.updated_at' : 'q.created_at';
  const dir = filter.sort?.dir === 'desc' ? 'DESC' : 'ASC';
  return `${field} ${dir}, q.id ASC`;
}

// ---------------------------------------------------------------------------
// Phase 1 辅助：JSON 序列化 / 校验 / 行映射
// ---------------------------------------------------------------------------

/** JSON.stringify 的安全封装：undefined 等不可序列化值直接抛错，避免静默丢字段。 */
function jsonStringify(value: unknown, field: string): string {
  const serialized = JSON.stringify(value);
  if (serialized === undefined) {
    throw new Error(`ExamStore: ${field} is not JSON-serializable`);
  }
  return serialized;
}

/** JSON.parse 的安全封装：损坏数据抛带字段名的错误。 */
function parseJson<T>(raw: SQLOutputValue | null | undefined, field: string): T {
  if (raw === null || raw === undefined) {
    throw new Error(`ExamStore: ${field} is NULL but expected JSON`);
  }
  try {
    return JSON.parse(String(raw)) as T;
  } catch {
    throw new Error(`ExamStore: corrupt JSON in ${field}`);
  }
}

const QUESTION_TYPES: readonly StoredQuestionType[] = ['single', 'multiple', 'boolean', 'essay'];

function validateQuestionType(type: string): StoredQuestionType {
  if (!(QUESTION_TYPES as readonly string[]).includes(type)) {
    throw new Error(`ExamStore: invalid question type "${type}"`);
  }
  return type as StoredQuestionType;
}

const GRADING_VERDICTS: readonly string[] = ['correct', 'partial', 'incorrect'];

function validateGradingVerdict(verdict: string): GradingVerdict {
  if (!GRADING_VERDICTS.includes(verdict)) {
    throw new Error(`ExamStore: invalid grading verdict "${verdict}"`);
  }
  return verdict as GradingVerdict;
}

const TUTOR_ROLES: readonly string[] = ['user', 'assistant'];

function validateTutorRole(role: string): TutorMessageRole {
  if (!TUTOR_ROLES.includes(role)) {
    throw new Error(`ExamStore: invalid tutor message role "${role}"`);
  }
  return role as TutorMessageRole;
}

const TUTOR_TURN_STATES: readonly string[] = ['pending', 'streaming', 'done', 'failed', 'cancelled'];

function validateTutorTurnState(state: string): TutorTurnState {
  if (!TUTOR_TURN_STATES.includes(state)) {
    throw new Error(`ExamStore: invalid tutor turn state "${state}"`);
  }
  return state as TutorTurnState;
}

function validatePositiveLimit(limit: number, what: string): void {
  if (!Number.isInteger(limit) || limit <= 0) {
    throw new Error(`ExamStore: ${what} limit must be a positive integer`);
  }
}

function validateNonNegativeIndex(index: number): void {
  if (!Number.isInteger(index) || index < 0) {
    throw new Error(`ExamStore: index must be a non-negative integer, got ${String(index)}`);
  }
}

const PLAN_ITEM_STATUSES: readonly string[] = ['pending', 'doing', 'done', 'skipped'];

function validatePlanItemStatus(status: string): PlanItemStatus {
  if (!PLAN_ITEM_STATUSES.includes(status)) {
    throw new Error(`ExamStore: invalid plan item status "${status}"`);
  }
  return status as PlanItemStatus;
}

/**
 * 标签/知识点规范化（t1）：逐项 trim → 小写 → **删除全部空白**（'TOGAF 9.2' /
 * 'togaf9.2' / '  togaf 9.2 ' 归一为 'togaf9.2'——同义变体同桶，见设计 §4.2）
 * → 去空串 → 去重（保序）。空数组 → null（与「未标注」同义）。
 * 中文本不受小写/空白规则影响（一般无空格）；英文复合标签连写展示
 * （'data architecture' → 'dataarchitecture'），换取匹配等价性。
 */
export function normalizeLabels(values: readonly string[] | null | undefined): string[] | null {
  if (values === null || values === undefined) return null;
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of values) {
    const label = normalizeQueryLabel(raw);
    if (label.length === 0) continue;
    if (seen.has(label)) continue;
    seen.add(label);
    out.push(label);
  }
  return out.length > 0 ? out : null;
}

/** 查询侧标签/知识点规范化（与 normalizeLabels 完全同规则：trim/小写/去全部空白）。 */
export function normalizeQueryLabel(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, '');
}

const PLAN_ITEM_ACTION_TYPES: readonly string[] = ['practice', 'reviewError', 'read', 'tutor'];

function isPlanItemActionType(value: string): value is PlanItemActionType {
  return (PLAN_ITEM_ACTION_TYPES as readonly string[]).includes(value);
}

function toQuestionRow(raw: Record<string, SQLOutputValue>): QuestionRow {
  return {
    id: String(raw.id),
    bankId: String(raw.bank_id),
    // 运行时 CHECK 允许 'essay'：类型为 StoredQuestionType（不再谎报为客观三型）。
    type: String(raw.type) as StoredQuestionType,
    stem: String(raw.stem),
    options: parseJson<string[]>(raw.options, 'options'),
    answer: parseJson<unknown>(raw.answer, 'answer'),
    explanation: raw.explanation === null ? null : String(raw.explanation),
    tags: raw.tags === null ? null : parseJson<string[]>(raw.tags, 'tags'),
    topics: raw.topics === null || raw.topics === undefined ? null : parseJson<string[]>(raw.topics, 'topics'),
    topicsSource: raw.topics_source === null || raw.topics_source === undefined ? null : String(raw.topics_source),
    createdAt: Number(raw.created_at ?? 0),
    updatedAt: Number(raw.updated_at ?? 0),
    deletedAt: raw.deleted_at === null || raw.deleted_at === undefined ? null : Number(raw.deleted_at),
  };
}

function toAttemptRow(raw: Record<string, SQLOutputValue>): AttemptRow {
  return {
    id: String(raw.id),
    questionId: String(raw.question_id),
    practiceId: raw.practice_id === null ? null : String(raw.practice_id),
    userAnswer: parseJson<unknown>(raw.user_answer, 'userAnswer'),
    isCorrect: Number(raw.is_correct) === 1,
    answeredAt: Number(raw.answered_at),
  };
}

function toPracticeSessionRow(raw: Record<string, SQLOutputValue>): PracticeSessionRow {
  return {
    id: String(raw.id),
    bankId: String(raw.bank_id),
    scope: parseJson<unknown>(raw.scope, 'scope'),
    questionIds: parseJson<string[]>(raw.question_ids, 'questionIds'),
    currentIndex: Number(raw.current_index),
    status: String(raw.status) as PracticeStatus,
    createdAt: Number(raw.created_at ?? 0),
    finishedAt: raw.finished_at === null ? null : Number(raw.finished_at),
  };
}

function toWrongBookRow(raw: Record<string, SQLOutputValue>): WrongBookRow {
  return {
    questionId: String(raw.question_id),
    wrongCount: Number(raw.wrong_count),
    lastWrongAt: raw.last_wrong_at === null ? null : Number(raw.last_wrong_at),
    mastered: Number(raw.mastered) === 1,
    consecutiveCorrect: Number(raw.consecutive_correct ?? 0),
    lastResult: raw.last_result === null || raw.last_result === undefined ? null : Number(raw.last_result) === 1,
    lifetimeWrongCount: Number(raw.lifetime_wrong_count ?? 0),
    masterySource:
      raw.mastery_source === null || raw.mastery_source === undefined ? null : String(raw.mastery_source) as MasterySource,
    // last_answer = 最近一次作答的 user_answer（JSON 序列化）；损坏时按无作答处理（null）
    lastAnswer:
      raw.last_answer === null || raw.last_answer === undefined
        ? null
        : (() => {
            try {
              return JSON.parse(String(raw.last_answer)) as unknown;
            } catch {
              return null;
            }
          })(),
  };
}

// ---------------------------------------------------------------------------
// Phase 2 辅助：行映射
// ---------------------------------------------------------------------------

function toEssayGradingRow(raw: Record<string, SQLOutputValue>): EssayGradingRow {
  return {
    attemptId: String(raw.attempt_id),
    score: Number(raw.score),
    verdict: String(raw.verdict) as GradingVerdict,
    feedback: String(raw.feedback),
    reference: raw.reference === null ? null : String(raw.reference),
    isCorrect: Number(raw.is_correct) === 1,
    model: raw.model === null ? null : String(raw.model),
    provider: raw.provider === null || raw.provider === undefined ? null : String(raw.provider),
    inputTokens: raw.input_tokens === null || raw.input_tokens === undefined ? null : Number(raw.input_tokens),
    outputTokens:
      raw.output_tokens === null || raw.output_tokens === undefined ? null : Number(raw.output_tokens),
    finishReason:
      raw.finish_reason === null || raw.finish_reason === undefined ? null : String(raw.finish_reason),
    createdAt: Number(raw.created_at),
  };
}

function toTutorSessionRow(raw: Record<string, SQLOutputValue>): TutorSessionRow {
  return {
    id: String(raw.id),
    questionId: raw.question_id === null ? null : String(raw.question_id),
    bankId: raw.bank_id === null ? null : String(raw.bank_id),
    status: String(raw.status) as TutorSessionStatus,
    createdAt: Number(raw.created_at),
    updatedAt: Number(raw.updated_at),
    ...(raw.question_stem !== undefined ? { questionStem: raw.question_stem === null ? null : String(raw.question_stem) } : {}),
    ...(raw.first_user_message !== undefined
      ? { firstUserMessage: raw.first_user_message === null ? null : String(raw.first_user_message) }
      : {}),
  };
}

function toTutorMessageRow(raw: Record<string, SQLOutputValue>): TutorMessageRow {
  return {
    id: String(raw.id),
    sessionId: String(raw.session_id),
    role: String(raw.role) as TutorMessageRole,
    content: String(raw.content),
    createdAt: Number(raw.created_at),
    turnId: raw.turn_id === null || raw.turn_id === undefined ? null : String(raw.turn_id),
  };
}

function toStudyPlanRow(raw: Record<string, SQLOutputValue>): StudyPlanRow {
  return {
    id: String(raw.id),
    title: String(raw.title),
    source: String(raw.source) as StudyPlanSource,
    status: String(raw.status) as StudyPlanStatus,
    createdAt: Number(raw.created_at),
    updatedAt: Number(raw.updated_at),
  };
}

function toPlanItemRow(raw: Record<string, SQLOutputValue>): PlanItemRow {
  return {
    id: String(raw.id),
    planId: String(raw.plan_id),
    title: String(raw.title),
    status: String(raw.status) as PlanItemStatus,
    sort: Number(raw.sort),
    createdAt: Number(raw.created_at),
    completedAt: raw.completed_at === null ? null : Number(raw.completed_at),
    note: raw.note === null || raw.note === undefined ? null : String(raw.note),
    actionType:
      raw.action_type === null || raw.action_type === undefined ? null : String(raw.action_type) as PlanItemActionType,
    scope: raw.scope === null || raw.scope === undefined ? null : parseJson<unknown>(raw.scope, 'scope'),
    dueAt: raw.due_at === null || raw.due_at === undefined ? null : Number(raw.due_at),
    priority: Number(raw.priority ?? 0),
    sourceDiagnosisId:
      raw.source_diagnosis_id === null || raw.source_diagnosis_id === undefined
        ? null
        : String(raw.source_diagnosis_id),
  };
}

// ---------------------------------------------------------------------------
// t13 辅助：诊断行映射（宽容解析——损坏 JSON 返回空数组，不阻断读取）
// ---------------------------------------------------------------------------

/** 宽容解析字符串数组（诊断 weaknesses；损坏/形态非法 → []）。 */
function parseDiagnosisStrings(raw: SQLOutputValue | null | undefined): string[] {
  if (raw === null || raw === undefined || typeof raw !== 'string' || raw.length === 0) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((item): item is string => typeof item === 'string');
  } catch {
    return [];
  }
}

/** 宽容解析结构化建议（字符串条目兼容为 { text }；动作形态非法时剥离 action 保留文本）。 */
function parseDiagnosisSuggestions(raw: SQLOutputValue | null | undefined): DiagnosisSuggestionRecord[] {
  if (raw === null || raw === undefined || typeof raw !== 'string' || raw.length === 0) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const out: DiagnosisSuggestionRecord[] = [];
  for (const item of parsed) {
    if (typeof item === 'string') {
      if (item.trim().length > 0) out.push({ text: item });
      continue;
    }
    if (typeof item === 'object' && item !== null && typeof (item as Record<string, unknown>).text === 'string') {
      const record = item as Record<string, unknown>;
      let action: DiagnosisSuggestionAction | undefined;
      const rawAction = record.action;
      if (typeof rawAction === 'object' && rawAction !== null) {
        const candidate = rawAction as Record<string, unknown>;
        const mode = candidate.mode;
        if (mode === 'all' || mode === 'wrong' || mode === 'byType' || mode === 'byTag') {
          action = {
            mode,
            ...(typeof candidate.type === 'string' ? { type: candidate.type } : {}),
            ...(typeof candidate.tag === 'string' ? { tag: candidate.tag } : {}),
          };
        }
      }
      out.push({ text: record.text as string, ...(action !== undefined ? { action } : {}) });
    }
  }
  return out;
}

function toDiagnosisRow(raw: Record<string, SQLOutputValue>): DiagnosisRow {
  return {
    id: String(raw.id),
    summary: String(raw.summary),
    weaknesses: parseDiagnosisStrings(raw.weaknesses),
    suggestions: parseDiagnosisSuggestions(raw.suggestions),
    provider: raw.provider === null || raw.provider === undefined ? null : String(raw.provider),
    model: raw.model === null || raw.model === undefined ? null : String(raw.model),
    createdAt: Number(raw.created_at),
  };
}

// ---------------------------------------------------------------------------
// Phase 4 辅助：行映射
// ---------------------------------------------------------------------------

function toExplanationRow(raw: Record<string, SQLOutputValue>): ExplanationRow {
  return {
    id: String(raw.id),
    questionId: String(raw.question_id),
    answerNorm: String(raw.answer_norm),
    depth: (raw.depth ?? 'light') === 'deep' ? 'deep' : 'light',
    content: String(raw.content),
    model: raw.model === null ? null : String(raw.model),
    provider: raw.provider === null || raw.provider === undefined ? null : String(raw.provider),
    reasoningEffort:
      raw.reasoning_effort === null || raw.reasoning_effort === undefined ? null : String(raw.reasoning_effort),
    promptVersion: Number(raw.prompt_version ?? 1),
    questionUpdatedAt: Number(raw.question_updated_at ?? 0),
    inputTokens: raw.input_tokens === null || raw.input_tokens === undefined ? null : Number(raw.input_tokens),
    outputTokens:
      raw.output_tokens === null || raw.output_tokens === undefined ? null : Number(raw.output_tokens),
    finishReason:
      raw.finish_reason === null || raw.finish_reason === undefined ? null : String(raw.finish_reason),
    createdAt: Number(raw.created_at),
  };
}

// ---------------------------------------------------------------------------
// t5 辅助：Tutor turn / 导入批次 / 草稿 行映射
// ---------------------------------------------------------------------------

function toTutorTurnRow(raw: Record<string, SQLOutputValue>): TutorTurnRow {
  return {
    id: String(raw.id),
    sessionId: String(raw.session_id),
    clientMessageId:
      raw.client_message_id === null || raw.client_message_id === undefined
        ? null
        : String(raw.client_message_id),
    userMessageId: String(raw.user_message_id),
    assistantMessageId:
      raw.assistant_message_id === null || raw.assistant_message_id === undefined
        ? null
        : String(raw.assistant_message_id),
    state: String(raw.state) as TutorTurnState,
    errorCode: raw.error_code === null || raw.error_code === undefined ? null : String(raw.error_code),
    provider: raw.provider === null || raw.provider === undefined ? null : String(raw.provider),
    model: raw.model === null || raw.model === undefined ? null : String(raw.model),
    inputTokens: raw.input_tokens === null || raw.input_tokens === undefined ? null : Number(raw.input_tokens),
    outputTokens:
      raw.output_tokens === null || raw.output_tokens === undefined ? null : Number(raw.output_tokens),
    createdAt: Number(raw.created_at),
    updatedAt: Number(raw.updated_at),
  };
}

function toImportBatchRow(raw: Record<string, SQLOutputValue>): ImportBatchRow {
  return {
    id: String(raw.id),
    bankId: String(raw.bank_id),
    status: 'committed',
    questionIds: parseJson<string[]>(raw.question_ids, 'questionIds'),
    createdAt: Number(raw.created_at),
  };
}

function toImportDraftRow(raw: Record<string, SQLOutputValue>): ImportDraftRow {
  return {
    id: String(raw.id),
    sourceHash: raw.source_hash === null || raw.source_hash === undefined ? null : String(raw.source_hash),
    items: parseJson<unknown[]>(raw.items, 'items'),
    status: String(raw.status) as ImportDraftRow['status'],
    createdAt: Number(raw.created_at),
    updatedAt: Number(raw.updated_at),
  };
}
