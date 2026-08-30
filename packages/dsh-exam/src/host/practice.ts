/**
 * Phase 1 练习引擎：范围解析 / 建会话 / 判分记录 / 成绩单 / 续做 / 错题本。
 *
 * 设计约束：
 * - 不接触 Cordis `ctx`；store 构造注入（可能为 undefined = 降级模式，
 *   此时一切存储操作抛 EXAM_STORE_UNAVAILABLE）。
 * - 全部异常为 ExamServiceError（errors.ts），HTTP 层映射状态码。
 * - 范围解析（resolveQuestionIds）：
 *   - all   ：题库全部题目（store 顺序：created_at ASC, id ASC）
 *   - undone：**从未作答过**的题目（无任何 attempt）
 *   - wrong ：错题本中 wrong_count>0 且未掌握（listWrong 缺省语义）
 *   - byType：按题型筛选；type 缺省/非法 → 回退 all + warn 记录
 *   - byTag ：按 tags 包含筛选；tag 缺省/空 → 回退 all + warn 记录
 * - shuffle：Fisher-Yates；seed 提供时用确定性 PRNG（mulberry32 + djb2 散列）。
 */
import { normalizeQueryLabel, type AttemptRow, type ExamStore, type PracticeSessionRow, type QuestionRow, type WrongBookRow } from './store.ts';
import { ExamServiceError } from './errors.ts';
import { gradeQuestion } from './grading.ts';
import type {
  ExamAttemptDto,
  ExamQuestionDto,
  ExamQuestionType,
  PracticeScopeDto,
  PracticeScopeMode,
  PracticeSessionDto,
  ScorecardDto,
  ScorecardTypeStat,
  WrongEntryDto,
} from './contract.ts';

const SCOPE_MODES: readonly PracticeScopeMode[] = ['all', 'undone', 'wrong', 'byType', 'byTag', 'byTopic'];
const QUESTION_TYPES: readonly ExamQuestionType[] = ['single', 'multiple', 'boolean', 'essay'];

/** 练习引擎。 */
export interface PracticeEngine {
  /** 按范围解析题目 ID 序列（已应用 shuffle）。 */
  resolveQuestionIds(bankId: string, scope: PracticeScopeDto, shuffle?: boolean, seed?: string): string[];
  /** 建会话（bankId 不存在 → EXAM_BANK_NOT_FOUND）。 */
  startPractice(input: {
    bankId: string;
    scope: PracticeScopeDto;
    shuffle?: boolean;
    seed?: string;
    currentIndex?: number;
  }): PracticeSessionDto;
  /** 续做：会话 + 每题最新作答（按会话题目顺序）。 */
  resumePractice(id: string): { practice: PracticeSessionDto; latestAttempts: ExamAttemptDto[] };
  /** 更新进度下标（非负整数）。 */
  updateIndex(id: string, currentIndex: number): PracticeSessionDto;
  /** 删除会话（历史条目移除；attempts 保留）。不存在 → EXAM_PRACTICE_NOT_FOUND。 */
  deletePractice(id: string): void;
  /** 判分 + 记录作答 + 更新错题本。 */
  gradeAnswer(input: { practiceId: string; questionId: string; answer: unknown }): {
    attempt: ExamAttemptDto;
    isCorrect: boolean;
  };
  /** 成绩单（每题最新作答聚合）。 */
  buildScorecard(id: string): ScorecardDto;
  /** 结束会话并返回成绩单（本阶段不做 insight_snapshots，历史即会话行）。 */
  finishPractice(id: string): { practice: PracticeSessionDto; scorecard: ScorecardDto };
  /** 错题列表。 */
  listWrong(options: { bankId?: string; includeMastered?: boolean }): WrongEntryDto[];
  /** 设置/取消掌握标记（题目不存在 → EXAM_QUESTION_NOT_FOUND）。 */
  setMastered(questionId: string, mastered: boolean): WrongEntryDto;
}

