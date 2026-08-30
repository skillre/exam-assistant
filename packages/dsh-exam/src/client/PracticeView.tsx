/**
 * PracticeView —— 练习流程（Phase 1 + Phase 2 + Phase 4 解析卡）。
 *
 * 步骤：
 * 1. setup：选择题库（必选）+ mode（all/undone/wrong/byType/byTag）+ 可选 type/tag + shuffle 开关 → start；
 *    同页提供「历史与续做」：active 会话续做（resumePractice 恢复进度），finished 会话查看成绩单；
 * 2. session：逐题作答
 *    - 客观题（single / multiple / boolean）→ 提交 gradeAnswer 判分（对/错 + 正确答案 + 解析）
 *      → 判分后静默探测该题缓存解析（命中直接展开；未命中出「✦ AI 解析」按钮，流式生成可取消，
 *      done 后常驻「↻ 重新解析」force 覆盖）→ 下一题；
 *    - essay 主观题 → textarea 作答 → gradeEssay SSE 批改（流式展示 LLM 原文 delta →
 *      完成展示 score/verdict/feedback/reference 卡片）→「已批改」后下一题；不经客观 gradeAnswer
 *      （essay 不渲染 AI 解析卡，批改 feedback/reference 已是深度解析）；
 * 3. scorecard：finish 后展示成绩单（total/answered/correct/accuracy/byType）+ 返回/再练。
 *
 * 题目内容：start/resume 后拉取该题库全部题目，按 id 建索引（契约无单题 GET）。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  explainAnswerSse,
  fetchEssayGrading,
  fetchPracticeExplanation,
  finishPractice,
  getScorecard,
  deletePracticeSession,
  gradeAnswer,
  gradeEssay,
  listPracticeHistory,
  listQuestions,
  patchPracticeIndex,
  resumePractice,
  startPractice,
} from './api.ts';
import type {
  EssayGradingResultDto,
  ExamAttemptDto,
  ExamBankDto,
  ExamErrorDto,
  ExamQuestionDto,
  ExamQuestionType,
  ExplainDepth,
  PracticeHistoryItemDto,
  PracticeScopeDto,
  PracticeScopeMode,
  PracticeSessionDto,
  ScorecardDto,
} from './types.ts';
import { answerText, examErrorMessage, formatTime, identifierToIndex, optionLabel, questionTypeLabel, verdictLabel } from './ui-helpers.ts';
import { StreamingPlaceholder } from './Streaming.tsx';

type Phase = 'setup' | 'session' | 'scorecard';

interface SetupForm {
  bankId: string;
  mode: PracticeScopeMode;
  type: ExamQuestionType;
  tag: string;
  shuffle: boolean;
}

interface GradeState {
  isCorrect: boolean;
  correctAnswerText: string;
  explanation: string | null;
}

/** essay 批改状态机：idle → streaming（delta 原文）→ done（结构化结果）/ error。 */
type EssayGradeState =
  | { phase: 'idle' }
  | { phase: 'streaming'; delta: string }
  | { phase: 'done'; result: EssayGradingResultDto; delta: string }
  | { phase: 'error'; error: ExamErrorDto };

/**
 * AI 解析卡状态机（Phase 4，客观题判分后；essay 不渲染本卡）：
 * - probing：判分结果出现时的静默缓存探测（不渲染，命中直接 done / 未命中国 idle）；
 * - idle：未命中显示「✦ AI 解析」按钮；
 * - streaming：force 或首次生成的流式打字机（可取消，取消零落库）；depth 为本次生成档位；
 * - done：内容固化 + 常驻「↻ 重新解析」（force 重生成原位替换）+ 深档/追问入口；
 * - error：错误码映射文案 + 重试（保留触发时的 force 意图与 depth 档位）。
 */
type ExplainCardState =
  | { phase: 'idle' }
  | { phase: 'probing' }
  | { phase: 'streaming'; delta: string; depth: ExplainDepth }
  | { phase: 'done'; content: string; provider: string | null; model: string | null; reasoningEffort: string | null; depth: ExplainDepth }
  | { phase: 'error'; error: ExamErrorDto; force: boolean; depth: ExplainDepth };

/** 解析卡错误码 → 可读文案（设计 §7.1；未知码原样透传 code+message）。 */
function explainErrorMessage(error: ExamErrorDto): string {
  switch (error.code) {
    case 'EXAM_LLM_NO_PROVIDER':
    case 'EXAM_LLM_UNAVAILABLE':
      return '请先在设置中配置模型';
    case 'EXAM_NOT_GRADED':
      return '该题尚未判分，暂不能查看解析';
    case 'EXAM_INVALID_QUESTION':
      return '该题型不支持 AI 解析';
    case 'EXAM_PRACTICE_NOT_FOUND':
    case 'EXAM_QUESTION_NOT_FOUND':
    case 'EXAM_QUESTION_NOT_IN_PRACTICE':
      return '练习会话已失效或题目不在本题单中';
    case 'EXAM_LLM_STREAM_FAILED':
      return '生成失败：模型连接中断，请重试';
    default:
      // 其余码（含 EXAM_PRACTICE_FINISHED / EXAM_EMPTY_PRACTICE_SCOPE /
      // EXAM_ESSAY_GRADING_NOT_FOUND 等）走共享映射
      return examErrorMessage(error);
  }
}

/** 练习范围 mode → 人类可读（byType/byTag/byTopic 由筛选值细化，见 describePracticeScope）。 */
const SCOPE_MODE_LABELS: Record<PracticeScopeMode, string> = {
  all: '全部题目',
  undone: '未做题目',
  wrong: '错题重练',
  byType: '',
  byTag: '',
  byTopic: '',
};

/**
 * 练习范围 → 人类可读描述（历史条目标题用，替代裸 UUID）：
 * 指定题单 > 显式筛选值 > mode 兜底。
 */
function describePracticeScope(scope: PracticeScopeDto): string {
  if (scope.questionIds !== undefined && scope.questionIds.length > 0) {
    return `指定 ${scope.questionIds.length} 题`;
  }
  switch (scope.mode) {
    case 'byType':
      return `${questionTypeLabel(scope.type ?? 'single')}专项`;
    case 'byTag':
      return `知识点「${scope.tag ?? ''}」`;
    case 'byTopic':
      return `专题「${scope.topic ?? ''}」`;
    default:
      return SCOPE_MODE_LABELS[scope.mode] ?? scope.mode;
  }
}

type SessionQuestionsState =
  | { phase: 'idle' }
  | { phase: 'loading' }
  | { phase: 'error'; error: ExamErrorDto }
  | { phase: 'ready'; byId: Map<string, ExamQuestionDto> };

type HistoryState =
  | { phase: 'loading' }
  | { phase: 'error'; error: ExamErrorDto }
  | { phase: 'ready'; items: PracticeHistoryItemDto[] };

/**
 * 跨模块练习意图（错题本→练习 / 学情→练习）：预填 setup 表单。
 * 兼容性设计：可选 prop，缺省时行为与旧版完全一致（不强制要求 Host 新 API）。
 */
export interface PracticeIntent {
  bankId?: string;
  mode: PracticeScopeMode;
  type?: ExamQuestionType;
  tag?: string;
  /** t10：显式指定题目集合重练（错题单题/多选直达）；给定时按此列表解析，不做 mode 筛选。 */
  questionIds?: string[];
}

