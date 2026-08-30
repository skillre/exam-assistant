/**
 * WrongView —— 错题本（Phase 1 + Phase 4 摘要）。
 *
 * - 按 bankId 筛选（含「全部题库」）；
 * - 题目列表：错误次数、最近错误时间、已掌握标记切换；
 * - 展开行查看题目与正确答案（题目内容按 bank 拉取建索引）；
 * - Phase 4：展开时惰性探测该题缓存解析（按其最近一次作答答案），有则折叠展示
 *   只读摘要——无生成入口，重做流程走练习自然产生缓存。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { fetchPracticeExplanation, listBanks, listPracticeHistory, listQuestions, listWrong, setMastered } from './api.ts';
import type {
  ExamBankDto,
  ExamErrorDto,
  ExamQuestionDto,
  ExplanationDto,
  PracticeHistoryItemDto,
  WrongEntryDto,
} from './types.ts';
import { answerText, examErrorMessage, formatTime, identifierToIndex, optionLabel, questionTypeLabel } from './ui-helpers.ts';

type BanksState = { phase: 'loading' } | { phase: 'error'; error: ExamErrorDto } | { phase: 'ready'; banks: ExamBankDto[] };

type WrongState =
  | { phase: 'loading' }
  | { phase: 'error'; error: ExamErrorDto }
  | { phase: 'ready'; wrong: WrongEntryDto[] };

type QuestionIndexState =
  | { phase: 'idle' }
  | { phase: 'loading' }
  | { phase: 'error'; error: ExamErrorDto }
  | { phase: 'ready'; byId: Map<string, ExamQuestionDto> };

/** 展开条目的解析摘要探测态：probing（静默）/ hit（有缓存摘要）/ miss（无则不渲染）。 */
type ExplainSummaryState =
  | { questionId: string; status: 'probing' }
  | { questionId: string; status: 'hit'; explanation: ExplanationDto }
  | { questionId: string; status: 'miss' };

/** 最近一次作答（lastAnswer）→ 选项下标集（单选/多选）；其他类型或无法解析返回 null。 */
function lastAnswerOptionIdxs(answer: unknown): Set<number> | null {
  if (typeof answer === 'string') {
    const idx = identifierToIndex(answer);
    return idx === null ? null : new Set([idx]);
  }
  if (Array.isArray(answer)) {
    const set = new Set<number>();
    for (const value of answer) {
      const idx = identifierToIndex(value);
      if (idx !== null) set.add(idx);
    }
    return set.size > 0 ? set : null;
  }
  return null;
}

/** 正确答案 → 选项下标集（单选/多选）；其他类型或无法解析返回 null。 */
function correctOptionIdxs(question: ExamQuestionDto): Set<number> | null {
  if (question.type === 'single') {
    const idx = identifierToIndex(question.answer);
    return idx === null ? null : new Set([idx]);
  }
  if (question.type === 'multiple' && Array.isArray(question.answer)) {
    const set = new Set<number>();
    for (const value of question.answer as unknown[]) {
      const idx = identifierToIndex(value);
      if (idx !== null) set.add(idx);
    }
    return set.size > 0 ? set : null;
  }
  return null;
}

/** 「你的作答」人类可读文本：单选 'C'、多选 'A、C'、判断 '对/错'；无法解析返回 null。 */
function lastAnswerText(answer: unknown): string | null {
  if (typeof answer === 'string') {
    if (answer === 'true') return '对';
    if (answer === 'false') return '错';
    const idx = identifierToIndex(answer);
    return idx === null ? null : optionLabel(idx);
  }
  if (Array.isArray(answer)) {
    const parts: string[] = [];
    for (const value of answer) {
      const idx = identifierToIndex(value);
      if (idx !== null) parts.push(optionLabel(idx));
    }
    return parts.length > 0 ? parts.join('、') : null;
  }
  return null;
}