export function createPracticeEngine(
  store: ExamStore | undefined,
  warn: (message: string) => void = () => {},
): PracticeEngine {
  return {
    resolveQuestionIds(bankId, scope, shuffle, seed) {
      const s = assertStore(store);
      // 归一化在前：byType/byTag 缺筛选值 → 回退 all + warn（startPractice 同语义）。
      const normalized = normalizeScope(scope, warn);
      let ids: string[];
      if (normalized.questionIds !== undefined) {
        // t9：显式题目集合（错题单题/多选重练）——按给定列表解析，校验存在且属于 bank。
        ids = resolveExplicitQuestionIds(s, bankId, normalized.questionIds);
      } else {
        const questions = s.listQuestionsByBank(bankId);
        const matched = filterByScope(s, bankId, questions, normalized, warn);
        ids = matched.map((q) => q.id);
      }
      return shuffle ? shuffleIds(ids, seed) : ids;
    },

    startPractice(input) {
      const s = assertStore(store);
      requireBank(s, input.bankId);
      const scope = normalizeScope(input.scope, warn);
      const questionIds = this.resolveQuestionIds(input.bankId, scope, input.shuffle, input.seed);
      // t1：空范围不得建 active 空会话（稳定领域错误 EXAM_EMPTY_PRACTICE_SCOPE）。
      if (questionIds.length === 0) {
        throw new ExamServiceError(
          'EXAM_EMPTY_PRACTICE_SCOPE',
          `practice scope ${JSON.stringify(scope)} resolved to zero questions; refuse to create an empty session`,
        );
      }
      const row = s.createPracticeSession({
        bankId: input.bankId,
        scope,
        questionIds,
        currentIndex: input.currentIndex,
      });
      return toPracticeDto(row);
    },

    resumePractice(id) {
      const s = assertStore(store);
      const row = requirePractice(s, id);
      // t1：会话域每题最新作答（practice_id 精确匹配）——跨会话重做不串味。
      const latest = s.listLatestAttemptByPracticeQuestions(row.id, row.questionIds);
      const latestAttempts = row.questionIds
        .map((qid) => latest.get(qid))
        .filter((a): a is AttemptRow => a !== undefined)
        .map(toAttemptDto);
      return { practice: toPracticeDto(row), latestAttempts };
    },

    updateIndex(id, currentIndex) {
      const s = assertStore(store);
      const session = requirePractice(s, id);
      // t1：finished 会话禁止 patch currentIndex（进度只属于 active 会话）。
      if (session.status === 'finished') {
        throw new ExamServiceError(
          'EXAM_PRACTICE_FINISHED',
          `practice session ${id} is finished; currentIndex is immutable after finish`,
        );
      }
      if (!Number.isInteger(currentIndex) || currentIndex < 0) {
        throw new ExamServiceError('EXAM_INVALID_BODY', 'currentIndex must be a non-negative integer');
      }
      return toPracticeDto(s.updatePracticeIndex(id, currentIndex));
    },

    deletePractice(id) {
      const s = assertStore(store);
      if (!s.deletePracticeSession(id)) {
        throw new ExamServiceError('EXAM_PRACTICE_NOT_FOUND', `practice session not found: ${id}`);
      }
    },

    gradeAnswer(input) {
      const s = assertStore(store);
      const session = requirePractice(s, input.practiceId);
      // t1：客观判分禁止 finished 会话继续判分（finished 即定稿）。
      if (session.status === 'finished') {
        throw new ExamServiceError(
          'EXAM_PRACTICE_FINISHED',
          `practice session ${input.practiceId} is finished; no further grading is allowed`,
        );
      }
      // 任务流程：查题 → 判分 → 记录 → 更新错题本；先确认题目存在（已软删除 = 不存在）。
      const question = requireQuestion(s, input.questionId);
      if (!session.questionIds.includes(input.questionId)) {
        throw new ExamServiceError(
          'EXAM_QUESTION_NOT_IN_PRACTICE',
          `question ${input.questionId} is not part of practice ${input.practiceId}`,
        );
      }
      // Phase 2：essay 主观题不走客观判分（无标准答案），必须走批改接口。
      // QuestionRow.type 已含 'essay'（t1 类型修正），不再需要运行时扩宽。
      if (question.type === 'essay') {
        throw new ExamServiceError(
          'EXAM_INVALID_QUESTION',
          `question ${input.questionId} is an essay question; grade it via the essay grading endpoint`,
        );
      }
      const isCorrect = gradeQuestion(question, input.answer).isCorrect;
      // t1：作答 + 错题本同一事务（recordGradedAttempt）。
      const { attempt } = s.recordGradedAttempt({
        questionId: input.questionId,
        practiceId: input.practiceId,
        userAnswer: input.answer,
        isCorrect,
      });
      return { attempt: toAttemptDto(attempt), isCorrect };
    },

    buildScorecard(id) {
      const s = assertStore(store);
      const session = requirePractice(s, id);
      return buildScorecard(s, session);
    },

    finishPractice(id) {
      const s = assertStore(store);
      const session = requirePractice(s, id);
      const row = s.finishPracticeSession(id, session.questionIds);
      const scorecard = buildScorecard(s, session);
      return { practice: toPracticeDto(row), scorecard };
    },

    listWrong(options) {
      return assertStore(store)
        .listWrong(options)
        .map(toWrongDto);
    },

    setMastered(questionId, mastered) {
      const s = assertStore(store);
      requireQuestion(s, questionId);
      return toWrongDto(s.setMastered(questionId, mastered));
    },
  };
}

