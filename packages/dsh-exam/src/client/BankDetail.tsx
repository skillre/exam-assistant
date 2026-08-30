/**
 * BankDetail —— 题库详情视图（Phase 1 + Phase 4 AI 生成解析）。
 *
 * 内容：
 * - 题目列表（题干/题型/标签摘要；点击展开看选项与正确答案）；
 * - Phase 4：展开行提供「✦ AI 生成解析」（explanation 为空 → 主操作）/「↻ 重新解析」
 *   （已有 → 次操作，confirm 后覆盖写回 questions.explanation）；busy 防重复点击，
 *   成功后以响应 DTO 行内刷新（essay 题不提供——批改反馈已是解析）；
 * - 新增题目表单（type/stem/options/answer/explanation/tags；
 *   single/multiple 选项行编辑 + 正确答案标记，boolean 下拉对/错）；
 * - 编辑题目（列表行「编辑」→ 同一表单预填当前值 → PUT 保存后刷新列表）；
 * - 删除题目（行内二次确认：先点「删除」变「确认删除」，再点执行）；
 * - 返回题库列表。
 *
 * 状态：loading/error/empty 齐备；所有请求可经 AbortController 取消。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { applyTopics, bulkQuestions, createQuestion, deleteQuestion, explainGeneric, listBanks, listQuestions, topicSuggestions, updateQuestion } from './api.ts';
import type {
  BulkQuestionOp,
  ExamBankDto,
  ExamErrorDto,
  ExamQuestionDto,
  ExamQuestionType,
  ListQuestionsFilter,
} from './types.ts';
import {
  answerText,
  csvToTags,
  formatTime,
  identifierToIndex,
  optionLabel,
  questionTypeLabel,
  tagsToCsv,
} from './ui-helpers.ts';

type QuestionsState =
  | { phase: 'loading' }
  | { phase: 'error'; error: ExamErrorDto }
  | { phase: 'ready'; questions: ExamQuestionDto[] };

type CreateState =
  | { phase: 'idle' }
  | { phase: 'submitting' }
  | { phase: 'error'; error: ExamErrorDto }
  | { phase: 'created' };

interface QuestionFormState {
  type: ExamQuestionType;
  stem: string;
  options: string[];
  /** 单选：正确答案选项下标；多选：正确选项下标集合；判断：'true'|'false'。 */
  singleAnswer: number;
  multipleAnswers: number[];
  booleanAnswer: 'true' | 'false';
  explanation: string;
  tags: string;
  /** 知识点（知识单元级，CSV 编辑；入库并入 CreateQuestionRequest.topics）。 */
  topics: string;
}

const EMPTY_FORM: QuestionFormState = {
  type: 'single',
  stem: '',
  options: ['', ''],
  singleAnswer: 0,
  multipleAnswers: [0],
  booleanAnswer: 'true',
  explanation: '',
  tags: '',
  topics: '',
};

/** ExamQuestionDto → 表单预填值（编辑用；answer 编码对齐 ui-helpers）。 */
function questionToForm(q: ExamQuestionDto): QuestionFormState {
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
    booleanAnswer: q.answer === 'true' || q.answer === true ? 'true' : 'false',
    explanation: q.explanation ?? '',
    tags: tagsToCsv(q.tags),
    topics: tagsToCsv(q.topics),
  };
}

/** 题目是否已软删除/归档（deletedAt 非空；t9 批量 archive 同样落 deletedAt）。 */
function isDeletedQuestion(q: ExamQuestionDto): boolean {
  return q.deletedAt !== null && q.deletedAt !== undefined;
}

/** P2 批量标注：单条可编辑草稿（suggested 为 CSV 字符串，确认写回时转数组）。 */
interface TopicSuggestDraft {
  questionId: string;
  stem: string;
  currentTopics: string[];
  currentTags: string[];
  suggested: string;
  selected: boolean;
}

/** AI 知识标注流程状态机（草稿确认制，不自动写回）。 */
type TopicSuggestState =
  | { phase: 'idle' }
  | { phase: 'loading' }
  | { phase: 'error'; error: ExamErrorDto }
  | { phase: 'ready'; rows: TopicSuggestDraft[]; submitting: boolean; applied: number | null; error: ExamErrorDto | null };

/** 全库标注向导模式：宽松=每轮建议自动写回；严格=各轮草稿合并由用户统一确认。 */
type WizardMode = 'lenient' | 'strict';

/** 全库一键标注的进行状态（进度 / 汇总 / 错误）。 */
interface WizardState {
  /** 向导是否正在运行（防重入 + 禁用相关控件）。 */
  running: boolean;
  /** 当前已完成的轮次（1 起）。 */
  round: number;
  /** 宽松模式累计写回题数（严格模式恒为 0）。 */
  applied: number;
  /** 严格模式本轮合并进草稿表的条数（宽松模式恒为 0）。 */
  merged: number;
  error: ExamErrorDto | null;
  /** 完成后的汇总文案（成功后展示）。 */
  summary: string | null;
}

const EMPTY_WIZARD: WizardState = { running: false, round: 0, applied: 0, merged: 0, error: null, summary: null };

/** 全库一键标注的单轮批量大小（服务端单次上限 100）。 */
const WIZARD_BATCH = 100;
/** 循环上限保护：防止服务端反复返回相同候选导致死循环。 */
const MAX_WIZARD_ROUNDS = 200;

