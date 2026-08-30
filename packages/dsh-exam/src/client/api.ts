/**
 * dsh-exam API client —— 固定根路径 `/exam/api`（不碰 DSH 的 /api）。
 * 同源 fetch；无 CORS。
 *
 * Phase 0：health / banks / llm/test SSE
 * Phase 1：questions CRUD、practice start/get/patch/grade/finish/scorecard、wrong list/master
 * Phase 2：essay SSE 批改、Tutor 对话、AI 导入、学情洞察/诊断、学习计划、练习历史/续做
 *   （路由与响应包络对齐 src/host/index.ts；错误统一抛 { code, message }）
 */
import { streamSse, type SseHandlers } from './sse.ts';
import type {
  BulkQuestionOp,
  BulkQuestionsResult,
  ApplyTopicsRequest,
  ApplyTopicsResult,
  ChatTutorRequest,
  ChatTutorResultDto,
  CommitImportRequest,
  CommitImportResult,
  CreateManualPlanRequest,
  CreateQuestionRequest,
  DiagnoseInsightRequest,
  DiagnosisDto,
  DiagnosisRecordDto,
  EssayGradingResultDto,
  EssayGradingDto,
  ExamAttemptDto,
  ExamBankDto,
  ExamCreateBankRequest,
  ExamErrorDto,
  ExamHealthDto,
  ExamLlmTestRequest,
  ExamQuestionDto,
  ExplainDepth,
  ExplainGenericRequest,
  ExplainRequest,
  ExplainResultDto,
  ExplanationDto,
  FinishPracticeResponse,
  GeneratePlanRequest,
  GradeAnswerRequest,
  GradeEssayRequest,
  ImportedQuestion,
  InsightSummary,
  ListDiagnosesResult,
  ListPlansResult,
  ListQuestionsFilter,
  PlanDto,
  PlanItemDto,
  PlanWithItemsDto,
  PracticeHistoryItemDto,
  PracticeSessionDto,
  RenameBankRequest,
  ResumePracticeResponse,
  ScorecardDto,
  SetMasteredRequest,
  StartPracticeRequest,
  TopicSuggestionDto,
  TopicSuggestionsResultDto,
  TutorMessageDto,
  TutorSessionDto,
  UpdatePracticeIndexRequest,
  UpdateQuestionRequest,
  WrongEntryDto,
} from './types.ts';

export const EXAM_API_BASE = '/exam/api';

/** 网络层失败（fetch 抛错/未连通 Host）时使用的兜底错误。 */
const NETWORK_ERROR: ExamErrorDto = {
  code: 'EXAM_NETWORK',
  message: '无法连接考试助手 Host 服务（/exam/api 不可达）',
};

/** 请求被 AbortSignal 取消——不是网络故障，避免误导性"无法连接"提示。 */
const ABORTED_ERROR: ExamErrorDto = { code: 'EXAM_ABORTED', message: '请求已取消' };

function networkOrAborted(err: unknown): ExamErrorDto {
  return err instanceof DOMException && err.name === 'AbortError' ? ABORTED_ERROR : NETWORK_ERROR;
}

async function parseError(resp: Response): Promise<ExamErrorDto> {
  try {
    const body: unknown = await resp.json();
    if (
      typeof body === 'object' &&
      body !== null &&
      typeof (body as { error?: unknown }).error === 'object' &&
      (body as { error: { message?: unknown } }).error !== null
    ) {
      const err = (body as { error: { code?: unknown; message?: unknown } }).error;
      return {
        code: typeof err.code === 'string' ? err.code : `HTTP_${resp.status}`,
        message: typeof err.message === 'string' ? err.message : `请求失败 (${resp.status})`,
      };
    }
  } catch {
    /* 非 JSON，走兜底 */
  }
  return { code: `HTTP_${resp.status}`, message: `请求失败 (${resp.status})` };
}

/** 通用 JSON 请求：非 2xx 抛 ExamErrorDto；expectStatus 校验指定状态码。 */
async function jsonRequest<T>(
  url: string,
  init: RequestInit,
  expectStatus: number[] = [200],
  signal?: AbortSignal,
): Promise<T> {
  let resp: Response;
  try {
    resp = await fetch(url, {
      ...init,
      signal,
      headers: { Accept: 'application/json', ...(init.headers ?? {}) },
    });
  } catch (err) {
    throw networkOrAborted(err);
  }
  if (!expectStatus.includes(resp.status)) throw await parseError(resp);
  if (resp.status === 204) return undefined as T;
  return (await resp.json()) as T;
}

