/**
 * Insights —— 学情 tab（Phase 2 + t13 仪表盘重构）。
 *
 * - 洞察：指标分组（练习量 / 正确率 / 进度，带口径提示与近窗口差值）、可选趋势窗口
 *   （7/14/30 天）与题库维度过滤、连续学习天数、题型准确率（弱项行内直达练习）、
 *   薄弱知识点/标签（可下钻展开该维度的错题清单：重练单题 / 问 AI / 跳错题本）、
 *   错题 Top10（含最近错误时间与知识点 chips，点击定位错题本）；
 * - AI 诊断：结果持久化（t13），历史可回看；结构化建议携带可执行 action（直达练习）；
 * - 学习计划：列表 + 条目勾选/删除、计划删除（t13）、AI 生成（进行中计划时确认）、
 *   手动新建（默认折叠）。
 *
 * 下钻数据为客户端聚合：listWrong（全库）× 各题库 listQuestions 建索引，
 * 按维度（topic/tag）过滤错题——题量级（单机学习工具）下开销可接受。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  addPlanItems,
  createManualPlan,
  deletePlan,
  deletePlanItem,
  diagnoseInsight,
  generatePlan,
  getInsight,
  getPlan,
  listDiagnoses,
  listPlans,
  listQuestions,
  listWrong,
  setPlanItemDone,
} from './api.ts';
import type {
  DiagnosisDto,
  DiagnosisRecordDto,
  DiagnosisSuggestionActionDto,
  ExamBankDto,
  ExamErrorDto,
  ExamQuestionDto,
  ExamQuestionType,
  InsightSummary,
  PlanDto,
  PlanItemActionType,
  PlanItemDto,
  PlanItemStatus,
  PlanWithItemsDto,
  PracticeScopeMode,
  WrongEntryDto,
} from './types.ts';
import { examErrorMessage, formatTime, questionTypeLabel } from './ui-helpers.ts';

type InsightState =
  | { phase: 'loading' }
  | { phase: 'error'; error: ExamErrorDto }
  | { phase: 'ready'; insight: InsightSummary };

type DiagnoseState =
  | { phase: 'idle' }
  | { phase: 'running' }
  | { phase: 'error'; error: ExamErrorDto }
  | { phase: 'done'; diagnosis: DiagnosisRecordDto };

type PlansState =
  | { phase: 'loading' }
  | { phase: 'error'; error: ExamErrorDto }
  | { phase: 'ready'; plans: PlanDto[] };

/** 计划详情缓存（展开加载）。 */
type PlanDetailState =
  | { phase: 'loading' }
  | { phase: 'error'; error: ExamErrorDto }
  | { phase: 'ready'; detail: PlanWithItemsDto };

/** 下钻维度（薄弱知识点 / 薄弱标签）。 */
type DrillDim = { kind: 'topic' | 'tag'; value: string };

/** 下钻数据（惰性加载：全库错题 × 题目索引）。 */
type DrillDataState =
  | { phase: 'idle' }
  | { phase: 'loading' }
  | { phase: 'error'; error: ExamErrorDto }
  | { phase: 'ready'; wrong: WrongEntryDto[]; byId: Map<string, ExamQuestionDto> };

/** 趋势窗口可选值（与 host 校验一致）。 */
const WINDOW_OPTIONS = [7, 14, 30] as const;

/** t9 计划条目执行类型人类可读标签。 */
const ACTION_TYPE_LABELS: Record<PlanItemActionType, string> = {
  practice: '练习',
  reviewError: '错题重练',
  read: '阅读',
  tutor: '辅导',
};

/** t9 计划条目状态人类可读标签。 */
const PLAN_STATUS_LABELS: Record<PlanItemStatus, string> = {
  pending: '待开始',
  doing: '进行中',
  done: '已完成',
  skipped: '已跳过',
};

/** 0..1 → 百分比展示（防御非有限值）。 */
function pct(value: number | undefined): string {
  if (value === undefined || !Number.isFinite(value)) return '0%';
  return `${(value * 100).toFixed(0)}%`;
}

/** 诊断建议 action → 跨模块练习意图。 */
function actionToPracticeIntent(
  action: DiagnosisSuggestionActionDto,
): { mode: PracticeScopeMode; type?: ExamQuestionType; tag?: string } {
  if (action.mode === 'byType') {
    return { mode: 'byType', type: action.type as ExamQuestionType | undefined };
  }
  if (action.mode === 'byTag') {
    return { mode: 'byTag', tag: action.tag };
  }
  return { mode: action.mode };
}