export function PracticeView({
  banks,
  onBack,
  initialSetup,
  onAskQuestion,
}: {
  banks: ExamBankDto[];
  onBack: () => void;
  /** 可选：跨模块入口携带的练习预设（如「重练错题」「按薄弱题型练习」）。 */
  initialSetup?: PracticeIntent;
  /** 可选：解析卡「有疑问？与 AI 对话」→ 携带本题跳 AI tab（§3.3）。 */
  onAskQuestion?: (question: ExamQuestionDto, followUp?: string) => void;
}) {
  const [phase, setPhase] = useState<Phase>('setup');
  const [form, setForm] = useState<SetupForm>({ bankId: '', mode: 'all', type: 'single', tag: '', shuffle: true });
  /** t10：跨模块锁定的题目集合（错题单题/多选直达）；给定时范围锁定为显式集合。 */
  const [lockedQuestionIds, setLockedQuestionIds] = useState<string[] | null>(null);
  const [startError, setStartError] = useState<ExamErrorDto | null>(null);
  const [started, setStarted] = useState(false);

  const [practice, setPractice] = useState<PracticeSessionDto | null>(null);
  const [questions, setQuestions] = useState<SessionQuestionsState>({ phase: 'idle' });

  // 作答状态（客观题）
  const [singleChoice, setSingleChoice] = useState<number | null>(null);
  const [multipleChoices, setMultipleChoices] = useState<number[]>([]);
  const [booleanChoice, setBooleanChoice] = useState<boolean | null>(null);
  const [grade, setGrade] = useState<GradeState | null>(null);
  const [grading, setGrading] = useState(false);

  // 作答状态（essay 主观题）
  const [essayAnswer, setEssayAnswer] = useState('');
  const [essayGrade, setEssayGrade] = useState<EssayGradeState>({ phase: 'idle' });

  // AI 解析卡（Phase 4，客观题判分后；独立 AbortController——不与作答/结算共用，
  // 避免历史刷新等操作误杀进行中的解析流）
  const [explain, setExplain] = useState<ExplainCardState>({ phase: 'idle' });
  const explainAbortRef = useRef<AbortController | null>(null);

  const [scorecard, setScorecard] = useState<ScorecardDto | null>(null);
  const [finishing, setFinishing] = useState(false);
  const [finishError, setFinishError] = useState<ExamErrorDto | null>(null);

  /**
   * 本次会话每题最新作答（按题去重；essay 批改成功也会 recordAttempt → attempt 行）。
   * 唯一进度源：已答 = map.size，答对 = isCorrect 计数——与 scorecard/resume 口径一致。
   */
  const [attemptsByQuestion, setAttemptsByQuestion] = useState<Map<string, ExamAttemptDto>>(new Map());
  /** 会话内 essay 批改结果缓存（attemptId → grading；仅回看展示用）。 */
  const [essayGradings, setEssayGradings] = useState<Map<string, EssayGradingResultDto['grading']>>(new Map());
  /** essay 回看异步加载钳制：只允许当前题目的结果落地。 */
  const essayLookupRef = useRef<{ qid: string } | null>(null);

  // 历史与续做
  const [history, setHistory] = useState<HistoryState>({ phase: 'loading' });
  const [historyAction, setHistoryAction] = useState<{ kind: 'resume' | 'scorecard' | 'delete'; id: string } | null>(null);

  const abortRef = useRef<AbortController | null>(null);

  /** 答题导航：默认折叠为一行摘要，展开后限定高度内滚动（大题单不吞整屏）。 */
  const [navExpanded, setNavExpanded] = useState(false);
  const navScrollRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    return () => {
      abortRef.current?.abort();
      explainAbortRef.current?.abort();
    };
  }, []);

  /** 展开（或跳题）时把当前题号滚到视区中部——仅滚动导航容器，不扰动页面。 */
  useEffect(() => {
    if (!navExpanded) return;
    const box = navScrollRef.current;
    if (box === null) return;
    const el = box.querySelector<HTMLElement>('[data-nav-current="true"]');
    if (el === null) return;
    const boxRect = box.getBoundingClientRect();
    const elRect = el.getBoundingClientRect();
    const target = box.scrollTop + (elRect.top - boxRect.top) - (box.clientHeight - elRect.height) / 2;
    box.scrollTop = Math.max(0, target);
  }, [navExpanded, practice?.currentIndex]);

  /**
   * 跨模块意图应用：组件常驻挂载（tab 切换不卸载以保留状态），
   * 故不能用 useState 初始值——新意图对象到达时回到 setup 并预填表单。
   * 意图对象身份变化才触发，用户手动改表单后不会被打扰。
   */
  useEffect(() => {
    if (initialSetup === undefined) return;
    setPhase('setup');
    setPractice(null);
    setStartError(null);
    setLockedQuestionIds(initialSetup.questionIds && initialSetup.questionIds.length > 0 ? initialSetup.questionIds : null);
    setForm({
      bankId: initialSetup.bankId ?? '',
      mode: initialSetup.mode,
      type: initialSetup.type ?? 'single',
      tag: initialSetup.tag ?? '',
      shuffle: true,
    });
  }, [initialSetup]);

  /** bankId → 题库名（历史条目标题）；题库已删除时条目回退「已删除题库」。 */
  const bankNameById = useMemo(() => {
    const map = new Map<string, string>();
    for (const b of banks) map.set(b.id, b.name);
    return map;
  }, [banks]);

  const currentQuestion = useMemo(() => {
    if (practice === null) return null;
    if (questions.phase !== 'ready') return null;
    const id = practice.questionIds[practice.currentIndex];
    return id === undefined ? null : (questions.byId.get(id) ?? null);
  }, [practice, questions]);

  /** 派生进度：已答/答对（按题去重，同题重判不重复计数；与 scorecard 口径一致）。 */
  const sessionProgress = useMemo(() => {
    let answered = 0;
    let correct = 0;
    for (const attempt of attemptsByQuestion.values()) {
      answered += 1;
      if (attempt.isCorrect) correct += 1;
    }
    return { answered, correct };
  }, [attemptsByQuestion]);

  const resetAnswer = () => {
    setSingleChoice(null);
    setMultipleChoices([]);
    setBooleanChoice(null);
    setGrade(null);
    setGrading(false);
    setEssayAnswer('');
    setEssayGrade({ phase: 'idle' });
    // 解析卡随题切换复位；进行中的探测/生成流一并中止（取消零落库语义）
    explainAbortRef.current?.abort();
    setExplain({ phase: 'idle' });
  };

  const loadHistory = useCallback(async () => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setHistory({ phase: 'loading' });
    try {
      const items = await listPracticeHistory(controller.signal);
      setHistory({ phase: 'ready', items });
    } catch (err) {
      setHistory({ phase: 'error', error: err as ExamErrorDto });
    }
  }, []);

  useEffect(() => {
    if (phase === 'setup') void loadHistory();
  }, [phase, loadHistory]);

  const onStart = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (form.bankId.length === 0) {
      setStartError({ code: 'CLIENT_VALIDATION', message: '请选择题库' });
      return;
    }
    if ((form.mode === 'byType' && form.type.length === 0) || (form.mode === 'byTag' && form.tag.trim().length === 0)) {
      setStartError({ code: 'CLIENT_VALIDATION', message: 'byType/byTag 需要填写筛选值' });
      return;
    }
    setStartError(null);
    setStarted(true);
    setQuestions({ phase: 'loading' });
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    try {
      const scope =
        lockedQuestionIds !== null
          ? { mode: 'all' as const, questionIds: lockedQuestionIds }
          : (() => {
              const base: { mode: PracticeScopeMode; type?: ExamQuestionType; tag?: string } = { mode: form.mode };
              if (form.mode === 'byType') base.type = form.type;
              if (form.mode === 'byTag') base.tag = form.tag.trim();
              return base;
            })();
      const p = await startPractice(
        { bankId: form.bankId, scope, shuffle: form.shuffle },
        controller.signal,
      );
      setPractice(p);
      // 拉取题库题目建索引（契约无单题 GET，练习内容按 bank 全量获取）
      const items = await listQuestions(form.bankId, undefined, controller.signal);
      const byId = new Map<string, ExamQuestionDto>();
      for (const q of items) byId.set(q.id, q);
      setQuestions({ phase: 'ready', byId });
      setPhase('session');
      setAttemptsByQuestion(new Map());
      setEssayGradings(new Map());
      resetAnswer();
    } catch (err) {
      setQuestions({ phase: 'error', error: err as ExamErrorDto });
    }
  };

  /** 删除历史条目：仅移除会话（作答保留计入学情/错题本）；删除当前作答中的会话则回到设置页。 */
  const onDelete = async (id: string) => {
    const confirmed = window.confirm(
      `删除练习记录 ${id.slice(0, 8)}…？\n仅移除这条历史（不再可续做）；作答数据保留，错题本与学情统计不受影响。`,
    );
    if (!confirmed) return;
    setHistoryAction({ kind: 'delete', id });
    try {
      await deletePracticeSession(id);
      if (practice?.id === id) {
        setPractice(null);
        setPhase('setup');
      }
      await loadHistory();
    } catch (err) {
      setHistory({ phase: 'error', error: err as ExamErrorDto });
    } finally {
      setHistoryAction(null);
    }
  };

  /** 续做 active 会话：resumePractice 取会话 + 题目索引 → 进入 session。 */
  const onResume = async (id: string) => {
    setHistoryAction({ kind: 'resume', id });
    setStartError(null);
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    try {
      const { practice: p, latestAttempts } = await resumePractice(id, controller.signal);
      const items = await listQuestions(p.bankId, undefined, controller.signal);
      const byId = new Map<string, ExamQuestionDto>();
      for (const q of items) byId.set(q.id, q);
      setPractice(p);
      setQuestions({ phase: 'ready', byId });
      // 续做初始化：每题最新作答（服务端已按题去重）→ 唯一进度源
      const byQuestion = new Map<string, ExamAttemptDto>();
      for (const a of latestAttempts) byQuestion.set(a.questionId, a);
      setAttemptsByQuestion(byQuestion);
      setEssayGradings(new Map());
      setPhase('session');
      resetAnswer();
    } catch (err) {
      setStartError(err as ExamErrorDto);
      void loadHistory();
    } finally {
      setHistoryAction(null);
    }
  };

  /** 查看 finished 会话成绩单（buildScorecard 现成端点）。 */
  const onViewScorecard = async (id: string) => {
    setHistoryAction({ kind: 'scorecard', id });
    setStartError(null);
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    try {
      const sc = await getScorecard(id, controller.signal);
      setScorecard(sc);
      setPhase('scorecard');
    } catch (err) {
      setStartError(err as ExamErrorDto);
    } finally {
      setHistoryAction(null);
    }
  };

  const onSubmitAnswer = async () => {
    if (practice === null || currentQuestion === null || grading) return;
    let answer: unknown;
    if (currentQuestion.type === 'single') {
      if (singleChoice === null) return;
      answer = optionLabel(singleChoice);
    } else if (currentQuestion.type === 'multiple') {
      if (multipleChoices.length === 0) return;
      answer = [...multipleChoices].sort((a, b) => a - b).map((i) => optionLabel(i));
    } else {
      if (booleanChoice === null) return;
      answer = String(booleanChoice);
    }
    setGrading(true);
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    try {
      const { attempt, isCorrect } = await gradeAnswer(
        { practiceId: practice.id, questionId: currentQuestion.id, answer },
        controller.signal,
      );
      setGrade({
        isCorrect,
        correctAnswerText: answerText(currentQuestion),
        explanation: currentQuestion.explanation,
      });
      // 进度单源：按题记录（同题重判 upsert 覆盖，不重复计数——与 scorecard 一致）
      setAttemptsByQuestion((prev) => {
        const next = new Map(prev);
        next.set(currentQuestion.id, attempt);
        return next;
      });
      // 判分即推进服务端位置：此时退出/续做不会重答已答题（末题不推进，避免越界）
      const nextIndex = practice.currentIndex + 1;
      if (nextIndex < practice.questionIds.length) {
        void patchPracticeIndex(practice.id, nextIndex).catch(() => undefined);
      }
    } catch (err) {
      setGrade({ isCorrect: false, correctAnswerText: answerText(currentQuestion), explanation: currentQuestion.explanation });
      setGrading(false);
      // 判分失败不阻断流程：给出可读提示
      const e = err as ExamErrorDto;
      setStartError(e);
      return;
    }
    setGrading(false);
  };

  /** essay 主观题：SSE 批改（delta 流式原文 → done 结构化结果）。 */
  const onSubmitEssay = async () => {
    if (practice === null || currentQuestion === null) return;
    if (essayGrade.phase === 'streaming' || essayGrade.phase === 'done') return;
    const answer = essayAnswer.trim();
    if (answer.length === 0) return;
    setEssayGrade({ phase: 'streaming', delta: '' });
    setStartError(null);
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    await gradeEssay(
      { questionId: currentQuestion.id, practiceId: practice.id, userAnswer: answer },
      {
        onDelta: (delta) => {
          setEssayGrade((prev) => ({
            phase: 'streaming',
            delta: prev.phase === 'streaming' ? prev.delta + delta : delta,
          }));
        },
        onDone: (result) => {
          setEssayGrade((prev) => ({
            phase: 'done',
            result,
            delta: prev.phase === 'streaming' ? prev.delta : '',
          }));
          // 进度单源：essay 批改成功即 recordAttempt——本地按题记录（重批不重复计数）
          setAttemptsByQuestion((prev) => {
            const next = new Map(prev);
            next.set(currentQuestion.id, {
              id: result.attemptId,
              questionId: currentQuestion.id,
              practiceId: practice.id,
              userAnswer: answer,
              isCorrect: result.grading.isCorrect,
              answeredAt: Date.now(),
            });
            return next;
          });
          setEssayGradings((prev) => new Map(prev).set(result.attemptId, result.grading));
          // 批改即推进服务端位置（防续做重答；末题不推进）
          const nextIndex = practice.currentIndex + 1;
          if (nextIndex < practice.questionIds.length) {
            void patchPracticeIndex(practice.id, nextIndex).catch(() => undefined);
          }
        },
        onError: (error) => {
          setEssayGrade({ phase: 'error', error });
        },
      },
      { signal: controller.signal },
    );
  };

  const onCancelEssay = () => {
    abortRef.current?.abort();
    // streamSse 回调 onError(EXAM_LLM_ABORTED) → 状态落到 error，可重试
  };

  // ── Phase 4：AI 解析卡 ────────────────────────────────────────────────────

  // 判分结果出现时静默探测缓存：命中直接展开 done（无需用户点击），未命中回 idle
  // 显示按钮。essay 不进 P 形态；探测失败（网络/409 等）静默降级为按钮态，不阻塞作答。
  useEffect(() => {
    if (practice === null || currentQuestion === null || grade === null) return;
    if (currentQuestion.type === 'essay') return;
    const controller = new AbortController();
    explainAbortRef.current = controller;
    setExplain({ phase: 'probing' });
    fetchPracticeExplanation(practice.id, currentQuestion.id, 'light', controller.signal)
      .then((explanation) => {
        if (controller.signal.aborted) return;
        setExplain(
          explanation
            ? {
                phase: 'done',
                content: explanation.content,
                provider: explanation.provider,
                model: explanation.model,
                reasoningEffort: explanation.reasoningEffort,
                depth: explanation.depth,
              }
            : { phase: 'idle' },
        );
      })
      .catch(() => {
        if (controller.signal.aborted) return;
        setExplain({ phase: 'idle' });
      });
  }, [grade, practice, currentQuestion]);

  /** 启动解析流式生成；force=true = 「重新解析」（跳过缓存，覆盖同键旧行）；depth 为生成档位（缺省 light）。 */
  const startExplain = (force: boolean, depth: ExplainDepth = 'light') => {
    if (practice === null || currentQuestion === null) return;
    // 重新解析取消/失败时旧内容原样保留：先捕获当前 done 内容用于恢复
    const prevDone =
      explain.phase === 'done'
        ? {
            content: explain.content,
            provider: explain.provider,
            model: explain.model,
            reasoningEffort: explain.reasoningEffort,
            depth: explain.depth,
          }
        : null;
    explainAbortRef.current?.abort();
    const controller = new AbortController();
    explainAbortRef.current = controller;
    setExplain({ phase: 'streaming', delta: '', depth });
    const requestBase = { practiceId: practice.id, questionId: currentQuestion.id, depth };
    void explainAnswerSse(
      force ? { ...requestBase, force: true } : requestBase,
      {
        onDelta: (delta) => {
          setExplain((prev) => ({
            phase: 'streaming',
            depth: prev.phase === 'streaming' ? prev.depth : depth,
            delta: prev.phase === 'streaming' ? prev.delta + delta : delta,
          }));
        },
        onDone: (result) => {
          setExplain({
            phase: 'done',
            content: result.content,
            provider: result.provider ?? null,
            model: result.model ?? null,
            reasoningEffort: result.reasoningEffort ?? null,
            depth: result.depth ?? depth,
          });
        },
        onError: (error) => {
          if (error.code === 'EXAM_LLM_ABORTED') {
            // 取消零落库（设计 §5）：首次取消回按钮态；重新解析取消则旧内容不动
            setExplain((prev) =>
              prev.phase === 'streaming'
                ? prevDone !== null
                  ? { phase: 'done', ...prevDone }
                  : { phase: 'idle' }
                : prev,
            );
            return;
          }
          setExplain({ phase: 'error', error, force, depth });
        },
      },
      controller.signal,
    );
  };

  const onCancelExplain = () => {
    explainAbortRef.current?.abort();
    // EXAM_LLM_ABORTED 静默语义：不展示错误，回到按钮态 / 恢复旧内容（见 startExplain）
  };

  /**
   * 答题导航跳转：已答题 → 只读回看（判分结果/批改卡/解析卡探测），并恢复
   * **历史作答选择**用于标记「当时选了哪个」（输入保持只读，不产生新作答）；
   * 未答题 → 可作答。currentIndex 同步服务端（patch 幂等）。
   */
  const gotoQuestion = (index: number) => {
    if (practice === null) return;
    if (index < 0 || index >= practice.questionIds.length) return;
    const qid = practice.questionIds[index]!;
    setPractice({ ...practice, currentIndex: index });
    void patchPracticeIndex(practice.id, index).catch(() => undefined);
    // 与 resetAnswer 等效的作答重置（不清 attempts/gradings）
    explainAbortRef.current?.abort();
    setExplain({ phase: 'idle' });
    setSingleChoice(null);
    setMultipleChoices([]);
    setBooleanChoice(null);
    setEssayAnswer('');
    setGrading(false);
    const attempt = attemptsByQuestion.get(qid);
    const question = questions.phase === 'ready' ? (questions.byId.get(qid) ?? null) : null;
    if (attempt !== undefined && question !== null) {
      if (question.type === 'essay') {
        const cached = essayGradings.get(attempt.id);
        if (cached !== undefined) {
          setEssayGrade({ phase: 'done', result: { attemptId: attempt.id, grading: cached }, delta: '' });
        } else {
          // 续做场景本地无缓存：按 attemptId 查询批改结果
          setEssayGrade({ phase: 'idle' });
          essayLookupRef.current = { qid };
          void fetchEssayGrading(attempt.id)
            .then((grading) => {
              if (essayLookupRef.current?.qid !== qid) return; // 已被跳走
              setEssayGradings((prev) => new Map(prev).set(attempt.id, grading));
              setEssayGrade({ phase: 'done', result: { attemptId: attempt.id, grading }, delta: '' });
            })
            .catch(() => {
              if (essayLookupRef.current?.qid !== qid) return;
              setEssayGrade({ phase: 'idle' }); // 拉取失败：该题可重新批改
            });
        }
      } else {
        setGrade({
          isCorrect: attempt.isCorrect,
          correctAnswerText: answerText(question),
          explanation: question.explanation,
        });
        // 恢复历史选择（grade 已锁输入 → 只读展示；错选行标红、选中态保留）
        if (question.type === 'single') {
          setSingleChoice(identifierToIndex(attempt.userAnswer));
        } else if (question.type === 'multiple' && Array.isArray(attempt.userAnswer)) {
          setMultipleChoices(
            attempt.userAnswer
              .map((value) => identifierToIndex(value))
              .filter((value): value is number => value !== null),
          );
        } else if (question.type === 'boolean') {
          setBooleanChoice(attempt.userAnswer === true || attempt.userAnswer === 'true');
        }
      }
    } else {
      setGrade(null);
      setEssayGrade({ phase: 'idle' });
    }
  };

  const onNext = async () => {
    if (practice === null) return;
    const nextIndex = practice.currentIndex + 1;
    const finished = nextIndex >= practice.questionIds.length;
    if (!finished) {
      // 本地推进 + 尽力同步 currentIndex（失败不阻断作答）
      setPractice({ ...practice, currentIndex: nextIndex });
      void patchPracticeIndex(practice.id, nextIndex).catch(() => undefined);
    } else {
      await onFinish();
    }
    resetAnswer();
  };

  const onFinish = async () => {
    if (practice === null) return;
    setFinishing(true);
    setFinishError(null);
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    try {
      const { scorecard: sc } = await finishPractice(practice.id, controller.signal);
      setScorecard(sc);
      setPhase('scorecard');
    } catch (err) {
      setFinishError(err as ExamErrorDto);
    } finally {
      setFinishing(false);
    }
  };

  // ── setup ──
  if (phase === 'setup') {
    const historyItems = history.phase === 'ready' ? history.items : [];
    const active = historyItems.filter((item) => item.practice.status === 'active');
    const finished = historyItems.filter((item) => item.practice.status === 'finished');
    return (
      <div className="exam-assistant-workspace">
        <div>
          <button type="button" className="exam-assistant-button exam-assistant-button--ghost" onClick={onBack}>
            ← 返回
          </button>
          <h2 className="exam-assistant-workspace__headline">练习</h2>
          <p className="exam-assistant-workspace__subtitle">选择范围后开始逐题作答</p>
        </div>

        <form className="exam-assistant-card exam-assistant-question-form" onSubmit={(event) => void onStart(event)}>
          <div className="exam-assistant-form-row">
            <label className="exam-assistant-form-label" htmlFor="exam-p-bank">
              题库（必选）
            </label>
            <select
              id="exam-p-bank"
              className="exam-assistant-input"
              value={form.bankId}
              onChange={(event) => setForm((prev) => ({ ...prev, bankId: event.target.value }))}
            >
              <option value="">请选择…</option>
              {banks.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.name}
                </option>
              ))}
            </select>
          </div>

          <div className="exam-assistant-form-row">
            <label className="exam-assistant-form-label" htmlFor="exam-p-mode">
              范围
            </label>
            <select
              id="exam-p-mode"
              className="exam-assistant-input"
              value={form.mode}
              disabled={lockedQuestionIds !== null}
              onChange={(event) => setForm((prev) => ({ ...prev, mode: event.target.value as PracticeScopeMode }))}
            >
              <option value="all">全部题目</option>
              <option value="undone">未做过</option>
              <option value="wrong">错题</option>
              <option value="byType">按题型</option>
              <option value="byTag">按标签</option>
            </select>
          </div>
          {lockedQuestionIds !== null ? (
            <p className="exam-assistant-status exam-assistant-status--ok" role="status">
              <span className="exam-assistant-status__dot" aria-hidden="true" />
              将重练指定的 {lockedQuestionIds.length} 道题（范围已锁定，无需手动调整）
            </p>
          ) : null}

          {form.mode === 'byType' ? (
            <div className="exam-assistant-form-row">
              <label className="exam-assistant-form-label" htmlFor="exam-p-type">
                题型
              </label>
              <select
                id="exam-p-type"
                className="exam-assistant-input"
                value={form.type}
                onChange={(event) => setForm((prev) => ({ ...prev, type: event.target.value as ExamQuestionType }))}
              >
                <option value="single">单选</option>
                <option value="multiple">多选</option>
                <option value="boolean">判断</option>
                <option value="essay">主观</option>
              </select>
            </div>
          ) : null}

          {form.mode === 'byTag' ? (
            <div className="exam-assistant-form-row">
              <label className="exam-assistant-form-label" htmlFor="exam-p-tag">
                标签
              </label>
              <input
                id="exam-p-tag"
                className="exam-assistant-input"
                value={form.tag}
                onChange={(event) => setForm((prev) => ({ ...prev, tag: event.target.value }))}
                placeholder="如：高数"
              />
            </div>
          ) : null}

          <div className="exam-assistant-form-row">
            <label className="exam-assistant-form-label" htmlFor="exam-p-shuffle">
              打乱顺序
            </label>
            <input
              id="exam-p-shuffle"
              type="checkbox"
              checked={form.shuffle}
              onChange={(event) => setForm((prev) => ({ ...prev, shuffle: event.target.checked }))}
            />
          </div>

          {startError ? (
            <p className="exam-assistant-error" role="alert">
              {examErrorMessage(startError)}
            </p>
          ) : null}

          <div className="exam-assistant-form-actions">
            <button type="submit" className="exam-assistant-button" disabled={started && questions.phase === 'loading'}>
              {started && questions.phase === 'loading' ? '启动中…' : '开始练习'}
            </button>
          </div>
        </form>

        {/* 历史与续做 */}
        <section className="exam-assistant-card" aria-label="历史与续做">
          <div className="exam-assistant-row">
            <h3 className="exam-assistant-card__title">历史与续做</h3>
            <button type="button" className="exam-assistant-button exam-assistant-button--ghost" onClick={() => void loadHistory()}>
              刷新
            </button>
          </div>
          {history.phase === 'loading' ? (
            <div className="exam-assistant-skeleton">正在读取练习历史…</div>
          ) : history.phase === 'error' ? (
            <p className="exam-assistant-error">{examErrorMessage(history.error)}</p>
          ) : historyItems.length === 0 ? (
            <p className="exam-assistant-empty">暂无练习记录 —— 使用上方表单开始第一次练习</p>
          ) : (
            <div>
              {active.length > 0 ? (
                <div className="exam-assistant-history-group">
                  <p className="exam-assistant-history-group__title">进行中（可续做）</p>
                  <ul className="exam-assistant-history-list">
                    {active.map((item) => (
                      <li key={item.practice.id} className="exam-assistant-history-item">
                        <div className="exam-assistant-history-item__main">
                          <span className="exam-assistant-history-item__title">
                            {bankNameById.get(item.practice.bankId) ?? '已删除题库'} · {describePracticeScope(item.practice.scope)}
                          </span>
                          <span className="exam-assistant-history-item__meta">
                            第 {item.practice.currentIndex + 1}/{item.practice.questionIds.length} 题 ·
                            已答 {item.answeredCount} · 开始于 {formatTime(item.practice.createdAt)}
                          </span>
                        </div>
                        <div className="exam-assistant-history-item__actions">
                          <button
                            type="button"
                            className="exam-assistant-button exam-assistant-button--sm"
                            disabled={historyAction?.kind === 'resume' && historyAction.id === item.practice.id}
                            onClick={() => void onResume(item.practice.id)}
                          >
                            {historyAction?.kind === 'resume' && historyAction.id === item.practice.id ? '恢复中…' : '续做'}
                          </button>
                          <button
                            type="button"
                            className="exam-assistant-button exam-assistant-button--sm exam-assistant-button--danger"
                            disabled={historyAction?.id === item.practice.id}
                            onClick={() => void onDelete(item.practice.id)}
                          >
                            删除
                          </button>
                        </div>
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}
              {finished.length > 0 ? (
                <div className="exam-assistant-history-group">
                  <p className="exam-assistant-history-group__title">已结束（查看成绩单）</p>
                  <ul className="exam-assistant-history-list">
                    {finished.map((item) => (
                      <li key={item.practice.id} className="exam-assistant-history-item">
                        <div className="exam-assistant-history-item__main">
                          <span className="exam-assistant-history-item__title">
                            {bankNameById.get(item.practice.bankId) ?? '已删除题库'} · {describePracticeScope(item.practice.scope)}
                          </span>
                          <span className="exam-assistant-history-item__meta">
                            正确率 {item.scorecard ? `${(item.scorecard.accuracy * 100).toFixed(0)}%` : '—'} ·
                            结束于 {formatTime(item.practice.finishedAt)}
                          </span>
                        </div>
                        <div className="exam-assistant-history-item__actions">
                          <button
                            type="button"
                            className="exam-assistant-button exam-assistant-button--sm"
                            disabled={historyAction?.kind === 'scorecard' && historyAction.id === item.practice.id}
                            onClick={() => void onViewScorecard(item.practice.id)}
                          >
                            {historyAction?.kind === 'scorecard' && historyAction.id === item.practice.id ? '读取中…' : '成绩单'}
                          </button>
                          <button
                            type="button"
                            className="exam-assistant-button exam-assistant-button--sm exam-assistant-button--danger"
                            disabled={historyAction?.id === item.practice.id}
                            onClick={() => void onDelete(item.practice.id)}
                          >
                            删除
                          </button>
                        </div>
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}
            </div>
          )}
        </section>
      </div>
    );
  }

  // ── session ──
  if (phase === 'session') {
    if (practice === null) return null;
    if (questions.phase === 'loading') return <div className="exam-assistant-skeleton">正在准备练习…</div>;
    if (questions.phase === 'error') {
      return (
        <div className="exam-assistant-workspace">
          <p className="exam-assistant-error" role="alert">
            {examErrorMessage(questions.error)}
          </p>
          <button type="button" className="exam-assistant-button exam-assistant-button--ghost" onClick={() => setPhase('setup')}>
            返回设置
          </button>
        </div>
      );
    }
    if (currentQuestion === null) {
      return <div className="exam-assistant-empty">练习中没有可作答的题目（可能范围为空）。</div>;
    }

    const q = currentQuestion;
    // 判分后标色：正确答案选项下标（single/multiple）；boolean 由 answer 布尔值判定。
    const correctIdxSet = new Set<number>();
    if (q.type === 'single') {
      const i = identifierToIndex(q.answer);
      if (i !== null && i >= 0) correctIdxSet.add(i);
    } else if (q.type === 'multiple' && Array.isArray(q.answer)) {
      for (const id of q.answer) {
        const i = identifierToIndex(id);
        if (i !== null && i >= 0) correctIdxSet.add(i);
      }
    }
    const correctBool = q.type === 'boolean' ? q.answer === 'true' || q.answer === true : null;
    /** 客观题选项行状态：判分后 correct/wrong，作答中 selected。 */
    const rowState = (isCorrect: boolean, chosen: boolean): string => {
      if (grade !== null) {
        if (isCorrect) return ' exam-assistant-answer-row--correct';
        if (chosen) return ' exam-assistant-answer-row--wrong';
        return '';
      }
      return chosen ? ' exam-assistant-answer-row--selected' : '';
    };
    const pct = (sessionProgress.answered / Math.max(1, practice.questionIds.length)) * 100;
    const accuracy = sessionProgress.answered > 0 ? Math.round((sessionProgress.correct / sessionProgress.answered) * 100) : null;
    return (
      <div className="exam-assistant-workspace">
        {/* 固定栏（§5.3 P0）：合并「退出+meta / 进度条 / 答题导航头」为吸顶容器；
            展开的导航滚动区留在文档流，仅头部吸顶（不吞滚动内容）。 */}
        <div className="exam-assistant-practice-sticky">
          <div className="exam-assistant-row">
            <button type="button" className="exam-assistant-button exam-assistant-button--ghost" onClick={onBack}>
              ← 退出练习
            </button>
            <span className="exam-assistant-llm__meta">
              第 {practice.currentIndex + 1} / {practice.questionIds.length} 题 · 已答 {sessionProgress.answered} 题 · 开始于 {formatTime(practice.createdAt)}
            </span>
          </div>

          {/* 顶部进度条：答题 n/N + 正确率 */}
          <div
            className="exam-assistant-practice-progress"
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={practice.questionIds.length}
            aria-valuenow={sessionProgress.answered}
            aria-label="练习进度"
          >
            <div className="exam-assistant-practice-progress__head">
              <span className="exam-assistant-practice-progress__label">
                答题 {sessionProgress.answered} / {practice.questionIds.length}
              </span>
              <span className="exam-assistant-practice-progress__label">正确率 {accuracy !== null ? `${accuracy}%` : '—'}</span>
            </div>
            <div className="exam-assistant-practice-progress__track">
              <div
                className="exam-assistant-practice-progress__fill"
                style={{ '--exam-assistant-progress': pct } as React.CSSProperties}
              />
            </div>
          </div>

          {/* 答题导航头（仅头部固定；展开的滚动区在下方文档流独立滚动） */}
          <div className="exam-assistant-practice-nav" role="group" aria-label="答题导航">
            <div className="exam-assistant-practice-nav__head">
              <span className="exam-assistant-practice-nav__title">答题导航</span>
              <span className="exam-assistant-practice-nav__summary">
                第 {practice.currentIndex + 1} / {practice.questionIds.length} 题 · 已答 {sessionProgress.answered} 题
              </span>
              <button
                type="button"
                className="exam-assistant-practice-nav__toggle"
                aria-expanded={navExpanded}
                aria-controls="exam-practice-nav-scroll"
                onClick={() => setNavExpanded((v) => !v)}
              >
                {navExpanded ? '收起' : '展开'}
              </button>
            </div>
          </div>
        </div>

        {/* 展开的答题导航滚动区：在文档流内随内容滚动（不受吸顶影响） */}
        {navExpanded ? (
          <div
            id="exam-practice-nav-scroll"
            className="exam-assistant-practice-nav__scroll"
            ref={navScrollRef}
            role="group"
            aria-label="全部题号（可滚动）"
          >
            <div className="exam-assistant-practice-nav__grid">
              {practice.questionIds.map((qid, i) => {
                const attempt = attemptsByQuestion.get(qid);
                const isCurrent = i === practice.currentIndex;
                const stateClass = isCurrent
                  ? ' exam-assistant-practice-nav__dot--current'
                  : attempt !== undefined
                    ? attempt.isCorrect
                      ? ' exam-assistant-practice-nav__dot--correct'
                      : ' exam-assistant-practice-nav__dot--wrong'
                    : '';
                return (
                  <button
                    key={qid}
                    type="button"
                    className={`exam-assistant-practice-nav__dot${stateClass}`}
                    data-nav-current={isCurrent ? 'true' : undefined}
                    aria-current={isCurrent ? 'true' : undefined}
                    aria-label={`第 ${i + 1} 题${attempt !== undefined ? (attempt.isCorrect ? '（已答对）' : '（已答错）') : '（未答）'}`}
                    onClick={() => gotoQuestion(i)}
                  >
                    {i + 1}
                  </button>
                );
              })}
            </div>
          </div>
        ) : null}

        <section className="exam-assistant-card exam-assistant-quiz-card" aria-label={`第 ${practice.currentIndex + 1} 题`}>
          <div className="exam-assistant-row">
            <h3 className="exam-assistant-card__title">
              {questionTypeLabel(q.type)}题
            </h3>
            <span className="exam-assistant-tags">
              {(q.tags ?? []).map((tag) => (
                <span key={tag} className="exam-assistant-tag">
                  {tag}
                </span>
              ))}
            </span>
          </div>
          <p className="exam-assistant-question-stem">{q.stem}</p>

          {/* ── essay 主观题：textarea + SSE 批改 ── */}
          {q.type === 'essay' ? (
            <div>
              <div className="exam-assistant-form-row">
                <label className="exam-assistant-form-label" htmlFor="exam-p-essay">
                  你的作答
                </label>
                <textarea
                  id="exam-p-essay"
                  className="exam-assistant-input exam-assistant-essay-answer"
                  rows={6}
                  value={essayAnswer}
                  onChange={(event) => setEssayAnswer(event.target.value)}
                  disabled={essayGrade.phase === 'streaming' || essayGrade.phase === 'done'}
                  placeholder="输入你的作答内容…（提交后由 AI 批改）"
                />
              </div>

              {essayGrade.phase === 'idle' ? (
                <div className="exam-assistant-form-actions">
                  <button
                    type="button"
                    className="exam-assistant-button"
                    disabled={essayAnswer.trim().length === 0}
                    onClick={() => void onSubmitEssay()}
                  >
                    提交批改
                  </button>
                </div>
              ) : essayGrade.phase === 'streaming' ? (
                <div>
                  <p className="exam-assistant-llm__meta">AI 批改中…（流式原文）</p>
                  {essayGrade.delta === '' ? (
                    <StreamingPlaceholder />
                  ) : (
                    <pre className="exam-assistant-llm__output exam-assistant-llm__output--streaming" aria-live="polite">
                      {essayGrade.delta}
                    </pre>
                  )}
                  <div className="exam-assistant-form-actions">
                    <button type="button" className="exam-assistant-button exam-assistant-button--ghost" onClick={onCancelEssay}>
                      取消批改
                    </button>
                  </div>
                </div>
              ) : essayGrade.phase === 'done' ? (
                <div>
                  <p className="exam-assistant-status exam-assistant-status--ok" role="status">
                    <span className="exam-assistant-status__dot" aria-hidden="true" />
                    已批改 · {essayGrade.result.grading.score} 分 · {verdictLabel(essayGrade.result.grading.verdict)}
                    {essayGrade.result.grading.isCorrect ? '（判定为掌握）' : ''}
                  </p>
                  <div className="exam-assistant-grading-card">
                    <div className="exam-assistant-grading-card__score">
                      <div
                        className="exam-assistant-ring"
                        style={{ '--exam-assistant-ring-value': essayGrade.result.grading.score } as React.CSSProperties}
                      >
                        <div className="exam-assistant-ring__inner">
                          <span className="exam-assistant-grading-card__score-num">{essayGrade.result.grading.score}</span>
                        </div>
                      </div>
                      <span className="exam-assistant-grading-card__score-label">/ 100 分</span>
                    </div>
                    <div className="exam-assistant-grading-card__body">
                      <p className="exam-assistant-grading-card__feedback">{essayGrade.result.grading.feedback}</p>
                      {essayGrade.result.grading.reference ? (
                        <p className="exam-assistant-grading-card__reference">
                          <span className="exam-assistant-kv__key">参考答案要点</span>
                          <span className="exam-assistant-kv__value">{essayGrade.result.grading.reference}</span>
                        </p>
                      ) : null}
                    </div>
                  </div>
                  {essayGrade.delta ? (
                    <details className="exam-assistant-grading-raw">
                      <summary>AI 批改原文</summary>
                      <pre className="exam-assistant-llm__output">{essayGrade.delta}</pre>
                    </details>
                  ) : null}
                  <div className="exam-assistant-form-actions">
                    {practice.currentIndex + 1 < practice.questionIds.length ? (
                      <button type="button" className="exam-assistant-button" onClick={() => void onNext()}>
                        下一题 →
                      </button>
                    ) : (
                      <button type="button" className="exam-assistant-button" onClick={() => void onNext()} disabled={finishing}>
                        {finishing ? '结算中…' : '完成练习'}
                      </button>
                    )}
                  </div>
                </div>
              ) : (
                <div>
                  <p className="exam-assistant-error" role="alert">
                    {examErrorMessage(essayGrade.error)}
                  </p>
                  <div className="exam-assistant-form-actions">
                    <button type="button" className="exam-assistant-button" onClick={() => setEssayGrade({ phase: 'idle' })}>
                      重试批改
                    </button>
                  </div>
                </div>
              )}
            </div>
          ) : q.type === 'boolean' ? (
            <div className="exam-assistant-option-list">
              <label className={`exam-assistant-answer-row${rowState(correctBool === true, booleanChoice === true)}`}>
                <input
                  type="radio"
                  name="exam-p-bool"
                  checked={booleanChoice === true}
                  onChange={() => setBooleanChoice(true)}
                  disabled={grade !== null}
                />
                对
              </label>
              <label className={`exam-assistant-answer-row${rowState(correctBool === false, booleanChoice === false)}`}>
                <input
                  type="radio"
                  name="exam-p-bool"
                  checked={booleanChoice === false}
                  onChange={() => setBooleanChoice(false)}
                  disabled={grade !== null}
                />
                错
              </label>
            </div>
          ) : (
            <div className="exam-assistant-option-list">
              {q.options.map((opt, i) =>
                q.type === 'single' ? (
                  <label key={i} className={`exam-assistant-answer-row${rowState(correctIdxSet.has(i), singleChoice === i)}`}>
                    <input
                      type="radio"
                      name="exam-p-single"
                      checked={singleChoice === i}
                      onChange={() => setSingleChoice(i)}
                      disabled={grade !== null}
                    />
                    <span className="exam-assistant-answer-row__label">{optionLabel(i)}.</span> {opt}
                  </label>
                ) : (
                  <label key={i} className={`exam-assistant-answer-row${rowState(correctIdxSet.has(i), multipleChoices.includes(i))}`}>
                    <input
                      type="checkbox"
                      checked={multipleChoices.includes(i)}
                      onChange={() =>
                        setMultipleChoices((prev) =>
                          prev.includes(i) ? prev.filter((x) => x !== i) : [...prev, i],
                        )
                      }
                      disabled={grade !== null}
                    />
                    <span className="exam-assistant-answer-row__label">{optionLabel(i)}.</span> {opt}
                  </label>
                ),
              )}
            </div>
          )}

          {/* ── 客观题判分结果 ── */}
          {q.type !== 'essay' && grade !== null ? (
            <div>
              <p
                className={
                  grade.isCorrect
                    ? 'exam-assistant-status exam-assistant-status--ok'
                    : 'exam-assistant-status exam-assistant-status--err'
                }
                role="status"
              >
                <span className="exam-assistant-status__dot" aria-hidden="true" />
                {grade.isCorrect ? '回答正确' : '回答错误'} · 正确答案：{grade.correctAnswerText}
              </p>
              {grade.explanation ? <p className="exam-assistant-llm__meta">解析：{grade.explanation}</p> : null}

              {/* ── Phase 4：AI 解析卡（probing 静默不渲染；essay 已在外层排除） ── */}
              {explain.phase !== 'probing' ? (
                <div className="exam-assistant-explain">
                  {explain.phase === 'done' || explain.phase === 'streaming' ? (
                    <div className="exam-assistant-explain__head">
                      <span className="exam-assistant-explain__title">
                        <span className="exam-assistant-explain__glyph" aria-hidden="true">✦</span>
                        AI 解析
                      </span>
                      {explain.phase === 'done' ? (
                        <span className={`exam-assistant-depth-badge exam-assistant-depth-badge--${explain.depth}`}>
                          {explain.depth === 'deep' ? '深入讲解' : '浅层解析'}
                        </span>
                      ) : null}
                    </div>
                  ) : null}
                  {explain.phase === 'idle' ? (
                    <div className="exam-assistant-explain__actions">
                      {/* 答错 → 主张位置强调（最需要）；答对 → 次级（补强理解） */}
                      <button
                        type="button"
                        className={
                          grade.isCorrect
                            ? 'exam-assistant-button exam-assistant-button--ghost'
                            : 'exam-assistant-button'
                        }
                        onClick={() => startExplain(false)}
                      >
                        ✦ AI 解析
                      </button>
                      <span className="exam-assistant-explain__meta">
                        {grade.isCorrect ? '已答对 · 生成解析补强理解' : '针对你的作答生成个性化解析'}
                      </span>
                    </div>
                  ) : explain.phase === 'streaming' ? (
                    <>
                      <p className="exam-assistant-explain__meta">
                        {explain.depth === 'deep' ? '深入讲解生成中…' : 'AI 解析生成中…'}
                      </p>
                      {explain.delta === '' ? (
                        <StreamingPlaceholder />
                      ) : (
                        <pre className="exam-assistant-explain__content exam-assistant-explain__content--streaming" aria-live="polite">
                          {explain.delta}
                        </pre>
                      )}
                      <div className="exam-assistant-explain__actions">
                        <button
                          type="button"
                          className="exam-assistant-button exam-assistant-button--ghost exam-assistant-button--sm"
                          onClick={onCancelExplain}
                        >
                          取消生成
                        </button>
                      </div>
                    </>
                  ) : explain.phase === 'done' ? (
                    <>
                      <pre className="exam-assistant-explain__content" aria-live="polite">
                        {explain.content}
                      </pre>
                      <p className="exam-assistant-explain__meta">
                        供应商 {explain.provider ?? '—'} · 模型 {explain.model ?? '—'} · 思考{' '}
                        {explain.reasoningEffort ?? '默认'}
                      </p>
                      <div className="exam-assistant-explain__actions">
                        {explain.depth === 'light' ? (
                          <>
                            <button
                              type="button"
                              className="exam-assistant-button exam-assistant-button--ghost exam-assistant-button--sm"
                              onClick={() => startExplain(true, 'deep')}
                            >
                              ⚡ 深入讲解
                            </button>
                            <span className="exam-assistant-explain__meta">深入讲解消耗较高，将生成完整推理链</span>
                          </>
                        ) : null}
                        <button
                          type="button"
                          className="exam-assistant-button exam-assistant-button--ghost exam-assistant-button--sm"
                          onClick={() => startExplain(true, explain.depth)}
                        >
                          {explain.depth === 'deep' ? '↻ 重新解析（深入）' : '↻ 重新解析'}
                        </button>
                        {onAskQuestion ? (
                          <button
                            type="button"
                            className="exam-assistant-button exam-assistant-button--ghost exam-assistant-button--sm"
                            onClick={() => onAskQuestion(q)}
                          >
                            💬 有疑问？与 AI 对话
                          </button>
                        ) : null}
                      </div>
                    </>
                  ) : (
                    <>
                      <p className="exam-assistant-error" role="alert">
                        {explainErrorMessage(explain.error)}
                      </p>
                      <div className="exam-assistant-explain__actions">
                        <button
                          type="button"
                          className="exam-assistant-button exam-assistant-button--sm"
                          onClick={() => startExplain(explain.force, explain.depth)}
                        >
                          重试
                        </button>
                      </div>
                    </>
                  )}
                </div>
              ) : null}

              {startError ? (
                <p className="exam-assistant-error" role="alert">
                  {examErrorMessage(startError)}
                </p>
              ) : null}
              <div className="exam-assistant-form-actions">
                {practice.currentIndex + 1 < practice.questionIds.length ? (
                  <button type="button" className="exam-assistant-button" onClick={() => void onNext()}>
                    下一题 →
                  </button>
                ) : (
                  <button type="button" className="exam-assistant-button" onClick={() => void onNext()} disabled={finishing}>
                    {finishing ? '结算中…' : '完成练习'}
                  </button>
                )}
              </div>
            </div>
          ) : q.type !== 'essay' && grade === null ? (
            <div className="exam-assistant-form-actions">
              <button
                type="button"
                className="exam-assistant-button"
                disabled={
                  grading ||
                  (q.type === 'single' && singleChoice === null) ||
                  (q.type === 'multiple' && multipleChoices.length === 0) ||
                  (q.type === 'boolean' && booleanChoice === null)
                }
                onClick={() => void onSubmitAnswer()}
              >
                {grading ? '判分中…' : '提交答案'}
              </button>
            </div>
          ) : null}
        </section>

        {finishError ? (
          <p className="exam-assistant-error" role="alert">
            {examErrorMessage(finishError)}
          </p>
        ) : null}
      </div>
    );
  }

  // ── scorecard ──
  if (scorecard === null) return null;
  const typeRows = Object.entries(scorecard.byType).sort(([a], [b]) => a.localeCompare(b));
  return (
    <div className="exam-assistant-workspace">
      <div>
        <h2 className="exam-assistant-workspace__headline">练习完成 · 成绩单</h2>
        <p className="exam-assistant-workspace__subtitle">practice {scorecard.practiceId}</p>
      </div>

      <section className="exam-assistant-card" aria-label="成绩单">
        <div className="exam-assistant-scorecard-grid">
          <div className="exam-assistant-scorecard-cell">
            <span className="exam-assistant-scorecard-cell__num">{scorecard.total}</span>
            <span className="exam-assistant-scorecard-cell__label">总题数</span>
          </div>
          <div className="exam-assistant-scorecard-cell">
            <span className="exam-assistant-scorecard-cell__num">{scorecard.answered}</span>
            <span className="exam-assistant-scorecard-cell__label">已答</span>
          </div>
          <div className="exam-assistant-scorecard-cell">
            <span className="exam-assistant-scorecard-cell__num">{scorecard.correct}</span>
            <span className="exam-assistant-scorecard-cell__label">正确</span>
          </div>
          <div className="exam-assistant-scorecard-cell">
            <span className="exam-assistant-scorecard-cell__num">{(scorecard.accuracy * 100).toFixed(0)}%</span>
            <span className="exam-assistant-scorecard-cell__label">正确率</span>
          </div>
        </div>

        {typeRows.length > 0 ? (
          <table className="exam-assistant-table">
            <thead>
              <tr>
                <th>题型</th>
                <th>总题</th>
                <th>已答</th>
                <th>正确</th>
                <th>正确率</th>
              </tr>
            </thead>
            <tbody>
              {typeRows.map(([type, stat]) => (
                <tr key={type}>
                  <td>{questionTypeLabel(type as ExamQuestionType)}</td>
                  <td>{stat.total}</td>
                  <td>{stat.answered}</td>
                  <td>{stat.correct}</td>
                  <td>{(stat.accuracy * 100).toFixed(0)}%</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : null}

        <div className="exam-assistant-form-actions">
          <button
            type="button"
            className="exam-assistant-button"
            onClick={() => {
              setPhase('setup');
              setPractice(null);
              setQuestions({ phase: 'idle' });
              setScorecard(null);
            }}
          >
            再练一次
          </button>
          <button type="button" className="exam-assistant-button exam-assistant-button--ghost" onClick={onBack}>
            返回
          </button>
        </div>
      </section>
    </div>
  );
}
