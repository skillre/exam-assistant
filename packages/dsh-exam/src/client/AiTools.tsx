/**
 * AiTools —— AI tab（Phase 2）：Tutor 多轮对话 + AI 文本导入向导。
 *
 * Tutor 面板：
 * - 左列：会话列表（GET /exam/api/tutor/sessions）+「新对话」；
 * - 右列：消息流 + 输入框 + SSE 打字机（chatTutor：delta 流式 → done 定稿）；流式中可取消；
 * - 点开旧会话加载历史消息（GET /exam/api/tutor/sessions/:id → { session, messages }）；
 * - 可绑定题目（经 ExamWorkspace 从「AI 讲解」入口传入完整题目 DTO，展示题干/选项上下文，
 *   新会话携带 questionId）；支持无题自由问答；
 * - chatTutor 失败（非主动取消）时移除该次本地 user 气泡并提示重试，避免重发产生重复消息。
 *
 * AI 导入向导：
 * - textarea 粘贴资料 → generateImport（LLM 抽取 ≤8 题草稿）→ 逐题预览/编辑
 *   （type/stem/options/answer/explanation/tags）→ 选目标题库 → commitImport 批量入库。
 */
import { Fragment, useCallback, useEffect, useRef, useState } from 'react';
import {
  chatTutor,
  commitImport,
  deleteTutorSession,
  fetchTutorSessionDetail,
  generateImport,
  listTutorSessions,
} from './api.ts';
import type {
  ChatTutorResultDto,
  CreateQuestionRequest,
  ExamBankDto,
  ExamErrorDto,
  ExamQuestionDto,
  ExamQuestionType,
  ImportedQuestion,
  TutorMessageDto,
  TutorSessionDto,
} from './types.ts';
import {
  csvToTags,
  formatTime,
  identifierToIndex,
  optionLabel,
  questionTypeLabel,
  tagsToCsv,
} from './ui-helpers.ts';
import { StreamingPlaceholder } from './Streaming.tsx';
import { MarkdownContent } from './Markdown.tsx';

// ── 本地消息（页面内记忆；与 TutorMessageDto 同构，id 本地生成） ──────────────

interface LocalMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  createdAt: number;
}

let localIdSeed = 0;
function nextLocalId(): string {
  localIdSeed += 1;
  return `local-${Date.now()}-${localIdSeed}`;
}

/** 服务端历史消息（TutorMessageDto）→ 本地渲染消息（LocalMessage）。 */
function toLocalMessages(messages: TutorMessageDto[]): LocalMessage[] {
  return messages.map((m) => ({
    id: m.id,
    role: m.role,
    content: m.content,
    createdAt: m.createdAt,
  }));
}

// ── 导入草稿（可编辑态） ────────────────────────────────────────────────────

interface DraftEdit {
  type: ExamQuestionType;
  stem: string;
  options: string[];
  singleAnswer: number;
  multipleAnswers: number[];
  booleanAnswer: 'true' | 'false';
  explanation: string;
  tags: string;
  /** 知识点（知识单元级，CSV 编辑；入库时并入 CreateQuestionRequest.topics）。 */
  topics: string;
}

type SessionsState =
  | { phase: 'loading' }
  | { phase: 'error'; error: ExamErrorDto }
  | { phase: 'ready'; sessions: TutorSessionDto[] };

type ImportState =
  | { phase: 'idle' }
  | { phase: 'generating' }
  | { phase: 'error'; error: ExamErrorDto }
  | { phase: 'drafts'; drafts: DraftEdit[] }
  | { phase: 'committing' }
  | { phase: 'done'; count: number };

/** ImportedQuestion → 可编辑 DraftEdit。 */
function draftFromImported(q: ImportedQuestion): DraftEdit {
  const options = Array.isArray(q.options) ? q.options.slice() : [];
  const singleIdx = identifierToIndex(q.answer);
  const multipleIdx = Array.isArray(q.answer)
    ? (q.answer as unknown[])
        .map((id) => identifierToIndex(id))
        .filter((i): i is number => i !== null && i >= 0)
    : [];
  return {
    type: q.type,
    stem: q.stem,
    options: options.length > 0 ? options : ['', ''],
    singleAnswer: singleIdx !== null && singleIdx >= 0 ? singleIdx : 0,
    multipleAnswers: multipleIdx.length > 0 ? multipleIdx : [0],
    booleanAnswer: q.answer === 'true' ? 'true' : 'false',
    explanation: q.explanation ?? '',
    tags: tagsToCsv(q.tags),
    topics: tagsToCsv(q.topics),
  };
}

/** DraftEdit → CreateQuestionRequest（answer 编码对齐契约）。 */
function draftToPayload(d: DraftEdit): CreateQuestionRequest {
  if (d.type === 'essay') {
    return {
      type: d.type,
      stem: d.stem.trim(),
      options: [],
      answer: null,
      explanation: d.explanation.trim() || null,
      tags: csvToTags(d.tags),
      topics: csvToTags(d.topics),
    };
  }
  const options = d.options.map((o) => o.trim());
  let answer: unknown;
  if (d.type === 'single') answer = optionLabel(d.singleAnswer);
  else if (d.type === 'multiple') answer = [...d.multipleAnswers].sort((a, b) => a - b).map((i) => optionLabel(i));
  else answer = d.booleanAnswer;
  return {
    type: d.type,
    stem: d.stem.trim(),
    options: d.type === 'boolean' ? [] : options,
    answer,
    explanation: d.explanation.trim() || null,
    tags: csvToTags(d.tags),
    topics: csvToTags(d.topics),
  };
}