// ---------------------------------------------------------------------------
// 内部实现
// ---------------------------------------------------------------------------

function assertStore(store: ExamStore | undefined): ExamStore {
  if (store === undefined) {
    throw new ExamServiceError('EXAM_STORE_UNAVAILABLE', 'exam store is not opened');
  }
  return store;
}

function requireBank(store: ExamStore, bankId: string): void {
  if (!store.listBanks().some((b) => b.id === bankId)) {
    throw new ExamServiceError('EXAM_BANK_NOT_FOUND', `bank not found: ${bankId}`);
  }
}

function requirePractice(store: ExamStore, id: string): PracticeSessionRow {
  const row = store.getPracticeSession(id);
  if (row === undefined) {
    throw new ExamServiceError('EXAM_PRACTICE_NOT_FOUND', `practice session not found: ${id}`);
  }
  return row;
}

function requireQuestion(store: ExamStore, id: string): QuestionRow {
  const row = store.getQuestion(id);
  if (row === undefined) {
    throw new ExamServiceError('EXAM_QUESTION_NOT_FOUND', `question not found: ${id}`);
  }
  return row;
}

/**
 * t9：解析显式题目集合（错题单题/多选重练）。按给定列表顺序解析，去重由
 * normalizeQuestionIds 保证；任一 id 不存在或不属于该 bank（含已软删除）→
 * EXAM_QUESTION_NOT_FOUND（整批拒绝）。
 */
function resolveExplicitQuestionIds(store: ExamStore, bankId: string, questionIds: readonly string[]): string[] {
  const bankQuestions = new Map(store.listQuestionsByBank(bankId).map((q) => [q.id, q]));
  const result: string[] = [];
  for (const id of questionIds) {
    if (!bankQuestions.has(id)) {
      throw new ExamServiceError(
        'EXAM_QUESTION_NOT_FOUND',
        `question ${id} does not exist in bank ${bankId}`,
      );
    }
    result.push(id);
  }
  return result;
}