export function Insights({
  banks,
  onOpenWrong,
  onPractice,
  onOpenTutor,
  onAskQuestion,
}: {
  /** 活跃题库列表（维度过滤 select + 下钻题目索引）。 */
  banks: ExamBankDto[];
  /** 跳转错题本 tab；携带 questionId 时定位并展开该题（t13）。 */
  onOpenWrong?: (questionId?: string) => void;
  /** 可选：跨模块「学情→练习」意图（重练错题 / 按薄弱题型 / byTag / 计划条目）。 */
  onPractice?: (opts: {
    mode: PracticeScopeMode;
    type?: ExamQuestionType;
    tag?: string;
    bankId?: string;
    questionIds?: string[];
  }) => void;
  /** 可选：跳转 AI 学习 tab（计划条目 tutor 动作）。 */
  onOpenTutor?: () => void;
  /** 可选：携带题目跳转 AI 学习 tab 并绑定会话（下钻「问 AI」入口）。 */
  onAskQuestion?: (question: ExamQuestionDto) => void;
}) {
  const [windowDays, setWindowDays] = useState<number>(7);
  const [bankFilter, setBankFilter] = useState<string>('all');
  const [insight, setInsight] = useState<InsightState>({ phase: 'loading' });
  const [diagnose, setDiagnose] = useState<DiagnoseState>({ phase: 'idle' });
  const [diagnoses, setDiagnoses] = useState<DiagnosisRecordDto[]>([]);
  const [diagnoseHistoryOpen, setDiagnoseHistoryOpen] = useState(false);
  const [viewedDiagnosisId, setViewedDiagnosisId] = useState<string | null>(null);
  const [plans, setPlans] = useState<PlansState>({ phase: 'loading' });
  const [expandedPlan, setExpandedPlan] = useState<string | null>(null);
  const [planDetail, setPlanDetail] = useState<PlanDetailState | null>(null);
  const [manualFormOpen, setManualFormOpen] = useState(false);

  // 下钻（薄弱知识点 / 标签 → 错题清单）
  const [drillDim, setDrillDim] = useState<DrillDim | null>(null);
  const [drillData, setDrillData] = useState<DrillDataState>({ phase: 'idle' });

  // 手动新建计划表单
  const [manualTitle, setManualTitle] = useState('');
  const [manualItems, setManualItems] = useState('');
  const [manualBusy, setManualBusy] = useState(false);
  const [manualError, setManualError] = useState<ExamErrorDto | null>(null);

  const [planError, setPlanError] = useState<ExamErrorDto | null>(null);
  const [generating, setGenerating] = useState(false);

  // 删除治理（t13）：计划/条目删除 busy 与确认状态
  const [deletingPlanId, setDeletingPlanId] = useState<string | null>(null);
  const [deletingItemId, setDeletingItemId] = useState<string | null>(null);

  // 分域 abort：mount 时 loadInsight/loadPlans 背靠背发起，共享单个 ref 会互相掐断
  // （insight 请求被 plans 的 abort 取消 → AbortError 被误报为"无法连接"）。
  const insightAbortRef = useRef<AbortController | null>(null);
  const plansAbortRef = useRef<AbortController | null>(null);
  const diagnoseAbortRef = useRef<AbortController | null>(null);
  const diagnosesAbortRef = useRef<AbortController | null>(null);
  const drillAbortRef = useRef<AbortController | null>(null);
  // 计划各操作独立取消域：勾选/追加/生成/手建互不 abort
  // （例如勾选条目不再掐断进行中的 AI 生成，生成也不误杀已发出的勾选请求）。
  const planDetailAbortRef = useRef<AbortController | null>(null);
  const planItemAbortRef = useRef<AbortController | null>(null);
  const planGenerateAbortRef = useRef<AbortController | null>(null);
  const planManualAbortRef = useRef<AbortController | null>(null);
  const planAddAbortRef = useRef<AbortController | null>(null);
  const planDeleteAbortRef = useRef<AbortController | null>(null);

  // 计划操作 busy 防护：同一操作同时只允许一个在途（防双击/防并发提交）
  const [planItemBusy, setPlanItemBusy] = useState<{ planId: string; itemId: string } | null>(null);
  const [addBusy, setAddBusy] = useState(false);

  const loadInsight = useCallback(async () => {
    insightAbortRef.current?.abort();
    const controller = new AbortController();
    insightAbortRef.current = controller;
    setInsight({ phase: 'loading' });
    try {
      const data = await getInsight(
        { windowDays, ...(bankFilter !== 'all' ? { bankId: bankFilter } : {}) },
        controller.signal,
      );
      if (controller.signal.aborted) return;
      setInsight({ phase: 'ready', insight: data });
    } catch (err) {
      if (controller.signal.aborted) return;
      setInsight({ phase: 'error', error: err as ExamErrorDto });
    }
  }, [windowDays, bankFilter]);

  const loadPlans = useCallback(async () => {
    plansAbortRef.current?.abort();
    const controller = new AbortController();
    plansAbortRef.current = controller;
    setPlans({ phase: 'loading' });
    try {
      const data = await listPlans(controller.signal);
      if (controller.signal.aborted) return;
      setPlans({ phase: 'ready', plans: data });
    } catch (err) {
      if (controller.signal.aborted) return;
      setPlans({ phase: 'error', error: err as ExamErrorDto });
    }
  }, []);

  const loadDiagnoses = useCallback(async () => {
    diagnosesAbortRef.current?.abort();
    const controller = new AbortController();
    diagnosesAbortRef.current = controller;
    try {
      const data = await listDiagnoses(controller.signal);
      if (controller.signal.aborted) return;
      setDiagnoses(data);
    } catch {
      // 历史不可用不阻断主流程（生成新诊断仍可进行）
      if (!controller.signal.aborted) setDiagnoses([]);
    }
  }, []);

  useEffect(() => {
    void loadInsight();
  }, [loadInsight]);

  useEffect(() => {
    void loadPlans();
    void loadDiagnoses();
    return () => {
      insightAbortRef.current?.abort();
      plansAbortRef.current?.abort();
      diagnoseAbortRef.current?.abort();
      diagnosesAbortRef.current?.abort();
      drillAbortRef.current?.abort();
      planDetailAbortRef.current?.abort();
      planItemAbortRef.current?.abort();
      planGenerateAbortRef.current?.abort();
      planManualAbortRef.current?.abort();
      planAddAbortRef.current?.abort();
      planDeleteAbortRef.current?.abort();
    };
  }, [loadPlans, loadDiagnoses]);

  /** 下钻数据：全库错题 + 各题库题目索引（一次加载，按维度过滤渲染）。 */
  const loadDrill = useCallback(
    async (dim: DrillDim) => {
      drillAbortRef.current?.abort();
      const controller = new AbortController();
      drillAbortRef.current = controller;
      setDrillDim(dim);
      setDrillData({ phase: 'loading' });
      try {
        const [wrong, ...bankQuestions] = await Promise.all([
          listWrong({ includeMastered: true }, controller.signal),
          ...banks.map((bank) => listQuestions(bank.id, {}, controller.signal)),
        ]);
        if (controller.signal.aborted) return;
        const byId = new Map<string, ExamQuestionDto>();
        for (const list of bankQuestions) {
          for (const question of list) byId.set(question.id, question);
        }
        setDrillData({ phase: 'ready', wrong, byId });
      } catch (err) {
        if (controller.signal.aborted) return;
        setDrillData({ phase: 'error', error: err as ExamErrorDto });
      }
    },
    [banks],
  );

  const toggleDrill = (dim: DrillDim) => {
    if (drillDim !== null && drillDim.kind === dim.kind && drillDim.value === dim.value) {
      drillAbortRef.current?.abort();
      setDrillDim(null);
      setDrillData({ phase: 'idle' });
      return;
    }
    void loadDrill(dim);
  };

  /** 当前展开维度的错题清单（题目缺失/已删的条目跳过）。 */
  const drillRows = useMemo(() => {
    if (drillDim === null || drillData.phase !== 'ready') return [];
    return drillData.wrong
      .map((entry) => ({ entry, question: drillData.byId.get(entry.questionId) ?? null }))
      .filter(({ question }) => {
        if (question === null) return false;
        const labels = drillDim.kind === 'topic' ? question.topics : question.tags;
        return labels !== null && labels.includes(drillDim.value);
      })
      .sort((a, b) => b.entry.wrongCount - a.entry.wrongCount);
  }, [drillDim, drillData]);

  const onDiagnose = async () => {
    setDiagnose({ phase: 'running' });
    diagnoseAbortRef.current?.abort();
    const controller = new AbortController();
    diagnoseAbortRef.current = controller;
    try {
      const diagnosis = await diagnoseInsight({}, controller.signal);
      if (controller.signal.aborted) return;
      setDiagnose({ phase: 'done', diagnosis });
      setViewedDiagnosisId(diagnosis.id);
      void loadDiagnoses();
    } catch (err) {
      if (controller.signal.aborted) return;
      setDiagnose({ phase: 'error', error: err as ExamErrorDto });
    }
  };

  const togglePlan = async (planId: string) => {
    if (expandedPlan === planId) {
      // 收起：中止在途详情加载（Abort 静默），避免过期结果落地
      planDetailAbortRef.current?.abort();
      setExpandedPlan(null);
      setPlanDetail(null);
      return;
    }
    setExpandedPlan(planId);
    setPlanDetail({ phase: 'loading' });
    planDetailAbortRef.current?.abort();
    const controller = new AbortController();
    planDetailAbortRef.current = controller;
    try {
      const detail = await getPlan(planId, controller.signal);
      if (controller.signal.aborted) return;
      setPlanDetail({ phase: 'ready', detail });
    } catch (err) {
      if (controller.signal.aborted) return;
      setPlanDetail({ phase: 'error', error: err as ExamErrorDto });
    }
  };

  const onToggleItem = async (planId: string, itemId: string, done: boolean) => {
    if (planItemBusy !== null) return; // busy 防护：同一时刻只允许一个勾选在途
    setPlanItemBusy({ planId, itemId });
    planItemAbortRef.current?.abort();
    const controller = new AbortController();
    planItemAbortRef.current = controller;
    try {
      const item = await setPlanItemDone(planId, itemId, done, controller.signal);
      if (controller.signal.aborted) return;
      // 乐观更新本地详情
      setPlanDetail((prev) =>
        prev !== null && prev.phase === 'ready'
          ? {
              ...prev,
              detail: {
                ...prev.detail,
                items: prev.detail.items.map((it) => (it.id === itemId ? item : it)),
              },
            }
          : prev,
      );
      // 计划状态可能随完成度变化（active→completed），刷新列表头
      void loadPlans();
    } catch (err) {
      if (controller.signal.aborted) return;
      setPlanError(err as ExamErrorDto);
    } finally {
      setPlanItemBusy(null);
    }
  };

  const onDeleteItem = async (planId: string, itemId: string) => {
    if (deletingItemId !== null) return;
    if (!window.confirm('删除该条目？')) return;
    setDeletingItemId(itemId);
    planDeleteAbortRef.current?.abort();
    const controller = new AbortController();
    planDeleteAbortRef.current = controller;
    try {
      await deletePlanItem(planId, itemId, controller.signal);
      if (controller.signal.aborted) return;
      setPlanDetail((prev) =>
        prev !== null && prev.phase === 'ready'
          ? {
              ...prev,
              detail: { ...prev.detail, items: prev.detail.items.filter((it) => it.id !== itemId) },
            }
          : prev,
      );
      void loadPlans();
    } catch (err) {
      if (controller.signal.aborted) return;
      setPlanError(err as ExamErrorDto);
    } finally {
      setDeletingItemId(null);
    }
  };

  const onDeletePlan = async (plan: PlanDto) => {
    if (deletingPlanId !== null) return;
    if (!window.confirm(`删除计划「${plan.title}」及其全部条目？`)) return;
    setDeletingPlanId(plan.id);
    planDeleteAbortRef.current?.abort();
    const controller = new AbortController();
    planDeleteAbortRef.current = controller;
    try {
      await deletePlan(plan.id, controller.signal);
      if (controller.signal.aborted) return;
      if (expandedPlan === plan.id) {
        planDetailAbortRef.current?.abort();
        setExpandedPlan(null);
        setPlanDetail(null);
      }
      await loadPlans();
    } catch (err) {
      if (controller.signal.aborted) return;
      setPlanError(err as ExamErrorDto);
    } finally {
      setDeletingPlanId(null);
    }
  };

  const onGeneratePlan = async () => {
    if (generating) return; // busy 防护：防重复点击并发生成
    // t13 治理：已有进行中计划时确认，避免堆叠重复计划
    if (activePlanCount > 0 && !window.confirm(`已有 ${activePlanCount} 个进行中的计划，仍然生成新计划？`)) {
      return;
    }
    setGenerating(true);
    setPlanError(null);
    planGenerateAbortRef.current?.abort();
    const controller = new AbortController();
    planGenerateAbortRef.current = controller;
    try {
      await generatePlan({}, controller.signal);
      await loadPlans();
    } catch (err) {
      if (controller.signal.aborted) return;
      setPlanError(err as ExamErrorDto);
    } finally {
      setGenerating(false);
    }
  };

  const onCreateManual = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (manualBusy) return; // busy 防护：防重复提交
    const title = manualTitle.trim();
    if (title.length === 0) {
      setManualError({ code: 'CLIENT_VALIDATION', message: '计划标题不能为空' });
      return;
    }
    const items = manualItems
      .split('\n')
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    setManualBusy(true);
    setManualError(null);
    planManualAbortRef.current?.abort();
    const controller = new AbortController();
    planManualAbortRef.current = controller;
    try {
      const detail = await createManualPlan(title, items, controller.signal);
      if (controller.signal.aborted) return;
      setManualTitle('');
      setManualItems('');
      setPlanDetail({ phase: 'ready', detail });
      setExpandedPlan(detail.plan.id);
      await loadPlans();
    } catch (err) {
      if (controller.signal.aborted) return;
      setManualError(err as ExamErrorDto);
    } finally {
      setManualBusy(false);
    }
  };

  const onAddItems = async (planId: string, titlesText: string) => {
    const titles = titlesText
      .split('\n')
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    if (titles.length === 0) return;
    if (addBusy) return; // busy 防护：防重复点击追加
    setAddBusy(true);
    planAddAbortRef.current?.abort();
    const controller = new AbortController();
    planAddAbortRef.current = controller;
    try {
      const detail = await addPlanItems(planId, titles, controller.signal);
      if (controller.signal.aborted) return;
      setPlanDetail({ phase: 'ready', detail });
      setAddItemsText('');
    } catch (err) {
      if (controller.signal.aborted) return;
      setPlanError(err as ExamErrorDto);
    } finally {
      setAddBusy(false);
    }
  };

  const [addItemsText, setAddItemsText] = useState('');

  // ── 渲染派生 ──
  const insightData = insight.phase === 'ready' ? insight.insight : null;
  const maxDailyTotal = insightData ? Math.max(1, ...insightData.daily.map((d) => d.total)) : 1;
  const dailySum = insightData ? insightData.daily.reduce((sum, d) => sum + d.total, 0) : 0;
  const typeRows = insightData ? Object.entries(insightData.byType).sort(([a], [b]) => a.localeCompare(b)) : [];
  const activePlanCount = plans.phase === 'ready' ? plans.plans.filter((p) => p.status === 'active').length : 0;

  // 诊断查看目标：刚生成的 > 用户点选的历史 > 最新一条
  const viewedDiagnosis: DiagnosisRecordDto | null = (() => {
    if (diagnose.phase === 'done') return diagnose.diagnosis;
    if (viewedDiagnosisId !== null) return diagnoses.find((d) => d.id === viewedDiagnosisId) ?? null;
    return diagnoses[0] ?? null;
  })();
  const diagnosingNow = diagnose.phase === 'running';
  const diagnoseError = diagnose.phase === 'error' ? diagnose.error : null;

  /**
   * t9：计划条目可执行动作按钮映射。scope 可完整直达 byType/byTag/questionIds；
   * reviewError 无 scope 时按全部错题范围；tutor 打开 AI 学习 tab；read 无动作。
   */
  const planItemAction = (it: PlanItemDto): React.ReactNode => {
    if (it.actionType === 'practice' && it.scope) {
      return (
        <button
          type="button"
          className="exam-assistant-button exam-assistant-button--ghost exam-assistant-button--sm"
          onClick={() =>
            onPractice?.({
              mode: it.scope!.mode,
              type: it.scope!.type,
              tag: it.scope!.tag,
              questionIds: it.scope!.questionIds,
            })
          }
        >
          去练习 →
        </button>
      );
    }
    if (it.actionType === 'practice') {
      return (
        <button
          type="button"
          className="exam-assistant-button exam-assistant-button--ghost exam-assistant-button--sm"
          onClick={() => onPractice?.({ mode: 'all' })}
        >
          去练习 →
        </button>
      );
    }
    if (it.actionType === 'reviewError') {
      return (
        <button
          type="button"
          className="exam-assistant-button exam-assistant-button--ghost exam-assistant-button--sm"
          onClick={() => onPractice?.({ mode: 'wrong' })}
        >
          重练错题 →
        </button>
      );
    }
    if (it.actionType === 'tutor') {
      return (
        <button
          type="button"
          className="exam-assistant-button exam-assistant-button--ghost exam-assistant-button--sm"
          onClick={() => onOpenTutor?.()}
        >
          AI 辅导 →
        </button>
      );
    }
    return null;
  };

  /** 弱项行内「去练习」按钮。 */
  const weakPracticeButton = (label: string, title: string, opts: { mode: PracticeScopeMode; type?: ExamQuestionType; tag?: string }) =>
    onPractice ? (
      <button
        type="button"
        className="exam-assistant-type-bar__action"
        title={title}
        onClick={() => onPractice(opts)}
      >
        {label}
      </button>
    ) : null;

  /** 薄弱维度 chip（可下钻）。 */
  const weakChip = (dim: DrillDim, label: string, tooltip: string, active: boolean) => (
    <button
      key={`${dim.kind}:${dim.value}`}
      type="button"
      className={
        active
          ? 'exam-assistant-tag exam-assistant-tag--weak exam-assistant-tag--action exam-assistant-tag--active'
          : 'exam-assistant-tag exam-assistant-tag--weak exam-assistant-tag--action'
      }
      title={tooltip}
      onClick={() => toggleDrill(dim)}
    >
      {label}
    </button>
  );

  return (
    <div className="exam-assistant-workspace">
      {/* ── 洞察卡片 ── */}
      <section className="exam-assistant-card" aria-label="学情洞察">
        <div className="exam-assistant-row">
          <h3 className="exam-assistant-card__title">学情洞察</h3>
          <div className="exam-assistant-insight-toolbar">
            <select
              className="exam-assistant-input"
              value={bankFilter}
              onChange={(event) => setBankFilter(event.target.value)}
              aria-label="按题库过滤统计"
            >
              <option value="all">全部题库</option>
              {banks.map((bank) => (
                <option key={bank.id} value={bank.id}>
                  {bank.name}
                </option>
              ))}
            </select>
            <select
              className="exam-assistant-input"
              value={windowDays}
              onChange={(event) => setWindowDays(Number(event.target.value))}
              aria-label="趋势窗口天数"
            >
              {WINDOW_OPTIONS.map((days) => (
                <option key={days} value={days}>
                  近 {days} 天
                </option>
              ))}
            </select>
            <button type="button" className="exam-assistant-button exam-assistant-button--ghost" onClick={() => void loadInsight()}>
              刷新
            </button>
          </div>
        </div>
        {insight.phase === 'loading' ? (
          <div className="exam-assistant-skeleton">正在聚合统计数据…</div>
        ) : insight.phase === 'error' ? (
          <p className="exam-assistant-error">{examErrorMessage(insight.error)}</p>
        ) : insightData !== null ? (
          <div>
            {/* 指标分组：练习量 / 正确率 / 进度（口径见各卡 tooltip） */}
            <div className="exam-assistant-insight-metrics">
              <div className="exam-assistant-insight-metrics__group">
                <p className="exam-assistant-insight-metrics__title">练习量</p>
                <div className="exam-assistant-scorecard-grid">
                  <div className="exam-assistant-scorecard-cell" title="所有作答记录数（同一题重做会计入）">
                    <span className="exam-assistant-scorecard-cell__num">{insightData.totalAttempts}</span>
                    <span className="exam-assistant-scorecard-cell__label">总答题</span>
                  </div>
                  <div className="exam-assistant-scorecard-cell" title="已结束的练习会话数">
                    <span className="exam-assistant-scorecard-cell__num">{insightData.finishedPractices}</span>
                    <span className="exam-assistant-scorecard-cell__label">完成练习</span>
                  </div>
                  <div className="exam-assistant-scorecard-cell" title={`最近 ${insightData.windowDays} 天的作答数`}>
                    <span className="exam-assistant-scorecard-cell__num">{dailySum}</span>
                    <span className="exam-assistant-scorecard-cell__label">近{insightData.windowDays}天答题</span>
                  </div>
                </div>
              </div>
              <div className="exam-assistant-insight-metrics__group">
                <p className="exam-assistant-insight-metrics__title">正确率</p>
                <div className="exam-assistant-scorecard-grid">
                  <div
                    className="exam-assistant-scorecard-cell"
                    title={`最近 ${insightData.windowDays} 天作答的正确率（全部历史为 ${pct(insightData.accuracy)}）`}
                  >
                    <span className="exam-assistant-scorecard-cell__num">{pct(insightData.accuracyWindow)}</span>
                    <span className="exam-assistant-scorecard-cell__label">近{insightData.windowDays}天</span>
                    {dailySum > 0 ? (
                      <span
                        className={
                          insightData.accuracyWindow >= insightData.accuracy
                            ? 'exam-assistant-insight-delta exam-assistant-insight-delta--up'
                            : 'exam-assistant-insight-delta exam-assistant-insight-delta--down'
                        }
                      >
                        {insightData.accuracyWindow >= insightData.accuracy ? '▲' : '▼'}{' '}
                        {Math.abs(insightData.accuracyWindow - insightData.accuracy) * 100 >= 0.5
                          ? `${(Math.abs(insightData.accuracyWindow - insightData.accuracy) * 100).toFixed(0)}pp`
                          : '持平'}
                        {' '}
                        vs 全部
                      </span>
                    ) : null}
                  </div>
                  <div className="exam-assistant-scorecard-cell" title="全部历史作答的正确率">
                    <span className="exam-assistant-scorecard-cell__num">{pct(insightData.accuracy)}</span>
                    <span className="exam-assistant-scorecard-cell__label">全部正确率</span>
                  </div>
                  <div className="exam-assistant-scorecard-cell" title="每道题第一次作答的正确率（未复习的真实水平）">
                    <span className="exam-assistant-scorecard-cell__num">{pct(insightData.firstAttemptAccuracy)}</span>
                    <span className="exam-assistant-scorecard-cell__label">首次作答</span>
                  </div>
                  <div className="exam-assistant-scorecard-cell" title="每道题最近一次作答的正确率（当前掌握水平）">
                    <span className="exam-assistant-scorecard-cell__num">{pct(insightData.currentMastery)}</span>
                    <span className="exam-assistant-scorecard-cell__label">当前掌握</span>
                  </div>
                </div>
              </div>
              <div className="exam-assistant-insight-metrics__group">
                <p className="exam-assistant-insight-metrics__title">进度</p>
                <div className="exam-assistant-scorecard-grid">
                  <div className="exam-assistant-scorecard-cell" title="已作答过的题目数 / 可用题目总数">
                    <span className="exam-assistant-scorecard-cell__num">{pct(insightData.coverage)}</span>
                    <span className="exam-assistant-scorecard-cell__label">题库覆盖率</span>
                  </div>
                  <div className="exam-assistant-scorecard-cell" title="从今天（或昨天）起连续有作答的天数">
                    <span className="exam-assistant-scorecard-cell__num">{insightData.streakDays}</span>
                    <span className="exam-assistant-scorecard-cell__label">连续学习（天）</span>
                  </div>
                </div>
              </div>
            </div>

            {/* 趋势（div 条形，无图表库；窗口可选） */}
            <div className="exam-assistant-insight-trend">
              <p className="exam-assistant-form-label">
                近 {insightData.windowDays} 天答题趋势（绿=正确 / 灰蓝=全部）
                {insightData.streakDays > 0 ? (
                  <span className="exam-assistant-insight-streak">🔥 连续学习 {insightData.streakDays} 天</span>
                ) : null}
              </p>
              <div className="exam-assistant-insight-trend__bars">
                {insightData.daily.every((d) => d.total === 0) && (
                  <div className="exam-assistant-insight-trend__empty">该窗口内暂无答题记录</div>
                )}
                {insightData.daily.map((d) => (
                  <div key={d.date} className="exam-assistant-insight-trend__col" title={`${d.date}：${d.total} 答 / ${d.correct} 对`}>
                    <div className="exam-assistant-insight-trend__stack">
                      <div
                        className="exam-assistant-insight-trend__bar exam-assistant-insight-trend__bar--correct"
                        style={{ '--exam-assistant-bar': (d.correct / maxDailyTotal) * 100 } as React.CSSProperties}
                      />
                      <div
                        className="exam-assistant-insight-trend__bar exam-assistant-insight-trend__bar--total"
                        style={{ '--exam-assistant-bar': (d.total / maxDailyTotal) * 100 } as React.CSSProperties}
                      />
                    </div>
                    <span className="exam-assistant-insight-trend__label">{d.date.slice(5)}</span>
                    <span className="exam-assistant-insight-trend__count">{d.total}</span>
                  </div>
                ))}
              </div>
            </div>

            <div className="exam-assistant-insight-grid">
              {/* 题型准确率 */}
              {typeRows.length > 0 ? (
                <div>
                  <p className="exam-assistant-form-label">
                    题型准确率{insightData.weakTypes.length > 0 ? '（红色为薄弱项）' : ''}
                  </p>
                  <div className="exam-assistant-type-bars">
                    {typeRows.map(([type, stat]) => {
                      const isWeak = insightData.weakTypes.includes(type);
                      return (
                        <div
                          key={type}
                          className={`exam-assistant-type-bar${isWeak ? ' exam-assistant-type-bar--weak' : ''}`}
                          title={`作答 ${stat.answered} 次 · 答对 ${stat.correct} 次`}
                        >
                          <span className="exam-assistant-type-bar__label">
                            {questionTypeLabel(type as ExamQuestionType)}
                            <span className="exam-assistant-type-bar__sample">×{stat.answered}</span>
                          </span>
                          <div className="exam-assistant-type-bar__track">
                            <div
                              className="exam-assistant-type-bar__fill"
                              style={{ '--exam-assistant-type-fill': stat.accuracy * 100 } as React.CSSProperties}
                            />
                          </div>
                          <span className="exam-assistant-type-bar__value">
                            {(stat.accuracy * 100).toFixed(0)}%
                          </span>
                          {isWeak
                            ? weakPracticeButton('去练习 →', `按「${questionTypeLabel(type as ExamQuestionType)}」题型去练习`, {
                                mode: 'byType',
                                type: type as ExamQuestionType,
                              })
                            : null}
                        </div>
                      );
                    })}
                  </div>
                </div>
              ) : null}

              {/* 薄弱点：知识点 / 标签（可下钻） + 错题 Top10（可定位） */}
              <div>
                <p className="exam-assistant-form-label">薄弱知识点</p>
                {insightData.weakTopics.length === 0 ? (
                  <p className="exam-assistant-empty">暂无满足条件的薄弱知识点（样本 ≥3 且明显低于整体水平）</p>
                ) : (
                  <div className="exam-assistant-tags">
                    {insightData.weakTopics.map((wt) =>
                      weakChip(
                        { kind: 'topic', value: wt.topic },
                        `${wt.topic} ${pct(wt.accuracy)}`,
                        `知识点「${wt.topic}」：作答 ${wt.answered} 次 / 正确率 ${pct(wt.accuracy)}——点击展开该维度的错题`,
                        drillDim?.kind === 'topic' && drillDim.value === wt.topic,
                      ),
                    )}
                  </div>
                )}

                <p className="exam-assistant-form-label">薄弱标签</p>
                {insightData.weakTags.length === 0 ? (
                  <p className="exam-assistant-empty">暂无满足条件的薄弱标签 —— 试题打标签后完成练习会自动分析</p>
                ) : (
                  <div className="exam-assistant-tags">
                    {insightData.weakTags.map((wt) =>
                      weakChip(
                        { kind: 'tag', value: wt.tag },
                        `${wt.tag} ${pct(wt.accuracy)}`,
                        `标签「${wt.tag}」：作答 ${wt.answered} 次 / 正确率 ${pct(wt.accuracy)}——点击展开该维度的错题`,
                        drillDim?.kind === 'tag' && drillDim.value === wt.tag,
                      ),
                    )}
                  </div>
                )}

                {/* 下钻面板：该维度下的错题清单（重练单题 / 问 AI / 跳错题本） */}
                {drillDim !== null ? (
                  <div className="exam-assistant-insight-drill">
                    <div className="exam-assistant-insight-drill__head">
                      <span>
                        {drillDim.kind === 'topic' ? '知识点' : '标签'}「{drillDim.value}」的错题（{drillRows.length}）
                      </span>
                      <button
                        type="button"
                        className="exam-assistant-button exam-assistant-button--ghost exam-assistant-button--sm"
                        onClick={() => {
                          drillAbortRef.current?.abort();
                          setDrillDim(null);
                          setDrillData({ phase: 'idle' });
                        }}
                      >
                        收起
                      </button>
                    </div>
                    {drillData.phase === 'loading' ? (
                      <div className="exam-assistant-skeleton">正在加载该维度的错题…</div>
                    ) : drillData.phase === 'error' ? (
                      <p className="exam-assistant-error">{examErrorMessage(drillData.error)}</p>
                    ) : drillRows.length === 0 ? (
                      <p className="exam-assistant-empty">该维度下暂无错题 —— 保持住 👍</p>
                    ) : (
                      <ul className="exam-assistant-insight-drill__list">
                        {drillRows.map(({ entry, question }) => (
                          <li key={entry.questionId} className="exam-assistant-insight-drill__item">
                            <span className="exam-assistant-insight-drill__stem" title={question?.stem}>
                              {question?.stem ?? entry.questionId}
                            </span>
                            <span className="exam-assistant-insight-drill__meta">
                              错 {entry.wrongCount} 次
                              {entry.lastWrongAt !== null ? ` · 最近错 ${formatTime(entry.lastWrongAt)}` : ''}
                              {entry.mastered ? ' · 已掌握' : ''}
                            </span>
                            <span className="exam-assistant-insight-drill__actions">
                              {onPractice ? (
                                <button
                                  type="button"
                                  className="exam-assistant-button exam-assistant-button--sm"
                                  title="单独重练这道题"
                                  onClick={() =>
                                    onPractice({
                                      mode: 'all',
                                      bankId: question?.bankId,
                                      questionIds: [entry.questionId],
                                    })
                                  }
                                >
                                  重练此题
                                </button>
                              ) : null}
                              {onAskQuestion && question !== null ? (
                                <button
                                  type="button"
                                  className="exam-assistant-button exam-assistant-button--ghost exam-assistant-button--sm"
                                  title="在 AI 学习中绑定本题提问"
                                  onClick={() => onAskQuestion(question)}
                                >
                                  问 AI
                                </button>
                              ) : null}
                              {onOpenWrong ? (
                                <button
                                  type="button"
                                  className="exam-assistant-button exam-assistant-button--ghost exam-assistant-button--sm"
                                  title="在错题本中查看"
                                  onClick={() => onOpenWrong(entry.questionId)}
                                >
                                  错题本 →
                                </button>
                              ) : null}
                            </span>
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                ) : null}

                <p className="exam-assistant-form-label">错题 Top {insightData.wrongTop.length}</p>
                {insightData.wrongTop.length === 0 ? (
                  <p className="exam-assistant-empty">暂无错题</p>
                ) : (
                  <ol className="exam-assistant-insight-wrong">
                    {insightData.wrongTop.map((w, i) => (
                      <li key={w.questionId}>
                        {onOpenWrong ? (
                          <button
                            type="button"
                            className="exam-assistant-insight-wrong__item"
                            title="点击在错题本中定位该题"
                            onClick={() => onOpenWrong(w.questionId)}
                          >
                            <span className="exam-assistant-insight-wrong__rank">{i + 1}</span>
                            <span className="exam-assistant-insight-wrong__main">
                              <span className="exam-assistant-insight-wrong__stem">{w.stem}</span>
                              {w.topics.length > 0 ? (
                                <span className="exam-assistant-insight-wrong__topics">
                                  {w.topics.slice(0, 3).map((topic) => (
                                    <span key={topic} className="exam-assistant-tag">
                                      {topic}
                                    </span>
                                  ))}
                                </span>
                              ) : null}
                            </span>
                            <span className="exam-assistant-insight-wrong__count">
                              错 {w.wrongCount} 次
                              {w.lastWrongAt !== null ? ` · ${formatTime(w.lastWrongAt)}` : ''}
                            </span>
                          </button>
                        ) : (
                          <div className="exam-assistant-insight-wrong__item">
                            <span className="exam-assistant-insight-wrong__rank">{i + 1}</span>
                            <span className="exam-assistant-insight-wrong__main">
                              <span className="exam-assistant-insight-wrong__stem">{w.stem}</span>
                            </span>
                            <span className="exam-assistant-insight-wrong__count">错 {w.wrongCount} 次</span>
                          </div>
                        )}
                      </li>
                    ))}
                  </ol>
                )}
                {insightData.wrongTop.length > 0 ? (
                  <div className="exam-assistant-form-actions">
                    {onPractice ? (
                      <button
                        type="button"
                        className="exam-assistant-button exam-assistant-button--ghost exam-assistant-button--sm"
                        onClick={() => onPractice({ mode: 'wrong' })}
                      >
                        去练习重做错题 →
                      </button>
                    ) : null}
                    {onOpenWrong ? (
                      <button
                        type="button"
                        className="exam-assistant-button exam-assistant-button--ghost exam-assistant-button--sm"
                        onClick={() => onOpenWrong()}
                      >
                        在错题本中查看 →
                      </button>
                    ) : null}
                  </div>
                ) : null}
              </div>
            </div>
          </div>
        ) : null}
      </section>

      {/* ── AI 诊断 ── */}
      <section className="exam-assistant-card" aria-label="AI 学情诊断">
        <div className="exam-assistant-row">
          <h3 className="exam-assistant-card__title">AI 学情诊断</h3>
          <button type="button" className="exam-assistant-button" disabled={diagnosingNow} onClick={() => void onDiagnose()}>
            {diagnosingNow ? '诊断中…' : '生成诊断'}
          </button>
        </div>
        {diagnoseError ? (
          <p className="exam-assistant-error" role="alert">{examErrorMessage(diagnoseError)}</p>
        ) : null}
        {diagnosingNow ? (
          <p className="exam-assistant-empty">基于当前统计摘要，由 LLM 生成学习建议…</p>
        ) : viewedDiagnosis !== null ? (
          <div className="exam-assistant-diagnosis">
            <p className="exam-assistant-llm__meta">
              {formatTime(viewedDiagnosis.createdAt)} 生成
              {viewedDiagnosis.model !== null ? ` · ${viewedDiagnosis.model}` : ''}
            </p>
            <p className="exam-assistant-diagnosis__summary">{viewedDiagnosis.summary}</p>
            <div className="exam-assistant-diagnosis__cols">
              {viewedDiagnosis.weaknesses.length > 0 ? (
                <div>
                  <p className="exam-assistant-form-label">薄弱环节</p>
                  <ul className="exam-assistant-diagnosis__list">
                    {viewedDiagnosis.weaknesses.map((w, i) => (
                      <li key={i}>{w}</li>
                    ))}
                  </ul>
                </div>
              ) : null}
              {viewedDiagnosis.suggestions.length > 0 ? (
                <div>
                  <p className="exam-assistant-form-label">学习建议</p>
                  <ul className="exam-assistant-diagnosis__list">
                    {viewedDiagnosis.suggestions.map((s, i) => (
                      <li key={i} className="exam-assistant-diagnosis__suggestion">
                        <span>{s.text}</span>
                        {s.action !== undefined && onPractice ? (
                          <button
                            type="button"
                            className="exam-assistant-button exam-assistant-button--ghost exam-assistant-button--sm"
                            title="按该建议直达练习"
                            onClick={() => {
                              const intent = actionToPracticeIntent(s.action!);
                              onPractice?.(intent);
                            }}
                          >
                            去练习 →
                          </button>
                        ) : null}
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}
            </div>
            {diagnoses.length > 1 ? (
              <div className="exam-assistant-diagnosis-history">
                <button
                  type="button"
                  className="exam-assistant-button exam-assistant-button--ghost exam-assistant-button--sm"
                  aria-expanded={diagnoseHistoryOpen}
                  onClick={() => setDiagnoseHistoryOpen((prev) => !prev)}
                >
                  {diagnoseHistoryOpen ? '收起历史诊断' : `历史诊断（${diagnoses.length}）`}
                </button>
                {diagnoseHistoryOpen ? (
                  <ul className="exam-assistant-diagnosis-history__list">
                    {diagnoses.map((record) => (
                      <li key={record.id}>
                        <button
                          type="button"
                          className={
                            record.id === viewedDiagnosis.id
                              ? 'exam-assistant-diagnosis-history__item exam-assistant-diagnosis-history__item--active'
                              : 'exam-assistant-diagnosis-history__item'
                          }
                          onClick={() => setViewedDiagnosisId(record.id)}
                        >
                          {formatTime(record.createdAt)} · {record.summary.slice(0, 40)}
                          {record.summary.length > 40 ? '…' : ''}
                        </button>
                      </li>
                    ))}
                  </ul>
                ) : null}
              </div>
            ) : null}
          </div>
        ) : (
          <p className="exam-assistant-empty">基于当前统计摘要，由 LLM 生成学习建议；生成结果自动保存，可回看历史。</p>
        )}
      </section>

      {/* ── 学习计划 ── */}
      <section className="exam-assistant-card" aria-label="学习计划">
        <div className="exam-assistant-row">
          <h3 className="exam-assistant-card__title">学习计划</h3>
          <span className="exam-assistant-llm__meta">
            {plans.phase === 'ready' ? `${plans.plans.length} 个计划 · ${activePlanCount} 个进行中` : ''}
          </span>
        </div>

        <div className="exam-assistant-form-actions">
          <button type="button" className="exam-assistant-button" disabled={generating} onClick={() => void onGeneratePlan()}>
            {generating ? 'AI 生成中…' : 'AI 生成计划'}
          </button>
          <button
            type="button"
            className="exam-assistant-button exam-assistant-button--ghost"
            aria-expanded={manualFormOpen}
            onClick={() => setManualFormOpen((prev) => !prev)}
          >
            {manualFormOpen ? '收起新建表单' : '手动新建'}
          </button>
        </div>
        {planError ? (
          <p className="exam-assistant-error" role="alert">{examErrorMessage(planError)}</p>
        ) : null}

        {plans.phase === 'loading' ? (
          <div className="exam-assistant-skeleton">正在读取计划…</div>
        ) : plans.phase === 'error' ? (
          <p className="exam-assistant-error">{examErrorMessage(plans.error)}</p>
        ) : plans.plans.length === 0 ? (
          <p className="exam-assistant-empty">暂无学习计划 —— 点击「AI 生成计划」或「手动新建」</p>
        ) : (
          <ul className="exam-assistant-plan-list">
            {plans.plans.map((p) => {
              const isExpanded = expandedPlan === p.id;
              const detail = isExpanded ? planDetail : null;
              const doneCount = detail !== null && detail.phase === 'ready'
                ? detail.detail.items.filter((it) => it.status === 'done').length
                : null;
              const totalCount = detail !== null && detail.phase === 'ready' ? detail.detail.items.length : null;
              return (
                <li key={p.id} className="exam-assistant-plan-item">
                  <div className="exam-assistant-plan-item__headrow">
                    <button
                      type="button"
                      className="exam-assistant-plan-item__head"
                      aria-expanded={isExpanded}
                      aria-controls={isExpanded ? `exam-plan-detail-${p.id}` : undefined}
                      onClick={() => void togglePlan(p.id)}
                    >
                      <span className="exam-assistant-plan-item__title">{p.title}</span>
                      <span className="exam-assistant-plan-item__meta">
                        {p.source === 'llm' ? 'AI' : '手动'} · {p.status === 'active' ? '进行中' : '已完成'} ·{' '}
                        {doneCount !== null && totalCount !== null ? `${doneCount}/${totalCount} 完成 · ` : ''}
                        更新于 {formatTime(p.updatedAt)}
                      </span>
                    </button>
                    <button
                      type="button"
                      className="exam-assistant-plan-item__delete"
                      title="删除该计划（含全部条目）"
                      disabled={deletingPlanId !== null}
                      onClick={() => void onDeletePlan(p)}
                    >
                      {deletingPlanId === p.id ? '…' : '✕'}
                    </button>
                  </div>
                  {isExpanded ? (
                    <div id={`exam-plan-detail-${p.id}`} className="exam-assistant-plan-item__detail">
                      {detail === null ? null : detail.phase === 'loading' ? (
                        <div className="exam-assistant-skeleton">正在读取条目…</div>
                      ) : detail.phase === 'error' ? (
                        <p className="exam-assistant-error">{examErrorMessage(detail.error)}</p>
                      ) : detail.detail.items.length === 0 ? (
                        <p className="exam-assistant-empty">暂无条目 —— 在下方添加</p>
                      ) : (
                        <ul className="exam-assistant-plan-tasks">
                          {detail.detail.items.map((it) => (
                            <li key={it.id} className="exam-assistant-plan-task">
                              <label className="exam-assistant-answer-row">
                                <input
                                  type="checkbox"
                                  checked={it.status === 'done'}
                                  disabled={planItemBusy?.itemId === it.id}
                                  onChange={(event) => void onToggleItem(p.id, it.id, event.target.checked)}
                                />
                                <span className={it.status === 'done' ? 'exam-assistant-plan-task__title exam-assistant-plan-task__title--done' : 'exam-assistant-plan-task__title'}>
                                  {it.title}
                                </span>
                              </label>
                              <div className="exam-assistant-plan-task__side">
                                {it.actionType ? (
                                  <span className="exam-assistant-plan-task__chip">{ACTION_TYPE_LABELS[it.actionType] ?? it.actionType}</span>
                                ) : null}
                                <span className="exam-assistant-plan-task__chip exam-assistant-plan-task__chip--status">
                                  {PLAN_STATUS_LABELS[it.status] ?? it.status}
                                </span>
                                {it.priority !== 0 ? (
                                  <span className="exam-assistant-llm__meta">P{it.priority}</span>
                                ) : null}
                                {it.dueAt ? (
                                  <span className="exam-assistant-llm__meta">· 到期 {formatTime(it.dueAt)}</span>
                                ) : null}
                                {it.note ? <span className="exam-assistant-plan-task__note">{it.note}</span> : null}
                                {planItemAction(it)}
                                <button
                                  type="button"
                                  className="exam-assistant-plan-task__delete"
                                  title="删除该条目"
                                  disabled={deletingItemId !== null}
                                  onClick={() => void onDeleteItem(p.id, it.id)}
                                >
                                  {deletingItemId === it.id ? '…' : '✕'}
                                </button>
                              </div>
                              {it.completedAt !== null ? (
                                <span className="exam-assistant-llm__meta">完成于 {formatTime(it.completedAt)}</span>
                              ) : null}
                            </li>
                          ))}
                        </ul>
                      )}
                      <div className="exam-assistant-form-row">
                        <textarea
                          className="exam-assistant-input"
                          rows={2}
                          value={addItemsText}
                          onChange={(event) => setAddItemsText(event.target.value)}
                          placeholder={'新增条目（每行一条）…'}
                          aria-label={`为计划 ${p.title} 新增条目`}
                        />
                        <button
                          type="button"
                          className="exam-assistant-button exam-assistant-button--sm"
                          disabled={addItemsText.trim().length === 0 || addBusy}
                          onClick={() => void onAddItems(p.id, addItemsText)}
                        >
                          {addBusy ? '添加中…' : '添加条目'}
                        </button>
                      </div>
                    </div>
                  ) : null}
                </li>
              );
            })}
          </ul>
        )}

        {/* 手动新建（默认折叠，t13） */}
        {manualFormOpen ? (
          <form className="exam-assistant-question-form" onSubmit={(event) => void onCreateManual(event)}>
            <p className="exam-assistant-form-label">手动新建计划</p>
            <div className="exam-assistant-form-row">
              <input
                className="exam-assistant-input"
                value={manualTitle}
                onChange={(event) => setManualTitle(event.target.value)}
                placeholder="计划标题（如：高数考前冲刺）"
                aria-label="计划标题"
              />
            </div>
            <div className="exam-assistant-form-row">
              <textarea
                className="exam-assistant-input"
                rows={3}
                value={manualItems}
                onChange={(event) => setManualItems(event.target.value)}
                placeholder={'初始条目（每行一条，可选）：\n第一章 极限与连续复习\n课后习题 1-20'}
                aria-label="初始条目"
              />
            </div>
            {manualError ? (
              <p className="exam-assistant-error" role="alert">{examErrorMessage(manualError)}</p>
            ) : null}
            <div className="exam-assistant-form-actions">
              <button type="submit" className="exam-assistant-button" disabled={manualBusy}>
                {manualBusy ? '创建中…' : '创建计划'}
              </button>
            </div>
          </form>
        ) : null}
      </section>
    </div>
  );
}
