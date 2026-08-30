/**
 * Phase 2 学情洞察（insights.ts）：纯统计聚合，不依赖 LLM。
 *
 * 设计约束（Phase 2 设计 §3 + t13 优化）：
 * - 全部从 store 现有方法聚合（attempts 全量扫 + JS 分组；不做 SQL 聚合扩展）；
 * - 趋势窗口可选（7/14/30 天，service 层校验），按尝试 answered_at 归日，
 *   key 用本地日期字符串 'YYYY-MM-DD'（含空档日）；
 * - 可选 bankId 维度过滤：题库池与作答都收敛到该题库（对比/覆盖率/薄弱同步收敛）；
 * - 薄弱判定 = 相对阈值 + 样本量门槛：accuracy < max(整体正确率 − 15pp, 60%) 且
 *   answered ≥ 3，按正确率升序取 Top 5（避免「2 次全错登顶」与「全员薄弱」两个极端）；
 * - 返回纯 JSON DTO（InsightSummary，contract.ts），不接触 live 对象。
 */
import type { ExamStore } from './store.ts';
import type { InsightSummary, ScorecardTypeStat } from './contract.ts';

/** 趋势窗口缺省天数。 */
const DEFAULT_WINDOW_DAYS = 7;
/** 趋势窗口允许值（service 层校验，这里仅兜底）。 */
export const INSIGHT_WINDOW_DAYS = [7, 14, 30] as const;
const WRONG_TOP_N = 10;
/** 薄弱判定的最小采样（作答次数）——低于该样本不参与薄弱判定。 */
const WEAK_MIN_SAMPLE = 3;
/** 薄弱相对阈值：比整体正确率低至少该比例。 */
const WEAK_REL_DELTA = 0.15;
/** 薄弱绝对下限：整体正确率很低时阈值不随之失速（保底 60%）。 */
const WEAK_ABS_FLOOR = 0.6;
/** 薄弱清单上限（按正确率升序截断）。 */
const WEAK_TOP_N = 5;

/** 薄弱聚合输入行（题型/标签/知识点三维共用）。 */
interface WeakSampleRow {
  key: string;
  answered: number;
  correct: number;
  accuracy: number;
}

/**
 * 通用薄弱判定：样本达门槛且正确率低于阈值（相对整体 −15pp，保底 60%），
 * 按正确率升序取 Top N；并列按 key 字典序保证确定性。
 */
function pickWeakRows(rows: WeakSampleRow[], overallAccuracy: number, topN = WEAK_TOP_N): WeakSampleRow[] {
  const threshold = Math.max(overallAccuracy - WEAK_REL_DELTA, WEAK_ABS_FLOOR);
  return rows
    .filter((row) => row.answered >= WEAK_MIN_SAMPLE && row.accuracy < threshold)
    .sort((a, b) => a.accuracy - b.accuracy || a.key.localeCompare(b.key))
    .slice(0, topN);
}

/**
 * 从 store 聚合学情摘要（纯函数；store 数据为空时返回全零摘要）。
 * opts.windowDays：趋势窗口天数（缺省 7）；opts.bankId：题库维度过滤（缺省全部活跃题库）。
 */