/** 归一化 scope：mode 校验；byType/byTag 缺筛选值时回退 all 并 warn；保存 questionIds（t9）。 */
function normalizeScope(scope: PracticeScopeDto, warn: (message: string) => void): PracticeScopeDto {
  if (typeof scope !== 'object' || scope === null || !isScopeMode(scope.mode)) {
    throw new ExamServiceError('EXAM_INVALID_SCOPE', 'invalid practice scope mode');
  }
  // t9：显式题目集合（错题单题/多选重练）——与 mode 正交，解析时优先按此列表。
  const questionIds = normalizeQuestionIds(scope.questionIds);
  if (questionIds !== undefined) return { mode: scope.mode, questionIds };
  const mode = scope.mode;
  if (mode === 'byType') {
    if (scope.type === undefined || !isQuestionType(scope.type)) {
      warn('practice scope byType without valid type; falling back to all');
      return { mode: 'all' };
    }
    return { mode, type: scope.type };
  }
  if (mode === 'byTag') {
    if (typeof scope.tag !== 'string' || scope.tag.trim().length === 0) {
      warn('practice scope byTag without tag; falling back to all');
      return { mode: 'all' };
    }
    return { mode, tag: normalizeQueryLabel(scope.tag) };
  }
  if (mode === 'byTopic') {
    if (typeof scope.topic !== 'string' || scope.topic.trim().length === 0) {
      warn('practice scope byTopic without topic; falling back to all');
      return { mode: 'all' };
    }
    return { mode, topic: normalizeQueryLabel(scope.topic) };
  }
  return { mode };
}

/** questionIds 归一化：非空字符串数组去重保序；空/非法返回 undefined（回退 mode）。 */
function normalizeQuestionIds(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const ids = value.filter((item): item is string => typeof item === 'string' && item.length > 0);
  if (ids.length === 0) return undefined;
  return [...new Set(ids)];
}

/** 按 scope 过滤题目（undone/wrong 依赖 store 查询）。 */
function filterByScope(
  store: ExamStore,
  bankId: string,
  questions: readonly QuestionRow[],
  scope: PracticeScopeDto,
  warn: (message: string) => void,
): QuestionRow[] {
  switch (scope.mode) {
    case 'all':
      return [...questions];
    case 'undone': {
      const latest = store.listLatestAttemptByQuestion(questions.map((q) => q.id));
      return questions.filter((q) => !latest.has(q.id));
    }
    case 'wrong': {
      const wrongIds = new Set(store.listWrong({ bankId }).map((w) => w.questionId));
      return questions.filter((q) => wrongIds.has(q.id));
    }
    case 'byType':
      return questions.filter((q) => q.type === scope.type);
    case 'byTag': {
      const tag = scope.tag ?? '';
      return questions.filter((q) => q.tags !== null && q.tags.includes(tag));
    }
    case 'byTopic': {
      const topic = scope.topic ?? '';
      return questions.filter((q) => q.topics !== null && q.topics.includes(topic));
    }
    default:
      warn(`unknown scope mode ${String((scope as { mode?: string }).mode)}; falling back to all`);
      return [...questions];
  }
}

function isScopeMode(value: unknown): value is PracticeScopeMode {
  return typeof value === 'string' && (SCOPE_MODES as readonly string[]).includes(value);
}

function isQuestionType(value: unknown): value is ExamQuestionType {
  return typeof value === 'string' && (QUESTION_TYPES as readonly string[]).includes(value);
}

/** Fisher-Yates 洗牌；seed 提供时用确定性 PRNG。 */
export function shuffleIds(ids: readonly string[], seed?: string): string[] {
  const result = [...ids];
  const random = seed === undefined ? Math.random : mulberry32(hashString(seed));
  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    const tmp = result[i]!;
    result[i] = result[j]!;
    result[j] = tmp;
  }
  return result;
}

/** djb2 字符串散列 → uint32。 */
function hashString(text: string): number {
  let hash = 5381;
  for (let i = 0; i < text.length; i++) {
    hash = ((hash << 5) + hash + text.charCodeAt(i)) >>> 0;
  }
  return hash >>> 0;
}