function jsonBody(method: string, body: unknown): RequestInit {
  return { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
}

// ── Phase 0 ────────────────────────────────────────────────────────────────

export async function getHealth(signal?: AbortSignal): Promise<ExamHealthDto> {
  let resp: Response;
  try {
    resp = await fetch(`${EXAM_API_BASE}/health`, { signal, headers: { Accept: 'application/json' } });
  } catch (err) {
    throw networkOrAborted(err);
  }
  // 200/503 均为同结构 DTO；其余状态按错误处理
  if (resp.status !== 200 && resp.status !== 503) throw await parseError(resp);
  return (await resp.json()) as ExamHealthDto;
}

/** GET /exam/api/banks 查询选项（t9 题库生命周期：默认仅返回活跃题库）。 */
export interface ListBanksOptions {
  /** true = 同时返回已归档题库。 */
  includeArchived?: boolean;
  /** true = 同时返回已删除题库。 */
  includeDeleted?: boolean;
}

/** GET /exam/api/banks?includeArchived&includeDeleted → { banks }。 */
export async function listBanks(
  options: ListBanksOptions = {},
  signal?: AbortSignal,
): Promise<ExamBankDto[]> {
  const params = new URLSearchParams();
  if (options.includeArchived === true) params.set('includeArchived', 'true');
  if (options.includeDeleted === true) params.set('includeDeleted', 'true');
  const qs = params.toString();
  const body = await jsonRequest<{ banks?: ExamBankDto[] }>(
    `${EXAM_API_BASE}/banks${qs ? `?${qs}` : ''}`,
    { method: 'GET' },
    [200],
    signal,
  );
  return body.banks ?? [];
}

/** PATCH /exam/api/banks/:id → { bank }（重命名）。 */
export async function renameBank(id: string, name: string, signal?: AbortSignal): Promise<ExamBankDto> {
  const payload: RenameBankRequest = { name };
  const body = await jsonRequest<{ bank?: ExamBankDto }>(
    `${EXAM_API_BASE}/banks/${encodeURIComponent(id)}`,
    jsonBody('PATCH', payload),
    [200],
    signal,
  );
  if (!body.bank) throw { code: 'EXAM_INTERNAL', message: '重命名成功但响应缺少 bank 字段' } satisfies ExamErrorDto;
  return body.bank;
}

/** POST /exam/api/banks/:id/archive → { bank }（归档）。 */
export async function archiveBank(id: string, signal?: AbortSignal): Promise<ExamBankDto> {
  const body = await jsonRequest<{ bank?: ExamBankDto }>(
    `${EXAM_API_BASE}/banks/${encodeURIComponent(id)}/archive`,
    { method: 'POST' },
    [200],
    signal,
  );
  if (!body.bank) throw { code: 'EXAM_INTERNAL', message: '归档成功但响应缺少 bank 字段' } satisfies ExamErrorDto;
  return body.bank;
}

/** POST /exam/api/banks/:id/restore → { bank }（恢复归档）。 */
export async function restoreBank(id: string, signal?: AbortSignal): Promise<ExamBankDto> {
  const body = await jsonRequest<{ bank?: ExamBankDto }>(
    `${EXAM_API_BASE}/banks/${encodeURIComponent(id)}/restore`,
    { method: 'POST' },
    [200],
    signal,
  );
  if (!body.bank) throw { code: 'EXAM_INTERNAL', message: '恢复成功但响应缺少 bank 字段' } satisfies ExamErrorDto;
  return body.bank;
}

/** DELETE /exam/api/banks/:id → 204（软删除）。 */
export async function deleteBank(id: string, signal?: AbortSignal): Promise<void> {
  await jsonRequest<void>(
    `${EXAM_API_BASE}/banks/${encodeURIComponent(id)}`,
    { method: 'DELETE' },
    [204],
    signal,
  );
}

export async function createBank(name: string, signal?: AbortSignal): Promise<ExamBankDto> {
  const payload: ExamCreateBankRequest = { name };
  const body = await jsonRequest<{ bank?: ExamBankDto }>(
    `${EXAM_API_BASE}/banks`,
    jsonBody('POST', payload),
    [201],
    signal,
  );
  if (!body.bank) throw { code: 'EXAM_INTERNAL', message: '创建成功但响应缺少 bank 字段' } satisfies ExamErrorDto;
  return body.bank;
}

export interface StreamLlmOptions {
  provider?: string;
  model?: string;
  signal?: AbortSignal;
}

/** llm/test SSE done 事件的 result 载荷。 */
export interface StreamLlmResult {
  text: string;
  usage?: unknown;
  finish: string;
  provider: string;
  model: string;
}

/** 发起 LLM 流式测试；结果通过 handlers 回调（delta/done/error），promise 仅在传输收尾后 resolve。 */
export async function streamLlmTest(
  prompt: string,
  handlers: SseHandlers<StreamLlmResult>,
  opts: StreamLlmOptions = {},
): Promise<void> {
  const body: ExamLlmTestRequest = { prompt };
  if (opts.provider !== undefined) body.provider = opts.provider;
  if (opts.model !== undefined) body.model = opts.model;
  await streamSse(`${EXAM_API_BASE}/llm/test`, body, handlers, opts.signal);
}

// ── Phase 1：题目 ──────────────────────────────────────────────────────────

/** GET /exam/api/banks/:bankId/questions → { questions }（t9 支持 q/type/tags/hasExplanation/sort 过滤）。 */
export async function listQuestions(
  bankId: string,
  filter: ListQuestionsFilter = {},
  signal?: AbortSignal,
): Promise<ExamQuestionDto[]> {
  const params = new URLSearchParams();
  if (filter.q !== undefined && filter.q.trim().length > 0) params.set('q', filter.q.trim());
  if (filter.type !== undefined) {
    const types = Array.isArray(filter.type) ? filter.type : [filter.type];
    params.set('type', types.join(','));
  }
  if (filter.tags !== undefined) {
    const tags = Array.isArray(filter.tags) ? filter.tags : [filter.tags];
    params.set('tags', tags.join(','));
  }
  if (filter.hasExplanation !== undefined) params.set('hasExplanation', String(filter.hasExplanation));
  if (filter.includeDeleted === true) params.set('includeDeleted', 'true');
  if (filter.sort !== undefined) params.set('sort', `${filter.sort.field}:${filter.sort.dir}`);
  const qs = params.toString();
  const body = await jsonRequest<{ questions?: ExamQuestionDto[] }>(
    `${EXAM_API_BASE}/banks/${encodeURIComponent(bankId)}/questions${qs ? `?${qs}` : ''}`,
    { method: 'GET' },
    [200],
    signal,
  );
  return body.questions ?? [];
}

/**
 * POST /exam/api/questions/bulk → BulkQuestionsResult（t9 批量操作）。
 * op：tag/move/archive/restore/delete/explain-generic；逐个应用到给定题目 id 集合。
 * explain-generic 走 LLM（可能较慢），其余为本地批量。
 */
export async function bulkQuestions(op: BulkQuestionOp, signal?: AbortSignal): Promise<BulkQuestionsResult> {
  return jsonRequest<BulkQuestionsResult>(
    `${EXAM_API_BASE}/questions/bulk`,
    jsonBody('POST', op),
    [200],
    signal,
  );
}

/** POST /exam/api/banks/:bankId/questions → 201 { question }。 */
export async function createQuestion(
  bankId: string,
  input: CreateQuestionRequest,
  signal?: AbortSignal,
): Promise<ExamQuestionDto> {
  const body = await jsonRequest<{ question?: ExamQuestionDto }>(
    `${EXAM_API_BASE}/banks/${encodeURIComponent(bankId)}/questions`,
    jsonBody('POST', input),
    [201],
    signal,
  );
  if (!body.question) throw { code: 'EXAM_INTERNAL', message: '创建成功但响应缺少 question 字段' } satisfies ExamErrorDto;
  return body.question;
}

/** PUT /exam/api/questions/:id → 200 { question }。 */
export async function updateQuestion(
  id: string,
  patch: UpdateQuestionRequest,
  signal?: AbortSignal,
): Promise<ExamQuestionDto> {
  const body = await jsonRequest<{ question?: ExamQuestionDto }>(
    `${EXAM_API_BASE}/questions/${encodeURIComponent(id)}`,
    jsonBody('PUT', patch),
    [200],
    signal,
  );
  if (!body.question) throw { code: 'EXAM_INTERNAL', message: '更新成功但响应缺少 question 字段' } satisfies ExamErrorDto;
  return body.question;
}

/** DELETE /exam/api/questions/:id → 204。 */
export async function deleteQuestion(id: string, signal?: AbortSignal): Promise<void> {
  await jsonRequest<void>(
    `${EXAM_API_BASE}/questions/${encodeURIComponent(id)}`,
    { method: 'DELETE' },
    [204],
    signal,
  );
}

// ── Phase 1：练习 ──────────────────────────────────────────────────────────

/** POST /exam/api/practice/start → 201 { practice }。 */
export async function startPractice(
  input: StartPracticeRequest,
  signal?: AbortSignal,
): Promise<PracticeSessionDto> {
  const body = await jsonRequest<{ practice?: PracticeSessionDto }>(
    `${EXAM_API_BASE}/practice/start`,
    jsonBody('POST', input),
    [201],
    signal,
  );
  if (!body.practice) throw { code: 'EXAM_INTERNAL', message: '启动成功但响应缺少 practice 字段' } satisfies ExamErrorDto;
  return body.practice;
}

/** GET /exam/api/practice/:id → 续做态（裸体 { practice, latestAttempts }）。 */
export async function resumePractice(id: string, signal?: AbortSignal): Promise<ResumePracticeResponse> {
  return jsonRequest<ResumePracticeResponse>(
    `${EXAM_API_BASE}/practice/${encodeURIComponent(id)}`,
    { method: 'GET' },
    [200],
    signal,
  );
}

/** DELETE /exam/api/practice/:id → 204（删除历史条目；作答记录保留）。 */
export async function deletePracticeSession(id: string, signal?: AbortSignal): Promise<void> {
  await jsonRequest<void>(
    `${EXAM_API_BASE}/practice/${encodeURIComponent(id)}`,
    { method: 'DELETE' },
    [204],
    signal,
  );
}

/** PATCH /exam/api/practice/:id → { practice }。 */
export async function patchPracticeIndex(
  id: string,
  currentIndex: number,
  signal?: AbortSignal,
): Promise<PracticeSessionDto> {
  const patch: UpdatePracticeIndexRequest = { currentIndex };
  const body = await jsonRequest<{ practice?: PracticeSessionDto }>(
    `${EXAM_API_BASE}/practice/${encodeURIComponent(id)}`,
    jsonBody('PATCH', patch),
    [200],
    signal,
  );
  if (!body.practice) throw { code: 'EXAM_INTERNAL', message: '更新成功但响应缺少 practice 字段' } satisfies ExamErrorDto;
  return body.practice;
}

/** POST /exam/api/quiz/grade → { attempt, isCorrect }。 */
export async function gradeAnswer(
  input: GradeAnswerRequest,
  signal?: AbortSignal,
): Promise<{ attempt: ExamAttemptDto; isCorrect: boolean }> {
  return jsonRequest<{ attempt: ExamAttemptDto; isCorrect: boolean }>(
    `${EXAM_API_BASE}/quiz/grade`,
    jsonBody('POST', input),
    [200],
    signal,
  );
}

/** POST /exam/api/practice/:id/finish → { practice, scorecard }。 */
export async function finishPractice(id: string, signal?: AbortSignal): Promise<FinishPracticeResponse> {
  return jsonRequest<FinishPracticeResponse>(
    `${EXAM_API_BASE}/practice/${encodeURIComponent(id)}/finish`,
    { method: 'POST' },
    [200],
    signal,
  );
}

/** GET /exam/api/practice/:id/scorecard → { scorecard }。 */
export async function getScorecard(id: string, signal?: AbortSignal): Promise<ScorecardDto> {
  const body = await jsonRequest<{ scorecard?: ScorecardDto }>(
    `${EXAM_API_BASE}/practice/${encodeURIComponent(id)}/scorecard`,
    { method: 'GET' },
    [200],
    signal,
  );
  if (!body.scorecard) throw { code: 'EXAM_INTERNAL', message: '响应缺少 scorecard 字段' } satisfies ExamErrorDto;
  return body.scorecard;
}

// ── Phase 1：错题本 ────────────────────────────────────────────────────────

/** GET /exam/api/wrong?bankId=&includeMastered= → { wrong }。 */
export async function listWrong(
  options: { bankId?: string; includeMastered?: boolean } = {},
  signal?: AbortSignal,
): Promise<WrongEntryDto[]> {
  const params = new URLSearchParams();
  if (options.bankId !== undefined) params.set('bankId', options.bankId);
  if (options.includeMastered !== undefined) params.set('includeMastered', String(options.includeMastered));
  const qs = params.toString();
  const body = await jsonRequest<{ wrong?: WrongEntryDto[] }>(
    `${EXAM_API_BASE}/wrong${qs ? `?${qs}` : ''}`,
    { method: 'GET' },
    [200],
    signal,
  );
  return body.wrong ?? [];
}

/** POST /exam/api/wrong/:questionId/master → { wrong }。 */
export async function setMastered(
  questionId: string,
  mastered: boolean,
  signal?: AbortSignal,
): Promise<WrongEntryDto> {
  const payload: SetMasteredRequest = { mastered };
  const body = await jsonRequest<{ wrong?: WrongEntryDto }>(
    `${EXAM_API_BASE}/wrong/${encodeURIComponent(questionId)}/master`,
    jsonBody('POST', payload),
    [200],
    signal,
  );
  if (!body.wrong) throw { code: 'EXAM_INTERNAL', message: '响应缺少 wrong 字段' } satisfies ExamErrorDto;
  return body.wrong;
}

// ── Phase 2：essay 批改（SSE） ──────────────────────────────────────────────

export interface SseOptions {
  provider?: string;
  model?: string;
  signal?: AbortSignal;
}

/** 携带可选 provider/model 构造请求体。 */
function withLlmOptions<T extends object>(base: T, opts: SseOptions): T & { provider?: string; model?: string } {
  const body: T & { provider?: string; model?: string } = { ...base };
  if (opts.provider !== undefined) body.provider = opts.provider;
  if (opts.model !== undefined) body.model = opts.model;
  return body;
}

/**
 * POST /exam/api/grading/essay（SSE）——essay 主观题批改。
 * 事件：delta（LLM 原文）→ done { result: { attemptId, grading } }；错误 error { code, message }。
 */
export async function gradeEssay(
  input: Omit<GradeEssayRequest, 'provider' | 'model'>,
  handlers: SseHandlers<EssayGradingResultDto>,
  opts: SseOptions = {},
): Promise<void> {
  await streamSse(
    `${EXAM_API_BASE}/grading/essay`,
    withLlmOptions<GradeEssayRequest>(input, opts),
    handlers,
    opts.signal,
  );
}

// ── Phase 2：Tutor 多轮对话（SSE） ─────────────────────────────────────────

/** GET /exam/api/grading/:attemptId → { grading }（练习内回看 essay 批改结果）。 */
export async function fetchEssayGrading(
  attemptId: string,
  signal?: AbortSignal,
): Promise<EssayGradingDto> {
  const body = await jsonRequest<{ grading?: EssayGradingDto }>(
    `${EXAM_API_BASE}/grading/${encodeURIComponent(attemptId)}`,
    { method: 'GET' },
    [200],
    signal,
  );
  if (body.grading === undefined) throw new Error('essay grading missing in response');
  return body.grading;
}

/**
 * POST /exam/api/tutor/chat（SSE）——Tutor 对话。
 * 事件：delta（回复原文）→ done { result: { sessionId, messageId, reply, model? } }。
 */
export async function chatTutor(
  input: Omit<ChatTutorRequest, 'provider' | 'model'>,
  handlers: SseHandlers<ChatTutorResultDto>,
  opts: SseOptions = {},
): Promise<void> {
  await streamSse(
    `${EXAM_API_BASE}/tutor/chat`,
    withLlmOptions<ChatTutorRequest>(input, opts),
    handlers,
    opts.signal,
  );
}

/** GET /exam/api/tutor/sessions → { sessions }。 */
export async function listTutorSessions(signal?: AbortSignal): Promise<TutorSessionDto[]> {
  const body = await jsonRequest<{ sessions?: TutorSessionDto[] }>(
    `${EXAM_API_BASE}/tutor/sessions`,
    { method: 'GET' },
    [200],
    signal,
  );
  return body.sessions ?? [];
}

/** GET /exam/api/tutor/sessions/:id → { session, messages }（单会话详情 + 全部历史消息）。 */
export async function fetchTutorSessionDetail(
  id: string,
  signal?: AbortSignal,
): Promise<{ session: TutorSessionDto; messages: TutorMessageDto[] }> {
  const body = await jsonRequest<{ session?: TutorSessionDto; messages?: TutorMessageDto[] }>(
    `${EXAM_API_BASE}/tutor/sessions/${encodeURIComponent(id)}`,
    { method: 'GET' },
    [200],
    signal,
  );
  if (!body.session) throw { code: 'EXAM_INTERNAL', message: '响应缺少 session 字段' } satisfies ExamErrorDto;
  return { session: body.session, messages: body.messages ?? [] };
}

/** DELETE /exam/api/tutor/sessions/:id → 204（会话与消息级联删除；不存在视为成功）。 */
export async function deleteTutorSession(id: string, signal?: AbortSignal): Promise<void> {
  await jsonRequest<never>(
    `${EXAM_API_BASE}/tutor/sessions/${encodeURIComponent(id)}`,
    { method: 'DELETE' },
    [204],
    signal,
  );
}

// ── Phase 2：AI 导入 ────────────────────────────────────────────────────────

/** POST /exam/api/import/generate → { questions }（题目草稿，不落库）。 */
export async function generateImport(
  text: string,
  opts: SseOptions = {},
  signal?: AbortSignal,
): Promise<ImportedQuestion[]> {
  const body = await jsonRequest<{ questions?: ImportedQuestion[] }>(
    `${EXAM_API_BASE}/import/generate`,
    jsonBody('POST', withLlmOptions({ text }, opts)),
    [200],
    signal,
  );
  return body.questions ?? [];
}

/** POST /exam/api/import/commit → { count, questions }（草稿批量入库）。 */
export async function commitImport(
  bankId: string,
  questions: CreateQuestionRequest[],
  signal?: AbortSignal,
): Promise<CommitImportResult> {
  const payload: CommitImportRequest = { bankId, questions };
  return jsonRequest<CommitImportResult>(
    `${EXAM_API_BASE}/import/commit`,
    jsonBody('POST', payload),
    [200],
    signal,
  );
}

// ── Phase 2：学情洞察 / 诊断 ────────────────────────────────────────────────

/** GET /exam/api/insights → { insight }（纯统计聚合；可选窗口 7/14/30 与题库过滤）。 */
export async function getInsight(
  opts: { windowDays?: number; bankId?: string } = {},
  signal?: AbortSignal,
): Promise<InsightSummary> {
  const params = new URLSearchParams();
  if (opts.windowDays !== undefined) params.set('window', String(opts.windowDays));
  if (opts.bankId !== undefined && opts.bankId.length > 0) params.set('bank', opts.bankId);
  const query = params.toString();
  const body = await jsonRequest<{ insight?: InsightSummary }>(
    `${EXAM_API_BASE}/insights${query.length > 0 ? `?${query}` : ''}`,
    { method: 'GET' },
    [200],
    signal,
  );
  if (!body.insight) throw { code: 'EXAM_INTERNAL', message: '响应缺少 insight 字段' } satisfies ExamErrorDto;
  return body.insight;
}

/** POST /exam/api/insights/diagnose → { diagnosis }（LLM 诊断；t13 返回持久化记录）。 */
export async function diagnoseInsight(
  opts: SseOptions = {},
  signal?: AbortSignal,
): Promise<DiagnosisRecordDto> {
  const body = await jsonRequest<{ diagnosis?: DiagnosisRecordDto }>(
    `${EXAM_API_BASE}/insights/diagnose`,
    jsonBody('POST', withLlmOptions<DiagnoseInsightRequest>({}, opts)),
    [200],
    signal,
  );
  if (!body.diagnosis) throw { code: 'EXAM_INTERNAL', message: '响应缺少 diagnosis 字段' } satisfies ExamErrorDto;
  return body.diagnosis;
}

/** GET /exam/api/insights/diagnoses → { diagnoses }（诊断历史，created_at DESC）。 */
export async function listDiagnoses(signal?: AbortSignal): Promise<DiagnosisRecordDto[]> {
  const body = await jsonRequest<ListDiagnosesResult>(
    `${EXAM_API_BASE}/insights/diagnoses`,
    { method: 'GET' },
    [200],
    signal,
  );
  return body.diagnoses ?? [];
}

// ── Phase 2：学习计划 ───────────────────────────────────────────────────────

/** GET /exam/api/plans → { plans }。 */
export async function listPlans(signal?: AbortSignal): Promise<PlanDto[]> {
  const body = await jsonRequest<ListPlansResult>(`${EXAM_API_BASE}/plans`, { method: 'GET' }, [200], signal);
  return body.plans ?? [];
}

/** GET /exam/api/plans/:id → { plan, items }。 */
export async function getPlan(id: string, signal?: AbortSignal): Promise<PlanWithItemsDto> {
  return jsonRequest<PlanWithItemsDto>(
    `${EXAM_API_BASE}/plans/${encodeURIComponent(id)}`,
    { method: 'GET' },
    [200],
    signal,
  );
}

/** POST /exam/api/plans/generate → 201 { plan, items }（LLM 生成并落库）。 */
export async function generatePlan(
  opts: SseOptions & { title?: string } = {},
  signal?: AbortSignal,
): Promise<PlanWithItemsDto> {
  return jsonRequest<PlanWithItemsDto>(
    `${EXAM_API_BASE}/plans/generate`,
    jsonBody('POST', withLlmOptions<GeneratePlanRequest>({ title: opts.title }, opts)),
    [201],
    signal,
  );
}

/** POST /exam/api/plans → 201 { plan, items }（手动新建）。 */
export async function createManualPlan(
  title: string,
  items: string[] = [],
  signal?: AbortSignal,
): Promise<PlanWithItemsDto> {
  const payload: CreateManualPlanRequest = { title, items };
  return jsonRequest<PlanWithItemsDto>(`${EXAM_API_BASE}/plans`, jsonBody('POST', payload), [201], signal);
}

/** POST /exam/api/plans/:id/items → 201 { plan, items }（追加条目）。 */
export async function addPlanItems(
  planId: string,
  titles: string[],
  signal?: AbortSignal,
): Promise<PlanWithItemsDto> {
  return jsonRequest<PlanWithItemsDto>(
    `${EXAM_API_BASE}/plans/${encodeURIComponent(planId)}/items`,
    jsonBody('POST', { titles }),
    [201],
    signal,
  );
}

/** PATCH /exam/api/plans/:id/items/:itemId → { item }（勾选/取消完成）。 */
export async function setPlanItemDone(
  planId: string,
  itemId: string,
  done: boolean,
  signal?: AbortSignal,
): Promise<PlanItemDto> {
  const body = await jsonRequest<{ item?: PlanItemDto }>(
    `${EXAM_API_BASE}/plans/${encodeURIComponent(planId)}/items/${encodeURIComponent(itemId)}`,
    jsonBody('PATCH', { done }),
    [200],
    signal,
  );
  if (!body.item) throw { code: 'EXAM_INTERNAL', message: '响应缺少 item 字段' } satisfies ExamErrorDto;
  return body.item;
}

/** DELETE /exam/api/plans/:id → 204（级联删除条目）。 */
export async function deletePlan(planId: string, signal?: AbortSignal): Promise<void> {
  await jsonRequest<undefined>(
    `${EXAM_API_BASE}/plans/${encodeURIComponent(planId)}`,
    { method: 'DELETE' },
    [204],
    signal,
  );
}

/** DELETE /exam/api/plans/:id/items/:itemId → 204（同事务重算计划状态）。 */
export async function deletePlanItem(planId: string, itemId: string, signal?: AbortSignal): Promise<void> {
  await jsonRequest<undefined>(
    `${EXAM_API_BASE}/plans/${encodeURIComponent(planId)}/items/${encodeURIComponent(itemId)}`,
    { method: 'DELETE' },
    [204],
    signal,
  );
}

// ── Phase 2：练习历史 / 续做 ────────────────────────────────────────────────

/** GET /exam/api/practice/history → { sessions }（active 附 answeredCount，finished 附 scorecard）。 */
export async function listPracticeHistory(signal?: AbortSignal): Promise<PracticeHistoryItemDto[]> {
  const body = await jsonRequest<{ sessions?: PracticeHistoryItemDto[] }>(
    `${EXAM_API_BASE}/practice/history`,
    { method: 'GET' },
    [200],
    signal,
  );
  return body.sessions ?? [];
}

// ── Phase 4：题目 AI 解析（P 个性化 SSE / 缓存探测 / G 通用写回） ─────────────

/**
 * POST /exam/api/practice/explain（SSE）——练习内个性化解析（P 形态）。
 * 事件：delta（LLM 原文）→ done { result: ExplainResultDto }；流内失败 error { code, message }。
 * - 缓存命中且非 force：直接 done { cached: true }，零 delta（provider 未配置也能命中）；
 * - force: true = 「重新解析」：跳过缓存生成并覆盖同键旧行；
 * - signal 全链透传，取消零落库——EXAM_LLM_ABORTED 由 UI 层静默处理（不展示错误）。
 */
export async function explainAnswerSse(
  input: ExplainRequest,
  handlers: SseHandlers<ExplainResultDto>,
  signal?: AbortSignal,
): Promise<void> {
  await streamSse(`${EXAM_API_BASE}/practice/explain`, input, handlers, signal);
}

/**
 * GET /exam/api/practice/explain?practiceId&questionId[&depth] —— 解析缓存探测。
 * 「暂无缓存」是正常态而非错误：404 且 EXAM_EXPLANATION_NOT_FOUND 时返回 null
 * （调用方据此决定显示「AI 解析」按钮还是直出缓存内容）；其余错误照常抛 ExamErrorDto。
 * depth 缺省 'light' 不进 URL（服务端缺省即 light）；'deep' 时追加 depth=deep，按档位各自命中缓存。
 */
export async function fetchPracticeExplanation(
  practiceId: string,
  questionId: string,
  depth: ExplainDepth = 'light',
  signal?: AbortSignal,
): Promise<ExplanationDto | null> {
  const params = new URLSearchParams({ practiceId, questionId });
  if (depth !== 'light') params.set('depth', depth);
  let resp: Response;
  try {
    resp = await fetch(`${EXAM_API_BASE}/practice/explain?${params.toString()}`, {
      signal,
      headers: { Accept: 'application/json' },
    });
  } catch (err) {
    throw networkOrAborted(err);
  }
  if (resp.status === 404) {
    const err = await parseError(resp);
    if (err.code === 'EXAM_EXPLANATION_NOT_FOUND') return null;
    throw err;
  }
  if (resp.status !== 200) throw await parseError(resp);
  const body = (await resp.json()) as { explanation?: ExplanationDto };
  return body.explanation ?? null;
}

/**
 * POST /exam/api/questions/:id/explain-generic —— 题库通用解析（G 形态，JSON 非流式）。
 * 后台一次生成并写回 questions.explanation，返回更新后的题目 DTO；
 * 再次调用即「重新解析」覆盖（原值非空时由 UI confirm）。同步等待可接受（~10s 内）。
 */
export async function explainGeneric(
  questionId: string,
  opts: SseOptions = {},
  signal?: AbortSignal,
): Promise<ExamQuestionDto> {
  const body = await jsonRequest<{ question?: ExamQuestionDto }>(
    `${EXAM_API_BASE}/questions/${encodeURIComponent(questionId)}/explain-generic`,
    jsonBody('POST', withLlmOptions<ExplainGenericRequest>({}, opts)),
    [200],
    signal,
  );
  if (!body.question) throw { code: 'EXAM_INTERNAL', message: '响应缺少 question 字段' } satisfies ExamErrorDto;
  return body.question;
}

// ── t1：知识标注（P2 批量标注草稿确认制）────────────────────────────────────

/**
 * POST /exam/api/banks/:bankId/topic-suggestions —— AI 知识标注草稿。
 * 对选定题库逐题 LLM 判别 topics；返回草稿（不自动写回），用户确认后走 applyTopics。
 * @param opts.limit 缺省 50（服务端单次最多 100）；仅"可生成建议"的客观题入选。
 * @param opts.questionIds 提供时只对这批题目返回建议（长度 1-20；用于单题 AI 补标）。
 */
export async function topicSuggestions(
  bankId: string,
  opts: { limit?: number; questionIds?: string[] } = {},
  signal?: AbortSignal,
): Promise<TopicSuggestionDto[]> {
  // body 透传两个可选字段（均缺省时发空对象，由服务端按缺省 50 处理）
  const body: { limit?: number; questionIds?: string[] } = {};
  if (opts.limit !== undefined) body.limit = opts.limit;
  if (opts.questionIds !== undefined && opts.questionIds.length > 0) body.questionIds = opts.questionIds;
  const result = await jsonRequest<TopicSuggestionsResultDto>(
    `${EXAM_API_BASE}/banks/${encodeURIComponent(bankId)}/topic-suggestions`,
    jsonBody('POST', body),
    [200],
    signal,
  );
  return result.items ?? [];
}

/** POST /exam/api/questions/topics —— 用户确认后的批量写回（覆盖式）。返回成功写回题数。 */
export async function applyTopics(
  items: ApplyTopicsRequest['items'],
  signal?: AbortSignal,
): Promise<ApplyTopicsResult> {
  return jsonRequest<ApplyTopicsResult>(
    `${EXAM_API_BASE}/questions/topics`,
    jsonBody('POST', { items }),
    [200],
    signal,
  );
}