/** 前端校验单条草稿；返回错误文案或 null。 */
function validateDraft(d: DraftEdit): string | null {
  if (d.stem.trim().length === 0) return '题干不能为空';
  if (d.type !== 'boolean') {
    const filled = d.options.filter((o) => o.trim().length > 0);
    if (filled.length < 2) return '至少需要 2 个非空选项';
  }
  if (d.type === 'single' && d.options[d.singleAnswer]?.trim().length === 0) return '正确答案对应的选项不能为空';
  if (d.type === 'multiple' && d.multipleAnswers.length === 0) return '至少选择一个正确答案';
  return null;
}

export function AiTools({
  banks,
  initialQuestion,
  initialAsk,
  onInitialAskHandled,
  onBanksChanged,
}: {
  banks: ExamBankDto[];
  /** 从「AI 讲解」入口携带的题目（绑定到新 Tutor 会话）。 */
  initialQuestion?: ExamQuestionDto | null;
  /** 练习解析卡「有疑问？与 AI 对话」入口：绑定题目 + 预填首条消息（§3.3）。 */
  initialAsk?: { boundQuestion: ExamQuestionDto; prefilledPrompt: string } | null;
  /** 应用完 initialAsk 后回调（父级清空，避免重复触发绑定/预填）。 */
  onInitialAskHandled?: () => void;
  /** AI 导入入库成功后回调（ExamWorkspace 刷新题库列表）。 */
  onBanksChanged?: () => void;
}) {
  // ── 子 tab ──
  const [tool, setTool] = useState<'tutor' | 'import'>('tutor');

  // ── Tutor 状态 ──
  const [sessions, setSessions] = useState<SessionsState>({ phase: 'loading' });
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null);
  const [historyBySession, setHistoryBySession] = useState<Record<string, LocalMessage[]>>({});
  /** 正在拉取历史消息的会话 id（每次一个：仅当前选中的会话）。 */
  const [historyLoading, setHistoryLoading] = useState<string | null>(null);
  /** 当前选中会话的历史加载错误（404 等）。 */
  const [historyError, setHistoryError] = useState<ExamErrorDto | null>(null);
  const [input, setInput] = useState('');
  const [streaming, setStreaming] = useState<{ sessionId: string | null; delta: string } | null>(null);
  const [tutorError, setTutorError] = useState<ExamErrorDto | null>(null);
  const [boundQuestion, setBoundQuestion] = useState<ExamQuestionDto | null>(initialQuestion ?? null);
  const [sending, setSending] = useState(false);
  /** 正在删除的会话 id（行级 busy，防重入）。 */
  const [deletingSessionId, setDeletingSessionId] = useState<string | null>(null);

  // ── AI 导入状态 ──
  const [importText, setImportText] = useState('');
  const [importTargetBank, setImportTargetBank] = useState('');
  const [importState, setImportState] = useState<ImportState>({ phase: 'idle' });
  /** 草稿校验错误：提交时逐题校验失败的内联提示（不丢草稿，修正后可重试）。 */
  const [importDraftError, setImportDraftError] = useState<{ index: number; message: string } | null>(null);

  const tutorAbort = useRef<AbortController | null>(null);
  const importAbort = useRef<AbortController | null>(null);
  /** 历史消息加载的独立取消域：与 tutor 流/会话列表互不掐断。 */
  const historyAbortRef = useRef<AbortController | null>(null);
  /** 新会话（sessionId 未定）期间暂存的 user 消息。 */
  const pendingRef = useRef<LocalMessage[]>([]);
  /** 提交失败提示（草稿保留，修正后可重试）。 */
  const [importCommitError, setImportCommitError] = useState<ExamErrorDto | null>(null);

  const loadSessions = useCallback(async () => {
    tutorAbort.current?.abort();
    const controller = new AbortController();
    tutorAbort.current = controller;
    setSessions({ phase: 'loading' });
    try {
      const items = await listTutorSessions(controller.signal);
      setSessions({ phase: 'ready', sessions: items });
    } catch (err) {
      setSessions({ phase: 'error', error: err as ExamErrorDto });
    }
  }, []);

  useEffect(() => {
    void loadSessions();
    return () => {
      tutorAbort.current?.abort();
      importAbort.current?.abort();
      historyAbortRef.current?.abort();
    };
  }, [loadSessions]);

  /**
   * 点开旧会话：先对齐题目上下文与会话（绑定题与会话实际题目不一致或会话无题时
   * 解除绑定，避免"上下文与历史 session 错位"），再加载历史消息（已加载过则直接复用）。
   * 请求带 AbortController + request identity：快速切换会话时旧请求被中止，
   * 迟到的响应按 identity 丢弃，绝不污染当前会话视图。
   */
  const historyRequestRef = useRef<string | null>(null);
  const openSession = async (id: string) => {
    setSelectedSessionId(id);
    setTutorError(null);
    setHistoryError(null);
    // 上下文对齐：仅当会话题目与当前绑定一致时保留上下文展示，否则解除（错位防护）
    const session = sessions.phase === 'ready' ? sessions.sessions.find((s) => s.id === id) : undefined;
    if (session !== undefined) {
      const sessionQid = session.questionId ?? null;
      const boundQid = boundQuestion?.id ?? null;
      if (sessionQid !== boundQid) setBoundQuestion(null);
    }
    if (historyBySession[id] !== undefined) return;
    historyAbortRef.current?.abort();
    const controller = new AbortController();
    historyAbortRef.current = controller;
    historyRequestRef.current = id;
    setHistoryLoading(id);
    try {
      const { messages } = await fetchTutorSessionDetail(id, controller.signal);
      // 请求已中止或用户已切走：丢弃过期结果
      if (controller.signal.aborted || historyRequestRef.current !== id) return;
      setHistoryBySession((prev) => ({ ...prev, [id]: toLocalMessages(messages) }));
    } catch (err) {
      if (controller.signal.aborted || historyRequestRef.current !== id) return;
      setHistoryError(err as ExamErrorDto);
    } finally {
      setHistoryLoading((prev) => (prev === id ? null : prev));
    }
  };

  /** 从本地消息列表移除指定消息（chatTutor 失败时清理该次 user 气泡，避免重试重复）。 */
  const removeUserMessage = (id: string, sessionId: string | null) => {
    if (sessionId === null) {
      pendingRef.current = pendingRef.current.filter((m) => m.id !== id);
    } else {
      setHistoryBySession((prev) => {
        const list = prev[sessionId];
        if (list === undefined) return prev;
        return { ...prev, [sessionId]: list.filter((m) => m.id !== id) };
      });
    }
  };

  // 「AI 讲解」入口带来的题目变化时重新绑定（切换题目）。
  useEffect(() => {
    if (initialQuestion === null || initialQuestion === undefined) return;
    setBoundQuestion(initialQuestion);
    setSelectedSessionId(null);
    setHistoryError(null);
  }, [initialQuestion]);

  // 「有疑问？与 AI 对话」入口（练习解析卡跳转）：绑定题目 + 预填首条消息，切到 Tutor。
  // 应用后立即回调 onInitialAskHandled → 父级清空，避免同一条 initialAsk 重复触发。
  useEffect(() => {
    if (initialAsk === null || initialAsk === undefined) return;
    setBoundQuestion(initialAsk.boundQuestion);
    setSelectedSessionId(null);
    setHistoryError(null);
    setInput(initialAsk.prefilledPrompt);
    setTool('tutor');
    onInitialAskHandled?.();
  }, [initialAsk, onInitialAskHandled]);

  const currentHistory = selectedSessionId === null ? pendingRef.current : (historyBySession[selectedSessionId] ?? []);
  /** 当前选中会话已关闭（closed）：只读可回看，禁发并提示新建对话。 */
  const selectedSessionClosed =
    selectedSessionId !== null && sessions.phase === 'ready'
      ? sessions.sessions.find((s) => s.id === selectedSessionId)?.status === 'closed'
      : false;

  const sendMessage = async () => {
    const message = input.trim();
    if (message.length === 0 || streaming !== null || sending) return;
    const userMsg: LocalMessage = { id: nextLocalId(), role: 'user', content: message, createdAt: Date.now() };
    setInput('');
    setTutorError(null);
    setSending(true);
    // 新会话：user 消息先入暂存区（sessionId 由 done 事件带回后再迁移）。
    const targetSessionId = selectedSessionId;
    if (targetSessionId === null) {
      pendingRef.current = [...pendingRef.current, userMsg];
    } else {
      setHistoryBySession((prev) => ({
        ...prev,
        [targetSessionId]: [...(prev[targetSessionId] ?? []), userMsg],
      }));
    }
    setStreaming({ sessionId: targetSessionId, delta: '' });
    tutorAbort.current?.abort();
    const controller = new AbortController();
    tutorAbort.current = controller;
    // SSE request token：只有「当前在途请求」的回调才允许落地状态。
    // 被新请求取代的旧请求（或取消竞态中迟到的帧）一律丢弃，避免污染新流。
    const isCurrent = () => tutorAbort.current === controller;
    await chatTutor(
      targetSessionId === null
        ? { message, questionId: boundQuestion?.id, bankId: boundQuestion?.bankId }
        : { sessionId: targetSessionId, message },
      {
        onDelta: (delta) => {
          if (!isCurrent()) return;
          setStreaming((prev) => ({
            sessionId: prev?.sessionId ?? null,
            delta: (prev?.delta ?? '') + delta,
          }));
        },
        onDone: (result: ChatTutorResultDto) => {
          if (!isCurrent()) return;
          const assistantMsg: LocalMessage = {
            id: result.messageId,
            role: 'assistant',
            content: result.reply,
            createdAt: Date.now(),
          };
          setStreaming(null);
          setSending(false);
          if (targetSessionId === null) {
            // 新会话：暂存 user 消息迁入真实 sessionId
            const pending = pendingRef.current;
            pendingRef.current = [];
            setHistoryBySession((prev) => ({
              ...prev,
              [result.sessionId]: [...pending, assistantMsg],
            }));
            setSelectedSessionId(result.sessionId);
          } else {
            setHistoryBySession((prev) => ({
              ...prev,
              [targetSessionId]: [...(prev[targetSessionId] ?? []), assistantMsg],
            }));
          }
          void loadSessions();
        },
        onError: (error) => {
          if (!isCurrent()) return;
          setStreaming(null);
          setSending(false);
          setTutorError(error);
          if (error.code === 'EXAM_LLM_ABORTED') {
            // 主动取消：保留 user 气泡（内容仍在流中），仅清理进行中状态。
            return;
          }
          // 失败（网络/LLM/预检 4xx）：移除该次 user 气泡并回填输入框，重试不会产生重复消息。
          removeUserMessage(userMsg.id, targetSessionId);
          setInput(message);
        },
      },
      { signal: controller.signal },
    );
  };

  const cancelStreaming = () => {
    tutorAbort.current?.abort();
    // streamSse 回调 onError(EXAM_LLM_ABORTED) → 状态清理
  };

  const startNewSession = () => {
    if (streaming !== null) return;
    historyAbortRef.current?.abort();
    setSelectedSessionId(null);
    setTutorError(null);
    setHistoryError(null);
    historyRequestRef.current = null;
    // 解除关联可回滚：新建会话时恢复入口携带的题目绑定（若入口仍提供题目）
    setBoundQuestion(initialQuestion ?? null);
  };

  /** 删除会话（级联删除服务端消息与 turns）；删除当前会话时回到「新对话」态。 */
  const onDeleteSession = async (id: string) => {
    if (streaming !== null || deletingSessionId !== null) return;
    const target = sessions.phase === 'ready' ? sessions.sessions.find((s) => s.id === id) : undefined;
    const label = target?.title ?? '该会话';
    if (!window.confirm(`删除会话「${label}」？\n将同时删除该会话的全部消息记录，不可恢复。`)) return;
    setDeletingSessionId(id);
    setTutorError(null);
    try {
      await deleteTutorSession(id);
      setSessions((prev) =>
        prev.phase === 'ready' ? { ...prev, sessions: prev.sessions.filter((s) => s.id !== id) } : prev,
      );
      setHistoryBySession((prev) => {
        const next = { ...prev };
        delete next[id];
        return next;
      });
      if (selectedSessionId === id) startNewSession();
    } catch (err) {
      setTutorError(err as ExamErrorDto);
    } finally {
      setDeletingSessionId(null);
    }
  };

  // ── AI 导入 ──
  const onGenerate = async () => {
    const text = importText.trim();
    if (text.length < 50) {
      setImportState({ phase: 'error', error: { code: 'CLIENT_VALIDATION', message: '资料文本至少 50 字符' } });
      return;
    }
    setImportState({ phase: 'generating' });
    setImportCommitError(null);
    importAbort.current?.abort();
    const controller = new AbortController();
    importAbort.current = controller;
    try {
      const questions = await generateImport(text, {}, controller.signal);
      if (questions.length === 0) {
        setImportState({ phase: 'error', error: { code: 'EXAM_IMPORT_PARSE_FAILED', message: 'AI 未能从资料中抽取题目，请调整文本后重试' } });
        return;
      }
      setImportState({ phase: 'drafts', drafts: questions.map(draftFromImported) });
      setImportDraftError(null);
    } catch (err) {
      setImportState({ phase: 'error', error: err as ExamErrorDto });
    }
  };

  const updateDraft = (index: number, patch: Partial<DraftEdit>) => {
    setImportDraftError(null);
    setImportCommitError(null);
    setImportState((prev) =>
      prev.phase === 'drafts'
        ? { ...prev, drafts: prev.drafts.map((d, i) => (i === index ? { ...d, ...patch } : d)) }
        : prev,
    );
  };

  const removeDraft = (index: number) => {
    setImportDraftError(null);
    setImportCommitError(null);
    setImportState((prev) =>
      prev.phase === 'drafts'
        ? { ...prev, drafts: prev.drafts.filter((_, i) => i !== index) }
        : prev,
    );
  };

  const onCommit = async () => {
    if (importState.phase !== 'drafts') return;
    if (importTargetBank.length === 0) {
      setImportState({ phase: 'error', error: { code: 'CLIENT_VALIDATION', message: '请选择目标题库' } });
      return;
    }
    for (const [i, d] of importState.drafts.entries()) {
      const invalid = validateDraft(d);
      if (invalid !== null) {
        // 内联提示并保留草稿（修正后可重试）——不整页回退丢数据
        setImportDraftError({ index: i, message: invalid });
        return;
      }
    }
    setImportDraftError(null);
    setImportCommitError(null);
    // 快照草稿：提交失败时原样恢复（DraftEdit[] 不因错误丢失）
    const drafts = importState.drafts;
    setImportState({ phase: 'committing' });
    importAbort.current?.abort();
    const controller = new AbortController();
    importAbort.current = controller;
    try {
      const payloads = drafts.map(draftToPayload);
      const { count } = await commitImport(importTargetBank, payloads, controller.signal);
      setImportState({ phase: 'done', count });
      onBanksChanged?.();
    } catch (err) {
      if (controller.signal.aborted) return;
      // 提交失败：恢复草稿编辑态（用户逐题核对的内容全部保留），仅提示错误
      setImportState({ phase: 'drafts', drafts });
      setImportCommitError(err as ExamErrorDto);
    }
  };

  /**
   * AI 子 tab 键盘导航（WAI-ARIA tabs 模式）：←/→ 循环切换，Home/End 跳首尾；
   * 自动激活（简单 tab 组，无需手动 Enter/Space）。
   */
  const onToolTabKeyDown = (event: React.KeyboardEvent<HTMLButtonElement>, id: 'tutor' | 'import') => {
    let next: 'tutor' | 'import' | null = null;
    if (event.key === 'ArrowRight') next = id === 'tutor' ? 'import' : 'tutor';
    else if (event.key === 'ArrowLeft') next = id === 'import' ? 'tutor' : 'import';
    else if (event.key === 'Home') next = 'tutor';
    else if (event.key === 'End') next = 'import';
    else return;
    event.preventDefault();
    setTool(next);
  };

  return (
    <div className="exam-assistant-workspace">
      <nav className="exam-assistant-tabs" role="tablist" aria-label="AI 工具">
        <button
          type="button"
          role="tab"
          id="exam-ai-tab-tutor"
          aria-selected={tool === 'tutor'}
          aria-controls="exam-ai-panel-tutor"
          tabIndex={tool === 'tutor' ? 0 : -1}
          className={tool === 'tutor' ? 'exam-assistant-tab exam-assistant-tab--active' : 'exam-assistant-tab'}
          onClick={() => setTool('tutor')}
          onKeyDown={(event) => onToolTabKeyDown(event, 'tutor')}
        >
          Tutor 讲解
        </button>
        <button
          type="button"
          role="tab"
          id="exam-ai-tab-import"
          aria-selected={tool === 'import'}
          aria-controls="exam-ai-panel-import"
          tabIndex={tool === 'import' ? 0 : -1}
          className={tool === 'import' ? 'exam-assistant-tab exam-assistant-tab--active' : 'exam-assistant-tab'}
          onClick={() => setTool('import')}
          onKeyDown={(event) => onToolTabKeyDown(event, 'import')}
        >
          AI 导入
        </button>
      </nav>

      {tool === 'tutor' ? (
        <section
          role="tabpanel"
          id="exam-ai-panel-tutor"
          aria-labelledby="exam-ai-tab-tutor"
          className="exam-assistant-card exam-assistant-tutor"
          aria-label="Tutor 对话"
        >
          <div className="exam-assistant-tutor__layout">
            {/* 会话列表 */}
            <div className="exam-assistant-tutor__sessions">
              <div className="exam-assistant-row">
                <h3 className="exam-assistant-card__title">会话</h3>
                <button
                  type="button"
                  className="exam-assistant-button exam-assistant-button--sm"
                  disabled={streaming !== null}
                  onClick={startNewSession}
                >
                  新对话
                </button>
              </div>
              {sessions.phase === 'loading' ? (
                <div className="exam-assistant-skeleton">正在读取会话…</div>
              ) : sessions.phase === 'error' ? (
                <p className="exam-assistant-error">{sessions.error.code}: {sessions.error.message}</p>
              ) : sessions.sessions.length === 0 && selectedSessionId === null ? (
                <p className="exam-assistant-empty">暂无会话 —— 在右侧输入第一条消息开始</p>
              ) : (
                <ul className="exam-assistant-tutor__session-list">
                  {sessions.sessions.map((s) => (
                    <li key={s.id} className="exam-assistant-tutor__session-item">
                      <button
                        type="button"
                        className={
                          selectedSessionId === s.id
                            ? 'exam-assistant-tutor__session exam-assistant-tutor__session--active'
                            : 'exam-assistant-tutor__session'
                        }
                        disabled={streaming !== null}
                        onClick={() => void openSession(s.id)}
                      >
                        <span className="exam-assistant-tutor__session-title">
                          {s.title ?? (s.questionId !== undefined ? `题目讲解 ${s.questionId}` : '自由问答')}
                          {s.status === 'closed' ? '（已关闭）' : ''}
                        </span>
                        <span className="exam-assistant-tutor__session-meta">{formatTime(s.updatedAt)}</span>
                      </button>
                      <button
                        type="button"
                        className="exam-assistant-tutor__session-delete"
                        aria-label={`删除会话：${s.title}`}
                        title="删除会话"
                        disabled={streaming !== null || deletingSessionId === s.id}
                        onClick={(event) => {
                          event.stopPropagation();
                          void onDeleteSession(s.id);
                        }}
                      >
                        {deletingSessionId === s.id ? '…' : '✕'}
                      </button>
                    </li>
                  ))}
                  {selectedSessionId === null ? (
                    <li>
                      <span className="exam-assistant-tutor__session exam-assistant-tutor__session--active">
                        <span className="exam-assistant-tutor__session-title">新对话（未创建）</span>
                        <span className="exam-assistant-tutor__session-meta">发送消息后自动创建</span>
                      </span>
                    </li>
                  ) : null}
                </ul>
              )}
            </div>

            {/* 消息流 */}
            <div className="exam-assistant-tutor__chat">
              {boundQuestion !== null ? (
                <div className="exam-assistant-tutor__context">
                  <div className="exam-assistant-row">
                    <span className="exam-assistant-tags">
                      <span className="exam-assistant-tag">{questionTypeLabel(boundQuestion.type)}题</span>
                    </span>
                    <button
                      type="button"
                      className="exam-assistant-button exam-assistant-button--ghost exam-assistant-button--sm"
                      onClick={() => setBoundQuestion(null)}
                    >
                      解除关联
                    </button>
                  </div>
                  <p className="exam-assistant-tutor__context-stem">{boundQuestion.stem}</p>
                  {boundQuestion.options.length > 0 ? (
                    <ul className="exam-assistant-option-list">
                      {boundQuestion.options.map((opt, i) => (
                        <li key={i}>
                          {optionLabel(i)}. {opt}
                        </li>
                      ))}
                    </ul>
                  ) : null}
                </div>
              ) : null}

              <div className="exam-assistant-tutor__messages" aria-live="polite">
                {historyLoading === selectedSessionId && selectedSessionId !== null ? (
                  <div className="exam-assistant-skeleton">正在加载历史消息…</div>
                ) : historyError !== null && selectedSessionId !== null ? (
                  <div>
                    <p className="exam-assistant-error" role="alert">
                      {historyError.code}: {historyError.message}
                    </p>
                    <div className="exam-assistant-form-actions">
                      <button type="button" className="exam-assistant-button exam-assistant-button--ghost" onClick={startNewSession}>
                        ← 返回新对话
                      </button>
                    </div>
                  </div>
                ) : currentHistory.length === 0 && streaming === null ? (
                  <p className="exam-assistant-empty">
                    {selectedSessionId === null
                      ? boundQuestion !== null
                        ? '针对上方题目提问，AI 将结合题干讲解。'
                        : '输入消息开始对话（自由问答，或从题目详情点「AI 讲解」绑定题目）。'
                      : '该会话暂无历史消息 —— 发送新消息继续对话。'}
                  </p>
                ) : null}
                {currentHistory.map((m, i) => {
                  const prev = currentHistory[i - 1];
                  // 分隔时间戳：首条或与前一条间隔 >10 分钟时插入居中时间标签
                  const showTime = prev === undefined || m.createdAt - prev.createdAt > 10 * 60 * 1000;
                  return (
                    <Fragment key={m.id}>
                      {showTime ? (
                        <div className="exam-assistant-tutor__time">{formatTime(m.createdAt)}</div>
                      ) : null}
                      <div
                        className={
                          m.role === 'user'
                            ? 'exam-assistant-tutor__bubble exam-assistant-tutor__bubble--user'
                            : 'exam-assistant-tutor__bubble'
                        }
                      >
                        {m.role === 'user' ? m.content : <MarkdownContent content={m.content} />}
                      </div>
                    </Fragment>
                  );
                })}
                {streaming !== null ? (
                  <div className="exam-assistant-tutor__bubble exam-assistant-tutor__bubble--streaming">
                    {streaming.delta === '' ? (
                      <StreamingPlaceholder lines={2} label="AI 正在思考…" />
                    ) : (
                      <MarkdownContent content={streaming.delta} />
                    )}
                  </div>
                ) : null}
              </div>

              {tutorError ? (
                <p className="exam-assistant-error" role="alert">
                  {tutorError.code === 'EXAM_LLM_ABORTED'
                    ? `已停止生成：${tutorError.code}: ${tutorError.message}`
                    : `发送失败，请重试：${tutorError.code}: ${tutorError.message}`}
                </p>
              ) : null}

              <div className="exam-assistant-tutor__input">
                <textarea
                  className="exam-assistant-input"
                  rows={2}
                  value={input}
                  onChange={(event) => setInput(event.target.value)}
                  disabled={streaming !== null || selectedSessionClosed}
                  placeholder={
                    selectedSessionClosed
                      ? '该会话已关闭 —— 点「新对话」继续提问'
                      : '向 AI 提问…（Enter 换行，点击发送）'
                  }
                />
                <div className="exam-assistant-form-actions">
                  {streaming !== null ? (
                    <button type="button" className="exam-assistant-button exam-assistant-button--ghost" onClick={cancelStreaming}>
                      停止生成
                    </button>
                  ) : (
                    <button
                      type="button"
                      className="exam-assistant-button"
                      disabled={input.trim().length === 0 || sending || selectedSessionClosed}
                      onClick={() => void sendMessage()}
                    >
                      {sending ? '发送中…' : '发送'}
                    </button>
                  )}
                </div>
              </div>
            </div>
          </div>
        </section>
      ) : (
        <section
          role="tabpanel"
          id="exam-ai-panel-import"
          aria-labelledby="exam-ai-tab-import"
          className="exam-assistant-card"
          aria-label="AI 导入"
        >
          <h3 className="exam-assistant-card__title">AI 文本导入</h3>
          <p className="exam-assistant-workspace__subtitle">
            粘贴资料（TXT / Markdown 纯文本，≥50 字符）→ AI 抽取至多 8 道客观题草稿 → 预览编辑 → 批量入库。
          </p>

          {/* 步骤指示器：1 粘贴 → 2 生成预览 → 3 选库提交 */}
          {(() => {
            const importStep =
              importState.phase === 'idle' || importState.phase === 'error' || importState.phase === 'generating'
                ? 1
                : importState.phase === 'drafts'
                  ? 2
                  : 3;
            return (
              <ol className="exam-assistant-steps" aria-label="AI 导入步骤">
                {['粘贴资料', '生成预览', '提交入库'].map((label, i) => {
                  const step = i + 1;
                  const state = step < importStep ? '--done' : step === importStep ? '--active' : '';
                  return (
                    <li key={label} className={`exam-assistant-steps__item exam-assistant-steps__item${state}`}>
                      <span className="exam-assistant-steps__no" aria-hidden="true">
                        {step < importStep ? '✓' : step}
                      </span>
                      <span>{label}</span>
                    </li>
                  );
                })}
              </ol>
            );
          })()}

          {importState.phase === 'idle' || importState.phase === 'error' || importState.phase === 'generating' ? (
            <div>
              <div className="exam-assistant-form-row">
                <label className="exam-assistant-form-label" htmlFor="exam-ai-text">
                  资料文本
                </label>
                <textarea
                  id="exam-ai-text"
                  className="exam-assistant-input"
                  rows={8}
                  value={importText}
                  onChange={(event) => setImportText(event.target.value)}
                  placeholder={'粘贴复习资料、讲义、笔记文本…\n（支持选择题/判断题内容的段落式描述）'}
                />
              </div>
              {importState.phase === 'error' ? (
                <p className="exam-assistant-error" role="alert">
                  {importState.error.code}: {importState.error.message}
                </p>
              ) : null}
              <div className="exam-assistant-form-actions">
                <button
                  type="button"
                  className="exam-assistant-button"
                  disabled={importState.phase === 'generating' || importText.trim().length === 0}
                  onClick={() => void onGenerate()}
                >
                  {importState.phase === 'generating' ? 'AI 生成中…' : '生成题目草稿'}
                </button>
              </div>
            </div>
          ) : null}

          {importState.phase === 'drafts' ? (
            <div>
              <div className="exam-assistant-row">
                <span className="exam-assistant-llm__meta">共 {importState.drafts.length} 道草稿 —— 逐题核对后提交入库</span>
                <button
                  type="button"
                  className="exam-assistant-button exam-assistant-button--ghost exam-assistant-button--sm"
                  onClick={() => {
                    setImportDraftError(null);
                    setImportCommitError(null);
                    setImportState({ phase: 'idle' });
                  }}
                >
                  放弃草稿
                </button>
              </div>
              {importDraftError !== null ? (
                <p className="exam-assistant-error" role="alert">
                  第 {importDraftError.index + 1} 题：{importDraftError.message}（草稿已保留，修正后可重新提交）
                </p>
              ) : null}
              {importCommitError !== null ? (
                <p className="exam-assistant-error" role="alert">
                  提交失败，草稿已全部保留：{importCommitError.code}: {importCommitError.message}
                </p>
              ) : null}
              {importState.drafts.map((d, index) => (
                <div key={index} className="exam-assistant-draft">
                  <div className="exam-assistant-row">
                    <span className="exam-assistant-draft__no">第 {index + 1} 题</span>
                    <select
                      className="exam-assistant-input exam-assistant-draft__type"
                      value={d.type}
                      onChange={(event) => {
                        const type = event.target.value as ExamQuestionType;
                        updateDraft(index, { type, multipleAnswers: d.multipleAnswers.length > 0 ? d.multipleAnswers : [0] });
                      }}
                      aria-label={`第 ${index + 1} 题题型`}
                    >
                      <option value="single">单选</option>
                      <option value="multiple">多选</option>
                      <option value="boolean">判断</option>
                    </select>
                    <button
                      type="button"
                      className="exam-assistant-button exam-assistant-button--ghost exam-assistant-button--sm"
                      onClick={() => removeDraft(index)}
                    >
                      删除
                    </button>
                  </div>
                  <textarea
                    className="exam-assistant-input"
                    rows={2}
                    value={d.stem}
                    onChange={(event) => updateDraft(index, { stem: event.target.value })}
                    aria-label={`第 ${index + 1} 题题干`}
                    placeholder="题干…"
                  />
                  {d.type === 'boolean' ? (
                    <div className="exam-assistant-form-row">
                      <label className="exam-assistant-form-label">正确答案</label>
                      <select
                        className="exam-assistant-input"
                        value={d.booleanAnswer}
                        onChange={(event) => updateDraft(index, { booleanAnswer: event.target.value as 'true' | 'false' })}
                      >
                        <option value="true">对</option>
                        <option value="false">错</option>
                      </select>
                    </div>
                  ) : (
                    <div className="exam-assistant-form-row exam-assistant-form-row--col">
                      <span className="exam-assistant-form-label">选项（勾选/点选标记正确答案）</span>
                      {d.options.map((opt, i) => (
                        <div key={i} className="exam-assistant-option-row">
                          <span className="exam-assistant-option-row__label">{optionLabel(i)}</span>
                          <input
                            className="exam-assistant-input"
                            value={opt}
                            onChange={(event) => {
                              const options = d.options.slice();
                              options[i] = event.target.value;
                              updateDraft(index, { options });
                            }}
                            aria-label={`第 ${index + 1} 题选项 ${optionLabel(i)}`}
                          />
                          {d.type === 'single' ? (
                            <input
                              type="radio"
                              name={`exam-draft-answer-${index}`}
                              checked={d.singleAnswer === i}
                              onChange={() => updateDraft(index, { singleAnswer: i })}
                              aria-label={`设为正确答案（${optionLabel(i)}）`}
                            />
                          ) : (
                            <input
                              type="checkbox"
                              checked={d.multipleAnswers.includes(i)}
                              onChange={() =>
                                updateDraft(index, {
                                  multipleAnswers: d.multipleAnswers.includes(i)
                                    ? d.multipleAnswers.filter((x) => x !== i)
                                    : [...d.multipleAnswers, i],
                                })
                              }
                              aria-label={`设为正确答案（${optionLabel(i)}）`}
                            />
                          )}
                          <button
                            type="button"
                            className="exam-assistant-button exam-assistant-button--ghost exam-assistant-button--sm"
                            disabled={d.options.length <= 2}
                            onClick={() => {
                              const options = d.options.filter((_, x) => x !== i);
                              const singleAnswer = d.singleAnswer === i ? 0 : d.singleAnswer > i ? d.singleAnswer - 1 : d.singleAnswer;
                              const multipleAnswers = d.multipleAnswers
                                .filter((x) => x !== i)
                                .map((x) => (x > i ? x - 1 : x));
                              updateDraft(index, {
                                options,
                                singleAnswer,
                                multipleAnswers: multipleAnswers.length > 0 ? multipleAnswers : [0],
                              });
                            }}
                          >
                            删除
                          </button>
                        </div>
                      ))}
                      <button
                        type="button"
                        className="exam-assistant-button exam-assistant-button--ghost exam-assistant-button--sm"
                        onClick={() => updateDraft(index, { options: [...d.options, ''] })}
                      >
                        + 添加选项
                      </button>
                    </div>
                  )}
                  <div className="exam-assistant-form-row">
                    <label className="exam-assistant-form-label">解析（可选）</label>
                    <input
                      className="exam-assistant-input"
                      value={d.explanation}
                      onChange={(event) => updateDraft(index, { explanation: event.target.value })}
                    />
                  </div>
                  <div className="exam-assistant-form-row">
                    <label className="exam-assistant-form-label">标签（逗号分隔）</label>
                    <input
                      className="exam-assistant-input"
                      value={d.tags}
                      onChange={(event) => updateDraft(index, { tags: event.target.value })}
                      placeholder="高数, 微积分"
                    />
                  </div>
                  <div className="exam-assistant-form-row">
                    <label className="exam-assistant-form-label">知识点（逗号分隔）</label>
                    <input
                      className="exam-assistant-input"
                      value={d.topics}
                      onChange={(event) => updateDraft(index, { topics: event.target.value })}
                      placeholder="知识单元级，2~4 个，不要用题库名"
                    />
                  </div>
                </div>
              ))}

              <div className="exam-assistant-form-row">
                <label className="exam-assistant-form-label" htmlFor="exam-ai-bank">
                  目标题库（必选）
                </label>
                <select
                  id="exam-ai-bank"
                  className="exam-assistant-input"
                  value={importTargetBank}
                  onChange={(event) => setImportTargetBank(event.target.value)}
                >
                  <option value="">请选择…</option>
                  {banks.map((b) => (
                    <option key={b.id} value={b.id}>
                      {b.name}（{b.id}）
                    </option>
                  ))}
                </select>
              </div>

              <div className="exam-assistant-form-actions">
                <button type="button" className="exam-assistant-button" disabled={importState.drafts.length === 0} onClick={() => void onCommit()}>
                  提交 {importState.drafts.length} 题入库
                </button>
              </div>
            </div>
          ) : null}

          {importState.phase === 'committing' ? (
            <div className="exam-assistant-skeleton">正在批量入库…</div>
          ) : null}

          {importState.phase === 'done' ? (
            <div>
              <p className="exam-assistant-status exam-assistant-status--ok" role="status">
                <span className="exam-assistant-status__dot" aria-hidden="true" />
                已成功入库 {importState.count} 道题目 —— 可在题库中查看
              </p>
              <div className="exam-assistant-form-actions">
                <button
                  type="button"
                  className="exam-assistant-button"
                  onClick={() => {
                    setImportState({ phase: 'idle' });
                    setImportText('');
                    setImportTargetBank('');
                  }}
                >
                  继续导入
                </button>
              </div>
            </div>
          ) : null}
        </section>
      )}
    </div>
  );
}