/** mulberry32 PRNG（确定性、可复现）。 */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 成绩单聚合（会话域每题最新作答；已软删除题目仍计入——历史可解释）。 */
function buildScorecard(store: ExamStore, session: PracticeSessionRow): ScorecardDto {
  // t1：会话域最新作答（practice_id 精确匹配），跨会话重做不串味。
  const latest = store.listLatestAttemptByPracticeQuestions(session.id, session.questionIds);
  const total = session.questionIds.length;
  let answered = 0;
  let correct = 0;
  const byType: Record<string, ScorecardTypeStat> = {};

  for (const qid of session.questionIds) {
    // 软删除题目仍参与统计（total/type 稳定）；仅物理缺失时跳过。
    const question = store.getQuestionIncludingDeleted(qid);
    if (question === undefined) continue; // 题目已物理缺失（历史遗留）
    const stat = (byType[question.type] ??= { total: 0, answered: 0, correct: 0, accuracy: 0 });
    stat.total += 1;
    const attempt = latest.get(qid);
    if (attempt !== undefined) {
      answered += 1;
      stat.answered += 1;
      if (attempt.isCorrect) {
        correct += 1;
        stat.correct += 1;
      }
    }
  }

  for (const stat of Object.values(byType)) {
    stat.accuracy = stat.answered === 0 ? 0 : stat.correct / stat.answered;
  }

  return {
    practiceId: session.id,
    total,
    answered,
    correct,
    accuracy: answered === 0 ? 0 : correct / answered,
    byType,
  };
}

function toPracticeDto(row: PracticeSessionRow): PracticeSessionDto {
  return {
    id: row.id,
    bankId: row.bankId,
    scope: normalizeStoredScope(row.scope),
    questionIds: row.questionIds,
    currentIndex: row.currentIndex,
    status: row.status,
    createdAt: row.createdAt,
    finishedAt: row.finishedAt,
  };
}

/** 存储的 scope JSON → 契约 DTO（损坏时保守回退 all；t9 增补 questionIds）。 */
function normalizeStoredScope(raw: unknown): PracticeScopeDto {
  if (typeof raw === 'object' && raw !== null && isScopeMode((raw as { mode?: unknown }).mode)) {
    const scope = raw as PracticeScopeDto;
    const questionIds = normalizeQuestionIds(scope.questionIds);
    if (questionIds !== undefined) return { mode: scope.mode, questionIds };
    if (scope.mode === 'byType' && isQuestionType(scope.type)) return { mode: 'byType', type: scope.type };
    if (scope.mode === 'byTag' && typeof scope.tag === 'string') return { mode: 'byTag', tag: scope.tag };
    return { mode: scope.mode };
  }
  return { mode: 'all' };
}

function toAttemptDto(row: AttemptRow): ExamAttemptDto {
  return {
    id: row.id,
    questionId: row.questionId,
    practiceId: row.practiceId,
    userAnswer: row.userAnswer,
    isCorrect: row.isCorrect,
    answeredAt: row.answeredAt,
  };
}

function toWrongDto(row: WrongBookRow): WrongEntryDto {
  return {
    questionId: row.questionId,
    wrongCount: row.wrongCount,
    lastWrongAt: row.lastWrongAt,
    mastered: row.mastered,
    consecutiveCorrect: row.consecutiveCorrect,
    lastResult: row.lastResult,
    lifetimeWrongCount: row.lifetimeWrongCount,
    masterySource: row.masterySource,
    lastAnswer: row.lastAnswer,
  };
}

/** 领域行 → 题目 DTO（导出供 service.ts 复用）。 */
export function toQuestionDto(row: QuestionRow): ExamQuestionDto {
  return {
    id: row.id,
    bankId: row.bankId,
    type: row.type,
    stem: row.stem,
    options: row.options,
    answer: row.answer,
    explanation: row.explanation,
    tags: row.tags,
    topics: row.topics,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    deletedAt: row.deletedAt,
  };
}
