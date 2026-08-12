// 贯通前后端的共享类型（@exam/shared）。前后端禁止各自私定义，一律从此处 import。

// ── 题目与作答 ──────────────────────────────────────────────
export type QuestionType = 'single' | 'multiple' | 'boolean';

/** 作答/正确答案的取值：单选=选项 index；多选=index 数组；判断=布尔 */
export type AnswerValue = number | number[] | boolean;

export type QuestionSource = 'paste-ai' | 'file';

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
export type QuestionDraft = Omit<Question, 'id' | 'bankId' | 'createdAt'>;

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

export type MoveCopyOp = 'move' | 'copy';
export interface MoveCopyRequest {
  questionIds: string[];
  targetBankId: string;
  op: MoveCopyOp;
}
export type TagApplyMode = 'add' | 'replace';
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
export type PracticeMode = 'all' | 'undone' | 'wrong' | 'byType' | 'byTag';

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

/** 练习会话已答判分：questionId → 最新作答（含 correctAnswer，供续做恢复完整判分态，P0-2） */
export type PracticeGraded = Record<string, GradeResponse>;

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
export interface ValidateDraftsRequest {
  questions: QuestionDraft[];
}
export interface ValidateDraftsResponse {
  results: DraftValidationIssue[];
}

// ── v2：Provider 连通性测试（DEC-27：Key 绝不回传） ────────
export interface ConnTestResult {
  ok: boolean;
  message: string;
  latencyMs?: number;
}

// ── SSE 事件协议（统一 delta | done | error） ──────────────
export type SseEvent =
  | { type: 'delta'; text: string }
  | { type: 'done' }
  | { type: 'error'; message: string };
