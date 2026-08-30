/**
 * ExamWorkspace —— Phase 0/1/2/3 贯通页面（渲染在 shell.overlay 面板内）。
 *
 * Phase 0：标题 + Host health + 题库列表 + 新建题库表单 + DSH LLM 流式测试。
 * Phase 1（t11）：顶部 tab 切换 —— 题库 / 练习 / 错题 / 设置占位；
 *   题库 tab 内含列表 ↔ 详情（BankDetail）两级视图；不引入路由库（内部 tab 状态）。
 * Phase 2（t24）：tab 扩展 —— 题库 / 练习 / 错题 / AI / 学情 / 设置；
 *   AI tab（AiTools：Tutor 对话 + AI 导入），题库题目「AI 讲解」入口携带题目对象跳 AI tab；
 *   学情 tab（Insights：洞察 / 诊断 / 学习计划）。
 * Phase 3（s4）：信息架构重排 —— tab 为 题库 / 练习 / 错题本 / AI 学习 / 学情；
 *   移除 workspace 内 health 大卡（Host 状态移入 DSH 设置页「考试助手」分区，s5 完善）；
 *   题库列表升级为卡片网格（学士帽封面 + 题数徽章 + 建库时间）。
 *
 * API 根路径固定 /exam/api（api.ts）；所有区域有 loading/error/empty 状态；
 * LLM 测试用 fetch + ReadableStream 消费 POST SSE（sse.ts），AbortController 可取消。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { archiveBank, createBank, deleteBank, listBanks, listQuestions, renameBank, restoreBank, streamLlmTest } from './api.ts';
import type { ExamBankDto, ExamErrorDto, ExamQuestionDto } from './types.ts';
import { formatTime } from './ui-helpers.ts';
import { AiTools } from './AiTools.tsx';
import { BankDetail } from './BankDetail.tsx';
import { Insights } from './Insights.tsx';
import { PracticeView, type PracticeIntent } from './PracticeView.tsx';
import { StreamingPlaceholder } from './Streaming.tsx';
import { WrongView } from './WrongView.tsx';

type Tab = 'banks' | 'practice' | 'wrong' | 'ai' | 'insights';

type BanksState =
  | { phase: 'loading' }
  | { phase: 'error'; error: ExamErrorDto }
  | { phase: 'ready'; banks: ExamBankDto[] };

type CreateState =
  | { phase: 'idle' }
  | { phase: 'submitting' }
  | { phase: 'error'; error: ExamErrorDto }
  | { phase: 'created'; bank: ExamBankDto };

type LlmState =
  | { phase: 'idle' }
  | { phase: 'streaming'; text: string }
  | { phase: 'done'; text: string; result: string }
  | { phase: 'error'; error: ExamErrorDto };

const DEFAULT_PROMPT = '用一句话介绍你自己，并说明你可以如何帮助用户备考。';

const TABS: { id: Tab; label: string }[] = [
  { id: 'banks', label: '题库' },
  { id: 'practice', label: '练习' },
  { id: 'wrong', label: '错题本' },
  { id: 'ai', label: 'AI 学习' },
  { id: 'insights', label: '学情' },
];

export function ExamWorkspace() {
  const [tab, setTab] = useState<Tab>('banks');
  const [detailBank, setDetailBank] = useState<ExamBankDto | null>(null);
  /** 「AI 讲解」入口携带的题目（切到 AI tab 并绑定 Tutor 会话）。 */
  const [aiQuestion, setAiQuestion] = useState<ExamQuestionDto | null>(null);
  /** 练习解析卡「有疑问？与 AI 对话」入口：绑定题目 + 预填首条消息（跳到 AI tab）。 */
  const [aiAsk, setAiAsk] = useState<{ boundQuestion: ExamQuestionDto; prefilledPrompt: string } | null>(null);
  /**
   * 跨模块练习意图（错题本→练习 / 学情→练习）：携带至 PracticeView 预填 setup 表单。
   * 纯 client 兼容层：不依赖任何新 Host API（练习范围契约已存在）。
   */
  const [practiceIntent, setPracticeIntent] = useState<PracticeIntent | null>(null);
  /** 从错题/学情进入练习后的「完成/退出」返回目标 tab；直接点练习 tab 时重置为题库。 */
  const [practiceReturnTab, setPracticeReturnTab] = useState<Tab>('banks');
  /**
   * 错题本定位意图（t13）：学情页错题 Top10/下钻点击 → 携带 questionId 与触发序号，
   * WrongView 切全库、展开该题并滚动定位。nonce 保证同题重复点击也能再次触发。
   */
  const [wrongFocus, setWrongFocus] = useState<{ questionId: string; nonce: number } | null>(null);

  /** 统一 tab 选择：直接点选/键盘进入练习 tab 视为直达入口，返回目标重置为题库。 */
  const selectTab = (id: Tab) => {
    if (id === 'practice' && tab !== 'practice') setPracticeReturnTab('banks');
    setTab(id);
  };

  const goPractice = (intent: PracticeIntent, source: Tab) => {
    setPracticeReturnTab(source);
    setPracticeIntent(intent);
    setTab('practice');
  };

  /** 练习解析卡「有疑问？与 AI 对话」：跳 AI tab、绑定本题、预填首条消息（§3.3）。 */
  const onAskQuestion = (question: ExamQuestionDto, followUp?: string) => {
    setAiAsk({
      boundQuestion: question,
      prefilledPrompt: followUp !== undefined ? followUp : '我看了解析，还有疑问：',
    });
    setTab('ai');
  };

  /** AiTools 应用完 initialAsk 后清空，避免重复触发绑定/预填。 */
  const clearAiAsk = () => setAiAsk(null);

  /**
   * 顶层 tab 键盘导航（WAI-ARIA tabs 模式）：←/→ 循环切换，Home/End 跳首尾；
   * 自动激活（简单 tab 组，无需手动 Enter/Space）。roving tabindex 由渲染侧
   * 按选中态给出（选中 0 / 其余 -1），屏幕阅读器只感知选中 tab 在 tab 序中。
   */
  const onTabKeyDown = (event: React.KeyboardEvent<HTMLButtonElement>, id: Tab) => {
    const idx = TABS.findIndex((t) => t.id === id);
    if (idx === -1) return;
    let next: Tab | null = null;
    if (event.key === 'ArrowRight') next = TABS[(idx + 1) % TABS.length]!.id;
    else if (event.key === 'ArrowLeft') next = TABS[(idx - 1 + TABS.length) % TABS.length]!.id;
    else if (event.key === 'Home') next = TABS[0]!.id;
    else if (event.key === 'End') next = TABS[TABS.length - 1]!.id;
    else return;
    event.preventDefault();
    selectTab(next);
  };

  const [banks, setBanks] = useState<BanksState>({ phase: 'loading' });
  /** 各题库题目数（拉取失败/进行中 = 缺省，徽章隐藏）。 */
  const [bankCounts, setBankCounts] = useState<Record<string, number | null>>({});
  const [create, setCreate] = useState<CreateState>({ phase: 'idle' });
  const [llm, setLlm] = useState<LlmState>({ phase: 'idle' });
  const [prompt, setPrompt] = useState(DEFAULT_PROMPT);

  // ── t10 题库生命周期：归档筛选 + 卡片「更多」菜单（重命名/归档/恢复/删除） ──
  const [showArchived, setShowArchived] = useState(false);
  /** 当前打开「更多」菜单的题库 id；null = 关闭。 */
  const [menuBankId, setMenuBankId] = useState<string | null>(null);
  /** 正在重命名的题库 id；null = 无。 */
  const [renameBankId, setRenameBankId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');
  /** 软删除两步确认中的题库 id。 */
  const [confirmDeleteBankId, setConfirmDeleteBankId] = useState<string | null>(null);
  /** 卡片操作失败的行级错误（不整页回退）。 */
  const [bankActionError, setBankActionError] = useState<{ bankId: string; error: ExamErrorDto } | null>(null);
  const [bankActionBusy, setBankActionBusy] = useState<{ bankId: string; kind: string } | null>(null);

  // 取消令牌：卸载/重新加载时 abort 在途请求
  const banksAbort = useRef<AbortController | null>(null);
  const llmAbort = useRef<AbortController | null>(null);

  const loadBanks = useCallback(async () => {
    banksAbort.current?.abort();
    const controller = new AbortController();
    banksAbort.current = controller;
    setBanks({ phase: 'loading' });
    try {
      const items = await listBanks({ includeArchived: showArchived }, controller.signal);
      setBanks({ phase: 'ready', banks: items });
      // 题数徽章：并行拉取各库题目数（本地 HTTP，量小；失败则该库徽章隐藏）
      const counts: Record<string, number | null> = {};
      await Promise.allSettled(
        items.map(async (b) => {
          const qs = await listQuestions(b.id, undefined, controller.signal);
          counts[b.id] = qs.length;
        }),
      );
      setBankCounts(counts);
    } catch (err) {
      setBanks({ phase: 'error', error: err as ExamErrorDto });
    }
  }, [showArchived]);

  // 挂载时加载 banks
  useEffect(() => {
    void loadBanks();
    return () => {
      banksAbort.current?.abort();
      llmAbort.current?.abort();
    };
  }, [loadBanks]);

  // 新建题库
  const onCreateBank = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = event.currentTarget;
    const input = form.elements.namedItem('bank-name') as HTMLInputElement | null;
    const name = input?.value.trim() ?? '';
    if (name.length === 0) return;
    setCreate({ phase: 'submitting' });
    try {
      const bank = await createBank(name);
      setCreate({ phase: 'created', bank });
      if (input) input.value = '';
      void loadBanks();
    } catch (err) {
      setCreate({ phase: 'error', error: err as ExamErrorDto });
    }
  };

  // LLM 流式测试
  const onRunLlm = async () => {
    const text = prompt.trim();
    if (text.length === 0) return;
    llmAbort.current?.abort();
    const controller = new AbortController();
    llmAbort.current = controller;
    setLlm({ phase: 'streaming', text: '' });
    await streamLlmTest(
      text,
      {
        onDelta: (delta) => {
          setLlm((prev) => ({
            phase: 'streaming',
            text: prev.phase === 'streaming' ? prev.text + delta : delta,
          }));
        },
        onDone: (result) => {
          setLlm((prev) => ({
            phase: 'done',
            text: prev.phase === 'streaming' ? prev.text : '',
            result: `finish=${result.finish} provider=${result.provider} model=${result.model}`,
          }));
        },
        onError: (error) => {
          setLlm({ phase: 'error', error });
        },
      },
      { signal: controller.signal },
    );
  };

  const onCancelLlm = () => {
    llmAbort.current?.abort();
    // streamSse 会回调 onError(EXAM_LLM_ABORTED)，由状态机落到 error
  };

  // ── t10 题库卡片菜单操作 ──

  /** 在题库列表里就地替换某库（重命名/归档/恢复后的局部更新）。 */
  const patchBankLocal = (updated: ExamBankDto) => {
    setBanks((prev) =>
      prev.phase === 'ready'
        ? { ...prev, banks: prev.banks.map((b) => (b.id === updated.id ? updated : b)) }
        : prev,
    );
  };

  const openMenu = (id: string) => setMenuBankId((prev) => (prev === id ? null : id));
  const closeMenu = () => {
    setMenuBankId(null);
    setRenameBankId(null);
    setRenameValue('');
    setConfirmDeleteBankId(null);
  };

  // 菜单打开时：点击菜单/kebab 以外区域关闭（滚动容器内 absolute 菜单，无 portal；
  // 缺省不关会造成「菜单一直挂着」的粘滞感）
  useEffect(() => {
    if (menuBankId === null) return;
    const onMouseDown = (event: MouseEvent) => {
      const target = event.target as HTMLElement | null;
      if (target === null) return;
      if (target.closest('.exam-assistant-bank-menu') !== null) return;
      if (target.closest(`[data-bank-menu-trigger="${menuBankId}"]`) !== null) return;
      closeMenu();
    };
    document.addEventListener('mousedown', onMouseDown);
    return () => document.removeEventListener('mousedown', onMouseDown);
  }, [menuBankId]);

  const startRename = (bank: ExamBankDto) => {
    setRenameBankId(bank.id);
    setRenameValue(bank.name);
    setBankActionError(null);
  };

  const submitRename = async (bankId: string) => {
    const name = renameValue.trim();
    if (name.length === 0) return;
    if (bankActionBusy !== null) return; // busy 防护
    setBankActionBusy({ bankId, kind: 'rename' });
    setBankActionError(null);
    try {
      const updated = await renameBank(bankId, name);
      patchBankLocal(updated);
      closeMenu();
    } catch (err) {
      setBankActionError({ bankId, error: err as ExamErrorDto });
    } finally {
      setBankActionBusy(null);
    }
  };

  const onArchive = async (bankId: string) => {
    if (bankActionBusy !== null) return;
    setBankActionBusy({ bankId, kind: 'archive' });
    setBankActionError(null);
    try {
      await archiveBank(bankId);
      // 归档后默认从活跃列表移除；若用户正在看归档列表则局部保持（archivedAt 已置位）
      if (showArchived) {
        const archived = await listBanks({ includeArchived: true });
        setBanks({ phase: 'ready', banks: archived });
      } else {
        setBanks((prev) =>
          prev.phase === 'ready' ? { ...prev, banks: prev.banks.filter((b) => b.id !== bankId) } : prev,
        );
      }
      setBankCounts((prev) => {
        const next = { ...prev };
        delete next[bankId];
        return next;
      });
      closeMenu();
    } catch (err) {
      setBankActionError({ bankId, error: err as ExamErrorDto });
    } finally {
      setBankActionBusy(null);
    }
  };

  const onRestore = async (bankId: string) => {
    if (bankActionBusy !== null) return;
    setBankActionBusy({ bankId, kind: 'restore' });
    setBankActionError(null);
    try {
      const updated = await restoreBank(bankId);
      // 恢复后回到活跃列表（若没看归档则直接出现在列表里）
      void loadBanks();
      patchBankLocal(updated);
      closeMenu();
    } catch (err) {
      setBankActionError({ bankId, error: err as ExamErrorDto });
    } finally {
      setBankActionBusy(null);
    }
  };

  const onDeleteBank = async (bankId: string) => {
    if (bankActionBusy !== null) return;
    if (confirmDeleteBankId !== bankId) {
      setConfirmDeleteBankId(bankId);
      return;
    }
    setBankActionBusy({ bankId, kind: 'delete' });
    setBankActionError(null);
    try {
      await deleteBank(bankId);
      setBanks((prev) =>
        prev.phase === 'ready' ? { ...prev, banks: prev.banks.filter((b) => b.id !== bankId) } : prev,
      );
      setBankCounts((prev) => {
        const next = { ...prev };
        delete next[bankId];
        return next;
      });
      closeMenu();
    } catch (err) {
      setBankActionError({ bankId, error: err as ExamErrorDto });
    } finally {
      setBankActionBusy(null);
    }
  };

  return (
    <div className="exam-assistant-workspace">
      {/* tab 切换 */}
      <nav className="exam-assistant-tabs exam-assistant-tabs--sticky" role="tablist" aria-label="考试助手功能">
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            id={`exam-workspace-tab-${t.id}`}
            aria-selected={tab === t.id}
            aria-controls={`exam-workspace-panel-${t.id}`}
            tabIndex={tab === t.id ? 0 : -1}
            className={tab === t.id ? 'exam-assistant-tab exam-assistant-tab--active' : 'exam-assistant-tab'}
            onClick={() => selectTab(t.id)}
            onKeyDown={(event) => onTabKeyDown(event, t.id)}
          >
            {t.label}
          </button>
        ))}
      </nav>

      {/* ── 题库 tab（常驻挂载 + hidden：保留钻取/表单/列表状态） ── */}
      <div
        role="tabpanel"
        id="exam-workspace-panel-banks"
        aria-labelledby="exam-workspace-tab-banks"
        className="exam-assistant-workspace"
        hidden={tab !== 'banks'}
      >
        {detailBank === null ? (
          <>
            {/* 题库列表（卡片网格） */}
            <section className="exam-assistant-card" aria-label="题库列表">
              <div className="exam-assistant-row exam-assistant-sticky">
                <h2 className="exam-assistant-card__title">题库</h2>
                <div className="exam-assistant-form-actions">
                  <button
                    type="button"
                    className={
                      showArchived
                        ? 'exam-assistant-button exam-assistant-button--ghost exam-assistant-button--sm exam-assistant-bank-archive-toggle exam-assistant-bank-archive-toggle--on'
                        : 'exam-assistant-button exam-assistant-button--ghost exam-assistant-button--sm exam-assistant-bank-archive-toggle'
                    }
                    aria-pressed={showArchived}
                    onClick={() => setShowArchived((prev) => !prev)}
                  >
                    含归档 {showArchived ? '✓' : ''}
                  </button>
                  <button type="button" className="exam-assistant-button exam-assistant-button--ghost exam-assistant-button--sm" onClick={() => void loadBanks()}>
                    刷新
                  </button>
                </div>
              </div>
              {banks.phase === 'loading' ? (
                <div className="exam-assistant-skeleton">正在读取 /exam/api/banks …</div>
              ) : banks.phase === 'error' ? (
                <p className="exam-assistant-error">
                  {banks.error.code}: {banks.error.message}
                </p>
              ) : banks.banks.length === 0 ? (
                <p className="exam-assistant-empty">暂无题库 —— 使用下方表单新建第一个题库</p>
              ) : (
                <ul className="exam-assistant-bank-list">
                  {banks.banks.map((bank) => {
                    const count = bankCounts[bank.id];
                    const menuOpen = menuBankId === bank.id;
                    const busy = bankActionBusy !== null ? bankActionBusy.bankId === bank.id : false;
                    const renaming = renameBankId === bank.id;
                    return (
                      <li key={bank.id} className="exam-assistant-bank-card">
                        <button
                          type="button"
                          className="exam-assistant-bank-item exam-assistant-bank-item--button"
                          onClick={() => {
                            closeMenu();
                            setDetailBank(bank);
                          }}
                        >
                          <span className="exam-assistant-bank-item__icon" aria-hidden="true">
                            {/* 内联 SVG 学士帽（与侧栏入口同款，lucide graduation-cap 图形） */}
                            <svg
                              xmlns="http://www.w3.org/2000/svg"
                              width="20"
                              height="20"
                              viewBox="0 0 24 24"
                              fill="none"
                              stroke="currentColor"
                              strokeWidth="2"
                              strokeLinecap="round"
                              strokeLinejoin="round"
                            >
                              <path d="M21.42 10.922a1 1 0 0 0-.019-1.838L12.83 5.18a2 2 0 0 0-1.66 0L2.6 9.08a1 1 0 0 0 0 1.832l8.57 3.908a2 2 0 0 0 1.66 0z" />
                              <path d="M22 10v6" />
                              <path d="M6 12.5V16a6 3 0 0 0 12 0v-3.5" />
                            </svg>
                          </span>
                          <span className="exam-assistant-bank-item__main">
                            <span className="exam-assistant-bank-item__name">{bank.name}</span>
                            <span className="exam-assistant-bank-item__meta">
                              {bank.id} · 创建于 {formatTime(bank.createdAt)}
                              {bank.archivedAt !== null && bank.archivedAt !== undefined ? ' · 已归档' : ''}
                            </span>
                          </span>
                          {count !== null && count !== undefined ? (
                            <span className="exam-assistant-bank-item__count">{count} 题</span>
                          ) : null}
                        </button>

                        {/* 「更多」菜单：重命名 / 归档 / 恢复 / 删除 */}
                        <div className="exam-assistant-bank-card__menu">
                          <button
                            type="button"
                            className="exam-assistant-bank-card__kebab"
                            aria-haspopup="menu"
                            aria-expanded={menuOpen}
                            aria-label={`更多操作：${bank.name}`}
                            data-bank-menu-trigger={bank.id}
                            onClick={() => openMenu(bank.id)}
                          >
                            <svg
                              xmlns="http://www.w3.org/2000/svg"
                              width="16"
                              height="16"
                              viewBox="0 0 24 24"
                              fill="currentColor"
                              stroke="none"
                              aria-hidden="true"
                            >
                              <circle cx="12" cy="5" r="1.6" />
                              <circle cx="12" cy="12" r="1.6" />
                              <circle cx="12" cy="19" r="1.6" />
                            </svg>
                          </button>
                          {menuOpen ? (
                            <div
                              className="exam-assistant-bank-menu"
                              role="menu"
                              aria-label={`${bank.name} 操作`}
                              onKeyDown={(event) => {
                                if (event.key === 'Escape') {
                                  event.preventDefault();
                                  closeMenu();
                                }
                              }}
                            >
                              {renaming ? (
                                <div className="exam-assistant-bank-menu__rename">
                                  <input
                                    className="exam-assistant-input"
                                    value={renameValue}
                                    onChange={(event) => setRenameValue(event.target.value)}
                                    aria-label={`重命名题库为（${bank.name}）`}
                                    autoFocus
                                    onKeyDown={(event) => {
                                      if (event.key === 'Enter') {
                                        event.preventDefault();
                                        void submitRename(bank.id);
                                      } else if (event.key === 'Escape') {
                                        event.preventDefault();
                                        closeMenu();
                                      }
                                    }}
                                  />
                                  <div className="exam-assistant-form-actions">
                                    <button
                                      type="button"
                                      className="exam-assistant-button exam-assistant-button--sm"
                                      disabled={busy || renameValue.trim().length === 0}
                                      onClick={() => void submitRename(bank.id)}
                                    >
                                      {busy ? '保存中…' : '保存'}
                                    </button>
                                    <button
                                      type="button"
                                      className="exam-assistant-button exam-assistant-button--ghost exam-assistant-button--sm"
                                      onClick={closeMenu}
                                    >
                                      取消
                                    </button>
                                  </div>
                                </div>
                              ) : (
                                <>
                                  <button type="button" role="menuitem" className="exam-assistant-bank-menu__item" onClick={() => startRename(bank)}>
                                    重命名
                                  </button>
                                  {bank.archivedAt !== null && bank.archivedAt !== undefined ? (
                                    <button type="button" role="menuitem" className="exam-assistant-bank-menu__item" onClick={() => void onRestore(bank.id)} disabled={busy}>
                                      {busy ? '恢复中…' : '恢复归档'}
                                    </button>
                                  ) : (
                                    <button type="button" role="menuitem" className="exam-assistant-bank-menu__item" onClick={() => void onArchive(bank.id)} disabled={busy}>
                                      {busy ? '归档中…' : '归档'}
                                    </button>
                                  )}
                                  <button
                                    type="button"
                                    role="menuitem"
                                    className={
                                      confirmDeleteBankId === bank.id
                                        ? 'exam-assistant-bank-menu__item exam-assistant-bank-menu__item--danger'
                                        : 'exam-assistant-bank-menu__item'
                                    }
                                    disabled={busy}
                                    onClick={() => void onDeleteBank(bank.id)}
                                  >
                                    {confirmDeleteBankId === bank.id ? '确认删除？' : '删除'}
                                  </button>
                                  {confirmDeleteBankId === bank.id ? (
                                    <button type="button" role="menuitem" className="exam-assistant-bank-menu__item" onClick={() => setConfirmDeleteBankId(null)}>
                                      取消删除
                                    </button>
                                  ) : null}
                                </>
                              )}
                            </div>
                          ) : null}
                        </div>

                        {bankActionError !== null && bankActionError.bankId === bank.id ? (
                          <p className="exam-assistant-bank-card__error" role="alert">
                            {bankActionError.error.code}: {bankActionError.error.message}
                          </p>
                        ) : null}
                      </li>
                    );
                  })}
                </ul>
              )}

              {/* 新建题库表单 */}
              <form className="exam-assistant-form" onSubmit={(event) => void onCreateBank(event)}>
                <input
                  name="bank-name"
                  className="exam-assistant-input"
                  placeholder="新题库名称（如：高等数学）"
                  aria-label="新题库名称"
                  disabled={create.phase === 'submitting'}
                  required
                />
                <button type="submit" className="exam-assistant-button" disabled={create.phase === 'submitting'}>
                  {create.phase === 'submitting' ? '创建中…' : '新建题库'}
                </button>
              </form>
              {create.phase === 'error' ? (
                <p className="exam-assistant-error" role="alert">
                  {create.error.code}: {create.error.message}
                </p>
              ) : null}
              {create.phase === 'created' ? (
                <p className="exam-assistant-status exam-assistant-status--ok" role="status">
                  <span className="exam-assistant-status__dot" aria-hidden="true" />
                  已创建题库「{create.bank.name}」（{create.bank.id}）
                </p>
              ) : null}
            </section>

            {/* DSH LLM 流式测试 */}
            <section className="exam-assistant-card exam-assistant-llm" aria-label="DSH LLM 流式测试">
              <h2 className="exam-assistant-card__title">DSH LLM 流式测试（POST /exam/api/llm/test · SSE）</h2>
              <textarea
                className="exam-assistant-input"
                rows={3}
                value={prompt}
                onChange={(event) => setPrompt(event.target.value)}
                aria-label="测试提示词"
                placeholder="输入测试提示词…"
              />
              <div className="exam-assistant-row">
                <button
                  type="button"
                  className="exam-assistant-button"
                  onClick={() => void onRunLlm()}
                  disabled={llm.phase === 'streaming' || prompt.trim().length === 0}
                >
                  {llm.phase === 'streaming' ? '生成中…' : '开始流式测试'}
                </button>
                {llm.phase === 'streaming' ? (
                  <button type="button" className="exam-assistant-button exam-assistant-button--ghost" onClick={onCancelLlm}>
                    取消
                  </button>
                ) : null}
              </div>

              {llm.phase === 'idle' ? (
                <p className="exam-assistant-empty">尚未运行 —— 点击「开始流式测试」后逐字展示 delta</p>
              ) : llm.phase === 'streaming' ? (
                llm.text === '' ? (
                  <StreamingPlaceholder />
                ) : (
                  <pre className="exam-assistant-llm__output exam-assistant-llm__output--streaming" aria-live="polite">
                    {llm.text}
                  </pre>
                )
              ) : llm.phase === 'done' ? (
                <div>
                  <pre className="exam-assistant-llm__output">{llm.text}</pre>
                  <p className="exam-assistant-llm__meta">{llm.result}</p>
                </div>
              ) : (
                <p className="exam-assistant-error" role="alert">
                  {llm.error.code}: {llm.error.message}
                </p>
              )}
            </section>
          </>
        ) : (
          <BankDetail
            bankId={detailBank.id}
            bankName={detailBank.name}
            onBack={() => setDetailBank(null)}
            onQuestionsChanged={() => void loadBanks()}
            onAskAi={(question) => {
              setAiQuestion(question);
              setTab('ai');
            }}
          />
        )}
      </div>

      {/* ── 练习 tab（常驻挂载，hidden 保留进行中练习与表单；initialSetup 为跨模块意图） ── */}
      <div
        role="tabpanel"
        id="exam-workspace-panel-practice"
        aria-labelledby="exam-workspace-tab-practice"
        hidden={tab !== 'practice'}
      >
        <PracticeView
          banks={banks.phase === 'ready' ? banks.banks : []}
          onBack={() => setTab(practiceReturnTab)}
          initialSetup={practiceIntent ?? undefined}
          onAskQuestion={(question, followUp) => onAskQuestion(question, followUp)}
        />
      </div>

      {/* ── 错题 tab（常驻挂载；onPracticeWrong = 错题→练习跨模块意图） ── */}
      <div
        role="tabpanel"
        id="exam-workspace-panel-wrong"
        aria-labelledby="exam-workspace-tab-wrong"
        hidden={tab !== 'wrong'}
      >
        <WrongView
          onBack={() => setTab('banks')}
          focusQuestion={wrongFocus}
          onPracticeWrong={(opts) =>
            goPractice(
              {
                bankId: opts.bankId,
                mode: opts.questionIds && opts.questionIds.length > 0 ? 'all' : 'wrong',
                questionIds: opts.questionIds && opts.questionIds.length > 0 ? opts.questionIds : undefined,
              },
              'wrong',
            )
          }
        />
      </div>

      {/* ── AI tab（Tutor + AI 导入；常驻挂载保留会话/流式状态） ── */}
      <div
        role="tabpanel"
        id="exam-workspace-panel-ai"
        aria-labelledby="exam-workspace-tab-ai"
        hidden={tab !== 'ai'}
      >
        <AiTools
          banks={banks.phase === 'ready' ? banks.banks : []}
          initialQuestion={aiQuestion}
          initialAsk={aiAsk}
          onInitialAskHandled={clearAiAsk}
          onBanksChanged={() => void loadBanks()}
        />
      </div>

      {/* ── 学情 tab（洞察 / 诊断 / 计划；onPractice = 学情→练习跨模块意图） ── */}
      <div
        role="tabpanel"
        id="exam-workspace-panel-insights"
        aria-labelledby="exam-workspace-tab-insights"
        hidden={tab !== 'insights'}
      >
        <Insights
          banks={banks.phase === 'ready' ? banks.banks : []}
          onOpenWrong={(questionId) => {
            setTab('wrong');
            if (questionId !== undefined) {
              // t13：携带题目与触发序号 → 错题本切全库、展开并滚动定位。
              setWrongFocus({ questionId, nonce: Date.now() });
            }
          }}
          onPractice={(opts) => goPractice(opts, 'insights')}
          onOpenTutor={() => setTab('ai')}
          onAskQuestion={(question) => onAskQuestion(question)}
        />
      </div>
    </div>
  );
}
