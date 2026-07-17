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

// ── SSE 事件协议（统一 delta | done | error） ──────────────
export type SseEvent =
  | { type: 'delta'; text: string }
  | { type: 'done' }
  | { type: 'error'; message: string };
