// 贯通前后端的共享类型（@exam/shared）。前后端禁止各自私定义，一律从此处 import。

// ── 题目与作答 ──────────────────────────────────────────────
export type QuestionType = "single" | "multiple" | "boolean";

/** 作答/正确答案的取值：单选=选项 index；多选=index 数组；判断=布尔 */
export type AnswerValue = number | number[] | boolean;

export type QuestionSource = "paste-ai" | "file";

export interface Question {
	id: string;
	bankId: string;
	type: QuestionType;
	stem: string;
	options: string[];
	answer: AnswerValue;
	explanation?: string;
	tags?: string[];
	source?: QuestionSource;
	createdAt: number;
}

/** 导入草稿：尚未入库、无 id/bankId */
export type QuestionDraft = Omit<Question, "id" | "bankId" | "createdAt">;

export interface Attempt {
	id: string;
	questionId: string;
	userAnswer: AnswerValue;
	isCorrect: boolean;
	answeredAt: number;
}

export interface Bank {
	id: string;
	name: string;
	createdAt: number;
}

/** v2 题库管理：列表附带题目数 */
export interface BankWithCount extends Bank {
	questionCount: number;
}

// ── v2：题库/题目管理 API 契约 ──────────────────────
export interface CreateBankRequest {
	name: string;
}
export interface RenameBankRequest {
	name: string;
}
/** 新增/编辑单题的载荷（等同一条草稿） */
export type QuestionUpsert = QuestionDraft;

export type MoveCopyOp = "move" | "copy";
export interface MoveCopyRequest {
	questionIds: string[];
	targetBankId: string;
	op: MoveCopyOp;
}
export type TagApplyMode = "add" | "replace";
export interface ApplyTagsRequest {
	questionIds: string[];
	tags: string[];
	mode: TagApplyMode;
}
/** 批量操作的通用回显：实际影响条数 */
export interface AffectedCountResponse {
	affected: number;
}

// ── 判分 API 契约 ───────────────────────────────────────────
export interface GradeRequest {
	questionId: string;
	userAnswer: AnswerValue;
}

/** attemptId = 新落库 attempt 的 id，供 tutor/explain 关联作答（评审 #4） */
export interface GradeResponse {
	attemptId: string;
	isCorrect: boolean;
	correctAnswer: AnswerValue;
	// v3：判分后是否刚触发掌握达标（可选——P0-2 graded 端点不构造此字段）
	mastered?: boolean;
}

// ── 导入 API 契约 ───────────────────────────────────────────
export interface ParseTextRequest {
	text: string;
}
export interface ParseResult {
	questions: QuestionDraft[];
}
export interface ImportCommitRequest {
	bankId?: string;
	bankName?: string;
	questions: QuestionDraft[];
}
export interface ImportCommitResponse {
	bankId: string;
	count: number;
}

// ── 学情分析（Phase 7 LearningDataCollector 产出） ──────────
export interface WeakTag {
	tag: string;
	wrong: number;
	total: number;
}
export interface LearningSnapshot {
	totalAttempts: number;
	accuracy: number; // 0..1
	weakTags: WeakTag[];
	tutorHighlights: string[]; // 从答疑 JSONL 提炼的要点
}

// ── 模型 / Provider（DEC-19/20：前端全管，Key 加密存后端，永不回传） ──
export interface ModelInfo {
	providerId: string;
	modelId: string;
	name: string;
}

export interface ProviderModel {
	id: string;
	name: string;
}

/** 对外暴露的 provider：configured 取代明文 Key（DEC-19） */
export interface Provider {
	id: string;
	name: string;
	baseUrl: string;
	api: string; // 如 'openai-completions'
	models: ProviderModel[];
	configured: boolean; // 是否已存 Key（不回传明文）
	createdAt: number;
}

/** 写入用：apiKey 仅新建/改 Key 时携带；编辑时省略则保持原 Key */
export interface ProviderUpsert {
	name: string;
	baseUrl: string;
	api: string;
	models: ProviderModel[];
	apiKey?: string;
}

export interface ActiveModelSelection {
	providerId: string;
	modelId: string;
}

// ── v2：练习会话（范围/筛选/乱序/进度/成绩单） ─────────────
export type PracticeMode = "all" | "undone" | "wrong" | "byType" | "byTag";

export interface PracticeScope {
	bankId: string;
	mode: PracticeMode;
	type?: QuestionType; // mode=byType
	tag?: string; // mode=byTag
	shuffle?: boolean;
}

export interface PracticeSession {
	id: string;
	bankId: string;
	questionIds: string[]; // 定序后的题目 id 列表（乱序也已定序落库）
	currentIndex: number;
	scope: PracticeScope;
	createdAt: number;
}