export function WrongView({
  onBack,
  onPracticeWrong,
  focusQuestion,
}: {
  onBack: () => void;
  /** 可选：跨模块「重练错题」→ 练习 tab。questionIds 直达指定题目集合（单题/多选重练）。 */
  onPracticeWrong?: (opts: { bankId?: string; questionIds?: string[] }) => void;
  /**
   * t13 定位意图：学情页 → 错题本。携带 questionId + 触发序号：切全库筛选、
   * 展开该题并滚动到视区。nonce 保证同题重复点击可再次触发。
   */
  focusQuestion?: { questionId: string; nonce: number } | null;
}) {
  const [banks, setBanks] = useState<BanksState>({ phase: 'loading' });
  const [bankFilter, setBankFilter] = useState<string>('all');
  const [wrong, setWrong] = useState<WrongState>({ phase: 'loading' });
  const [index, setIndex] = useState<QuestionIndexState>({ phase: 'idle' });
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [toggleBusy, setToggleBusy] = useState<string | null>(null);
  /** t10：多选重练所选题目集合。 */
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  // Phase 4：展开条目的解析摘要（惰性探测，一次只展开一行故单份状态足够）
  const [explainSummary, setExplainSummary] = useState<ExplainSummaryState | null>(null);
  /** 练习历史懒加载缓存：探测需 practiceId（GET 契约按会话校验），首次展开时取一次。 */
  const [historyItems, setHistoryItems] = useState<PracticeHistoryItemDto[] | null>(null);
  /** 掌握切换失败的行级错误（不整页回退 error 态，其余行仍可用）。 */
  const [masterError, setMasterError] = useState<{ questionId: string; error: ExamErrorDto } | null>(null);
  // 分域 abort：banks/wrong/index/master/summary 各自独立，互不掐断
  // （如掌握切换不再取消进行中的列表/索引加载，反之亦然）。
  const banksAbortRef = useRef<AbortController | null>(null);
  const wrongAbortRef = useRef<AbortController | null>(null);
  const indexAbortRef = useRef<AbortController | null>(null);
  const masterAbortRef = useRef<AbortController | null>(null);
  const summaryAbortRef = useRef<AbortController | null>(null);

  const loadBanks = useCallback(async () => {
    banksAbortRef.current?.abort();
    const controller = new AbortController();
    banksAbortRef.current = controller;
    setBanks({ phase: 'loading' });
    try {
      const items = await listBanks(undefined, controller.signal);
      if (controller.signal.aborted) return;
      setBanks({ phase: 'ready', banks: items });
    } catch (err) {
      if (controller.signal.aborted) return; // Abort 静默：不把取消误报为错误
      setBanks({ phase: 'error', error: err as ExamErrorDto });
    }
  }, []);

  const loadWrong = useCallback(async (bankId: string) => {
    wrongAbortRef.current?.abort();
    const controller = new AbortController();
    wrongAbortRef.current = controller;
    setWrong({ phase: 'loading' });
    try {
      const items = await listWrong(
        { bankId: bankId === 'all' ? undefined : bankId, includeMastered: true },
        controller.signal,
      );
      if (controller.signal.aborted) return;
      setWrong({ phase: 'ready', wrong: items });
    } catch (err) {
      if (controller.signal.aborted) return;
      setWrong({ phase: 'error', error: err as ExamErrorDto });
    }
  }, []);

  /** 拉取错题涉及题库的题目内容（全部题库时逐库拉取）。 */
  const loadQuestionIndex = useCallback(async (bankId: string, bankList: ExamBankDto[]) => {
    indexAbortRef.current?.abort();
    const controller = new AbortController();
    indexAbortRef.current = controller;
    setIndex({ phase: 'loading' });
    try {
      const targets = bankId === 'all' ? bankList : bankList.filter((b) => b.id === bankId);
      const lists = await Promise.all(targets.map((b) => listQuestions(b.id, undefined, controller.signal)));
      if (controller.signal.aborted) return;
      const byId = new Map<string, ExamQuestionDto>();
      for (const items of lists) for (const q of items) byId.set(q.id, q);
      setIndex({ phase: 'ready', byId });
    } catch (err) {
      if (controller.signal.aborted) return;
      setIndex({ phase: 'error', error: err as ExamErrorDto });
    }
  }, []);

  useEffect(() => {
    void loadBanks();
    return () => {
      banksAbortRef.current?.abort();
      wrongAbortRef.current?.abort();
      indexAbortRef.current?.abort();
      masterAbortRef.current?.abort();
      summaryAbortRef.current?.abort();
    };
  }, [loadBanks]);

  /**
   * Phase 4：展开条目时惰性探测缓存解析摘要（只读，无生成入口）。
   * 探测按 GET 契约需 practiceId：取包含该题的最近一个练习会话（history 按新到旧，
   * 服务端按该会话内该题最新作答答案定位缓存键）；无会话/未判分/无缓存 → miss 不渲染。
   */
  const probeExplainSummary = useCallback(
    async (questionId: string) => {
      summaryAbortRef.current?.abort();
      const controller = new AbortController();
      summaryAbortRef.current = controller;
      setExplainSummary({ questionId, status: 'probing' });
      let sessions = historyItems;
      if (sessions === null) {
        try {
          sessions = await listPracticeHistory(controller.signal);
          setHistoryItems(sessions);
        } catch {
          // 历史不可用 → 视为无摘要（错题本主流程不受影响）
          if (!controller.signal.aborted) setExplainSummary({ questionId, status: 'miss' });
          return;
        }
      }
      const host = sessions.find((item) => item.practice.questionIds.includes(questionId));
      if (host === undefined || controller.signal.aborted) {
        if (!controller.signal.aborted) setExplainSummary({ questionId, status: 'miss' });
        return;
      }
      try {
        const explanation = await fetchPracticeExplanation(host.practice.id, questionId, 'light', controller.signal);
        if (controller.signal.aborted) return;
        setExplainSummary(
          explanation
            ? { questionId, status: 'hit', explanation }
            : { questionId, status: 'miss' },
        );
      } catch {
        if (!controller.signal.aborted) setExplainSummary({ questionId, status: 'miss' });
      }
    },
    [historyItems],
  );

  /** 展开/收起：展开时触发摘要惰性探测；收起即中止探测并清理探测态。 */
  const onToggleExpand = (questionId: string) => {
    if (expandedId === questionId) {
      summaryAbortRef.current?.abort();
      setExpandedId(null);
      setExplainSummary(null);
      return;
    }
    setExpandedId(questionId);
    void probeExplainSummary(questionId);
  };

  useEffect(() => {
    if (banks.phase !== 'ready') return;
    void loadWrong(bankFilter);
    void loadQuestionIndex(bankFilter, banks.banks);
  }, [banks, bankFilter, loadWrong, loadQuestionIndex]);

  // t13 定位意图：切全库 → 展开该题（复用 onToggleExpand 触发摘要探测）→ 列表就绪后滚动定位。
  const focusHandledRef = useRef<number | null>(null);
  useEffect(() => {
    if (focusQuestion === undefined || focusQuestion === null) return;
    if (focusHandledRef.current === focusQuestion.nonce) return;
    focusHandledRef.current = focusQuestion.nonce;
    setBankFilter('all');
    if (expandedId !== focusQuestion.questionId) {
      onToggleExpand(focusQuestion.questionId);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusQuestion]);

  useEffect(() => {
    if (focusQuestion === undefined || focusQuestion === null) return;
    if (focusHandledRef.current !== focusQuestion.nonce) return;
    if (expandedId !== focusQuestion.questionId) return;
    if (wrong.phase !== 'ready' || wrong.wrong.some((entry) => entry.questionId === focusQuestion.questionId) === false) {
      return;
    }
    // 列表渲染后的下一帧再滚动，确保目标行已挂载
    const frame = requestAnimationFrame(() => {
      const el = document.querySelector<HTMLElement>(`[data-wrong-question-id="${focusQuestion.questionId}"]`);
      el?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    });
    return () => cancelAnimationFrame(frame);
  }, [focusQuestion, expandedId, wrong]);

  const onToggleMastered = async (entry: WrongEntryDto) => {
    if (toggleBusy !== null) return; // busy 防护：同一时刻只允许一个掌握切换在途
    setToggleBusy(entry.questionId);
    setMasterError(null);
    masterAbortRef.current?.abort();
    const controller = new AbortController();
    masterAbortRef.current = controller;
    try {
      const updated = await setMastered(entry.questionId, !entry.mastered, controller.signal);
      if (controller.signal.aborted) return; // Abort 静默
      setWrong((prev) =>
        prev.phase === 'ready'
          ? { ...prev, wrong: prev.wrong.map((w) => (w.questionId === updated.questionId ? updated : w)) }
          : prev,
      );
    } catch (err) {
      if (controller.signal.aborted) return;
      // 掌握失败 → 行级错误：仅标记出错行，不把整个错题列表打成 error 态
      setMasterError({ questionId: entry.questionId, error: err as ExamErrorDto });
    } finally {
      setToggleBusy(null);
    }
  };

  const rows = wrong.phase === 'ready' ? wrong.wrong : [];

  // 错题分组：高频（错 ≥3 次）/ 近期 / 已掌握
  const groups = useMemo(() => {
    const highFreq = rows.filter((e) => e.wrongCount >= 3 && !e.mastered);
    const recent = rows.filter((e) => e.wrongCount < 3 && !e.mastered);
    const mastered = rows.filter((e) => e.mastered);
    return [
      { title: `高频错题 · ${highFreq.length} 题（错 ≥3 次）`, items: highFreq },
      { title: `近期错题 · ${recent.length} 题`, items: recent },
      { title: `已掌握 · ${mastered.length} 题`, items: mastered },
    ].filter((g) => g.items.length > 0);
  }, [rows]);

  // t10：多选重练。所选题目必须属于同一题库（startPractice 校验同库）；
  // 返回该库 id；跨库返回 '__mixed__'，无法确定返回 null。
  const selectedBankId = useMemo(() => {
    if (selectedIds.length === 0) return null;
    const bankSet = new Set<string>();
    for (const id of selectedIds) {
      const q = index.phase === 'ready' ? index.byId.get(id) : undefined;
      if (q) bankSet.add(q.bankId);
    }
    if (bankSet.size === 0) return bankFilter === 'all' ? null : bankFilter;
    if (bankSet.size > 1) return '__mixed__';
    return [...bankSet][0]!;
  }, [selectedIds, index, bankFilter]);

  const toggleSelect = (id: string) => {
    setSelectedIds((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  };

  const allSelected = rows.length > 0 && rows.every((e) => selectedIds.includes(e.questionId));
  const toggleSelectAll = () => {
    setSelectedIds((prev) => (prev.length === rows.length && rows.every((e) => prev.includes(e.questionId)) ? [] : rows.map((e) => e.questionId)));
  };

  // 列表刷新/切换题库后移除已不存在的选择，避免跨库残留误操作。
  // 依赖 wrong 状态对象（loadWrong 才换引用），而非每次渲染都新造的 rows 数组，
  // 防止「值相等的空数组也总是新引用 → 依赖变化 → 反复 setState」的死循环。
  useEffect(() => {
    if (wrong.phase !== 'ready') return;
    const ids = new Set(wrong.wrong.map((e) => e.questionId));
    setSelectedIds((prev) => (prev.every((id) => ids.has(id)) ? prev : prev.filter((id) => ids.has(id))));
  }, [wrong]);

  /** 「重做此题」：单题直达（用 PracticeScope.questionIds）。 */
  const redoOne = (entry: WrongEntryDto) => {
    const q = index.phase === 'ready' ? index.byId.get(entry.questionId) : undefined;
    onPracticeWrong?.({ bankId: q?.bankId ?? (bankFilter === 'all' ? undefined : bankFilter), questionIds: [entry.questionId] });
  };

  return (
    <div className="exam-assistant-workspace">
      <div>
        <button type="button" className="exam-assistant-button exam-assistant-button--ghost" onClick={onBack}>
          ← 返回
        </button>
        <h2 className="exam-assistant-workspace__headline">错题本</h2>
        <p className="exam-assistant-workspace__subtitle">按题库筛选 · 单题/多选重练 · 掌握标记切换 · 展开查看题目与答案</p>
      </div>

      <div className="exam-assistant-form-row exam-assistant-sticky">
        <label className="exam-assistant-form-label" htmlFor="exam-w-bank">
          题库筛选
        </label>
        {banks.phase === 'loading' ? (
          <span className="exam-assistant-llm__meta">加载题库…</span>
        ) : banks.phase === 'error' ? (
          <span className="exam-assistant-error">{examErrorMessage(banks.error)}</span>
        ) : (
          <select
            id="exam-w-bank"
            className="exam-assistant-input"
            value={bankFilter}
            onChange={(event) => setBankFilter(event.target.value)}
          >
            <option value="all">全部题库</option>
            {banks.banks.map((b) => (
              <option key={b.id} value={b.id}>
                {b.name}
              </option>
            ))}
          </select>
        )}
        {onPracticeWrong ? (
          <button
            type="button"
            className="exam-assistant-button exam-assistant-button--ghost exam-assistant-button--sm"
            onClick={() =>
              onPracticeWrong({ bankId: bankFilter === 'all' ? undefined : bankFilter })
            }
          >
            去练习这些错题 →
          </button>
        ) : null}
      </div>

      {/* t10：多选重练批量条（全选 + 练习所选 + 清空） */}
      {onPracticeWrong ? (
        <div className="exam-assistant-form-row exam-assistant-batchbar" role="group" aria-label="多选重练">
          <label className="exam-assistant-batchbar__label">
            <input type="checkbox" checked={allSelected} onChange={toggleSelectAll} aria-label="全选当前错题" />
            全选
          </label>
          {selectedIds.length > 0 ? (
            <>
              <span className="exam-assistant-llm__meta">已选 {selectedIds.length} 题</span>
              {selectedBankId === '__mixed__' ? (
                <span className="exam-assistant-error" role="alert">
                  所选题目跨多个题库，请按题库筛选后可重练
                </span>
              ) : (
                <button
                  type="button"
                  className="exam-assistant-button exam-assistant-button--ghost exam-assistant-button--sm"
                  onClick={() =>
                    onPracticeWrong({
                      bankId: selectedBankId === null ? undefined : selectedBankId,
                      questionIds: selectedIds,
                    })
                  }
                >
                  练习所选 →
                </button>
              )}
              <button
                type="button"
                className="exam-assistant-button exam-assistant-button--ghost exam-assistant-button--sm"
                onClick={() => setSelectedIds([])}
              >
                清空
              </button>
            </>
          ) : null}
        </div>
      ) : null}

      {wrong.phase === 'loading' ? (
        <div className="exam-assistant-skeleton">正在读取错题…</div>
      ) : wrong.phase === 'error' ? (
        <p className="exam-assistant-error" role="alert">
          {examErrorMessage(wrong.error)}
        </p>
      ) : rows.length === 0 ? (
        <p className="exam-assistant-empty">暂无错题{index.phase === 'loading' ? '（题目索引加载中…）' : ''}</p>
      ) : (
        <div>
          {groups.map((group) => (
            <div key={group.title} className="exam-assistant-history-group">
              <p className="exam-assistant-history-group__title">{group.title}</p>
              <ul className="exam-assistant-wrong-list">
                {group.items.map((entry) => {
                  const question =
                    index.phase === 'ready' ? (index.byId.get(entry.questionId) ?? null) : null;
                  const expanded = expandedId === entry.questionId;
                  return (
                    <li
                      key={entry.questionId}
                      data-wrong-question-id={entry.questionId}
                      className={
                        entry.mastered
                          ? 'exam-assistant-wrong-item exam-assistant-wrong-item--mastered'
                          : 'exam-assistant-wrong-item'
                      }
                    >
                      <div className="exam-assistant-wrong-item__head">
                        <input
                          type="checkbox"
                          className="exam-assistant-wrong-item__check"
                          checked={selectedIds.includes(entry.questionId)}
                          onChange={() => toggleSelect(entry.questionId)}
                          aria-label={`选择本题（${question ? question.stem : entry.questionId}）`}
                        />
                        <button
                          type="button"
                          className="exam-assistant-wrong-item__main"
                          onClick={() => onToggleExpand(entry.questionId)}
                          aria-expanded={expanded}
                          aria-controls={expanded ? `exam-wrong-detail-${entry.questionId}` : undefined}
                        >
                          <span className="exam-assistant-wrong-item__stem">
                            {question ? question.stem : entry.questionId}
                          </span>
                          <span className="exam-assistant-wrong-item__meta">
                            最近 {formatTime(entry.lastWrongAt)}
                            {question ? ` · ${questionTypeLabel(question.type)}` : ''}
                            {entry.consecutiveCorrect > 0 ? ` · 连续答对 ${entry.consecutiveCorrect} 次` : ''}
                            {entry.lifetimeWrongCount > 0 ? ` · 累计错 ${entry.lifetimeWrongCount} 次` : ''}
                          </span>
                        </button>
                        <span className="exam-assistant-wrong-item__count-badge">错 {entry.wrongCount} 次</span>
                        {entry.mastered && (entry.masterySource === 'manual' || entry.masterySource === 'computed') ? (
                          <span
                            className="exam-assistant-wrong-item__mastery"
                            title="掌握来源：手动标记或连续答对自动判定"
                          >
                            {entry.masterySource === 'manual' ? '手动掌握' : '自动掌握'}
                          </span>
                        ) : null}
                        <button
                          type="button"
                          className={
                            entry.mastered
                              ? 'exam-assistant-button exam-assistant-button--sm exam-assistant-button--mastered'
                              : 'exam-assistant-button exam-assistant-button--ghost exam-assistant-button--sm'
                          }
                          onClick={() => void onToggleMastered(entry)}
                          disabled={toggleBusy === entry.questionId}
                        >
                          {toggleBusy === entry.questionId
                            ? '…'
                            : entry.mastered
                              ? '已掌握'
                              : '标记掌握'}
                        </button>
                      </div>
                      {entry.lastResult === true && !entry.mastered ? (
                        /* 最近一次答对但未掌握：提示可标记（连续答对达标将自动置位） */
                        <p className="exam-assistant-wrong-item__suggest">
                          已答对 —— 考虑「标记掌握」（连续答对达标后也会自动掌握）
                        </p>
                      ) : null}
                      {masterError !== null && masterError.questionId === entry.questionId ? (
                        <p className="exam-assistant-wrong-item__error" role="alert">
                          掌握操作失败：{examErrorMessage(masterError.error)}（请重试）
                        </p>
                      ) : null}
                      {expanded ? (
                        <div id={`exam-wrong-detail-${entry.questionId}`} className="exam-assistant-wrong-item__detail">
                          {question ? (
                            <>
                              {question.options.length > 0 ? (
                                <ul className="exam-assistant-option-list">
                                  {question.options.map((opt, i) => {
                                    const correctIdxs = correctOptionIdxs(question);
                                    const lastIdxs = lastAnswerOptionIdxs(entry.lastAnswer);
                                    const modifier =
                                      correctIdxs?.has(i)
                                        ? ' exam-assistant-answer-row--correct'
                                        : lastIdxs?.has(i)
                                          ? ' exam-assistant-answer-row--wrong'
                                          : '';
                                    return (
                                      <li key={i} className={`exam-assistant-answer-row${modifier}`}>
                                        {optionLabel(i)}. {opt}
                                      </li>
                                    );
                                  })}
                                </ul>
                              ) : null}
                              <p className="exam-assistant-kv">
                                <span className="exam-assistant-kv__key">正确答案</span>
                                <span className="exam-assistant-kv__value">{answerText(question)}</span>
                                {question.type !== 'essay' && entry.lastAnswer !== null ? (
                                  <>
                                    <span className="exam-assistant-kv__key">你的作答</span>
                                    <span className="exam-assistant-kv__value">
                                      {lastAnswerText(entry.lastAnswer) ?? '（无法解析）'}
                                    </span>
                                  </>
                                ) : null}
                                {question.explanation ? (
                                  <>
                                    <span className="exam-assistant-kv__key">解析</span>
                                    <span className="exam-assistant-kv__value">{question.explanation}</span>
                                  </>
                                ) : null}
                              </p>
                              {/* Phase 4：缓存解析摘要（只读折叠；无生成入口，重做走练习） */}
                              {explainSummary !== null &&
                              explainSummary.questionId === entry.questionId &&
                              explainSummary.status === 'hit' ? (
                                <details className="exam-assistant-explain-summary">
                                  <summary>AI 解析（按你最近一次作答）</summary>
                                  <pre className="exam-assistant-explain-summary__content">
                                    {explainSummary.explanation.content}
                                  </pre>
                                  <p className="exam-assistant-explain-summary__meta">
                                    供应商 {explainSummary.explanation.provider ?? '—'} · 模型{' '}
                                    {explainSummary.explanation.model ?? '—'} · 思考{' '}
                                    {explainSummary.explanation.reasoningEffort ?? '默认'}
                                  </p>
                                </details>
                              ) : null}
                              {onPracticeWrong ? (
                                // 单题重练：用 PracticeScope.questionIds 直达本题（t9 新增显式题目集合）
                                <div className="exam-assistant-form-actions">
                                  <button
                                    type="button"
                                    className="exam-assistant-button exam-assistant-button--ghost exam-assistant-button--sm"
                                    onClick={() => redoOne(entry)}
                                  >
                                    重做此题 →
                                  </button>
                                </div>
                              ) : null}
                            </>
                          ) : index.phase === 'loading' ? (
                            <div className="exam-assistant-skeleton">题目索引加载中…</div>
                          ) : (
                            <p className="exam-assistant-empty">题目内容不可用（questionId {entry.questionId}）</p>
                          )}
                        </div>
                      ) : null}
                    </li>
                  );
                })}
              </ul>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