export function BankDetail({
  bankId,
  bankName,
  onBack,
  onAskAi,
  onQuestionsChanged,
}: {
  bankId: string;
  bankName: string;
  onBack: () => void;
  /** Phase 2：「AI 讲解」入口——携带完整题目打开 AI tab 的 Tutor 会话（无单题 GET 契约，故传 DTO）。 */
  onAskAi?: (question: ExamQuestionDto) => void;
  /** 题目增删改成功后的通知（父级刷新题数徽章等）。 */
  onQuestionsChanged?: () => void;
}) {
  const [questions, setQuestions] = useState<QuestionsState>({ phase: 'loading' });
  const [form, setForm] = useState<QuestionFormState>(EMPTY_FORM);
  const [create, setCreate] = useState<CreateState>({ phase: 'idle' });
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  /** 删除失败错误：显示在题目列表区（操作点附近），不复用表单区 create.error。 */
  const [deleteError, setDeleteError] = useState<ExamErrorDto | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  /** 正在编辑的题目 id；null = 新增模式。 */
  const [editingId, setEditingId] = useState<string | null>(null);
  // Phase 4：G 形态 AI 解析（写回 questions.explanation）
  const [explainBusyId, setExplainBusyId] = useState<string | null>(null);
  const [confirmExplainId, setConfirmExplainId] = useState<string | null>(null);
  const [explainError, setExplainError] = useState<{ questionId: string; error: ExamErrorDto } | null>(null);
  const listAbort = useRef<AbortController | null>(null);
  const mutateAbort = useRef<AbortController | null>(null);
  const formRef = useRef<HTMLElement | null>(null);

  // ── t10 过滤器（工具条）：搜索 / 题型多选 / 标签 / 解析状态 / 排序 ──
  const [searchText, setSearchText] = useState('');
  const [query, setQuery] = useState('');
  const [typeFilter, setTypeFilter] = useState<ExamQuestionType[]>([]);
  const [tagsFilter, setTagsFilter] = useState('');
  const [explainFilter, setExplainFilter] = useState<'all' | 'has' | 'none'>('all');
  const [sortField, setSortField] = useState<'createdAt' | 'updatedAt'>('createdAt');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('asc');
  /** 「显示已删/归档」开关：开启后 listQuestions 带 includeDeleted，软删除题在题库内可见（供恢复）。 */
  const [showDeleted, setShowDeleted] = useState(false);

  // ── t10 多选批量操作 ──
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  /** 批量加标签的内联输入是否展开。 */
  const [batchTagOpen, setBatchTagOpen] = useState(false);
  /** 批量移动题库的内联选择是否展开。 */
  const [batchMoveOpen, setBatchMoveOpen] = useState(false);
  /** 批量加标签输入的标签值（展开时显示）。 */
  const [batchTagValue, setBatchTagValue] = useState('');
  /** 批量移动题库的目标库去重列表（懒加载）。 */
  const [banks, setBanks] = useState<ExamBankDto[]>([]);
  /** 批量移动的当前目标题库 id。 */
  const [batchMoveId, setBatchMoveId] = useState('');
  /** 批量操作取消令牌（独立域，不与列表/编辑互掐）。 */
  const bulkAbort = useRef<AbortController | null>(null);
  const [bulkBusy, setBulkBusy] = useState(false);
  const [bulkError, setBulkError] = useState<ExamErrorDto | null>(null);
  const [confirmBulkDelete, setConfirmBulkDelete] = useState(false);
  /** 批量设置知识点（覆盖式 op:'topics'）的内联输入是否展开。 */
  const [batchTopicOpen, setBatchTopicOpen] = useState(false);
  /** 批量设置知识点的输入值（展开时显示；CSV）。 */
  const [batchTopicValue, setBatchTopicValue] = useState('');
  /** 标签一览聚合（unfiltered 全库 tags + topics 频次；null = 未加载/失败）。 */
  const [tagOverview, setTagOverview] = useState<{ tags: { label: string; count: number }[]; topics: { label: string; count: number }[] } | null>(null);
  const overviewAbort = useRef<AbortController | null>(null);
  /** AI 知识标注（P2 批量标注草稿确认制）状态。 */
  const [topicSuggest, setTopicSuggest] = useState<TopicSuggestState>({ phase: 'idle' });
  const topicAbort = useRef<AbortController | null>(null);
  /** 单题「AI 补标」独立取消域（不与向导/草稿流程互掐）。 */
  const suggestAbort = useRef<AbortController | null>(null);
  /** 全库标注向导模式（默认宽松）。 */
  const [wizardMode, setWizardMode] = useState<WizardMode>('lenient');
  /** 全库一键标注进行状态。 */
  const [wizard, setWizard] = useState<WizardState>(EMPTY_WIZARD);
  /** 严格模式向导本地累计草稿（避免循环里闭包读到的 topicSuggest 过期）。 */
  const wizardDraftRef = useRef<TopicSuggestDraft[]>([]);
  /** 单题「AI 补标」进行中题目 id（行级 busy，参考 explainBusyId）。 */
  const [suggestBusyId, setSuggestBusyId] = useState<string | null>(null);
  /** 单题「AI 补标」失败错误（行级展示，参考 explainError）。 */
  const [suggestError, setSuggestError] = useState<{ questionId: string; error: ExamErrorDto } | null>(null);

  /** 由工具条状态组装 ListQuestionsFilter（t9 契约）。 */
  const buildFilter = useCallback((): ListQuestionsFilter => {
    const f: ListQuestionsFilter = {};
    if (query.trim().length > 0) f.q = query.trim();
    if (typeFilter.length === 1) f.type = typeFilter[0];
    else if (typeFilter.length > 1) f.type = typeFilter;
    const tags = tagsFilter
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    if (tags.length === 1) f.tags = tags[0];
    else if (tags.length > 1) f.tags = tags;
    if (explainFilter === 'has') f.hasExplanation = true;
    else if (explainFilter === 'none') f.hasExplanation = false;
    if (showDeleted) f.includeDeleted = true;
    f.sort = { field: sortField, dir: sortDir };
    return f;
  }, [query, typeFilter, tagsFilter, explainFilter, sortField, sortDir, showDeleted]);

  const load = useCallback(async () => {
    listAbort.current?.abort();
    const controller = new AbortController();
    listAbort.current = controller;
    setQuestions({ phase: 'loading' });
    try {
      const items = await listQuestions(bankId, buildFilter(), controller.signal);
      setQuestions({ phase: 'ready', questions: items });
      // 列表刷新后清掉不属于当前列表的选择（避免跨筛选残留）
      setSelectedIds((prev) => prev.filter((id) => items.some((q) => q.id === id)));
    } catch (err) {
      setQuestions({ phase: 'error', error: err as ExamErrorDto });
    }
  }, [bankId, buildFilter]);

  /** 标签一览聚合：拉取该库全部题目（unfiltered）统计 tags/topics 频次。 */
  const reloadTagOverview = useCallback(async () => {
    overviewAbort.current?.abort();
    const controller = new AbortController();
    overviewAbort.current = controller;
    try {
      const all = await listQuestions(bankId, undefined, controller.signal);
      if (controller.signal.aborted) return;
      const tagMap = new Map<string, number>();
      const topicMap = new Map<string, number>();
      for (const q of all) {
        for (const t of q.tags ?? []) tagMap.set(t, (tagMap.get(t) ?? 0) + 1);
        for (const t of q.topics ?? []) topicMap.set(t, (topicMap.get(t) ?? 0) + 1);
      }
      const toList = (m: Map<string, number>) =>
        [...m.entries()].map(([label, count]) => ({ label, count })).sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
      setTagOverview({ tags: toList(tagMap), topics: toList(topicMap) });
    } catch {
      if (controller.signal.aborted) return;
      setTagOverview(null);
    }
  }, [bankId]);

  useEffect(() => {
    void load();
    void reloadTagOverview();
    return () => {
      listAbort.current?.abort();
      mutateAbort.current?.abort();
      bulkAbort.current?.abort();
      overviewAbort.current?.abort();
      topicAbort.current?.abort();
      suggestAbort.current?.abort();
    };
  }, [load, reloadTagOverview]);

  // 搜索框防重（本地 HTTP 仍避免每键一刷）：输入停顿 300ms 后应用。
  useEffect(() => {
    const t = setTimeout(() => setQuery(searchText), 300);
    return () => clearTimeout(t);
  }, [searchText]);

  // 批量「移动题库」需要目标库选择：挂载时拉取一次题库（不含归档）。
  useEffect(() => {
    const controller = new AbortController();
    void listBanks(undefined, controller.signal)
      .then((items) => setBanks(items.filter((b) => b.id !== bankId)))
      .catch(() => setBanks([]));
    return () => controller.abort();
  }, [bankId]);

  /** 点题目行「编辑」：同一表单预填该题当前值并进入编辑模式。 */
  const startEdit = (q: ExamQuestionDto) => {
    setEditingId(q.id);
    setForm(questionToForm(q));
    setConfirmDeleteId(null);
    setCreate({ phase: 'idle' });
    // 表单固定在列表下方：滚动过去，保证用户看到预填内容。
    formRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  const cancelEdit = () => {
    setEditingId(null);
    setForm(EMPTY_FORM);
    setCreate({ phase: 'idle' });
  };

  const setOption = (index: number, value: string) => {
    setForm((prev) => {
      const options = prev.options.slice();
      options[index] = value;
      return { ...prev, options };
    });
  };

  const addOption = () => setForm((prev) => ({ ...prev, options: [...prev.options, ''] }));
  const removeOption = (index: number) =>
    setForm((prev) => {
      const options = prev.options.filter((_, i) => i !== index);
      let singleAnswer = prev.singleAnswer;
      let multipleAnswers = prev.multipleAnswers.filter((i) => i !== index).map((i) => (i > index ? i - 1 : i));
      if (singleAnswer === index) singleAnswer = 0;
      else if (singleAnswer > index) singleAnswer -= 1;
      if (multipleAnswers.length === 0) multipleAnswers = [0];
      return { ...prev, options, singleAnswer, multipleAnswers };
    });

  const toggleMultiple = (index: number) =>
    setForm((prev) => ({
      ...prev,
      multipleAnswers: prev.multipleAnswers.includes(index)
        ? prev.multipleAnswers.filter((i) => i !== index)
        : [...prev.multipleAnswers, index],
    }));

  /** 前端校验（服务端还有 EXAM_INVALID_BODY 兜底）。 */
  function validateForm(f: QuestionFormState): string | null {
    if (f.stem.trim().length === 0) return '题干不能为空';
    if (f.type === 'essay') return null; // 主观题：无需选项与标准答案
    if (f.type !== 'boolean') {
      const filled = f.options.filter((o) => o.trim().length > 0);
      if (filled.length < 2) return '至少需要 2 个非空选项';
    }
    if (f.type === 'single' && f.options[f.singleAnswer]?.trim().length === 0) return '正确答案对应的选项不能为空';
    if (f.type === 'multiple' && f.multipleAnswers.length === 0) return '至少选择一个正确答案';
    return null;
  }

  function buildPayload(f: QuestionFormState): {
    type: ExamQuestionType;
    stem: string;
    options: string[];
    answer: unknown;
    explanation: string | null;
    tags: string[];
    topics: string[];
  } {
    if (f.type === 'essay') {
      // 主观题：无选项、无标准答案（服务端 essay 校验放行空 options + null answer）
      return {
        type: f.type,
        stem: f.stem.trim(),
        options: [],
        answer: null,
        explanation: f.explanation.trim() || null,
        tags: csvToTags(f.tags),
        topics: csvToTags(f.topics),
      };
    }
    const options = f.options.map((o) => o.trim());
    let answer: unknown;
    if (f.type === 'single') {
      answer = optionLabel(f.singleAnswer);
    } else if (f.type === 'multiple') {
      answer = [...f.multipleAnswers].sort((a, b) => a - b).map((i) => optionLabel(i));
    } else {
      answer = f.booleanAnswer;
    }
    return {
      type: f.type,
      stem: f.stem.trim(),
      options: f.type === 'boolean' ? [] : options,
      answer,
      explanation: f.explanation.trim() || null,
      tags: csvToTags(f.tags),
      topics: csvToTags(f.topics),
    };
  }

  const onCreate = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const invalid = validateForm(form);
    if (invalid !== null) {
      setCreate({ phase: 'error', error: { code: 'CLIENT_VALIDATION', message: invalid } });
      return;
    }
    setCreate({ phase: 'submitting' });
    mutateAbort.current?.abort();
    const controller = new AbortController();
    mutateAbort.current = controller;
    try {
      if (editingId !== null) {
        // 编辑：局部替换（不整表重拉）——响应 DTO 直接覆盖对应行。
        const updated = await updateQuestion(editingId, buildPayload(form), controller.signal);
        setQuestions((prev) =>
          prev.phase === 'ready'
            ? { ...prev, questions: prev.questions.map((item) => (item.id === updated.id ? updated : item)) }
            : prev,
        );
        setEditingId(null);
      } else {
        const created = await createQuestion(bankId, buildPayload(form), controller.signal);
        // 新增：若无筛选则本地前置插入（满足「优先局部更新」）；有筛选用整表重拉保证匹配。
        const hasFilter = query.trim().length > 0 || typeFilter.length > 0 || tagsFilter.trim().length > 0 || explainFilter !== 'all';
        if (hasFilter) {
          void load();
        } else {
          setQuestions((prev) =>
            prev.phase === 'ready' ? { ...prev, questions: [created, ...prev.questions] } : prev,
          );
        }
      }
      setForm(EMPTY_FORM);
      setCreate({ phase: 'created' });
      void reloadTagOverview();
      onQuestionsChanged?.();
    } catch (err) {
      setCreate({ phase: 'error', error: err as ExamErrorDto });
    }
  };

  const onDelete = async (id: string) => {
    setDeleteError(null);
    if (confirmDeleteId !== id) {
      setConfirmDeleteId(id);
      return;
    }
    setConfirmDeleteId(null);
    mutateAbort.current?.abort();
    const controller = new AbortController();
    mutateAbort.current = controller;
    try {
      await deleteQuestion(id, controller.signal);
      void load();
      void reloadTagOverview();
      onQuestionsChanged?.();
    } catch (err) {
      setDeleteError(err as ExamErrorDto);
    }
  };

  // ── t10 多选批量操作 ──
  const toggleSelect = (id: string) => {
    setSelectedIds((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  };
  const allSelected =
    questions.phase === 'ready' && questions.questions.length > 0 && questions.questions.every((q) => selectedIds.includes(q.id));
  const toggleSelectAll = () => {
    if (questions.phase !== 'ready') return;
    setSelectedIds((prev) =>
      prev.length === questions.questions.length && questions.questions.every((q) => prev.includes(q.id))
        ? []
        : questions.questions.map((q) => q.id),
    );
  };

  /** 执行批量操作：explain-generic 行内合并结果，其余整表重拉（数组可能增减）。 */
  const runBulk = async (op: BulkQuestionOp) => {
    if (selectedIds.length === 0) return;
    if (bulkBusy) return; // busy 防护
    setBulkBusy(true);
    setBulkError(null);
    bulkAbort.current?.abort();
    const controller = new AbortController();
    bulkAbort.current = controller;
    try {
      const result = await bulkQuestions(op, controller.signal);
      if (op.op === 'explain-generic' && result.questions && result.questions.length > 0) {
        const updated = result.questions;
        setQuestions((prev) =>
          prev.phase === 'ready'
            ? {
                ...prev,
                questions: prev.questions.map((q) => {
                  const next = updated.find((r) => r.id === q.id);
                  return next ?? q;
                }),
              }
            : prev,
        );
      } else {
        void load();
      }
      setSelectedIds([]);
      setBatchTagOpen(false);
      setBatchMoveOpen(false);
      setBatchTagValue('');
      setBatchMoveId('');
      setBatchTopicOpen(false);
      setBatchTopicValue('');
      setConfirmBulkDelete(false);
      void reloadTagOverview();
      onQuestionsChanged?.();
    } catch (err) {
      setBulkError(err as ExamErrorDto);
    } finally {
      setBulkBusy(false);
    }
  };

  const onBulkTag = () => {
    const tag = batchTagValue.trim();
    if (tag.length === 0) {
      setBulkError({ code: 'CLIENT_VALIDATION', message: '请输入要添加的标签' });
      return;
    }
    void runBulk({ op: 'tag', questionIds: selectedIds, tag, add: true });
  };

  const onBulkMove = () => {
    if (batchMoveId.length === 0) {
      setBulkError({ code: 'CLIENT_VALIDATION', message: '请选择要移入的题库' });
      return;
    }
    void runBulk({ op: 'move', questionIds: selectedIds, bankId: batchMoveId });
  };

  const onBulkArchive = () => {
    void runBulk({ op: 'archive', questionIds: selectedIds });
  };

  const onBulkRestore = () => {
    void runBulk({ op: 'restore', questionIds: selectedIds });
  };

  /** 单题恢复：仅已删/已归档题触发（bulkQuestions restore → 整表重拉；已删视图随之刷新）。 */
  const onRestoreOne = async (q: ExamQuestionDto) => {
    if (bulkBusy) return;
    setBulkBusy(true);
    setBulkError(null);
    bulkAbort.current?.abort();
    const controller = new AbortController();
    bulkAbort.current = controller;
    try {
      await bulkQuestions({ op: 'restore', questionIds: [q.id] }, controller.signal);
      void load();
      void reloadTagOverview();
      onQuestionsChanged?.();
    } catch (err) {
      setBulkError(err as ExamErrorDto);
    } finally {
      setBulkBusy(false);
    }
  };

  const onBulkDelete = () => {
    if (bulkBusy) return;
    if (!confirmBulkDelete) {
      setConfirmBulkDelete(true);
      return;
    }
    void runBulk({ op: 'delete', questionIds: selectedIds });
  };

  const onBulkExplain = () => {
    void runBulk({ op: 'explain-generic', questionIds: selectedIds });
  };

  const onBulkTopics = () => {
    const topics = csvToTags(batchTopicValue);
    if (topics.length === 0) {
      setBulkError({ code: 'CLIENT_VALIDATION', message: '请输入要设置的知识点（至少 1 个）' });
      return;
    }
    void runBulk({ op: 'topics', questionIds: selectedIds, topics });
  };

  // ── P2 批量标注（AI 知识标注 · 草稿确认制） ────────────────────────────────

  const onTopicSuggest = async () => {
    setTopicSuggest({ phase: 'loading' });
    topicAbort.current?.abort();
    const controller = new AbortController();
    topicAbort.current = controller;
    try {
      const items = await topicSuggestions(bankId, { limit: 50 }, controller.signal);
      if (controller.signal.aborted) return;
      const rows: TopicSuggestDraft[] = items.map((it) => ({
        questionId: it.questionId,
        stem: it.stem,
        currentTopics: it.currentTopics ?? [],
        currentTags: it.currentTags ?? [],
        suggested: (it.suggestedTopics ?? []).join(', '),
        selected: true,
      }));
      setTopicSuggest({ phase: 'ready', rows, submitting: false, applied: null, error: null });
    } catch (err) {
      if (controller.signal.aborted) return;
      setTopicSuggest({ phase: 'error', error: err as ExamErrorDto });
    }
  };

  const updateTopicRow = (index: number, patch: Partial<TopicSuggestDraft>) => {
    if (wizard.running) return; // 向导运行中禁止编辑草稿（避免被合并覆盖）
    setTopicSuggest((prev) =>
      prev.phase === 'ready'
        ? { ...prev, rows: prev.rows.map((r, i) => (i === index ? { ...r, ...patch } : r)), error: null }
        : prev,
    );
  };

  const removeTopicRow = (index: number) => {
    if (wizard.running) return;
    setTopicSuggest((prev) => (prev.phase === 'ready' ? { ...prev, rows: prev.rows.filter((_, i) => i !== index) } : prev));
  };

  const toggleAllTopics = () => {
    if (wizard.running) return;
    setTopicSuggest((prev) => {
      if (prev.phase !== 'ready') return prev;
      const all = prev.rows.every((r) => r.selected);
      return { ...prev, rows: prev.rows.map((r) => ({ ...r, selected: !all })) };
    });
  };

  /** 确认写回：仅提交勾选行（覆盖式 topics），成功后刷新列表与标签一览。 */
  const onApplyTopicChanges = async () => {
    if (wizard.running) return; // 向导运行中禁用，避免互掐 topicAbort
    if (topicSuggest.phase !== 'ready') return;
    const items = topicSuggest.rows
      .filter((r) => r.selected)
      .map((r) => ({ questionId: r.questionId, topics: csvToTags(r.suggested) }));
    if (items.length === 0) {
      setTopicSuggest({ ...topicSuggest, error: { code: 'CLIENT_VALIDATION', message: '请至少保留一条勾选的知识点' } });
      return;
    }
    setTopicSuggest({ ...topicSuggest, submitting: true, error: null });
    topicAbort.current?.abort();
    const controller = new AbortController();
    topicAbort.current = controller;
    try {
      const res = await applyTopics(items, controller.signal);
      if (controller.signal.aborted) return;
      setTopicSuggest({ ...topicSuggest, submitting: false, applied: res.updated });
      void load();
      void reloadTagOverview();
      onQuestionsChanged?.();
    } catch (err) {
      if (controller.signal.aborted) return;
      setTopicSuggest({ ...topicSuggest, submitting: false, error: err as ExamErrorDto });
    }
  };

  /**
   * 全库一键标注：循环 limit=WIZARD_BATCH 拉草稿直到返回空数组即完成。
   * - 宽松：每轮建议直接 applyTopics 写回，累计已应用题数；
   * - 严格：每轮草稿合并进草稿确认表（按 questionId 去重），由用户最后统一确认。
   * - 可取消（沿用 topicAbort 分域）、防重入（running 禁用按钮）、200 轮上限防死循环。
   */
  const onAnnotateAll = async () => {
    if (wizard.running) return; // busy 防护：防重入
    setWizard({ ...EMPTY_WIZARD, running: true });
    // 严格模式：从当前草稿表快照出发继续合并（复用现有草稿表状态）
    if (wizardMode === 'strict') {
      wizardDraftRef.current = topicSuggest.phase === 'ready' ? topicSuggest.rows.slice() : [];
    }
    topicAbort.current?.abort();
    const controller = new AbortController();
    topicAbort.current = controller;
    let applied = 0;
    let merged = 0;
    let rounds = 0;
    try {
      for (rounds = 0; rounds < MAX_WIZARD_ROUNDS; rounds++) {
        setWizard((prev) => ({ ...prev, round: rounds + 1 }));
        const items = await topicSuggestions(bankId, { limit: WIZARD_BATCH }, controller.signal);
        if (controller.signal.aborted) return; // Abort 后静默不报错
        if (items.length === 0) break; // 返回空数组即完成
        if (wizardMode === 'lenient') {
          // 宽松：本批建议直接写回，累计已应用题数
          const res = await applyTopics(
            items.map((it) => ({ questionId: it.questionId, topics: it.suggestedTopics ?? [] })),
            controller.signal,
          );
          if (controller.signal.aborted) return;
          applied += res.updated;
          setWizard((prev) => ({ ...prev, applied }));
        } else {
          // 严格：本批草稿并入确认表，统计本轮新增条数（按 questionId 去重）
          const draft = wizardDraftRef.current;
          const existing = new Set(draft.map((r) => r.questionId));
          const before = draft.length;
          for (const it of items) {
            if (existing.has(it.questionId)) continue;
            existing.add(it.questionId);
            draft.push({
              questionId: it.questionId,
              stem: it.stem,
              currentTopics: it.currentTopics ?? [],
              currentTags: it.currentTags ?? [],
              suggested: (it.suggestedTopics ?? []).join(', '),
              selected: true,
            });
          }
          merged += draft.length - before;
          setTopicSuggest({ phase: 'ready', rows: draft.slice(), submitting: false, applied: null, error: null });
          setWizard((prev) => ({ ...prev, merged }));
        }
      }
      if (controller.signal.aborted) return;
      const capped = rounds >= MAX_WIZARD_ROUNDS;
      // 完成汇总：共应用 N 题 / 库内已无待标注题
      const summary =
        wizardMode === 'lenient'
          ? `共应用 ${applied} 题知识点 —— ${capped ? `已达 ${MAX_WIZARD_ROUNDS} 轮上限，可能仍有待标注题` : '库内已无待标注题'}`
          : `已合并 ${merged} 条草稿到下方确认表 —— ${capped ? `已达 ${MAX_WIZARD_ROUNDS} 轮上限，可能仍有待标注题` : '库内已无待标注题'}，核对后统一写回`;
      setWizard({ running: false, round: rounds, applied, merged, error: null, summary });
      void load();
      void reloadTagOverview();
      onQuestionsChanged?.();
    } catch (err) {
      if (controller.signal.aborted) return; // Abort 后静默不报错
      setWizard({ running: false, round: rounds, applied, merged, error: err as ExamErrorDto, summary: null });
    } finally {
      // 取消/Abort 收尾：恢复 running=false（静默），严格模式已合并草稿保留待确认
      if (controller.signal.aborted) setWizard((prev) => ({ ...prev, running: false }));
    }
  };

  /**
   * 单题「AI 补标」：按 questionId 取该题建议 → applyTopics 写回 → 行内替换该题。
   * 行级 busy（suggestBusyId）与行级错误（suggestError）沿用 explainError 模式；
   * 独立取消域 suggestAbort，不影响向导/草稿流程。
   */
  const onSuggestOne = async (q: ExamQuestionDto) => {
    if (wizard.running) return; // 向导运行中禁止（共用标注资源）
    if (suggestBusyId !== null) return; // busy 防护：防重入
    if (isDeletedQuestion(q)) return;
    setSuggestBusyId(q.id);
    setSuggestError(null);
    suggestAbort.current?.abort();
    const controller = new AbortController();
    suggestAbort.current = controller;
    try {
      const items = await topicSuggestions(bankId, { questionIds: [q.id] }, controller.signal);
      if (controller.signal.aborted) return;
      const match = items.find((it) => it.questionId === q.id);
      const topics = (match?.suggestedTopics ?? []).slice();
      if (!match || topics.length === 0) {
        setSuggestError({
          questionId: q.id,
          error: { code: 'EXAM_NO_SUGGESTION', message: '未获得该题的知识点建议（可能为主观题或已标注）' },
        });
        return;
      }
      await applyTopics([{ questionId: q.id, topics }], controller.signal);
      if (controller.signal.aborted) return;
      // 行内替换该题（参考 explainGeneric 的行级更新模式，无需整表重拉）
      setQuestions((prev) =>
        prev.phase === 'ready'
          ? { ...prev, questions: prev.questions.map((item) => (item.id === q.id ? { ...item, topics } : item)) }
          : prev,
      );
      void reloadTagOverview();
      onQuestionsChanged?.();
    } catch (err) {
      if (controller.signal.aborted) return;
      setSuggestError({ questionId: q.id, error: err as ExamErrorDto });
    } finally {
      setSuggestBusyId(null);
    }
  };

  /**
   * Phase 4：G 形态 AI 生成/重新解析（POST explain-generic → 写回 questions.explanation）。
   * explanation 为空直接生成（主操作）；已有则两步确认覆盖（设计 §10.5 写回不可逆）。
   * busy 态防重复点击；成功后以响应 DTO 行内替换（无需整表重拉）。
   */
  const onExplainGeneric = async (q: ExamQuestionDto) => {
    const hasExplanation = typeof q.explanation === 'string' && q.explanation.length > 0;
    if (hasExplanation && confirmExplainId !== q.id) {
      setConfirmExplainId(q.id);
      return;
    }
    setConfirmExplainId(null);
    setExplainError(null);
    setExplainBusyId(q.id);
    mutateAbort.current?.abort();
    const controller = new AbortController();
    mutateAbort.current = controller;
    try {
      const updated = await explainGeneric(q.id, {}, controller.signal);
      setQuestions((prev) =>
        prev.phase === 'ready'
          ? { ...prev, questions: prev.questions.map((item) => (item.id === updated.id ? updated : item)) }
          : prev,
      );
    } catch (err) {
      setExplainError({ questionId: q.id, error: err as ExamErrorDto });
    } finally {
      setExplainBusyId(null);
    }
  };

  return (
    <div className="exam-assistant-workspace">
      <div className="exam-assistant-sticky">
        <button type="button" className="exam-assistant-button exam-assistant-button--ghost" onClick={onBack}>
          ← 返回题库列表
        </button>
        <h2 className="exam-assistant-workspace__headline">题库详情：{bankName}</h2>
        <p className="exam-assistant-workspace__subtitle">
          bankId {bankId} · 题目 {questions.phase === 'ready' ? questions.questions.length : '…'} 道
        </p>
      </div>

      {/* 题目列表 */}
      <section className="exam-assistant-card" aria-label="题目列表">
        <div className="exam-assistant-row">
          <h3 className="exam-assistant-card__title">题目列表</h3>
          <div className="exam-assistant-form-actions">
            <label className="exam-assistant-selectall">
              <input type="checkbox" checked={allSelected} onChange={toggleSelectAll} aria-label="全选当前题目" />
              全选
            </label>
            <button type="button" className="exam-assistant-button exam-assistant-button--ghost exam-assistant-button--sm" onClick={() => void load()}>
              刷新
            </button>
          </div>
        </div>

        {/* 过滤工具条（t9 契约：q/type/tags/hasExplanation/sort） */}
        <div className="exam-assistant-question-toolbar" role="group" aria-label="题目筛选">
          <div className="exam-assistant-question-toolbar__field">
            <label className="exam-assistant-form-label" htmlFor="exam-q-search">搜索</label>
            <input
              id="exam-q-search"
              className="exam-assistant-input"
              value={searchText}
              onChange={(event) => setSearchText(event.target.value)}
              placeholder="题干关键词…"
            />
          </div>
          <div className="exam-assistant-question-toolbar__field">
            <span className="exam-assistant-form-label">题型</span>
            <div className="exam-assistant-tags">
              {(['single', 'multiple', 'boolean', 'essay'] as ExamQuestionType[]).map((t) => {
                const active = typeFilter.includes(t);
                return (
                  <button
                    key={t}
                    type="button"
                    className={
                      active
                        ? 'exam-assistant-tag exam-assistant-tag--type exam-assistant-tag--type-active'
                        : 'exam-assistant-tag exam-assistant-tag--type'
                    }
                    aria-pressed={active}
                    onClick={() =>
                      setTypeFilter((prev) => (prev.includes(t) ? prev.filter((x) => x !== t) : [...prev, t]))
                    }
                  >
                    {questionTypeLabel(t)}
                  </button>
                );
              })}
            </div>
          </div>
          <div className="exam-assistant-question-toolbar__field">
            <label className="exam-assistant-form-label" htmlFor="exam-q-tags-filter">标签</label>
            <input
              id="exam-q-tags-filter"
              className="exam-assistant-input"
              value={tagsFilter}
              onChange={(event) => setTagsFilter(event.target.value)}
              placeholder="标签, 逗号分隔"
            />
          </div>
          <div className="exam-assistant-question-toolbar__field">
            <label className="exam-assistant-form-label" htmlFor="exam-q-explain">解析</label>
            <select
              id="exam-q-explain"
              className="exam-assistant-input"
              value={explainFilter}
              onChange={(event) => setExplainFilter(event.target.value as 'all' | 'has' | 'none')}
            >
              <option value="all">全部</option>
              <option value="has">有解析</option>
              <option value="none">无解析</option>
            </select>
          </div>
          <div className="exam-assistant-question-toolbar__field">
            <label className="exam-assistant-form-label" htmlFor="exam-q-sort">排序</label>
            <select
              id="exam-q-sort"
              className="exam-assistant-input"
              value={sortField}
              onChange={(event) => setSortField(event.target.value as 'createdAt' | 'updatedAt')}
            >
              <option value="createdAt">创建时间</option>
              <option value="updatedAt">更新时间</option>
            </select>
            <select
              className="exam-assistant-input"
              value={sortDir}
              onChange={(event) => setSortDir(event.target.value as 'asc' | 'desc')}
              aria-label="排序方向"
            >
              <option value="asc">升序</option>
              <option value="desc">降序</option>
            </select>
          </div>
          <div className="exam-assistant-question-toolbar__field">
            <span className="exam-assistant-form-label">显示已删</span>
            <label className="exam-assistant-selectall">
              <input
                id="exam-q-show-deleted"
                type="checkbox"
                checked={showDeleted}
                onChange={(event) => setShowDeleted(event.target.checked)}
              />
              已删/归档
            </label>
          </div>
        </div>

        {/* 多选批量操作条（t9 契约：bulkQuestions） */}
        {questions.phase === 'ready' && selectedIds.length > 0 ? (
          <div className="exam-assistant-question-batch" role="group" aria-label="批量操作">
            <span className="exam-assistant-llm__meta">已选 {selectedIds.length} 题</span>
            <button
              type="button"
              className="exam-assistant-button exam-assistant-button--ghost exam-assistant-button--sm"
              onClick={onBulkArchive}
              disabled={bulkBusy}
            >
              归档
            </button>
            <button
              type="button"
              className="exam-assistant-button exam-assistant-button--ghost exam-assistant-button--sm"
              onClick={onBulkRestore}
              disabled={bulkBusy}
            >
              恢复
            </button>
            <button
              type="button"
              className="exam-assistant-button exam-assistant-button--ghost exam-assistant-button--sm"
              onClick={() => setBatchTagOpen((o) => !o)}
              disabled={bulkBusy}
              aria-expanded={batchTagOpen}
            >
              加标签
            </button>
            {batchTagOpen ? (
              <span className="exam-assistant-question-batch__inline">
                <input
                  className="exam-assistant-input"
                  value={batchTagValue}
                  onChange={(event) => setBatchTagValue(event.target.value)}
                  placeholder="标签，如：重点"
                  aria-label="批量添加的标签"
                  autoFocus
                />
                <button type="button" className="exam-assistant-button exam-assistant-button--sm" onClick={onBulkTag} disabled={bulkBusy}>
                  {bulkBusy ? '处理中…' : '确认'}
                </button>
                <button type="button" className="exam-assistant-button exam-assistant-button--ghost exam-assistant-button--sm" onClick={() => setBatchTagOpen(false)}>
                  取消
                </button>
              </span>
            ) : null}
            <button
              type="button"
              className="exam-assistant-button exam-assistant-button--ghost exam-assistant-button--sm"
              onClick={() => setBatchTopicOpen((o) => !o)}
              disabled={bulkBusy}
              aria-expanded={batchTopicOpen}
            >
              设置知识点
            </button>
            {batchTopicOpen ? (
              <span className="exam-assistant-question-batch__inline">
                <input
                  className="exam-assistant-input"
                  value={batchTopicValue}
                  onChange={(event) => setBatchTopicValue(event.target.value)}
                  placeholder="知识点，如：架构治理"
                  aria-label="批量设置的知识点（逗号分隔）"
                  autoFocus
                />
                <button type="button" className="exam-assistant-button exam-assistant-button--sm" onClick={onBulkTopics} disabled={bulkBusy}>
                  {bulkBusy ? '处理中…' : '确认'}
                </button>
                <button type="button" className="exam-assistant-button exam-assistant-button--ghost exam-assistant-button--sm" onClick={() => setBatchTopicOpen(false)}>
                  取消
                </button>
              </span>
            ) : null}
            <button
              type="button"
              className="exam-assistant-button exam-assistant-button--ghost exam-assistant-button--sm"
              onClick={() => setBatchMoveOpen((o) => !o)}
              disabled={bulkBusy}
              aria-expanded={batchMoveOpen}
            >
              移动题库
            </button>
            {batchMoveOpen ? (
              <span className="exam-assistant-question-batch__inline">
                <select
                  className="exam-assistant-input"
                  value={batchMoveId}
                  onChange={(event) => setBatchMoveId(event.target.value)}
                  aria-label="批量移动到题库"
                  autoFocus
                >
                  <option value="">请选择…</option>
                  {banks.map((b) => (
                    <option key={b.id} value={b.id}>
                      {b.name}
                    </option>
                  ))}
                </select>
                <button type="button" className="exam-assistant-button exam-assistant-button--sm" onClick={onBulkMove} disabled={bulkBusy}>
                  {bulkBusy ? '处理中…' : '移动'}
                </button>
                <button type="button" className="exam-assistant-button exam-assistant-button--ghost exam-assistant-button--sm" onClick={() => setBatchMoveOpen(false)}>
                  取消
                </button>
              </span>
            ) : null}
            <button
              type="button"
              className="exam-assistant-button exam-assistant-button--ghost exam-assistant-button--sm"
              onClick={onBulkExplain}
              disabled={bulkBusy}
              title="为所选题目批量生成通用解析（LLM，可能较慢）"
            >
              生成解析
            </button>
            <button
              type="button"
              className={
                confirmBulkDelete
                  ? 'exam-assistant-button exam-assistant-button--danger exam-assistant-button--sm'
                  : 'exam-assistant-button exam-assistant-button--ghost exam-assistant-button--sm'
              }
              onClick={onBulkDelete}
              disabled={bulkBusy}
            >
              {confirmBulkDelete ? '确认删除？' : '删除'}
            </button>
            <button type="button" className="exam-assistant-button exam-assistant-button--ghost exam-assistant-button--sm" onClick={() => setSelectedIds([])}>
              清空
            </button>
            {bulkError !== null ? (
              <p className="exam-assistant-error" role="alert">
                {bulkError.code}: {bulkError.message}
              </p>
            ) : null}
          </div>
        ) : null}

        {deleteError !== null ? (
          <p className="exam-assistant-error" role="alert">
            删除失败：{deleteError.code}: {deleteError.message}
          </p>
        ) : null}
        {questions.phase === 'loading' ? (
          <div className="exam-assistant-skeleton">正在读取题目…</div>
        ) : questions.phase === 'error' ? (
          <p className="exam-assistant-error">
            {questions.error.code}: {questions.error.message}
          </p>
        ) : questions.questions.length === 0 ? (
          <p className="exam-assistant-empty">
            {query.trim().length > 0 || typeFilter.length > 0 || tagsFilter.trim().length > 0 || explainFilter !== 'all'
              ? '没有匹配的题目 —— 请调整筛选条件'
              : '本题库暂无题目 —— 使用下方表单添加第一题'}
          </p>
        ) : (
          <ul className="exam-assistant-question-list">
            {questions.questions.map((q, index) => (
              <li key={q.id} className="exam-assistant-question-item">
                <div className="exam-assistant-question-item__row">
                  <input
                    type="checkbox"
                    className="exam-assistant-question-item__check"
                    checked={selectedIds.includes(q.id)}
                    onChange={() => toggleSelect(q.id)}
                    aria-label={`选择本题（${q.stem}）`}
                  />
                  <button
                    type="button"
                    className="exam-assistant-question-item__head"
                    onClick={() => setExpandedId(expandedId === q.id ? null : q.id)}
                    aria-expanded={expandedId === q.id}
                  >
                    <span className="exam-assistant-question-item__no">{index + 1}.</span>
                    <span className="exam-assistant-question-item__stem">{q.stem}</span>
                  </button>
                  <div className="exam-assistant-question-item__side">
                    <span className="exam-assistant-tags">
                      <span className={`exam-assistant-question-item__badge exam-assistant-question-item__badge--${q.type}`}>
                        {questionTypeLabel(q.type)}
                      </span>
                      {q.deletedAt !== null && q.deletedAt !== undefined ? (
                        /* 软删除标记（t1 删题只标 deletedAt；正常列表不会出现，异常/未来恢复场景兜底展示） */
                        <span className="exam-assistant-question-item__badge exam-assistant-question-item__badge--deleted">
                          已删除
                        </span>
                      ) : null}
                      {q.tags && q.tags.length > 0
                        ? q.tags.map((tag) => (
                            <span key={tag} className="exam-assistant-tag">
                              {tag}
                            </span>
                          ))
                        : null}
                      {q.topics && q.topics.length > 0
                        ? q.topics.map((topic) => (
                            <span key={topic} className="exam-assistant-topic-chip">
                              {topic}
                            </span>
                          ))
                        : null}
                    </span>
                    <div className="exam-assistant-question-item__actions">
                      {isDeletedQuestion(q) ? (
                        /* 已删/已归档题：仅保留「恢复」，避免误操作编辑/删除/生成解析。 */
                        <button
                          type="button"
                          className="exam-assistant-button exam-assistant-button--sm"
                          disabled={bulkBusy}
                          onClick={() => void onRestoreOne(q)}
                        >
                          恢复
                        </button>
                      ) : (
                        <>
                          <button
                            type="button"
                            className="exam-assistant-button exam-assistant-button--ghost exam-assistant-button--sm"
                            onClick={() => startEdit(q)}
                          >
                            编辑
                          </button>
                          <button
                            type="button"
                            className="exam-assistant-button exam-assistant-button--ghost exam-assistant-button--sm"
                            disabled={suggestBusyId !== null || wizard.running}
                            onClick={() => void onSuggestOne(q)}
                            title="AI 为该题生成知识点建议并写回"
                          >
                            {suggestBusyId === q.id ? '补标中…' : 'AI 补标'}
                          </button>
                          <button
                            type="button"
                            className={
                              confirmDeleteId === q.id
                                ? 'exam-assistant-button exam-assistant-button--danger exam-assistant-button--sm'
                                : 'exam-assistant-button exam-assistant-button--ghost exam-assistant-button--sm'
                            }
                            onClick={() => void onDelete(q.id)}
                          >
                            {confirmDeleteId === q.id ? '确认删除？' : '删除'}
                          </button>
                          {confirmDeleteId === q.id ? (
                            <button
                              type="button"
                              className="exam-assistant-button exam-assistant-button--ghost exam-assistant-button--sm"
                              onClick={() => setConfirmDeleteId(null)}
                            >
                              取消
                            </button>
                          ) : null}
                        </>
                      )}
                    </div>
                  </div>
                </div>
                {suggestError?.questionId === q.id ? (
                  <p className="exam-assistant-question-item__error" role="alert">
                    AI 补标失败：{suggestError.error.code}: {suggestError.error.message}
                  </p>
                ) : null}
                {expandedId === q.id ? (
                  <div className="exam-assistant-question-item__detail">
                    {q.options.length > 0 ? (
                      <ul className="exam-assistant-option-list">
                        {q.options.map((opt, i) => (
                          <li key={i}>
                            {optionLabel(i)}. {opt}
                          </li>
                        ))}
                      </ul>
                    ) : null}
                    <p className="exam-assistant-kv">
                      <span className="exam-assistant-kv__key">正确答案</span>
                      <span className="exam-assistant-kv__value">{answerText(q)}</span>
                      {q.explanation ? (
                        <>
                          <span className="exam-assistant-kv__key">解析</span>
                          <span className="exam-assistant-kv__value">{q.explanation}</span>
                        </>
                      ) : null}
                      {q.topics && q.topics.length > 0 ? (
                        <>
                          <span className="exam-assistant-kv__key">知识点</span>
                          <span className="exam-assistant-kv__value">{q.topics.join('、')}</span>
                        </>
                      ) : null}
                      <span className="exam-assistant-kv__key">更新时间</span>
                      <span className="exam-assistant-kv__value">{formatTime(q.updatedAt)}</span>
                    </p>
                    {/* Phase 4：G 形态 AI 解析（essay 不提供——批改反馈已是解析；已删/归档题不提供——恢复后再生成） */}
                    {q.type !== 'essay' && !isDeletedQuestion(q) ? (
                      <div className="exam-assistant-question-item__actions">
                        {q.explanation === null || q.explanation.length === 0 ? (
                          <button
                            type="button"
                            className="exam-assistant-button exam-assistant-button--sm"
                            disabled={explainBusyId !== null}
                            onClick={() => void onExplainGeneric(q)}
                          >
                            {explainBusyId === q.id ? '生成中…' : '✦ AI 生成解析'}
                          </button>
                        ) : (
                          <>
                            <button
                              type="button"
                              className={
                                confirmExplainId === q.id
                                  ? 'exam-assistant-button exam-assistant-button--danger exam-assistant-button--sm'
                                  : 'exam-assistant-button exam-assistant-button--ghost exam-assistant-button--sm'
                              }
                              disabled={explainBusyId !== null}
                              onClick={() => void onExplainGeneric(q)}
                            >
                              {explainBusyId === q.id
                                ? '重新解析中…'
                                : confirmExplainId === q.id
                                  ? '确认覆盖？'
                                  : '↻ 重新解析'}
                            </button>
                            {confirmExplainId === q.id ? (
                              <button
                                type="button"
                                className="exam-assistant-button exam-assistant-button--ghost exam-assistant-button--sm"
                                onClick={() => setConfirmExplainId(null)}
                              >
                                取消
                              </button>
                            ) : null}
                          </>
                        )}
                      </div>
                    ) : null}
                    {explainError?.questionId === q.id ? (
                      <p className="exam-assistant-error" role="alert">
                        {explainError.error.code}: {explainError.error.message}
                      </p>
                    ) : null}
                    {onAskAi && !isDeletedQuestion(q) ? (
                      <div className="exam-assistant-question-item__actions">
                        <button
                          type="button"
                          className="exam-assistant-button exam-assistant-button--ghost"
                          onClick={() => onAskAi(q)}
                        >
                          AI 讲解
                        </button>
                      </div>
                    ) : null}
                  </div>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* 标签一览：聚合该库 tags + topics 频次；提供「AI 知识标注…」入口（P2 草稿确认制） */}
      <section className="exam-assistant-card" aria-label="标签一览">
        <div className="exam-assistant-row">
          <h3 className="exam-assistant-card__title">标签一览</h3>
          <button
            type="button"
            className="exam-assistant-button exam-assistant-button--sm"
            disabled={
              wizard.running ||
              topicSuggest.phase === 'loading' ||
              (topicSuggest.phase === 'ready' && topicSuggest.submitting)
            }
            onClick={() => void onTopicSuggest()}
          >
            {topicSuggest.phase === 'loading' ? 'AI 标注中…' : 'AI 知识标注…'}
          </button>
        </div>

        {/* 全库标注向导：宽松自动写回 / 严格合并草稿（P2 批量标注升级） */}
        <div className="exam-assistant-wizard">
          <div className="exam-assistant-wizard__toolbar">
            <div className="exam-assistant-wizard__modes" role="group" aria-label="全库标注模式">
              <button
                type="button"
                className={
                  wizardMode === 'lenient'
                    ? 'exam-assistant-wizard__mode exam-assistant-wizard__mode--active'
                    : 'exam-assistant-wizard__mode'
                }
                disabled={wizard.running}
                aria-pressed={wizardMode === 'lenient'}
                onClick={() => setWizardMode('lenient')}
              >
                宽松
              </button>
              <button
                type="button"
                className={
                  wizardMode === 'strict'
                    ? 'exam-assistant-wizard__mode exam-assistant-wizard__mode--active'
                    : 'exam-assistant-wizard__mode'
                }
                disabled={wizard.running}
                aria-pressed={wizardMode === 'strict'}
                onClick={() => setWizardMode('strict')}
              >
                严格
              </button>
            </div>
            <span className="exam-assistant-llm__meta">
              {wizardMode === 'lenient'
                ? '宽松：每轮建议自动写回，逐批累计'
                : '严格：各轮草稿合并到下方确认表，核对后统一写回'}
            </span>
            <div className="exam-assistant-form-actions">
              <button
                type="button"
                className="exam-assistant-button exam-assistant-button--sm"
                disabled={
                  wizard.running ||
                  topicSuggest.phase === 'loading' ||
                  (topicSuggest.phase === 'ready' && topicSuggest.submitting)
                }
                onClick={() => void onAnnotateAll()}
              >
                {wizard.running ? '标注中…' : '一键标注全库'}
              </button>
              {wizard.running ? (
                <button
                  type="button"
                  className="exam-assistant-button exam-assistant-button--ghost exam-assistant-button--sm"
                  onClick={() => topicAbort.current?.abort()}
                >
                  取消
                </button>
              ) : null}
            </div>
          </div>
          {wizard.running ? (
            <p className="exam-assistant-llm__meta" role="status">
              正在标注全库… 第 {wizard.round} 轮
              {wizardMode === 'lenient' ? ` · 已应用 ${wizard.applied} 题` : ` · 已合并 ${wizard.merged} 条草稿`}
            </p>
          ) : wizard.summary !== null ? (
            <p className="exam-assistant-status exam-assistant-status--ok" role="status">
              <span className="exam-assistant-status__dot" aria-hidden="true" />
              {wizard.summary}
            </p>
          ) : null}
          {wizard.error !== null ? (
            <p className="exam-assistant-error" role="alert">
              {wizard.error.code}: {wizard.error.message}
            </p>
          ) : null}
        </div>
        {tagOverview === null ? (
          <p className="exam-assistant-empty">暂无标签 / 知识点数据</p>
        ) : (
          <div className="exam-assistant-tag-overview">
            <div>
              <p className="exam-assistant-form-label">主题标签（{tagOverview.tags.length}）</p>
              {tagOverview.tags.length === 0 ? (
                <p className="exam-assistant-empty">题库暂无主题标签</p>
              ) : (
                <div className="exam-assistant-tags">
                  {tagOverview.tags.map((t) => (
                    <span key={t.label} className="exam-assistant-tag">
                      {t.label} · {t.count}
                    </span>
                  ))}
                </div>
              )}
            </div>
            <div>
              <p className="exam-assistant-form-label">知识点（{tagOverview.topics.length}）</p>
              {tagOverview.topics.length === 0 ? (
                <p className="exam-assistant-empty">题库暂无知识点 —— 可用「AI 知识标注」自动补全</p>
              ) : (
                <div className="exam-assistant-tags">
                  {tagOverview.topics.map((t) => (
                    <span key={t.label} className="exam-assistant-topic-chip">
                      {t.label} · {t.count}
                    </span>
                  ))}
                </div>
              )}
            </div>
          </div>
        )}

        {/* AI 知识标注（P2 批量标注草稿确认制） */}
        {topicSuggest.phase === 'loading' ? (
          <div className="exam-assistant-skeleton">正在生成知识点候选…</div>
        ) : topicSuggest.phase === 'error' ? (
          <p className="exam-assistant-error" role="alert">
            {topicSuggest.error.code}: {topicSuggest.error.message}
          </p>
        ) : topicSuggest.phase === 'ready' ? (
          <div className="exam-assistant-topic-suggest">
            <div className="exam-assistant-row">
              <span className="exam-assistant-llm__meta">共 {topicSuggest.rows.length} 道候选 —— 逐题核对后写回</span>
              <div className="exam-assistant-form-actions">
                <label className="exam-assistant-selectall">
                  <input
                    type="checkbox"
                    checked={topicSuggest.rows.length > 0 && topicSuggest.rows.every((r) => r.selected)}
                    onChange={toggleAllTopics}
                    disabled={topicSuggest.submitting || wizard.running}
                    aria-label="全选知识点候选"
                  />
                  全选
                </label>
                <button
                  type="button"
                  className="exam-assistant-button exam-assistant-button--ghost exam-assistant-button--sm"
                  disabled={topicSuggest.submitting || wizard.running}
                  onClick={() => setTopicSuggest({ phase: 'idle' })}
                >
                  放弃
                </button>
                <button
                  type="button"
                  className="exam-assistant-button exam-assistant-button--sm"
                  disabled={topicSuggest.submitting || wizard.running}
                  onClick={() => void onApplyTopicChanges()}
                >
                  {topicSuggest.submitting ? '写回中…' : '确认写回'}
                </button>
              </div>
            </div>
            {topicSuggest.rows.length === 0 ? (
              <p className="exam-assistant-empty">无客观题可标注 —— 该题库所有题目或已全部标注</p>
            ) : (
              <ul className="exam-assistant-topic-suggest__list">
                {topicSuggest.rows.map((row, i) => (
                  <li key={row.questionId} className="exam-assistant-topic-suggest__item">
                    <div className="exam-assistant-topic-suggest__head">
                      <label className="exam-assistant-selectall">
                        <input
                          type="checkbox"
                          checked={row.selected}
                          onChange={() => updateTopicRow(i, { selected: !row.selected })}
                          disabled={topicSuggest.submitting || wizard.running}
                          aria-label={`选择本题（${row.stem}）`}
                        />
                      </label>
                      <span className="exam-assistant-topic-suggest__stem">{row.stem}</span>
                      <button
                        type="button"
                        className="exam-assistant-button exam-assistant-button--ghost exam-assistant-button--sm"
                        onClick={() => removeTopicRow(i)}
                        disabled={topicSuggest.submitting || wizard.running}
                        aria-label={`删除第 ${i + 1} 条草稿`}
                      >
                        删除
                      </button>
                    </div>
                    <div className="exam-assistant-topic-suggest__meta">
                      <span className="exam-assistant-llm__meta">
                        现有标签：
                        {row.currentTags.length > 0 ? row.currentTags.join('、') : '无'}
                      </span>
                      <span className="exam-assistant-llm__meta">
                        现有知识点：
                        {row.currentTopics.length > 0 ? row.currentTopics.join('、') : '无'}
                      </span>
                    </div>
                    <div className="exam-assistant-form-row">
                      <label className="exam-assistant-form-label" htmlFor={`exam-topic-suggest-${i}`}>
                        建议知识点（逗号分隔）
                      </label>
                      <input
                        id={`exam-topic-suggest-${i}`}
                        className="exam-assistant-input"
                        value={row.suggested}
                        onChange={(event) => updateTopicRow(i, { suggested: event.target.value })}
                        disabled={topicSuggest.submitting || wizard.running}
                        placeholder="知识单元级，2~4 个，不要用题库名"
                      />
                    </div>
                  </li>
                ))}
              </ul>
            )}
            {topicSuggest.error !== null ? (
              <p className="exam-assistant-error" role="alert">
                {topicSuggest.error.code}: {topicSuggest.error.message}
              </p>
            ) : null}
            {topicSuggest.applied !== null ? (
              <p className="exam-assistant-status exam-assistant-status--ok" role="status">
                <span className="exam-assistant-status__dot" aria-hidden="true" />
                已写回 {topicSuggest.applied} 题知识点 —— 标签一览与题目列表已刷新
              </p>
            ) : null}
          </div>
        ) : null}
      </section>

      {/* 新增/编辑题目表单（编辑时预填当前题目值） */}
      <section ref={formRef} className="exam-assistant-card" aria-label={editingId === null ? '新增题目' : '编辑题目'}>
        <div className="exam-assistant-row">
          <h3 className="exam-assistant-card__title">{editingId === null ? '新增题目' : '编辑题目'}</h3>
          {editingId !== null ? (
            <button
              type="button"
              className="exam-assistant-button exam-assistant-button--ghost exam-assistant-button--sm"
              onClick={cancelEdit}
            >
              取消编辑
            </button>
          ) : null}
        </div>
        <form className="exam-assistant-question-form" onSubmit={(event) => void onCreate(event)}>
          <div className="exam-assistant-form-row">
            <label className="exam-assistant-form-label" htmlFor="exam-q-type">
              题型
            </label>
            <select
              id="exam-q-type"
              className="exam-assistant-input"
              value={form.type}
              onChange={(event) => {
                const type = event.target.value as ExamQuestionType;
                setForm((prev) => ({
                  ...prev,
                  type,
                  singleAnswer: 0,
                  multipleAnswers: prev.multipleAnswers.length > 0 ? prev.multipleAnswers : [0],
                }));
              }}
            >
              <option value="single">单选</option>
              <option value="multiple">多选</option>
              <option value="boolean">判断</option>
              <option value="essay">主观（AI 批改）</option>
            </select>
          </div>

          <div className="exam-assistant-form-row">
            <label className="exam-assistant-form-label" htmlFor="exam-q-stem">
              题干
            </label>
            <textarea
              id="exam-q-stem"
              className="exam-assistant-input"
              rows={2}
              value={form.stem}
              onChange={(event) => setForm((prev) => ({ ...prev, stem: event.target.value }))}
              placeholder="题面内容…"
            />
          </div>

          {form.type === 'essay' ? (
            <div className="exam-assistant-form-row">
              <p className="exam-assistant-empty exam-assistant-essay-hint">
                主观题：由 AI 批改，无需选项与标准答案。学生在练习中提交文字作答后自动批改。
              </p>
            </div>
          ) : form.type !== 'boolean' ? (
            <div className="exam-assistant-form-row exam-assistant-form-row--col">
              <span className="exam-assistant-form-label">选项（勾选/点选标记正确答案）</span>
              {form.options.map((opt, i) => (
                <div key={i} className="exam-assistant-option-row">
                  <span className="exam-assistant-option-row__label">{optionLabel(i)}</span>
                  <input
                    className="exam-assistant-input"
                    value={opt}
                    onChange={(event) => setOption(i, event.target.value)}
                    aria-label={`选项 ${optionLabel(i)}`}
                  />
                  {form.type === 'single' ? (
                    <input
                      type="radio"
                      name="exam-q-single-answer"
                      checked={form.singleAnswer === i}
                      onChange={() => setForm((prev) => ({ ...prev, singleAnswer: i }))}
                      aria-label={`设为正确答案（${optionLabel(i)}）`}
                    />
                  ) : (
                    <input
                      type="checkbox"
                      checked={form.multipleAnswers.includes(i)}
                      onChange={() => toggleMultiple(i)}
                      aria-label={`设为正确答案（${optionLabel(i)}）`}
                    />
                  )}
                  <button
                    type="button"
                    className="exam-assistant-button exam-assistant-button--ghost exam-assistant-button--sm"
                    onClick={() => removeOption(i)}
                    disabled={form.options.length <= 2}
                    aria-label={`删除选项 ${optionLabel(i)}`}
                  >
                    删除
                  </button>
                </div>
              ))}
              <button type="button" className="exam-assistant-button exam-assistant-button--ghost exam-assistant-button--sm" onClick={addOption}>
                + 添加选项
              </button>
            </div>
          ) : (
            <div className="exam-assistant-form-row">
              <label className="exam-assistant-form-label" htmlFor="exam-q-bool">
                正确答案
              </label>
              <select
                id="exam-q-bool"
                className="exam-assistant-input"
                value={form.booleanAnswer}
                onChange={(event) => setForm((prev) => ({ ...prev, booleanAnswer: event.target.value as 'true' | 'false' }))}
              >
                <option value="true">对</option>
                <option value="false">错</option>
              </select>
            </div>
          )}

          <div className="exam-assistant-form-row">
            <label className="exam-assistant-form-label" htmlFor="exam-q-explanation">
              解析（可选）
            </label>
            <textarea
              id="exam-q-explanation"
              className="exam-assistant-input"
              rows={2}
              value={form.explanation}
              onChange={(event) => setForm((prev) => ({ ...prev, explanation: event.target.value }))}
            />
          </div>

          <div className="exam-assistant-form-row">
            <label className="exam-assistant-form-label" htmlFor="exam-q-tags">
              标签（逗号分隔，可选）
            </label>
            <input
              id="exam-q-tags"
              className="exam-assistant-input"
              value={form.tags}
              onChange={(event) => setForm((prev) => ({ ...prev, tags: event.target.value }))}
              placeholder="高数, 微积分"
            />
          </div>

          <div className="exam-assistant-form-row">
            <label className="exam-assistant-form-label" htmlFor="exam-q-topics">
              知识点（逗号分隔，可选）
            </label>
            <input
              id="exam-q-topics"
              className="exam-assistant-input"
              value={form.topics}
              onChange={(event) => setForm((prev) => ({ ...prev, topics: event.target.value }))}
              placeholder="知识单元级，2~4 个，不要用题库名"
            />
          </div>

          {create.phase === 'error' ? (
            <p className="exam-assistant-error" role="alert">
              {create.error.code}: {create.error.message}
            </p>
          ) : null}
          {create.phase === 'created' ? (
            <p className="exam-assistant-status exam-assistant-status--ok" role="status">
              <span className="exam-assistant-status__dot" aria-hidden="true" />
              {editingId === null ? '题目已添加' : '题目已更新'}
            </p>
          ) : null}

          <div className="exam-assistant-form-actions">
            <button type="submit" className="exam-assistant-button" disabled={create.phase === 'submitting'}>
              {create.phase === 'submitting' ? '保存中…' : editingId === null ? '添加题目' : '保存修改'}
            </button>
          </div>
        </form>
      </section>
    </div>
  );
}