export interface StartPracticeRequest {
	scope: PracticeScope;
}
export interface UpdatePracticeRequest {
	currentIndex: number;
}

/** 成绩单：一套练习结束的汇总（每题取最新一次作答） */
export interface Scorecard {
	sessionId: string;
	total: number;
	answered: number;
	correct: number;
	accuracy: number; // 0..1
	byType: { type: QuestionType; total: number; correct: number }[];
	byTag: { tag: string; total: number; correct: number }[];
	wrongQuestionIds: string[];
}

/** 练习会话已答判分：questionId → 最新作答（含 correctAnswer/answeredAt，供续做恢复完整判分态，P0-2） */
export type PracticeGraded = Record<
	string,
	GradeResponse & { answeredAt: number }
>;

// ── v2：错题本增强 ─────────────────────────────────────────
export interface WrongBookItem {
	question: Question;
	wrongCount: number;
	lastWrongAt: number;
	mastered: boolean;
}

export interface WrongBookQuery {
	bankId?: string;
	type?: QuestionType;
	tag?: string;
	includeMastered?: boolean;
}

export interface MasterRequest {
	mastered: boolean;
}

// ── v2：导入校验 ───────────────────────────────────────────
export interface DraftValidationIssue {
	index: number;
	ok: boolean;
	errors: string[];
}
// ── v2：Provider 连通性测试（DEC-27：Key 绝不回传） ────────
export interface ConnTestResult {
	ok: boolean;
	message: string;
	latencyMs?: number;
}

// ── SSE 事件协议（统一 delta | done | error） ──────────────
export type SseEvent =
	| { type: "delta"; text: string }
	| { type: "done" }
	| { type: "error"; message: string };

// ── v3：掌握判定（DEC-32 — consecutive streak） ─────────────
export interface MasteryState {
	questionId: string;
	consecutiveCorrect: number;
	mastered: boolean;
	updatedAt?: number;
}

// ── v3：学情快照（FR4 — 时间序列，DEC-30 落库） ─────────────
export interface TagStat {
	tag: string;
	total: number;
	correct: number;
}

export interface TypeStat {
	type: QuestionType;
	total: number;
	correct: number;
}

export interface InsightSnapshot {
	id: string;
	sessionId: string;
	bankId: string;
	total: number;
	correct: number;
	accuracy: number;
	byTag: TagStat[];
	byType: TypeStat[];
	createdAt: number;
}

// ── v3：学习计划 / 任务（FR2 — DEC-31，两表） ───────────────
export type TaskStatus = 'pending' | 'in_progress' | 'done';
export type PlanStatus = 'active' | 'completed' | 'archived';

export interface LearningPlan {
	id: string;
	bankId: string | null; // null = 全局计划（学情页"全部题库"范围生成）
	title: string;
	description?: string;
	phases: AiPhase[];
	status: PlanStatus;
	createdAt: number;
}

export interface LearningTask {
	id: string;
	planId: string;
	title: string;
	phaseIndex: number;
	sortOrder: number;
	scope: PracticeScope;
	status: TaskStatus;
	createdAt: number;
	completedAt?: number;
}

// ── v3：深度错因诊断（FR1 — DEC-33，固定枚举，扁平单题） ───
export type ErrorCategory =
	| 'concept_confusion'
	| 'calculation_error'
	| 'misread'
	| 'knowledge_gap';

export interface DiagnosisResult {
	questionId: string;
	stem: string;
	userAnswer: string; // AI 产出的选项文本（如 "B. xxx"）
	correctAnswer: string;
	errorCategory: ErrorCategory;
	distractorNote?: string;
}

// ── v3：AI 产出（计划生成，内部用） ─────────────────────────
export interface AiPhase {
	title: string;
	description?: string;
	tasks: AiTask[];
}

export interface AiTask {
	title: string;
	scope: PracticeScope;
}

export interface AiPlan {
	title: string;
	description?: string;
	phases: AiPhase[];
}

// ── v3：趋势（FR4 前端消费，Slice0 对账 T3/T4） ─────────────
export interface TrendPoint {
	ts: number;
	accuracy: number;
	total: number;
}

export interface TagTrendPoint {
	ts: number;
	tag: string;
	accuracy: number;
	total: number;
}

export interface TrendHistoryResponse {
	overall: TrendPoint[];
	byTag: TagTrendPoint[];
}

// ── v3：API 请求 / 响应 ────────────────────────────────────
/** 练习完成（Slice0 对账 T1）：快照落库 + 成绩单 */
export interface FinishPracticeResponse {
	scorecard: Scorecard;
	snapshotId: string;
}

export interface SnapshotHistoryQuery {
	bankId?: string;
	limit?: number;
}

export interface CoachGenerateRequest {
	bankId?: string;
}

export interface UpdateTaskRequest {
	status: TaskStatus;
}