export function buildInsightSummary(
  store: ExamStore,
  opts?: { windowDays?: number; bankId?: string | null },
): InsightSummary {
  const windowDays = opts?.windowDays ?? DEFAULT_WINDOW_DAYS;
  const bankId = typeof opts?.bankId === 'string' && opts.bankId.length > 0 ? opts.bankId : null;

  // 可用题目池：活跃题库的活跃题目（与默认列表/练习/错题选择器口径一致）；
  // 指定 bankId 时收敛到单库。
  const activeBanks = store.listBanks().filter((bank) => bankId === null || bank.id === bankId);
  const questions = activeBanks.flatMap((bank) => store.listQuestionsByBank(bank.id));
  const questionById = new Map(questions.map((question) => [question.id, question]));
  const poolIds = new Set(questionById.keys());
  const inPool = (questionId: string): boolean => poolIds.has(questionId);

  // 作答流：仅统计池内题目的作答（bankId 过滤时排除他库作答）。
  const attempts = store.listAllAttempts().filter((attempt) => inPool(attempt.questionId));

  // 总答题数 / 正确数 / 正确率
  const totalAttempts = attempts.length;
  const correctAttempts = attempts.filter((attempt) => attempt.isCorrect).length;
  const accuracy = totalAttempts === 0 ? 0 : correctAttempts / totalAttempts;

  // 趋势窗口（本地日期，含空档日）
  const byDate = new Map<string, { total: number; correct: number }>();
  for (const attempt of attempts) {
    const key = localDateKey(attempt.answeredAt);
    const bucket = byDate.get(key) ?? { total: 0, correct: 0 };
    bucket.total += 1;
    if (attempt.isCorrect) bucket.correct += 1;
    byDate.set(key, bucket);
  }
  const daily: InsightSummary['daily'] = [];
  const now = new Date();
  for (let offset = windowDays - 1; offset >= 0; offset--) {
    const day = new Date(now.getFullYear(), now.getMonth(), now.getDate() - offset);
    const key = localDateKey(day.getTime());
    const bucket = byDate.get(key);
    daily.push({ date: key, total: bucket?.total ?? 0, correct: bucket?.correct ?? 0 });
  }

  // 连续学习天数：从今天往前数连续有作答的天数；今天还没学则从昨天起算
  // （「昨天学了今天还没学」不打断 streak，避免白天查看时恒为 0）。
  let streakDays = 0;
  {
    const startOffset = byDate.has(localDateKey(now.getTime())) ? 0 : 1;
    for (let offset = startOffset; ; offset++) {
      const day = new Date(now.getFullYear(), now.getMonth(), now.getDate() - offset);
      if (byDate.has(localDateKey(day.getTime()))) {
        streakDays += 1;
      } else {
        break;
      }
      if (offset > 3650) break; // 防御：约 10 年上限
    }
  }

  // 按题型聚合：total=题目数，answered/correct=作答数（essay 作答同样计入）。
  const byType: Record<string, ScorecardTypeStat> = {};
  for (const question of questions) {
    const key = question.type;
    const stat = byType[key] ?? { total: 0, answered: 0, correct: 0, accuracy: 0 };
    stat.total += 1;
    byType[key] = stat;
  }
  for (const attempt of attempts) {
    const key = questionById.get(attempt.questionId)?.type ?? 'unknown';
    const stat = byType[key] ?? { total: 0, answered: 0, correct: 0, accuracy: 0 };
    stat.answered += 1;
    if (attempt.isCorrect) stat.correct += 1;
    byType[key] = stat;
  }
  for (const stat of Object.values(byType)) {
    stat.accuracy = stat.answered === 0 ? 0 : stat.correct / stat.answered;
  }

  // 错题 Top10（wrong_count 降序；附 stem 摘要 / 最近错误时间 / 所属题库 / 知识点）。
  const wrongTop = store
    .listWrong({ includeMastered: true })
    .filter((entry) => inPool(entry.questionId))
    .sort((a, b) => b.wrongCount - a.wrongCount)
    .slice(0, WRONG_TOP_N)
    .map((entry) => {
      const question = questionById.get(entry.questionId);
      const topics =
        question !== undefined && question.topics !== null && question.topics.length > 0
          ? [...question.topics]
          : question !== undefined && question.tags !== null && question.tags.length > 0
            ? [...question.tags]
            : [];
      return {
        questionId: entry.questionId,
        bankId: question?.bankId ?? '',
        wrongCount: entry.wrongCount,
        lastWrongAt: entry.lastWrongAt,
        stem: question?.stem ?? '',
        topics,
      };
    });

  // 练习次数（finished 会话数）。
  const finishedPractices = store.countFinishedPractices();

  // ── 薄弱判定（相对阈值 + 样本门槛；题型/标签/知识点三维同规则）──────────

  // 题型：作答数 > 0 的题型进入判定；返回 key 列表（客户端可从 byType 取采样数）。
  const typeRows: WeakSampleRow[] = Object.entries(byType)
    .filter(([, stat]) => stat.answered > 0)
    .map(([key, stat]) => ({ key, answered: stat.answered, correct: stat.correct, accuracy: stat.accuracy }));
  const weakTypes = pickWeakRows(typeRows, accuracy).map((row) => row.key);

  // 标签维度：按题目 tags 聚合作答（一题多标签各计一次）。
  const tagStat = new Map<string, { answered: number; correct: number }>();
  const topicStat = new Map<string, { answered: number; correct: number }>();
  for (const attempt of attempts) {
    const question = questionById.get(attempt.questionId);
    if (question === undefined) continue;
    const tags = question.tags;
    if (tags !== null && tags !== undefined && tags.length > 0) {
      for (const tag of tags) {
        const bucket = tagStat.get(tag) ?? { answered: 0, correct: 0 };
        bucket.answered += 1;
        if (attempt.isCorrect) bucket.correct += 1;
        tagStat.set(tag, bucket);
      }
    }
    const topics = question.topics;
    if (topics !== null && topics.length > 0) {
      for (const topic of topics) {
        const bucket = topicStat.get(topic) ?? { answered: 0, correct: 0 };
        bucket.answered += 1;
        if (attempt.isCorrect) bucket.correct += 1;
        topicStat.set(topic, bucket);
      }
    }
  }
  const weakTags = pickWeakRows(
    [...tagStat.entries()].map(([key, stat]) => ({
      key,
      answered: stat.answered,
      correct: stat.correct,
      accuracy: stat.answered === 0 ? 0 : stat.correct / stat.answered,
    })),
    accuracy,
  ).map((row) => ({ tag: row.key, answered: row.answered, correct: row.correct, accuracy: row.accuracy }));

  // 知识点维度（口径同 weakTags；供讲解/练习/下钻优先消费）。
  const weakTopics = pickWeakRows(
    [...topicStat.entries()].map(([key, stat]) => ({
      key,
      answered: stat.answered,
      correct: stat.correct,
      accuracy: stat.answered === 0 ? 0 : stat.correct / stat.answered,
    })),
    accuracy,
  ).map((row) => ({ topic: row.key, answered: row.answered, correct: row.correct, accuracy: row.accuracy }));

  // ── 掌握 / 覆盖 / 窗口正确率 ──────────────────────────────────────────

  // 首次作答正确率：attempts 已按 answered_at ASC 排序，首次出现的 questionId 即首答。
  const attemptedIds = new Set<string>();
  const firstCorrect = new Map<string, boolean>();
  for (const attempt of attempts) {
    if (!attemptedIds.has(attempt.questionId)) {
      attemptedIds.add(attempt.questionId);
      firstCorrect.set(attempt.questionId, attempt.isCorrect);
    }
  }
  const attemptedCount = attemptedIds.size;
  const firstAttemptAccuracy =
    attemptedCount === 0 ? 0 : [...firstCorrect.values()].filter((value) => value).length / attemptedCount;

  // 当前掌握率（每题最新一次作答正确率）：listLatestAttemptByQuestion 取每题最新（answered_at DESC, rowid DESC）。
  const latestByQuestion = store.listLatestAttemptByQuestion([...poolIds]);
  const masteredLatest = [...latestByQuestion.values()].filter((attempt) => attempt.isCorrect).length;
  const currentMastery = attemptedCount === 0 ? 0 : masteredLatest / attemptedCount;

  // 覆盖度：已作答唯一题数 / 可用题数。
  const coverage = questions.length === 0 ? 0 : attemptedCount / questions.length;

  // 窗口正确率：daily（windowDays 天）汇总口径。
  const totalWindow = daily.reduce((sum, d) => sum + d.total, 0);
  const correctWindow = daily.reduce((sum, d) => sum + d.correct, 0);
  const accuracyWindow = totalWindow === 0 ? 0 : correctWindow / totalWindow;

  return {
    windowDays,
    totalAttempts,
    correctAttempts,
    accuracy,
    daily,
    byType,
    wrongTop,
    finishedPractices,
    weakTypes,
    firstAttemptAccuracy,
    currentMastery,
    coverage,
    accuracyWindow,
    streakDays,
    weakTags,
    weakTopics,
  };
}

/** epoch 毫秒 → 本地日期字符串 'YYYY-MM-DD'（本时区归日）。 */
export function localDateKey(ms: number): string {
  const date = new Date(ms);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}
