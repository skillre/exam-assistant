/**
 * dsh-exam Host 插件入口（Phase 0 贯通样板）。
 *
 * 这是一个**普通源码 Cordis 插件**（非动态 cordis_define 插件）：
 * - `@deepseek-ai/cordis` 的 Service 基类插件：`super(ctx, 'exam')` 即向
 *   `ctx.exam` 提供最小 ExamService（随 fiber 卸载自动注销）。
 * - `static inject = ['webServer', 'settings', 'llm']`：全部为硬依赖，
 *   服务未就绪时插件进入 waiting，就绪后自动激活。
 * - 初始化时序：构造期解析配置与 settings；异步 `[Service.init]` 打开
 *   ExamStore（node:sqlite 延迟加载）后创建服务并注册路由；store 打开失败
 *   进入降级模式（health 503，插件行不 FAILED）。
 * - 副作用（webServer 路由、store 关闭）挂在 `ctx.effect` 上，fiber 卸载时
 *   按逆序执行 disposer：先注销路由，再关闭 store（未打开则为空操作）。
 *
 * HTTP 层使用 DSH `webServer` 的真实 `node:http` 接口
 * （`IncomingMessage` / `ServerResponse`），不假设 Express/Fastify；
 * 路由前缀为 `/exam/api/*`，绝不占用 DSH Web 自身的 `/api`。
 *
 * 数据目录解析顺序（TODO：Phase 1 改为 settings 全权 + 绝对路径校验）：
 *   1. 插件行 config.dataDir（cordis.yml `config`）
 *   2. settings `exam.dataDir`（用户覆盖，applies: 'restart'）
 *   3. 默认 `<cwd>/.exam-data`（cwd 为 dsh 启动目录；工作区启动即落在工作区下）
 * API Key 不进 settings：Phase 1 走 DSH `credentials`。
 */
import { Service } from '@deepseek-ai/cordis';
import type { Context } from '@deepseek-ai/cordis';
import z from '@deepseek-ai/schemastery';
import { settingsNamespace } from '@deepseek-ai/dsh-settings';
import type { WebServer } from '@deepseek-ai/dsh-host-webserver';
import type { Logger } from '@deepseek-ai/cordis';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { isAbsolute, join, resolve } from 'node:path';
import { normalizeQueryLabel, openExamStore, type ExamStore } from './store.ts';
import { createExamLlm } from './llm.ts';
import {
  createExamService,
  ExamServiceError,
  type CreateBankInput,
  type ExamService,
} from './service.ts';
import type {
  ApplyTopicsRequest,
  BulkQuestionOp,
  ChatTutorRequest,
  CommitImportRequest,
  CreateManualPlanRequest,
  CreateQuestionRequest,
  ExamQuestionType,
  ExplainDepth,
  ExplainGenericRequest,
  ExplainRequest,
  GradeAnswerRequest,
  GradeEssayRequest,
  ImportGenerateRequest,
  ListQuestionsFilter,
  PlanItemInput,
  PracticeScopeDto,
  PracticeScopeMode,
  StartPracticeRequest,
  UpdateQuestionRequest,
} from './contract.ts';

// dsh-llm 类型（含 Context.llm 增强）随本导入进入程序；运行时不产生依赖。
import type { LlmModelInfo, LlmProviderInfo, LlmResolvedModelInfo, LlmRuntime } from '@deepseek-ai/dsh-llm';

// ---------------------------------------------------------------------------
// 配置与 settings
// ---------------------------------------------------------------------------

/** 默认数据目录（相对 cwd）。 */
export const EXAM_DATA_DIR_DEFAULT = '.exam-data';

/** 插件行配置 schema（cordis.yml `config`）。 */
export const examConfigSchema = z.object({
  /** 数据目录；空串 = 按 settings → 默认路径解析。 */
  dataDir: z.string().default(''),
});

/** settings `exam` 命名空间 schema（不包含任何密钥；API Key 走 DSH credentials）。 */
export const examSettingsSchema = z.object({
  /** 数据目录；空串 = 使用默认路径（cwd/.exam-data）。 */
  dataDir: z.string().default(''),
});

/** 插件行配置的解析值类型。 */
export interface ExamConfig {
  dataDir?: string;
}

/** settings `exam` 命名空间的解析值类型。 */
export interface ExamSettings {
  dataDir: string;
}

const EXAM_SETTINGS_NS = settingsNamespace('exam');

/** 按 config → settings → 默认路径 的顺序解析数据目录（相对路径基于 cwd）。 */
export function resolveDataDir(configDataDir: string, settingsDataDir: string): string {
  const raw = configDataDir || settingsDataDir || EXAM_DATA_DIR_DEFAULT;
  const cwd = process.cwd();
  return isAbsolute(raw) ? raw : resolve(cwd, raw);
}

// ---------------------------------------------------------------------------
// HTTP 工具（DSH webServer 的 node:http 语义）
// ---------------------------------------------------------------------------

const EXAM_API_PREFIX = '/exam/api';
const MAX_BODY_BYTES = 1024 * 1024;

/** 统一 JSON 响应。 */
function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  const bytes = Buffer.byteLength(payload);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(bytes),
    'cache-control': 'no-store',
  });
  res.end(payload);
}

/** 统一错误响应：`{ error: { code, message } }`。 */
function sendError(res: ServerResponse, status: number, code: string, message: string): void {
  sendJson(res, status, { error: { code, message } });
}

/** 405：方法不允许（带 Allow 头）。 */
function methodNotAllowed(res: ServerResponse, allow: readonly string[]): void {
  res.writeHead(405, {
    allow: allow.join(', '),
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(JSON.stringify({ error: { code: 'EXAM_METHOD_NOT_ALLOWED', message: `method not allowed; expected ${allow.join(' or ')}` } }));
}

/** 读取并解析 JSON 请求体；上限 1MiB。抛 ExamServiceError 表达 4xx。 */
async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    total += buf.length;
    if (total > MAX_BODY_BYTES) {
      throw new ExamServiceError('EXAM_INVALID_BODY', 'request body exceeds 1 MiB limit');
    }
    chunks.push(buf);
  }
  if (total === 0) return undefined;
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new ExamServiceError('EXAM_INVALID_BODY', 'request body must be valid JSON');
  }
}

/** 把领域错误映射为 HTTP 状态码与稳定错误码。 */
function mapServiceError(res: ServerResponse, error: unknown, logger: Logger): void {
  if (error instanceof ExamServiceError) {
    switch (error.code) {
      case 'EXAM_BANK_NAME_REQUIRED':
      case 'EXAM_INVALID_BODY':
      case 'EXAM_INVALID_QUESTION':
      case 'EXAM_INVALID_SCOPE':
      case 'EXAM_QUESTION_NOT_IN_PRACTICE':
      // t1：空范围拒绝建会话（400 类校验错误）
      case 'EXAM_EMPTY_PRACTICE_SCOPE':
      // Phase 2：essay 批改 / Tutor / AI 导入校验错误
      case 'EXAM_NOT_ESSAY':
      case 'EXAM_ESSAY_ANSWER_REQUIRED':
      case 'EXAM_TUTOR_MESSAGE_REQUIRED':
      case 'EXAM_IMPORT_EMPTY':
      case 'EXAM_IMPORT_PARSE_FAILED':
      // t5：导入同批次重复条目（400 校验类）
      case 'EXAM_IMPORT_DUPLICATE_ITEM':
        return sendError(res, 400, error.code, error.message);
      case 'EXAM_BANK_NOT_FOUND':
      case 'EXAM_QUESTION_NOT_FOUND':
      case 'EXAM_PRACTICE_NOT_FOUND':
      // Phase 2：会话 / 计划不存在
      case 'EXAM_TUTOR_SESSION_NOT_FOUND':
      case 'EXAM_PLAN_NOT_FOUND':
      case 'EXAM_PLAN_ITEM_NOT_FOUND':
      // Phase 2：essay 批改结果不存在（练习内回看）
      case 'EXAM_ESSAY_GRADING_NOT_FOUND':
      // Phase 4：解析缓存未命中
      case 'EXAM_EXPLANATION_NOT_FOUND':
      // t5：导入草稿不存在
      case 'EXAM_IMPORT_DRAFT_NOT_FOUND':
        return sendError(res, 404, error.code, error.message);
      // Phase 4：防泄露硬边界——未判分不可见解析（设计 §2.2）
      case 'EXAM_NOT_GRADED':
      // t1：会话状态冲突——finished 会话禁止继续判分/改进度
      case 'EXAM_PRACTICE_FINISHED':
      // t5：Tutor 状态机冲突（closed 会话写 / 在途 turn / clientMessageId 跨会话）
      case 'EXAM_TUTOR_SESSION_CLOSED':
      case 'EXAM_TUTOR_TURN_IN_FLIGHT':
      case 'EXAM_TUTOR_TURN_CONFLICT':
      // t5：导入幂等冲突（草稿已消费 / 批次属于其他题库）
      case 'EXAM_IMPORT_DRAFT_CONSUMED':
      case 'EXAM_IMPORT_BATCH_CONFLICT':
        return sendError(res, 409, error.code, error.message);
      case 'EXAM_STORE_CLOSED':
      case 'EXAM_STORE_UNAVAILABLE':
      // Phase 2：LLM 路由解析失败（resolveLlmRoute）
      case 'EXAM_LLM_NO_PROVIDER':
      case 'EXAM_LLM_NO_MODEL':
      case 'EXAM_LLM_UNAVAILABLE':
        return sendError(res, 503, error.code, error.message);
      default:
        logger.warn('exam route failed: %s', error.message);
        return sendError(res, 500, error.code, error.message);
    }
  }
  const message = error instanceof Error ? error.message : String(error);
  logger.warn('exam route unexpected error: %s', message);
  sendError(res, 500, 'EXAM_INTERNAL', 'internal server error');
}

// ---------------------------------------------------------------------------
// 路由
// ---------------------------------------------------------------------------

/** GET /exam/api/health → 200/503 健康状态（纯 DTO）。 */
function handleHealth(req: IncomingMessage, res: ServerResponse, service: ExamService): void {
  if (req.method !== 'GET') return methodNotAllowed(res, ['GET']);
  const health = service.health();
  sendJson(res, health.ok ? 200 : 503, health);
}

/** GET/POST /exam/api/banks。 */
async function handleBanks(
  req: IncomingMessage,
  res: ServerResponse,
  service: ExamService,
  logger: Logger,
): Promise<void> {
  if (req.method === 'GET') {
    try {
      const url = new URL(req.url ?? '/', 'http://localhost');
      const includeArchived = url.searchParams.get('includeArchived') === 'true';
      const includeDeleted = url.searchParams.get('includeDeleted') === 'true';
      sendJson(res, 200, { banks: service.listBanks({ includeArchived, includeDeleted }) });
    } catch (error) {
      // 降级/关闭等场景：listBanks 可能抛 ExamServiceError，必须落响应，
      // 否则请求悬挂（真实 DSH webServer 中未捕获异常会波及进程）。
      mapServiceError(res, error, logger);
    }
    return;
  }
  if (req.method === 'POST') {
    let body: unknown;
    try {
      body = await readJsonBody(req);
    } catch (error) {
      return mapServiceError(res, error, logger);
    }
    const name = asBankName(body);
    if (name === undefined) {
      return sendError(res, 400, 'EXAM_INVALID_BODY', 'request body must be { "name": string }');
    }
    try {
      const bank = service.createBank({ name } satisfies CreateBankInput);
      sendJson(res, 201, { bank });
    } catch (error) {
      mapServiceError(res, error, logger);
    }
    return;
  }
  methodNotAllowed(res, ['GET', 'POST']);
}

/** 从 JSON 请求体中提取题库名（原样返回字符串），非字符串返回 undefined。 */
function asBankName(body: unknown): string | undefined {
  if (typeof body !== 'object' || body === null) return undefined;
  const name = (body as { name?: unknown }).name;
  return typeof name === 'string' ? name : undefined;
}

// ---------------------------------------------------------------------------
// SSE 工具与 /exam/api/llm/test
// ---------------------------------------------------------------------------

/** 开始 SSE 响应（200 + text/event-stream）。 */
function startSse(res: ServerResponse): void {
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-store',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  });
}

/** 发送一个 SSE data 事件（JSON）。 */
function sseSend(res: ServerResponse, event: unknown): void {
  res.write(`data: ${JSON.stringify(event)}\n\n`);
}

/** 路由层解析 LLM 测试请求时所需的 llm 面（LlmRuntime 的结构子集）。 */
export interface LlmRoute {
  listProviders(): LlmProviderInfo[];
  listModels(provider: string): Promise<LlmModelInfo[]>;
  /** t5：按 provider/model 解析模型元数据（contextWindow/defaultMaxTokens，token 预算用）。可选：缺失/失败降级为无 modelInfo。 */
  resolveModelInfo?(provider: string, model: string, signal?: AbortSignal): Promise<LlmResolvedModelInfo>;
}

/** DSH 默认模型选择（AgentDefaultModelConfig.currentSelection() 的返回形状，本地声明避免引入类型依赖）。 */
export interface AgentDefaultRoute {
  provider: string;
  model: string;
  /** 思考深度 id；provider 默认行为时缺省。 */
  reasoningEffort?: string;
}

/** t5 统一 LLM 路由（P5/P6）：provider/model/reasoningEffort + 模型上下文信息（预算消费）。 */
export interface ResolvedLlmRoute {
  provider: string;
  model: string;
  /** 思考深度 id；provider 默认行为时缺省。 */
  reasoningEffort?: string;
  /** 由 llm.resolveModelInfo 解析（带缓存）；解析失败时缺省（不阻断调用链）。 */
  modelInfo?: { contextWindow?: number; defaultMaxTokens?: number };
}

/**
 * t5 模型信息注册表缓存（P6）：同 (provider/model) 解析结果 TTL 内复用；
 * `llm/adapters-updated` 时 clear()。缓存对象由调用方（插件 init）创建并注入，
 * 不做模块级状态（可测）。
 */
export interface LlmModelInfoCache {
  /** 返回缓存中的 promise（可能已过期 → undefined 并清理）。 */
  resolve(provider: string, model: string): Promise<LlmResolvedModelInfo | undefined> | undefined;
  set(provider: string, model: string, promise: Promise<LlmResolvedModelInfo | undefined>): void;
  clear(): void;
}

/** 构造 TTL 模型信息缓存（settle 后保留至 TTL 过期；resolve 时惰性清理）。 */
export function createLlmRouteCache(ttlMs = 60_000): LlmModelInfoCache {
  const map = new Map<string, { promise: Promise<LlmResolvedModelInfo | undefined>; expires: number }>();
  return {
    resolve(provider, model) {
      const entry = map.get(`${provider}/${model}`);
      if (entry === undefined) return undefined;
      if (Date.now() > entry.expires) {
        map.delete(`${provider}/${model}`);
        return undefined;
      }
      return entry.promise;
    },
    set(provider, model, promise) {
      map.set(`${provider}/${model}`, { promise, expires: Date.now() + ttlMs });
    },
    clear() {
      map.clear();
    },
  };
}

/** 从 JSON 请求体提取可选字符串字段。 */
function asOptionalString(body: unknown, key: string): string | undefined {
  if (typeof body !== 'object' || body === null) return undefined;
  const value = (body as Record<string, unknown>)[key];
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
}

/**
 * 解析 LLM provider/model 缺省值（共享函数，llm/test 与 Phase 2/4 SSE/JSON 路由共用）：
 * 显式值 → DSH 默认模型（agent-default-model：provider/model/reasoningEffort 全继承；
 * 仅当默认 provider 已注册时生效，否则回退）→ 第一个可用 provider 及其第一个模型。
 * t5：`defaultRouteProvider` **每个请求调用一次**（改 DSH 默认模型即时生效，无需重启）；
 * 返回值统一为 ResolvedLlmRoute，modelInfo 经注册表缓存（cache）消费 llm.resolveModelInfo。
 * 失败抛 ExamServiceError（HTTP 层映射 503）：
 * - 无可用 provider → EXAM_LLM_NO_PROVIDER
 * - provider 无模型   → EXAM_LLM_NO_MODEL
 * - 注册表查询失败   → EXAM_LLM_UNAVAILABLE
 */
export async function resolveLlmRoute(
  llm: LlmRoute,
  provider?: string,
  model?: string,
  defaultRouteProvider?: () => AgentDefaultRoute | undefined,
  cache?: LlmModelInfoCache,
): Promise<ResolvedLlmRoute> {
  let resolvedProvider = provider;
  let resolvedModel = model;
  let reasoningEffort: string | undefined;
  try {
    // 每个请求现读默认模型（t5 P5）：异常视为 undefined（回退第一个 provider）。
    let defaultRoute: AgentDefaultRoute | undefined;
    try {
      defaultRoute = defaultRouteProvider?.();
    } catch {
      defaultRoute = undefined;
    }
    if (resolvedProvider === undefined && resolvedModel === undefined) {
      // 未显式指定：继承 DSH 默认模型（settings agent-default-model + 组合 entry）。
      const providers = llm.listProviders();
      if (defaultRoute?.provider && providers.some((p) => p.id === defaultRoute.provider)) {
        resolvedProvider = defaultRoute.provider;
        resolvedModel = defaultRoute.model;
        reasoningEffort = defaultRoute.reasoningEffort;
      } else if (providers.length === 0) {
        throw new ExamServiceError('EXAM_LLM_NO_PROVIDER', 'no LLM provider is configured; check DSH models/settings');
      } else {
        resolvedProvider = providers[0]?.id;
        if (resolvedProvider === undefined) {
          throw new ExamServiceError('EXAM_LLM_NO_PROVIDER', 'no LLM provider is configured; check DSH models/settings');
        }
      }
    } else if (resolvedProvider === undefined) {
      const providers = llm.listProviders();
      if (providers.length === 0) {
        throw new ExamServiceError('EXAM_LLM_NO_PROVIDER', 'no LLM provider is configured; check DSH models/settings');
      }
      resolvedProvider = providers[0]?.id;
    }
    if (resolvedModel === undefined && resolvedProvider !== undefined) {
      const models = await llm.listModels(resolvedProvider);
      resolvedModel = models[0]?.id;
      if (resolvedModel === undefined) {
        throw new ExamServiceError('EXAM_LLM_NO_MODEL', `provider ${resolvedProvider} has no models`);
      }
    }
  } catch (error) {
    if (error instanceof ExamServiceError) throw error;
    const message = error instanceof Error ? error.message : String(error);
    throw new ExamServiceError('EXAM_LLM_UNAVAILABLE', `cannot resolve LLM route: ${message}`);
  }
  if (resolvedProvider === undefined || resolvedModel === undefined) {
    throw new ExamServiceError('EXAM_LLM_UNAVAILABLE', 'cannot resolve provider/model route');
  }

  // t5：解析模型元数据（contextWindow/defaultMaxTokens），带缓存；失败降级为无 modelInfo。
  let modelInfo: ResolvedLlmRoute['modelInfo'];
  const resolver = llm.resolveModelInfo;
  if (resolver !== undefined) {
    let infoPromise: Promise<LlmResolvedModelInfo | undefined> | undefined;
    if (cache !== undefined) {
      infoPromise = cache.resolve(resolvedProvider, resolvedModel);
      if (infoPromise === undefined) {
        infoPromise = Promise.resolve()
          .then(() => resolver.call(llm, resolvedProvider, resolvedModel))
          .catch(() => undefined);
        cache.set(resolvedProvider, resolvedModel, infoPromise);
      }
    }
    try {
      const info =
        infoPromise !== undefined
          ? await infoPromise
          : await resolver.call(llm, resolvedProvider, resolvedModel);
      if (info !== undefined) {
        modelInfo = {
          ...(info.context?.contextWindow !== undefined ? { contextWindow: info.context.contextWindow } : {}),
          ...(info.defaultMaxTokens !== undefined ? { defaultMaxTokens: info.defaultMaxTokens } : {}),
        };
      }
    } catch {
      modelInfo = undefined;
    }
  }

  return {
    provider: resolvedProvider,
    model: resolvedModel,
    ...(reasoningEffort !== undefined ? { reasoningEffort } : {}),
    ...(modelInfo !== undefined ? { modelInfo } : {}),
  };
}

/**
 * POST /exam/api/llm/test — 流式测试 LLM 链路（SSE）。
 *
 * 契约（与 client-engineer 对齐，见 .codebase-review/09-host.md §4）：
 * - 请求：`{ prompt: string, provider?: string, model?: string }`。
 *   provider/model 缺省时自动取第一个可用 provider 及其第一个模型；
 *   无可用 provider → 503 JSON `{ error: { code: 'EXAM_LLM_NO_PROVIDER' } }`
 *   （stream 尚未开始，UI 直接读 JSON 错误即可）。
 * - 成功：200 + text/event-stream，事件为 JSON 行：
 *   `data: {"type":"delta","text":"…"}` → `data: {"type":"done","result":{…}}`。
 * - 流中失败：`data: {"type":"error","error":{"code","message"}}` 后关闭。
 */
async function handleLlmTest(
  req: IncomingMessage,
  res: ServerResponse,
  deps: {
    service: ExamService;
    llm: LlmRoute;
    defaultRouteProvider?: () => AgentDefaultRoute | undefined;
    routeCache?: LlmModelInfoCache;
    logger: Logger;
  },
): Promise<void> {
  if (req.method !== 'POST') return methodNotAllowed(res, ['POST']);

  let body: unknown;
  try {
    body = await readJsonBody(req);
  } catch (error) {
    return mapServiceError(res, error, deps.logger);
  }
  const prompt = asOptionalString(body, 'prompt');
  if (prompt === undefined) {
    return sendError(res, 400, 'EXAM_INVALID_BODY', 'request body must be { "prompt": string }');
  }

  // 解析 provider/model 缺省值（共享 resolveLlmRoute；失败 → 503 JSON，流未开始）。
  let route: ResolvedLlmRoute;
  try {
    route = await resolveLlmRoute(
      deps.llm,
      asOptionalString(body, 'provider'),
      asOptionalString(body, 'model'),
      deps.defaultRouteProvider,
      deps.routeCache,
    );
  } catch (error) {
    return mapServiceError(res, error, deps.logger);
  }
  const { provider, model } = route;

  startSse(res);

  // 客户端断开时中止底层调用（req/res close 双监听，同 runSseEndpoint 的 t6 加固）。
  const controller = new AbortController();
  const onClose = () => {
    if (!res.writableEnded) controller.abort();
  };
  req.on('close', onClose);
  res.on('close', onClose);

  try {
    const result = await deps.service.testLlmStream(
      { prompt, provider, model, signal: controller.signal },
      (delta) => sseSend(res, { type: 'delta', text: delta }),
    );
    // 契约：done.result.finish 归一化为字符串（finish.kind，如 'stop'）。
    // 领域层保留完整 LlmFinishReason；SSE 线协议只暴露 kind，与 Client 类型一致。
    if (!res.writableEnded && !res.destroyed) {
      sseSend(res, {
        type: 'done',
        result: { ...result, finish: result.finish.kind },
      });
      res.end();
    }
  } catch (error) {
    if (!res.writableEnded && !res.destroyed) {
      if (error instanceof ExamServiceError) {
        sseSend(res, { type: 'error', error: { code: error.code, message: error.message } });
      } else {
        const message = error instanceof Error ? error.message : String(error);
        deps.logger.warn('exam llm/test failed: %s', message);
        sseSend(res, { type: 'error', error: { code: 'EXAM_LLM_STREAM_FAILED', message: 'LLM test call failed' } });
      }
      res.end();
    }
  } finally {
    req.removeListener('close', onClose);
    res.removeListener('close', onClose);
  }
}

// ---------------------------------------------------------------------------
// Phase 2 SSE 路由：essay 批改 / Tutor 对话
// ---------------------------------------------------------------------------

/**
 * Phase 2 SSE 端点公共骨架：开始 SSE → 执行 invoke（onDelta 已由调用方注入
 * sseSend）→ done 事件 → 关闭；流中失败 → error 事件 → 关闭。
 * 客户端断开时中止底层调用（AbortController）。断开检测**同时监听 req/res 的
 * close**（实测客户端 abort 时 res 'close' 稳定触发、req 'close' 可能不触发，
 * t6 修复）；连接已断（res.destroyed）后不再写入。
 */
async function runSseEndpoint(
  req: IncomingMessage,
  res: ServerResponse,
  logger: Logger,
  invoke: (signal: AbortSignal) => Promise<unknown>,
  toDoneEvent: (result: unknown) => unknown,
  what: string,
  errorExtra?: (error: unknown) => Record<string, unknown>,
): Promise<void> {
  startSse(res);
  const controller = new AbortController();
  const onClose = () => {
    if (!res.writableEnded) controller.abort();
  };
  req.on('close', onClose);
  res.on('close', onClose);
  try {
    const result = await invoke(controller.signal);
    if (!res.writableEnded && !res.destroyed) {
      sseSend(res, toDoneEvent(result));
      res.end();
    }
  } catch (error) {
    if (!res.writableEnded && !res.destroyed) {
      const extra = errorExtra?.(error) ?? {};
      if (error instanceof ExamServiceError) {
        sseSend(res, { type: 'error', error: { code: error.code, message: error.message }, ...extra });
      } else {
        const message = error instanceof Error ? error.message : String(error);
        logger.warn('exam %s failed: %s', what, message);
        sseSend(res, { type: 'error', error: { code: 'EXAM_LLM_STREAM_FAILED', message: `${what} failed` }, ...extra });
      }
      res.end();
    }
  } finally {
    req.removeListener('close', onClose);
    res.removeListener('close', onClose);
  }
}

/**
 * JSON 端点公共骨架（t5 P10）：客户端断开（req/res close）→ AbortController.abort()，
 * signal 透传 service（底层 LLM 调用可中止，不浪费 token）。invoke 内自行 sendJson
 * （需自行守卫 res.writableEnded/destroyed——客户端已断开时不再写）。
 * 取消语义：EXAM_LLM_ABORTED 抛出后响应无从送达，客户端已断开，无需映射状态码。
 */
async function runJsonEndpoint(
  req: IncomingMessage,
  res: ServerResponse,
  logger: Logger,
  invoke: (signal: AbortSignal) => Promise<void>,
): Promise<void> {
  const controller = new AbortController();
  const onClose = () => {
    if (!res.writableEnded) controller.abort();
  };
  req.on('close', onClose);
  res.on('close', onClose);
  try {
    await invoke(controller.signal);
  } catch (error) {
    // 客户端已断开：不写响应（写也无从送达）。
    if (controller.signal.aborted || res.destroyed) return;
    mapServiceError(res, error, logger);
  } finally {
    req.removeListener('close', onClose);
    res.removeListener('close', onClose);
  }
}

/**
 * POST /exam/api/grading/essay — essay 主观题批改（SSE）。
 *
 * 契约：请求 `{ questionId, practiceId?, userAnswer, provider?, model? }`；
 * provider/model 缺省解析同 llm/test（共享 resolveLlmRoute，失败 → 503 JSON）。
 * 成功事件：`delta`（LLM 原文）→ `done { result: { attemptId, grading } }`；
 * 流中失败：`error { code, message }`。
 */
async function handleGradeEssay(
  req: IncomingMessage,
  res: ServerResponse,
  deps: {
    service: ExamService;
    llm: LlmRoute;
    defaultRouteProvider?: () => AgentDefaultRoute | undefined;
    routeCache?: LlmModelInfoCache;
    logger: Logger;
  },
): Promise<void> {
  if (req.method !== 'POST') return methodNotAllowed(res, ['POST']);
  let body: unknown;
  try {
    body = await readJsonBody(req);
  } catch (error) {
    return mapServiceError(res, error, deps.logger);
  }
  let input: GradeEssayRequest;
  try {
    input = parseGradeEssayRequest(body);
  } catch (error) {
    return mapServiceError(res, error, deps.logger);
  }
  // 流开始前的领域校验（设计 §4：SSE 错误统一——流开始前 400/404 JSON；
  // 服务层保留同款校验作为纵深防御）。
  try {
    const question = deps.service.getQuestion(input.questionId);
    if (question === undefined) {
      return sendError(res, 404, 'EXAM_QUESTION_NOT_FOUND', `question not found: ${input.questionId}`);
    }
    if (question.type !== 'essay') {
      return sendError(
        res,
        400,
        'EXAM_NOT_ESSAY',
        `question ${input.questionId} is not an essay question; use quiz/grade for objective questions`,
      );
    }
    if (input.userAnswer.trim().length === 0) {
      return sendError(res, 400, 'EXAM_ESSAY_ANSWER_REQUIRED', 'essay answer must be a non-empty string');
    }
    // t1 流前守卫（与客观判分同语义；JSON 呈现而非 SSE error）：
    // practice 存在 → 未 finished → question 属于该会话题单。
    if (input.practiceId !== undefined) {
      const resumed = deps.service.resumePractice(input.practiceId);
      if (resumed.practice.status === 'finished') {
        return sendError(
          res,
          409,
          'EXAM_PRACTICE_FINISHED',
          `practice session ${input.practiceId} is finished; no further grading is allowed`,
        );
      }
      if (!resumed.practice.questionIds.includes(input.questionId)) {
        return sendError(
          res,
          400,
          'EXAM_QUESTION_NOT_IN_PRACTICE',
          `question ${input.questionId} is not part of practice ${input.practiceId}`,
        );
      }
    }
  } catch (error) {
    return mapServiceError(res, error, deps.logger);
  }
  let route: ResolvedLlmRoute;
  try {
    route = await resolveLlmRoute(deps.llm, input.provider, input.model, deps.defaultRouteProvider, deps.routeCache);
  } catch (error) {
    return mapServiceError(res, error, deps.logger);
  }
  await runSseEndpoint(
    req,
    res,
    deps.logger,
    (signal) =>
      deps.service.gradeEssay(
        {
          questionId: input.questionId,
          practiceId: input.practiceId,
          userAnswer: input.userAnswer,
          provider: route.provider,
          model: route.model,
          signal,
        },
        (delta) => sseSend(res, { type: 'delta', text: delta }),
      ),
    (result) => ({ type: 'done', result }),
    'grading/essay',
  );
}

/** prefix /exam/api/grading 分派：/<attemptId> → GET 批改结果（练习内回看）。 */
function handleGradingPrefix(
  req: IncomingMessage,
  res: ServerResponse,
  service: ExamService,
  logger: Logger,
): void {
  const seg = pathSegments(req); // exam, api, grading, <attemptId>
  if (seg.length !== 4 || seg[3] === undefined || seg[3].length === 0) {
    return dispatchMiss(req, res);
  }
  const attemptId = seg[3];
  void runRoute(req, res, logger, () => {
    if (req.method !== 'GET') return methodNotAllowed(res, ['GET']);
    const grading = service.getEssayGrading(attemptId);
    if (grading === undefined) {
      throw new ExamServiceError(
        'EXAM_ESSAY_GRADING_NOT_FOUND',
        `essay grading not found: ${attemptId}`,
      );
    }
    sendJson(res, 200, { grading });
  });
}

/**
 * POST /exam/api/tutor/chat — Tutor 多轮对话（SSE）。
 *
 * 契约：请求 `{ sessionId?, questionId?, bankId?, message, provider?, model? }`；
 * sessionId 缺省 = 新建会话（questionId 可选自由问答）。
 * 成功事件：`delta` → `done { result: { sessionId, messageId, reply, model? } }`；
 * 流中失败：`error { code, message }`（user 消息保留、assistant 不落库，可重试）。
 */
async function handleTutorChat(
  req: IncomingMessage,
  res: ServerResponse,
  deps: {
    service: ExamService;
    llm: LlmRoute;
    defaultRouteProvider?: () => AgentDefaultRoute | undefined;
    routeCache?: LlmModelInfoCache;
    logger: Logger;
  },
): Promise<void> {
  if (req.method !== 'POST') return methodNotAllowed(res, ['POST']);
  let body: unknown;
  try {
    body = await readJsonBody(req);
  } catch (error) {
    return mapServiceError(res, error, deps.logger);
  }
  let input: ChatTutorRequest;
  try {
    input = parseChatTutorRequest(body);
  } catch (error) {
    return mapServiceError(res, error, deps.logger);
  }
  // 流开始前的领域校验（设计 §4：400/404/409 JSON；服务层保留同款校验作为纵深防御）。
  try {
    if (input.message.trim().length === 0) {
      return sendError(res, 400, 'EXAM_TUTOR_MESSAGE_REQUIRED', 'tutor message must be a non-empty string');
    }
    if (input.sessionId !== undefined) {
      const session = deps.service.getTutorSession(input.sessionId);
      if (session === undefined) {
        return sendError(res, 404, 'EXAM_TUTOR_SESSION_NOT_FOUND', `tutor session not found: ${input.sessionId}`);
      }
      // t5 P3：closed guard 流前呈现（JSON 409），不启动 SSE。
      if (session.status === 'closed') {
        return sendError(
          res,
          409,
          'EXAM_TUTOR_SESSION_CLOSED',
          `tutor session ${input.sessionId} is closed; start a new conversation`,
        );
      }
    }
    if (input.questionId !== undefined && deps.service.getQuestion(input.questionId) === undefined) {
      return sendError(res, 404, 'EXAM_QUESTION_NOT_FOUND', `question not found: ${input.questionId}`);
    }
  } catch (error) {
    return mapServiceError(res, error, deps.logger);
  }
  let route: ResolvedLlmRoute;
  try {
    route = await resolveLlmRoute(deps.llm, input.provider, input.model, deps.defaultRouteProvider, deps.routeCache);
  } catch (error) {
    return mapServiceError(res, error, deps.logger);
  }
  await runSseEndpoint(
    req,
    res,
    deps.logger,
    (signal) =>
      deps.service.chatTutor(
        {
          sessionId: input.sessionId,
          questionId: input.questionId,
          bankId: input.bankId,
          message: input.message,
          provider: route.provider,
          model: route.model,
          clientMessageId: input.clientMessageId,
          modelInfo: route.modelInfo,
          signal,
        },
        (delta) => sseSend(res, { type: 'delta', text: delta }),
      ),
    (result) => ({ type: 'done', result }),
    'tutor/chat',
    // t5 P1：SSE error 载荷携带 sessionId/turnId/retryable（服务层错误 meta 透出）。
    (error) => (error instanceof ExamServiceError ? error.meta ?? {} : {}),
  );
}

/**
 * POST /exam/api/practice/explain — 练习内个性化解析（P 形态，SSE，Phase 4）。
 * GET  /exam/api/practice/explain?practiceId&questionId — 解析缓存探测（JSON）。
 *
 * 契约（设计 §5）：
 * - POST：请求 `{ practiceId, questionId, provider?, model?, force? }`。
 *   流前领域校验复用 getPracticeExplanation 的完整校验链——404/409(未判分)/400
 *   以 JSON 呈现（流未开始）；EXAM_EXPLANATION_NOT_FOUND 不是错误，表示
 *   「校验通过 + 暂无缓存」，放行进入生成路径。缓存命中且非 force 时跳过
 *   resolveLlmRoute（零 LLM 语义：无可用 provider 也能命中缓存）；
 *   需要生成时 resolveLlmRoute 失败 → 503 JSON（流未开始）。
 *   成功事件：`delta* → done { result: ExplainResultDto }`；流中失败：
 *   `error { code, message }`。signal 全链透传，取消零落库。
 * - GET：200 `{ explanation: ExplanationDto }` | 404 EXAM_EXPLANATION_NOT_FOUND。
 */
async function handlePracticeExplain(
  req: IncomingMessage,
  res: ServerResponse,
  deps: {
    service: ExamService;
    llm: LlmRoute;
    defaultRouteProvider?: () => AgentDefaultRoute | undefined;
    routeCache?: LlmModelInfoCache;
    logger: Logger;
  },
): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://localhost');
  if (req.method === 'GET') {
    const practiceId = url.searchParams.get('practiceId');
    const questionId = url.searchParams.get('questionId');
    if (practiceId === null || practiceId.length === 0 || questionId === null || questionId.length === 0) {
      return sendError(res, 400, 'EXAM_INVALID_BODY', 'query parameters practiceId and questionId are required');
    }
    try {
      const depth = parseDepthValue(url.searchParams.get('depth'));
      sendJson(res, 200, {
        explanation: deps.service.getPracticeExplanation({
          practiceId,
          questionId,
          ...(depth !== undefined ? { depth } : {}),
        }),
      });
    } catch (error) {
      mapServiceError(res, error, deps.logger);
    }
    return;
  }
  if (req.method !== 'POST') return methodNotAllowed(res, ['GET', 'POST']);
  let body: unknown;
  try {
    body = await readJsonBody(req);
  } catch (error) {
    return mapServiceError(res, error, deps.logger);
  }
  let input: ExplainRequest;
  try {
    input = parseExplainRequest(body);
  } catch (error) {
    return mapServiceError(res, error, deps.logger);
  }

  // 流前领域校验（同 gradeEssay 双段语义）：getPracticeExplanation 内部即完整
  // 校验链（practice/question/题单归属/已判分 409/essay 400）；探测结果同时用于
  // 决定是否需要预解析 LLM 路由。
  let cacheHit = false;
  try {
    deps.service.getPracticeExplanation({
      practiceId: input.practiceId,
      questionId: input.questionId,
      ...(input.depth !== undefined ? { depth: input.depth } : {}),
    });
    cacheHit = true;
  } catch (error) {
    if (!(error instanceof ExamServiceError && error.code === 'EXAM_EXPLANATION_NOT_FOUND')) {
      return mapServiceError(res, error, deps.logger);
    }
  }

  // 命中且非 force → 不调 LLM，无需路由解析（服务层同样短路，双保险一致）；
  // 否则预解析 provider/model 缺省值，失败 → 503 JSON（流未开始）。
  let route: ResolvedLlmRoute | undefined;
  if (!(cacheHit && input.force !== true)) {
    try {
      route = await resolveLlmRoute(deps.llm, input.provider, input.model, deps.defaultRouteProvider, deps.routeCache);
    } catch (error) {
      return mapServiceError(res, error, deps.logger);
    }
  }

  await runSseEndpoint(
    req,
    res,
    deps.logger,
    (signal) =>
      deps.service.explainQuestion(
        {
          practiceId: input.practiceId,
          questionId: input.questionId,
          // 服务层契约：具体 provider/model 必须由路由层解析后传入（纵深防御）；
          // 仅「命中缓存且非 force」路径允许 undefined（服务层在 requireLlmRoute
          // 之前已短路返回缓存）。
          provider: route?.provider,
          model: route?.model,
          // t1 B：深档默认高推理档（high，除非客户端显式给出）；浅档跟随 DSH 默认。
          reasoningEffort:
            input.depth === 'deep'
              ? (input.reasoningEffort ?? 'high')
              : (input.reasoningEffort ?? route?.reasoningEffort),
          // t1 B：深档 maxTokens 计算所需模型上下文信息（contextWindow/defaultMaxTokens）。
          ...(route?.modelInfo !== undefined ? { modelInfo: route.modelInfo } : {}),
          ...(input.depth !== undefined ? { depth: input.depth } : {}),
          force: input.force,
          signal,
        },
        (delta) => sseSend(res, { type: 'delta', text: delta }),
      ),
    (result) => ({ type: 'done', result }),
    'practice/explain',
  );
}

/** GET /exam/api/tutor/sessions — Tutor 会话列表。 */
async function handleTutorSessions(
  req: IncomingMessage,
  res: ServerResponse,
  deps: { service: ExamService; logger: Logger },
): Promise<void> {
  if (req.method !== 'GET') return methodNotAllowed(res, ['GET']);
  try {
    sendJson(res, 200, { sessions: deps.service.listTutorSessions() });
  } catch (error) {
    mapServiceError(res, error, deps.logger);
  }
}

/**
 * prefix /exam/api/tutor/sessions 分派：
 * - /sessions/<id>          → GET `{ session, messages }`（Tutor 历史端点）/ DELETE（t5 硬删除 204）
 * - /sessions/<id>/close    → POST `{ session }`（t5 closed guard 配套，幂等）
 * 会话不存在 → 404 EXAM_TUTOR_SESSION_NOT_FOUND。
 */
function handleTutorSessionsPrefix(
  req: IncomingMessage,
  res: ServerResponse,
  service: ExamService,
  logger: Logger,
): void {
  const seg = pathSegments(req); // exam, api, tutor, sessions, <id>[, close]
  if ((seg.length !== 5 && seg.length !== 6) || seg[4] === undefined) {
    return dispatchMiss(req, res);
  }
  const id = seg[4];
  void runRoute(req, res, logger, () => {
    if (seg.length === 6 && seg[5] === 'close') {
      if (req.method !== 'POST') return methodNotAllowed(res, ['POST']);
      sendJson(res, 200, { session: service.closeTutorSession(id) });
      return;
    }
    if (seg.length === 5 && req.method === 'DELETE') {
      service.deleteTutorSession(id);
      res.writeHead(204, { 'cache-control': 'no-store' });
      res.end();
      return;
    }
    if (req.method !== 'GET') return methodNotAllowed(res, ['GET', 'DELETE']);
    const session = service.getTutorSession(id);
    if (session === undefined) {
      throw new ExamServiceError('EXAM_TUTOR_SESSION_NOT_FOUND', `tutor session not found: ${id}`);
    }
    sendJson(res, 200, { session, messages: service.listTutorMessages(id) });
  });
}

// ---------------------------------------------------------------------------
// Phase 2 JSON 路由：AI 导入 / 学情 / 学习计划
// ---------------------------------------------------------------------------

/** POST /exam/api/import/generate — 资料 → 题目草稿（JSON；t5 响应携带 draftId + AbortSignal）。 */
async function handleImportGenerate(
  req: IncomingMessage,
  res: ServerResponse,
  deps: {
    service: ExamService;
    llm: LlmRoute;
    defaultRouteProvider?: () => AgentDefaultRoute | undefined;
    routeCache?: LlmModelInfoCache;
    logger: Logger;
  },
): Promise<void> {
  if (req.method !== 'POST') return methodNotAllowed(res, ['POST']);
  let body: unknown;
  try {
    body = await readJsonBody(req);
  } catch (error) {
    return mapServiceError(res, error, deps.logger);
  }
  let input: ImportGenerateRequest;
  try {
    input = parseImportGenerateRequest(body);
  } catch (error) {
    return mapServiceError(res, error, deps.logger);
  }
  let route: ResolvedLlmRoute;
  try {
    route = await resolveLlmRoute(deps.llm, input.provider, input.model, deps.defaultRouteProvider, deps.routeCache);
  } catch (error) {
    return mapServiceError(res, error, deps.logger);
  }
  await runJsonEndpoint(req, res, deps.logger, async (signal) => {
    const result = await deps.service.listImportedQuestions({
      text: input.text,
      provider: route.provider,
      model: route.model,
      signal,
    });
    if (!res.writableEnded && !res.destroyed) sendJson(res, 200, result);
  });
}

/** POST /exam/api/import/commit — 草稿批量入库。 */
async function handleImportCommit(
  req: IncomingMessage,
  res: ServerResponse,
  deps: { service: ExamService; logger: Logger },
): Promise<void> {
  if (req.method !== 'POST') return methodNotAllowed(res, ['POST']);
  let body: unknown;
  try {
    body = await readJsonBody(req);
  } catch (error) {
    return mapServiceError(res, error, deps.logger);
  }
  let input: CommitImportRequest;
  try {
    input = parseCommitImportRequest(body);
  } catch (error) {
    return mapServiceError(res, error, deps.logger);
  }
  try {
    sendJson(res, 200, deps.service.importQuestions(input.bankId, {
      questions: input.questions,
      batchId: input.batchId,
      draftId: input.draftId,
    }));
  } catch (error) {
    mapServiceError(res, error, deps.logger);
  }
}

/**
 * prefix /exam/api/import/drafts 分派（t5 草稿恢复）：
 * - GET  /import/drafts/<id>          → `{ questions }`（404 不存在；409 已 consumed/discarded）
 * - POST /import/drafts/<id>/discard  → `{ draft }`（置 discarded；幂等）
 */
function handleImportDraftsPrefix(
  req: IncomingMessage,
  res: ServerResponse,
  service: ExamService,
  logger: Logger,
): void {
  const seg = pathSegments(req); // exam, api, import, drafts, <id>[, discard]
  if ((seg.length !== 5 && seg.length !== 6) || seg[4] === undefined) {
    return dispatchMiss(req, res);
  }
  const id = seg[4];
  void runRoute(req, res, logger, () => {
    if (seg.length === 6 && seg[5] === 'discard') {
      if (req.method !== 'POST') return methodNotAllowed(res, ['POST']);
      service.discardImportDraft(id);
      res.writeHead(204, { 'cache-control': 'no-store' });
      res.end();
      return;
    }
    if (req.method !== 'GET') return methodNotAllowed(res, ['GET']);
    sendJson(res, 200, { questions: service.getImportDraft(id) });
  });
}

/** GET /exam/api/insights — 学情洞察摘要（纯统计；?window=7|14|30 &bank=<bankId> 可选）。 */
async function handleInsights(
  req: IncomingMessage,
  res: ServerResponse,
  deps: { service: ExamService; logger: Logger },
): Promise<void> {
  if (req.method !== 'GET') return methodNotAllowed(res, ['GET']);
  // t13：可选查询参数 —— window（趋势窗口天数）与 bank（题库维度过滤）。
  const url = new URL(req.url ?? '/', 'http://localhost');
  const windowRaw = url.searchParams.get('window');
  const windowDays = windowRaw === null ? undefined : Number(windowRaw);
  const bankId = url.searchParams.get('bank') ?? undefined;
  try {
    const insight = deps.service.listInsight({
      ...(windowDays !== undefined ? { windowDays } : {}),
      ...(bankId !== undefined ? { bankId } : {}),
    });
    sendJson(res, 200, { insight });
  } catch (error) {
    mapServiceError(res, error, deps.logger);
  }
}

/** GET /exam/api/insights/diagnoses — 诊断历史（t13 持久化记录，created_at DESC）。 */
async function handleInsightsDiagnoses(
  req: IncomingMessage,
  res: ServerResponse,
  deps: { service: ExamService; logger: Logger },
): Promise<void> {
  if (req.method !== 'GET') return methodNotAllowed(res, ['GET']);
  try {
    sendJson(res, 200, deps.service.listDiagnoses());
  } catch (error) {
    mapServiceError(res, error, deps.logger);
  }
}

/** POST /exam/api/insights/diagnose — LLM 学情诊断（t5 AbortSignal）。 */
async function handleInsightsDiagnose(
  req: IncomingMessage,
  res: ServerResponse,
  deps: {
    service: ExamService;
    llm: LlmRoute;
    defaultRouteProvider?: () => AgentDefaultRoute | undefined;
    routeCache?: LlmModelInfoCache;
    logger: Logger;
  },
): Promise<void> {
  if (req.method !== 'POST') return methodNotAllowed(res, ['POST']);
  let body: unknown;
  try {
    body = await readJsonBody(req);
  } catch (error) {
    return mapServiceError(res, error, deps.logger);
  }
  let route: ResolvedLlmRoute;
  try {
    route = await resolveLlmRoute(
      deps.llm,
      asOptionalString(body, 'provider'),
      asOptionalString(body, 'model'),
      deps.defaultRouteProvider,
      deps.routeCache,
    );
  } catch (error) {
    return mapServiceError(res, error, deps.logger);
  }
  await runJsonEndpoint(req, res, deps.logger, async (signal) => {
    const diagnosis = await deps.service.diagnoseInsight({ provider: route.provider, model: route.model, signal });
    if (!res.writableEnded && !res.destroyed) sendJson(res, 200, { diagnosis });
  });
}

/** GET/POST /exam/api/plans — 列表 / 手动新建。 */
async function handlePlans(
  req: IncomingMessage,
  res: ServerResponse,
  deps: { service: ExamService; logger: Logger },
): Promise<void> {
  if (req.method === 'GET') {
    try {
      sendJson(res, 200, deps.service.listPlans());
    } catch (error) {
      mapServiceError(res, error, deps.logger);
    }
    return;
  }
  if (req.method === 'POST') {
    let body: unknown;
    try {
      body = await readJsonBody(req);
    } catch (error) {
      return mapServiceError(res, error, deps.logger);
    }
    let input: CreateManualPlanRequest;
    try {
      input = parseManualPlanRequest(body);
    } catch (error) {
      return mapServiceError(res, error, deps.logger);
    }
    try {
      sendJson(res, 201, deps.service.createManualPlan(input));
    } catch (error) {
      mapServiceError(res, error, deps.logger);
    }
    return;
  }
  methodNotAllowed(res, ['GET', 'POST']);
}

/** POST /exam/api/plans/generate — LLM 生成计划并落库（t5 AbortSignal）。 */
async function handlePlansGenerate(
  req: IncomingMessage,
  res: ServerResponse,
  deps: {
    service: ExamService;
    llm: LlmRoute;
    defaultRouteProvider?: () => AgentDefaultRoute | undefined;
    routeCache?: LlmModelInfoCache;
    logger: Logger;
  },
): Promise<void> {
  if (req.method !== 'POST') return methodNotAllowed(res, ['POST']);
  let body: unknown;
  try {
    body = await readJsonBody(req);
  } catch (error) {
    return mapServiceError(res, error, deps.logger);
  }
  let route: ResolvedLlmRoute;
  try {
    route = await resolveLlmRoute(
      deps.llm,
      asOptionalString(body, 'provider'),
      asOptionalString(body, 'model'),
      deps.defaultRouteProvider,
      deps.routeCache,
    );
  } catch (error) {
    return mapServiceError(res, error, deps.logger);
  }
  await runJsonEndpoint(req, res, deps.logger, async (signal) => {
    const title = asOptionalString(body, 'title');
    const result = await deps.service.generatePlan({
      provider: route.provider,
      model: route.model,
      title,
      signal,
    });
    if (!res.writableEnded && !res.destroyed) sendJson(res, 201, { plan: result.plan, items: result.items });
  });
}

/**
 * prefix /exam/api/plans 分派：/plans/<id> → GET/DELETE；/plans/<id>/items → POST；
 * /plans/<id>/items/<itemId> → PATCH/DELETE（t13 计划与条目删除）。
 */
function handlePlansPrefix(
  req: IncomingMessage,
  res: ServerResponse,
  service: ExamService,
  logger: Logger,
): void {
  const seg = pathSegments(req); // exam, api, plans, ...
  if (seg.length !== 4 && seg.length !== 5 && seg.length !== 6) {
    return dispatchMiss(req, res);
  }
  const planId = seg[3];
  void runRoute(req, res, logger, async () => {
    if (seg.length === 4 && planId !== undefined) {
      if (req.method === 'DELETE') {
        // t13：删除整个计划（级联清理条目）→ 204。
        service.deletePlan(planId);
        res.statusCode = 204;
        res.end();
        return;
      }
      if (req.method !== 'GET') return methodNotAllowed(res, ['GET', 'DELETE']);
      sendJson(res, 200, service.getPlan(planId));
      return;
    }
    if (seg.length === 5 && planId !== undefined && seg[4] === 'items') {
      if (req.method !== 'POST') return methodNotAllowed(res, ['POST']);
      const body = await readJsonBody(req);
      const titles = parseAddPlanItems(body);
      sendJson(res, 201, service.addPlanItems(planId, titles));
      return;
    }
    if (seg.length === 6 && planId !== undefined && seg[4] === 'items' && seg[5] !== undefined) {
      const itemId = seg[5];
      if (req.method === 'DELETE') {
        // t13：删除单条条目（同事务重算计划状态）→ 204。
        service.deletePlanItem(planId, itemId);
        res.statusCode = 204;
        res.end();
        return;
      }
      if (req.method !== 'PATCH') return methodNotAllowed(res, ['PATCH', 'DELETE']);
      const body = await readJsonBody(req);
      const done = parseSetPlanItemDone(body);
      sendJson(res, 200, { item: service.setPlanItemDone(planId, itemId, done) });
      return;
    }
    dispatchMiss(req, res);
  });
}

// ---------------------------------------------------------------------------
// Phase 1 路由：题目 / 练习 / 作答 / 错题本（prefix 分派 + 手工路径段解析）
// ---------------------------------------------------------------------------

/** 解析请求 pathname 为路径段数组（不含空段）。 */
function pathSegments(req: IncomingMessage): string[] {
  const url = new URL(req.url ?? '/', 'http://localhost');
  return url.pathname.split('/').filter((segment) => segment.length > 0);
}

/** 通用子路径 404（分派器未匹配的段组合）。 */
function dispatchMiss(req: IncomingMessage, res: ServerResponse): void {
  sendError(res, 404, 'EXAM_NOT_FOUND', `no exam route for ${req.method ?? '?'} ${req.url ?? '?'}`);
}

/** 把任意执行包装为 try/catch → mapServiceError。 */
async function runRoute(
  req: IncomingMessage,
  res: ServerResponse,
  logger: Logger,
  fn: () => void | Promise<void>,
): Promise<void> {
  try {
    await fn();
  } catch (error) {
    mapServiceError(res, error, logger);
  }
}

/**
 * prefix /exam/api/banks 分派：/banks/<bankId>/questions + /banks/<bankId>/topic-suggestions（P2）。
 * （裸 /banks 由 exact 路由处理，见 handleBanks。）
 */
function handleBanksPrefix(
  req: IncomingMessage,
  res: ServerResponse,
  deps: {
    service: ExamService;
    llm: LlmRoute;
    defaultRouteProvider?: () => AgentDefaultRoute | undefined;
    routeCache?: LlmModelInfoCache;
    logger: Logger;
  },
): void {
  const { service, llm, defaultRouteProvider, routeCache, logger } = deps;
  const seg = pathSegments(req); // exam, api, banks, ...
  const bankId = seg[3];
  if (seg.length === 4 && bankId !== undefined) {
    // t9 生命周期：PATCH 重命名 / DELETE 软删除。
    void runRoute(req, res, logger, async () => {
      if (req.method === 'PATCH') {
        const body = await readJsonBody(req);
        const name = asBankName(body);
        if (name === undefined) {
          return sendError(res, 400, 'EXAM_INVALID_BODY', 'request body must be { "name": string }');
        }
        sendJson(res, 200, { bank: service.renameBank(bankId, name) });
        return;
      }
      if (req.method === 'DELETE') {
        service.deleteBank(bankId);
        res.writeHead(204, { 'cache-control': 'no-store' });
        res.end();
        return;
      }
      methodNotAllowed(res, ['PATCH', 'DELETE']);
    });
    return;
  }
  if (seg.length !== 5 || bankId === undefined) {
    return dispatchMiss(req, res);
  }
  const action = seg[4];
  void runRoute(req, res, logger, async () => {
    if (action === 'questions') {
      if (req.method === 'GET') {
        // t9：题库题目列表（支持 q/type/tags/hasExplanation/sort 过滤）。
        const url = new URL(req.url ?? '/', 'http://localhost');
        sendJson(res, 200, { questions: service.listQuestionsByBank(bankId, parseListQuestionsFilter(url)) });
        return;
      }
      if (req.method === 'POST') {
        const body = await readJsonBody(req);
        const input = parseCreateQuestion(body);
        const question = service.createQuestion(bankId, input);
        sendJson(res, 201, { question });
        return;
      }
      methodNotAllowed(res, ['GET', 'POST']);
      return;
    }
    if (action === 'archive') {
      if (req.method !== 'POST') return methodNotAllowed(res, ['POST']);
      sendJson(res, 200, { bank: service.archiveBank(bankId) });
      return;
    }
    if (action === 'restore') {
      if (req.method !== 'POST') return methodNotAllowed(res, ['POST']);
      sendJson(res, 200, { bank: service.restoreBank(bankId) });
      return;
    }
    if (action === 'topic-suggestions') {
      if (req.method !== 'POST') return methodNotAllowed(res, ['POST']);
      const body = await readJsonBody(req);
      const input = parseTopicSuggestRequest(body);
      const route = await resolveLlmRoute(llm, undefined, undefined, defaultRouteProvider, routeCache);
      await runJsonEndpoint(req, res, logger, async (signal) => {
        const result = await service.explainTopicSuggestions({
          bankId,
          ...(input.limit !== undefined ? { limit: input.limit } : {}),
          ...(input.questionIds !== undefined ? { questionIds: input.questionIds } : {}),
          provider: route.provider,
          model: route.model,
          signal,
        });
        if (!res.writableEnded && !res.destroyed) sendJson(res, 200, result);
      });
      return;
    }
    dispatchMiss(req, res);
  });
}

/** prefix /exam/api/questions 分派：/questions/<id> → PUT / DELETE；/questions/<id>/explain-generic → POST（Phase 4 G 形态）。 */
function handleQuestionsPrefix(
  req: IncomingMessage,
  res: ServerResponse,
  deps: {
    service: ExamService;
    llm: LlmRoute;
    defaultRouteProvider?: () => AgentDefaultRoute | undefined;
    routeCache?: LlmModelInfoCache;
    logger: Logger;
  },
): void {
  const seg = pathSegments(req); // exam, api, questions, <id>[, explain-generic]
  if ((seg.length !== 4 && seg.length !== 5) || seg[3] === undefined) {
    return dispatchMiss(req, res);
  }
  const id = seg[3];
  const { service, llm, defaultRouteProvider, routeCache, logger } = deps;
  // P2：POST /questions/topics — 用户确认后的批量知识标注写回（ApplyTopicsRequest）。
  if (seg.length === 4 && id === 'topics') {
    if (req.method !== 'POST') return methodNotAllowed(res, ['POST']);
    return void runRoute(req, res, logger, async () => {
      const body = await readJsonBody(req);
      const input = parseApplyTopicsRequest(body);
      const result = service.applyTopics(input.items);
      sendJson(res, 200, result);
    });
  }
  // t9：POST /questions/bulk — 批量题目操作（tag/move/archive/restore/delete/explain-generic）。
  if (seg.length === 4 && id === 'bulk') {
    if (req.method !== 'POST') return methodNotAllowed(res, ['POST']);
    return void runRoute(req, res, logger, async () => {
      const body = await readJsonBody(req);
      const op = parseBulkQuestion(body);
      if (op.op === 'explain-generic') {
        // LLM 批量解析：先解析缺省路由（失败 → 503 JSON），再经 runJsonEndpoint 逐个生成。
        const route = await resolveLlmRoute(llm, undefined, undefined, defaultRouteProvider, routeCache);
        await runJsonEndpoint(req, res, logger, async (signal) => {
          const result = await service.bulkQuestions(op, {
            provider: route.provider,
            model: route.model,
            reasoningEffort: route.reasoningEffort,
            signal,
          });
          if (!res.writableEnded && !res.destroyed) sendJson(res, 200, result);
        });
        return;
      }
      sendJson(res, 200, await service.bulkQuestions(op));
    });
  }
  // Phase 4：POST /questions/<id>/explain-generic — 题库通用解析写回（JSON，非流式；t5 AbortSignal）。
  if (seg.length === 5) {
    if (seg[4] !== 'explain-generic') return dispatchMiss(req, res);
    if (req.method !== 'POST') return methodNotAllowed(res, ['POST']);
    return void runRoute(req, res, logger, async () => {
      // 空请求体合法（provider/model 均可选）；readJsonBody 空体返回 undefined。
      let body: unknown;
      try {
        body = await readJsonBody(req);
      } catch (error) {
        return mapServiceError(res, error, logger);
      }
      let input: ExplainGenericRequest;
      try {
        input = parseExplainGenericRequest(body);
      } catch (error) {
        return mapServiceError(res, error, logger);
      }
      // G 形态必然调用 LLM（无缓存短路），先解析缺省路由；失败 → 503 JSON。
      const route = await resolveLlmRoute(llm, input.provider, input.model, defaultRouteProvider, routeCache);
      await runJsonEndpoint(req, res, logger, async (signal) => {
        const question = await service.explainGenericQuestion({
          questionId: id,
          provider: route.provider,
          model: route.model,
          reasoningEffort: input.reasoningEffort ?? route.reasoningEffort,
          signal,
        });
        if (!res.writableEnded && !res.destroyed) sendJson(res, 200, { question });
      });
    });
  }
  void runRoute(req, res, logger, async () => {
    if (req.method === 'PUT') {
      const body = await readJsonBody(req);
      const patch = parseUpdateQuestion(body);
      const question = service.updateQuestion(id, patch);
      sendJson(res, 200, { question });
      return;
    }
    if (req.method === 'DELETE') {
      service.deleteQuestion(id);
      res.writeHead(204, { 'cache-control': 'no-store' });
      res.end();
      return;
    }
    methodNotAllowed(res, ['PUT', 'DELETE']);
  });
}

/** prefix /exam/api/practice 分派：history / start / <id> / <id>/finish / <id>/scorecard。 */
function handlePracticePrefix(
  req: IncomingMessage,
  res: ServerResponse,
  service: ExamService,
  logger: Logger,
): void {
  const seg = pathSegments(req); // exam, api, practice, ...
  if (seg.length !== 4 && seg.length !== 5) {
    return dispatchMiss(req, res);
  }
  const sub = seg[3];
  void runRoute(req, res, logger, async () => {
    if (sub === 'history' && seg.length === 4) {
      // Phase 2：练习历史 / 续做（active 附 answeredCount，finished 附 scorecard）。
      if (req.method !== 'GET') return methodNotAllowed(res, ['GET']);
      sendJson(res, 200, { sessions: service.listPracticeHistory() });
      return;
    }
    if (sub === 'start' && seg.length === 4) {
      if (req.method !== 'POST') return methodNotAllowed(res, ['POST']);
      const body = await readJsonBody(req);
      const input = parseStartPractice(body);
      const practice = service.startPractice(input);
      sendJson(res, 201, { practice });
      return;
    }
    if (seg.length === 4 && sub !== undefined) {
      const id = sub;
      if (req.method === 'GET') {
        sendJson(res, 200, service.resumePractice(id));
        return;
      }
      if (req.method === 'PATCH') {
        const body = await readJsonBody(req);
        const currentIndex = parseCurrentIndex(body);
        sendJson(res, 200, { practice: service.updatePracticeIndex(id, currentIndex) });
        return;
      }
      if (req.method === 'DELETE') {
        // 删除历史条目（仅会话行；attempts 保留计入学情/错题本）。
        service.deletePractice(id);
        res.writeHead(204, { 'cache-control': 'no-store' });
        res.end();
        return;
      }
      return methodNotAllowed(res, ['GET', 'PATCH', 'DELETE']);
    }
    if (seg.length === 5 && sub !== undefined && seg[4] === 'finish') {
      if (req.method !== 'POST') return methodNotAllowed(res, ['POST']);
      sendJson(res, 200, service.finishPractice(sub));
      return;
    }
    if (seg.length === 5 && sub !== undefined && seg[4] === 'scorecard') {
      if (req.method !== 'GET') return methodNotAllowed(res, ['GET']);
      sendJson(res, 200, { scorecard: service.buildScorecard(sub) });
      return;
    }
    dispatchMiss(req, res);
  });
}

/** prefix /exam/api/quiz 分派：/quiz/grade → POST。 */
function handleQuizPrefix(
  req: IncomingMessage,
  res: ServerResponse,
  service: ExamService,
  logger: Logger,
): void {
  const seg = pathSegments(req); // exam, api, quiz, grade
  if (seg.length !== 4 || seg[3] !== 'grade') {
    return dispatchMiss(req, res);
  }
  void runRoute(req, res, logger, async () => {
    if (req.method !== 'POST') return methodNotAllowed(res, ['POST']);
    const body = await readJsonBody(req);
    const input = parseGradeAnswer(body);
    sendJson(res, 200, service.gradeAnswer(input));
  });
}

/** prefix /exam/api/wrong 分派：GET 列表 / <questionId>/master POST。 */
function handleWrongPrefix(
  req: IncomingMessage,
  res: ServerResponse,
  service: ExamService,
  logger: Logger,
): void {
  const seg = pathSegments(req); // exam, api, wrong, [questionId, master]
  if (seg.length === 3) {
    void runRoute(req, res, logger, () => {
      if (req.method !== 'GET') return methodNotAllowed(res, ['GET']);
      const url = new URL(req.url ?? '/', 'http://localhost');
      const bankId = url.searchParams.get('bankId') ?? undefined;
      const includeMastered = url.searchParams.get('includeMastered') === 'true';
      sendJson(res, 200, { wrong: service.listWrong({ bankId, includeMastered }) });
    });
    return;
  }
  if (seg.length === 5 && seg[3] !== undefined && seg[4] === 'master') {
    void runRoute(req, res, logger, async () => {
      if (req.method !== 'POST') return methodNotAllowed(res, ['POST']);
      const body = await readJsonBody(req);
      const mastered = parseMastered(body);
      sendJson(res, 200, { wrong: service.setMastered(seg[3]!, mastered) });
    });
    return;
  }
  dispatchMiss(req, res);
}

// ── Phase 1 请求体解析（手写最小校验，非法一律 EXAM_INVALID_BODY）─────────

function parseCreateQuestion(body: unknown): CreateQuestionRequest {
  const obj = asObject(body);
  const type = asString(obj.type);
  if (!isQuestionTypeValue(type)) {
    throw new ExamServiceError('EXAM_INVALID_BODY', 'question type must be single|multiple|boolean|essay');
  }
  const stem = asString(obj.stem);
  const options = asStringArray(obj.options);
  if (obj.answer === undefined) {
    throw new ExamServiceError('EXAM_INVALID_BODY', 'question answer is required');
  }
  return {
    type,
    stem,
    options,
    answer: obj.answer,
    explanation: asNullableString(obj.explanation),
    tags: obj.tags === undefined || obj.tags === null ? null : asStringArray(obj.tags),
    topics: obj.topics === undefined || obj.topics === null ? null : asStringArray(obj.topics),
  };
}

function parseUpdateQuestion(body: unknown): UpdateQuestionRequest {
  const obj = asObject(body);
  const patch: UpdateQuestionRequest = {};
  if (obj.type !== undefined) {
    const type = asString(obj.type);
    if (!isQuestionTypeValue(type)) {
      throw new ExamServiceError('EXAM_INVALID_BODY', 'question type must be single|multiple|boolean|essay');
    }
    patch.type = type;
  }
  if (obj.stem !== undefined) patch.stem = asString(obj.stem);
  if (obj.options !== undefined) patch.options = asStringArray(obj.options);
  if (obj.answer !== undefined) patch.answer = obj.answer;
  if (obj.explanation !== undefined) patch.explanation = asNullableString(obj.explanation);
  if (obj.tags !== undefined) patch.tags = obj.tags === null ? null : asStringArray(obj.tags);
  if (obj.topics !== undefined) patch.topics = obj.topics === null ? null : asStringArray(obj.topics);
  if (Object.keys(patch).length === 0) {
    throw new ExamServiceError('EXAM_INVALID_BODY', 'update question requires at least one field');
  }
  return patch;
}

function parseStartPractice(body: unknown): StartPracticeRequest {
  const obj = asObject(body);
  const bankId = asString(obj.bankId);
  const scope = parseScope(obj.scope);
  const shuffle = obj.shuffle === undefined ? undefined : asBoolean(obj.shuffle);
  const seed = obj.seed === undefined ? undefined : asString(obj.seed);
  return { bankId, scope, shuffle, seed };
}

function parseScope(value: unknown): PracticeScopeDto {
  const obj = asObject(value);
  const mode = asString(obj.mode);
  if (!isScopeModeValue(mode)) {
    throw new ExamServiceError('EXAM_INVALID_BODY', 'scope mode must be all|undone|wrong|byType|byTag|byTopic');
  }
  const scope: PracticeScopeDto = { mode };
  if (obj.type !== undefined) {
    const type = asString(obj.type);
    if (!isQuestionTypeValue(type)) {
      throw new ExamServiceError('EXAM_INVALID_BODY', 'scope type must be single|multiple|boolean|essay');
    }
    scope.type = type;
  }
  if (obj.tag !== undefined) scope.tag = normalizeQueryLabel(asString(obj.tag));
  // t1：byTopic 筛选值（topics 包含匹配）。
  if (obj.topic !== undefined) scope.topic = normalizeQueryLabel(asString(obj.topic));
  // t9：显式题目集合（错题单题/多选重练）。
  if (obj.questionIds !== undefined) {
    scope.questionIds = asStringArray(obj.questionIds);
  }
  return scope;
}

function parseCurrentIndex(body: unknown): number {
  const obj = asObject(body);
  const index = obj.currentIndex;
  if (typeof index !== 'number' || !Number.isInteger(index) || index < 0) {
    throw new ExamServiceError('EXAM_INVALID_BODY', 'currentIndex must be a non-negative integer');
  }
  return index;
}

function parseGradeAnswer(body: unknown): GradeAnswerRequest {
  const obj = asObject(body);
  const practiceId = asString(obj.practiceId);
  const questionId = asString(obj.questionId);
  if (obj.answer === undefined) {
    throw new ExamServiceError('EXAM_INVALID_BODY', 'answer is required');
  }
  return { practiceId, questionId, answer: obj.answer };
}

function parseMastered(body: unknown): boolean {
  const obj = asObject(body);
  return asBoolean(obj.mastered);
}

// ── Phase 2 请求体解析（手写最小校验，非法一律 EXAM_INVALID_BODY）───────────

function parseGradeEssayRequest(body: unknown): GradeEssayRequest {
  const obj = asObject(body);
  const questionId = asString(obj.questionId);
  // userAnswer 必须为字符串（可为空串——空串交给服务层报 EXAM_ESSAY_ANSWER_REQUIRED）。
  const userAnswer = obj.userAnswer;
  if (typeof userAnswer !== 'string') {
    throw new ExamServiceError('EXAM_INVALID_BODY', 'userAnswer must be a string');
  }
  return {
    questionId,
    ...(obj.practiceId !== undefined ? { practiceId: asString(obj.practiceId) } : {}),
    userAnswer,
    ...(obj.provider !== undefined ? { provider: asString(obj.provider) } : {}),
    ...(obj.model !== undefined ? { model: asString(obj.model) } : {}),
  };
}

function parseChatTutorRequest(body: unknown): ChatTutorRequest {
  const obj = asObject(body);
  const message = obj.message;
  if (typeof message !== 'string') {
    throw new ExamServiceError('EXAM_INVALID_BODY', 'message must be a string');
  }
  return {
    ...(obj.sessionId !== undefined ? { sessionId: asString(obj.sessionId) } : {}),
    ...(obj.questionId !== undefined ? { questionId: asString(obj.questionId) } : {}),
    ...(obj.bankId !== undefined ? { bankId: asString(obj.bankId) } : {}),
    message,
    ...(obj.provider !== undefined ? { provider: asString(obj.provider) } : {}),
    ...(obj.model !== undefined ? { model: asString(obj.model) } : {}),
    ...(obj.clientMessageId !== undefined ? { clientMessageId: asString(obj.clientMessageId) } : {}),
  };
}

function parseImportGenerateRequest(body: unknown): ImportGenerateRequest {
  const obj = asObject(body);
  const text = obj.text;
  if (typeof text !== 'string') {
    throw new ExamServiceError('EXAM_INVALID_BODY', 'text must be a string');
  }
  return {
    text,
    ...(obj.provider !== undefined ? { provider: asString(obj.provider) } : {}),
    ...(obj.model !== undefined ? { model: asString(obj.model) } : {}),
  };
}

function parseCommitImportRequest(body: unknown): CommitImportRequest {
  const obj = asObject(body);
  const bankId = asString(obj.bankId);
  const rawQuestions = obj.questions;
  // t5：draftId 与 questions 二选一（draftId 优先，服务层裁决）；都缺 → 400。
  if (obj.draftId === undefined && (!Array.isArray(rawQuestions) || rawQuestions.length === 0)) {
    throw new ExamServiceError('EXAM_INVALID_BODY', 'questions must be a non-empty array (or provide draftId)');
  }
  return {
    bankId,
    ...(Array.isArray(rawQuestions)
      ? { questions: rawQuestions.map((item) => parseCreateQuestion(item)) }
      : {}),
    ...(obj.batchId !== undefined ? { batchId: asString(obj.batchId) } : {}),
    ...(obj.draftId !== undefined ? { draftId: asString(obj.draftId) } : {}),
  };
}

// ── Phase 4 请求体解析（手写最小校验，非法一律 EXAM_INVALID_BODY）───────────

/** POST /exam/api/practice/explain 请求体：practiceId/questionId 必填，force 可选布尔，depth 枚举校验。 */
function parseExplainRequest(body: unknown): ExplainRequest {
  const obj = asObject(body);
  const depth = parseDepthValue(obj.depth);
  return {
    practiceId: asString(obj.practiceId),
    questionId: asString(obj.questionId),
    ...(obj.provider !== undefined ? { provider: asString(obj.provider) } : {}),
    ...(obj.model !== undefined ? { model: asString(obj.model) } : {}),
    ...(obj.reasoningEffort !== undefined ? { reasoningEffort: asString(obj.reasoningEffort) } : {}),
    ...(depth !== undefined ? { depth } : {}),
    ...(obj.force !== undefined ? { force: asBoolean(obj.force) } : {}),
  };
}

/** depth 取值校验（'light'|'deep'）；undefined/null/空串 → undefined（缺省 light）。 */
function parseDepthValue(value: unknown): ExplainDepth | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (value === 'light' || value === 'deep') return value;
  throw new ExamServiceError('EXAM_INVALID_BODY', 'depth must be light|deep');
}

/** POST /exam/api/questions/:id/explain-generic 请求体：provider/model 均可选（空体合法）。 */
function parseExplainGenericRequest(body: unknown): ExplainGenericRequest {
  if (body === undefined || body === null) return {};
  const obj = asObject(body);
  return {
    ...(obj.provider !== undefined ? { provider: asString(obj.provider) } : {}),
    ...(obj.model !== undefined ? { model: asString(obj.model) } : {}),
    ...(obj.reasoningEffort !== undefined ? { reasoningEffort: asString(obj.reasoningEffort) } : {}),
  };
}

/** POST /exam/api/banks/:bankId/topic-suggestions 请求体：`{ limit?: number, questionIds?: string[] }`（limit 缺省 50 上限 100、questionIds 1-20 由服务层校验/透传）。 */
function parseTopicSuggestRequest(body: unknown): { limit?: number; questionIds?: string[] } {
  if (body === undefined || body === null) return {};
  const obj = asObject(body);
  const result: { limit?: number; questionIds?: string[] } = {};
  if (obj.limit !== undefined) {
    const limit = obj.limit;
    if (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1) {
      throw new ExamServiceError('EXAM_INVALID_BODY', 'limit must be a positive integer');
    }
    result.limit = limit;
  }
  if (obj.questionIds !== undefined) {
    result.questionIds = asStringArray(obj.questionIds);
  }
  return result;
}

/** POST /exam/api/questions/topics 请求体：`{ items: { questionId, topics[] }[] }`（服务层逐题校验）。 */
function parseApplyTopicsRequest(body: unknown): ApplyTopicsRequest {
  const obj = asObject(body);
  const items = obj.items;
  if (!Array.isArray(items)) {
    throw new ExamServiceError('EXAM_INVALID_BODY', 'items must be an array');
  }
  return {
    items: items.map((item) => {
      const it = asObject(item);
      return { questionId: asString(it.questionId), topics: asStringArray(it.topics) };
    }),
  };
}

function parseManualPlanRequest(body: unknown): CreateManualPlanRequest {
  const obj = asObject(body);
  const title = asString(obj.title);
  const items = obj.items;
  if (items !== undefined) {
    if (!Array.isArray(items)) {
      throw new ExamServiceError('EXAM_INVALID_BODY', 'items must be an array');
    }
    return { title, items: items.map(parsePlanItemLike) };
  }
  return { title };
}

function parseAddPlanItems(body: unknown): Array<string | PlanItemInput> {
  const obj = asObject(body);
  // t9：优先结构化 items；旧版 titles 兼容（缺省转换）。
  if (obj.items !== undefined) {
    if (!Array.isArray(obj.items)) {
      throw new ExamServiceError('EXAM_INVALID_BODY', 'items must be an array');
    }
    return obj.items.map(parsePlanItemLike);
  }
  const titles = obj.titles;
  if (!Array.isArray(titles) || titles.length === 0 || !titles.every((item) => typeof item === 'string')) {
    throw new ExamServiceError('EXAM_INVALID_BODY', 'titles must be a non-empty string array');
  }
  return titles as string[];
}

/** 计划条目输入归一化：字符串 = 标题；对象 = 结构化条目（PlanItemInput 校验）。 */
function parsePlanItemLike(value: unknown): string | PlanItemInput {
  if (typeof value === 'string') {
    if (value.trim().length === 0) throw new ExamServiceError('EXAM_INVALID_BODY', 'plan item title must be a non-empty string');
    return value;
  }
  const obj = asObject(value);
  const title = asString(obj.title);
  const item: PlanItemInput = { title };
  if (obj.note !== undefined) item.note = asNullableString(obj.note);
  if (obj.actionType !== undefined) item.actionType = asPlanItemActionType(asString(obj.actionType));
  if (obj.scope !== undefined) item.scope = parseScope(obj.scope);
  if (obj.dueAt !== undefined) item.dueAt = asNonNegativeInt(obj.dueAt, 'dueAt');
  if (obj.priority !== undefined) item.priority = asNonNegativeInt(obj.priority, 'priority');
  if (obj.status !== undefined) item.status = asPlanItemStatus(asString(obj.status));
  if (obj.sourceDiagnosisId !== undefined) item.sourceDiagnosisId = asString(obj.sourceDiagnosisId);
  return item;
}

function asPlanItemActionType(value: string): PlanItemInput['actionType'] {
  if (value === 'practice' || value === 'reviewError' || value === 'read' || value === 'tutor') return value;
  throw new ExamServiceError('EXAM_INVALID_BODY', 'actionType must be practice|reviewError|read|tutor');
}

function asPlanItemStatus(value: string): PlanItemInput['status'] {
  if (value === 'pending' || value === 'doing' || value === 'done' || value === 'skipped') return value;
  throw new ExamServiceError('EXAM_INVALID_BODY', 'status must be pending|doing|done|skipped');
}

function asNonNegativeInt(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw new ExamServiceError('EXAM_INVALID_BODY', `${field} must be a non-negative integer`);
  }
  return value;
}

function parseSetPlanItemDone(body: unknown): boolean {
  const obj = asObject(body);
  return asBoolean(obj.done);
}

function asObject(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new ExamServiceError('EXAM_INVALID_BODY', 'request body must be a JSON object');
  }
  return value as Record<string, unknown>;
}

function asString(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new ExamServiceError('EXAM_INVALID_BODY', 'expected a non-empty string');
  }
  return value;
}

function asNullableString(value: unknown): string | null {
  if (value === null || value === undefined || value === '') return null;
  return asString(value);
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value) || !value.every((item) => typeof item === 'string')) {
    throw new ExamServiceError('EXAM_INVALID_BODY', 'expected a string array');
  }
  return value;
}

function asBoolean(value: unknown): boolean {
  if (typeof value !== 'boolean') {
    throw new ExamServiceError('EXAM_INVALID_BODY', 'expected a boolean');
  }
  return value;
}

function asNonEmptyStringArray(value: unknown): string[] {
  if (!Array.isArray(value) || value.length === 0 || !value.every((item) => typeof item === 'string' && item.length > 0)) {
    throw new ExamServiceError('EXAM_INVALID_BODY', 'expected a non-empty string array');
  }
  return value as string[];
}

/** POST /exam/api/questions/bulk 请求体解析（op 校验 + 逐操作参数校验）。 */
function parseBulkQuestion(body: unknown): BulkQuestionOp {
  const obj = asObject(body);
  const op = asString(obj.op);
  const questionIds = asNonEmptyStringArray(obj.questionIds);
  switch (op) {
    case 'tag':
      return { op, questionIds, tag: asString(obj.tag), add: asBoolean(obj.add) };
    case 'topics':
      return { op, questionIds, topics: asStringArray(obj.topics) };
    case 'move':
      return { op, questionIds, bankId: asString(obj.bankId) };
    case 'archive':
    case 'restore':
    case 'delete':
    case 'explain-generic':
      return { op, questionIds };
    default:
      throw new ExamServiceError(
        'EXAM_INVALID_BODY',
        'op must be tag|topics|move|archive|restore|delete|explain-generic',
      );
  }
}

/** GET /exam/api/banks/:id/questions 的过滤查询参数解析（t9）。 */
function parseListQuestionsFilter(url: URL): ListQuestionsFilter {
  const filter: ListQuestionsFilter = {};
  const q = url.searchParams.get('q');
  if (q !== null && q.trim().length > 0) filter.q = q.trim();
  const types = url.searchParams
    .getAll('type')
    .flatMap((value) => value.split(',').map((item) => item.trim()).filter(Boolean))
    .filter(isQuestionTypeValue);
  if (types.length === 1) filter.type = types[0];
  else if (types.length > 1) filter.type = types;
  const tags = url.searchParams
    .getAll('tags')
    .flatMap((value) => value.split(',').map((item) => normalizeQueryLabel(item)).filter(Boolean));
  if (tags.length === 1) filter.tags = tags[0];
  else if (tags.length > 1) filter.tags = tags;
  const hasExplanation = url.searchParams.get('hasExplanation');
  if (hasExplanation === 'true') filter.hasExplanation = true;
  else if (hasExplanation === 'false') filter.hasExplanation = false;
  const includeDeleted = url.searchParams.get('includeDeleted');
  if (includeDeleted === 'true') filter.includeDeleted = true;
  const sort = url.searchParams.get('sort');
  if (sort !== null) {
    const [fieldRaw, dirRaw] = sort.split(':');
    const field = fieldRaw === 'updatedAt' ? 'updatedAt' : fieldRaw === 'createdAt' ? 'createdAt' : undefined;
    if (field !== undefined) filter.sort = { field, dir: dirRaw === 'desc' ? 'desc' : 'asc' };
  }
  return filter;
}

const QUESTION_TYPES: readonly ExamQuestionType[] = ['single', 'multiple', 'boolean', 'essay'];
const SCOPE_MODES: readonly PracticeScopeMode[] = ['all', 'undone', 'wrong', 'byType', 'byTag', 'byTopic'];

function isQuestionTypeValue(value: string): value is ExamQuestionType {
  return (QUESTION_TYPES as readonly string[]).includes(value);
}

function isScopeModeValue(value: string): value is PracticeScopeMode {
  return (SCOPE_MODES as readonly string[]).includes(value);
}

/** 未匹配的 /exam/api/* 前缀兜底：返回 JSON 404，不落入 SPA fallback。 */
function handleApiMiss(req: IncomingMessage, res: ServerResponse): void {
  sendError(res, 404, 'EXAM_NOT_FOUND', `no exam route for ${req.method ?? '?'} ${req.url ?? '?'}`);
}

/**
 * 注册全部 exam 路由。返回 disposer 数组；卸载时逐个调用（逆序由
 * ctx.effect 统一管理）。路由冲突（重复 kind+path）会抛错并让插件 FAILED。
 * t5：第 5 参由值改函数（defaultRouteProvider，每个请求现读 DSH 默认模型）；
 * 第 6 参为模型信息注册表缓存（resolveLlmRoute 消费，adapters-updated 时 clear）。
 */
export function registerExamRoutes(
  webServer: WebServer,
  service: ExamService,
  llm: LlmRoute,
  logger: Logger,
  defaultRouteProvider?: () => AgentDefaultRoute | undefined,
  routeCache?: LlmModelInfoCache,
): Array<() => void> {
  const disposers: Array<() => void> = [];
  disposers.push(
    webServer.register({
      kind: 'exact',
      path: `${EXAM_API_PREFIX}/health`,
      handler: (req, res) => handleHealth(req, res, service),
    }),
    webServer.register({
      kind: 'exact',
      path: `${EXAM_API_PREFIX}/banks`,
      handler: (req, res) => handleBanks(req, res, service, logger),
    }),
    webServer.register({
      kind: 'exact',
      path: `${EXAM_API_PREFIX}/llm/test`,
      handler: (req, res) => handleLlmTest(req, res, { service, llm, defaultRouteProvider, routeCache, logger }),
    }),
    // ── Phase 2：exact 路由（SSE 批改/Tutor、AI 导入、学情、计划）────────
    webServer.register({
      kind: 'exact',
      path: `${EXAM_API_PREFIX}/grading/essay`,
      handler: (req, res) => handleGradeEssay(req, res, { service, llm, defaultRouteProvider, routeCache, logger }),
    }),
    // essay 批改结果按 attemptId 查询（练习内回看已答条目；exact 表优先于本 prefix）。
    webServer.register({
      kind: 'prefix',
      path: `${EXAM_API_PREFIX}/grading`,
      handler: (req, res) => handleGradingPrefix(req, res, service, logger),
    }),
    webServer.register({
      kind: 'exact',
      path: `${EXAM_API_PREFIX}/tutor/chat`,
      handler: (req, res) => handleTutorChat(req, res, { service, llm, defaultRouteProvider, routeCache, logger }),
    }),
    webServer.register({
      kind: 'exact',
      path: `${EXAM_API_PREFIX}/tutor/sessions`,
      handler: (req, res) => handleTutorSessions(req, res, { service, logger }),
    }),
    // ── Phase 4：练习内 AI 解析（POST SSE 生成 / GET JSON 探测；exact 表优先于 practice prefix）──
    webServer.register({
      kind: 'exact',
      path: `${EXAM_API_PREFIX}/practice/explain`,
      handler: (req, res) => handlePracticeExplain(req, res, { service, llm, defaultRouteProvider, routeCache, logger }),
    }),
    // prefix 分派：/tutor/sessions/<id> → GET { session, messages } / DELETE / <id>/close POST（exact 表优先）。
    webServer.register({
      kind: 'prefix',
      path: `${EXAM_API_PREFIX}/tutor/sessions`,
      handler: (req, res) => handleTutorSessionsPrefix(req, res, service, logger),
    }),
    webServer.register({
      kind: 'exact',
      path: `${EXAM_API_PREFIX}/import/generate`,
      handler: (req, res) => handleImportGenerate(req, res, { service, llm, defaultRouteProvider, routeCache, logger }),
    }),
    webServer.register({
      kind: 'exact',
      path: `${EXAM_API_PREFIX}/import/commit`,
      handler: (req, res) => handleImportCommit(req, res, { service, logger }),
    }),
    // t5：导入草稿恢复/丢弃（prefix 分派）。
    webServer.register({
      kind: 'prefix',
      path: `${EXAM_API_PREFIX}/import/drafts`,
      handler: (req, res) => handleImportDraftsPrefix(req, res, service, logger),
    }),
    webServer.register({
      kind: 'exact',
      path: `${EXAM_API_PREFIX}/insights`,
      handler: (req, res) => handleInsights(req, res, { service, logger }),
    }),
    webServer.register({
      kind: 'exact',
      path: `${EXAM_API_PREFIX}/insights/diagnose`,
      handler: (req, res) => handleInsightsDiagnose(req, res, { service, llm, defaultRouteProvider, routeCache, logger }),
    }),
    // t13：诊断历史（持久化记录回看）。
    webServer.register({
      kind: 'exact',
      path: `${EXAM_API_PREFIX}/insights/diagnoses`,
      handler: (req, res) => handleInsightsDiagnoses(req, res, { service, logger }),
    }),
    webServer.register({
      kind: 'exact',
      path: `${EXAM_API_PREFIX}/plans/generate`,
      handler: (req, res) => handlePlansGenerate(req, res, { service, llm, defaultRouteProvider, routeCache, logger }),
    }),
    webServer.register({
      kind: 'exact',
      path: `${EXAM_API_PREFIX}/plans`,
      handler: (req, res) => handlePlans(req, res, { service, logger }),
    }),
    // ── Phase 1：prefix 分派路由（exact 表优先；最长 prefix 优先）─────────
    webServer.register({
      kind: 'prefix',
      path: `${EXAM_API_PREFIX}/banks`,
      handler: (req, res) => handleBanksPrefix(req, res, { service, llm, defaultRouteProvider, routeCache, logger }),
    }),
    webServer.register({
      kind: 'prefix',
      path: `${EXAM_API_PREFIX}/questions`,
      handler: (req, res) => handleQuestionsPrefix(req, res, { service, llm, defaultRouteProvider, routeCache, logger }),
    }),
    webServer.register({
      kind: 'prefix',
      path: `${EXAM_API_PREFIX}/practice`,
      handler: (req, res) => handlePracticePrefix(req, res, service, logger),
    }),
    webServer.register({
      kind: 'prefix',
      path: `${EXAM_API_PREFIX}/quiz`,
      handler: (req, res) => handleQuizPrefix(req, res, service, logger),
    }),
    webServer.register({
      kind: 'prefix',
      path: `${EXAM_API_PREFIX}/wrong`,
      handler: (req, res) => handleWrongPrefix(req, res, service, logger),
    }),
    webServer.register({
      kind: 'prefix',
      path: `${EXAM_API_PREFIX}/plans`,
      handler: (req, res) => handlePlansPrefix(req, res, service, logger),
    }),
    // prefix 兜底：exact 表优先，未来 /exam/api/* 子资源可安全注册 exact 路由。
    webServer.register({
      kind: 'prefix',
      path: EXAM_API_PREFIX,
      handler: handleApiMiss,
    }),
  );
  logger.info('exam routes registered under %s', EXAM_API_PREFIX);
  return disposers;
}

// ---------------------------------------------------------------------------
// 插件本体
// ---------------------------------------------------------------------------

/**
 * 考试助手 Host 插件：以 `ctx.exam` 提供最小 ExamService，同时承载
 * /exam/api/* 路由、settings `exam` 命名空间与 ExamStore/ExamLlm 生命周期。
 */
export class ExamPlugin extends Service implements ExamService {
  static inject = ['webServer', 'settings', 'llm'];
  static Config = examConfigSchema;

  private readonly logger: Logger;
  /** 异步初始化（[Service.init]）完成后赋值；插件激活前不可调用。 */
  private impl!: ExamService;
  private readonly dataDir: string;

  constructor(ctx: Context, config: ExamConfig) {
    super(ctx, 'exam');
    this.logger = ctx.logger('exam');

    // settings 命名空间注册随 fiber 卸载自动移除（DSH settings 契约）。
    const settingsScope = ctx.settings.register(EXAM_SETTINGS_NS, examSettingsSchema, {
      applies: 'restart',
    });

    this.dataDir = resolveDataDir(config.dataDir ?? '', settingsScope.get().dataDir);
  }

  /**
   * Cordis 类插件异步初始化钩子：构造后执行，runner 会 await 返回的 Promise。
   * ExamStore 是 async 工厂（node:sqlite 延迟加载 + ExperimentalWarning 过滤），
   * 待 store 就绪后再创建服务与注册路由。
   *
   * 降级语义（t7）：store 打开失败**不**使插件行 FAILED——记录 warn 后以
   * "无 store" 的降级服务继续激活：health 返回 503 + 可读 error，bank 读写
   * 返回 503 EXAM_STORE_UNAVAILABLE，llm 测试链路不受影响；Fiber 卸载时
   * store 未打开则为空操作（close 幂等）。
   */
  [Service.init]() {
    const ctx = this.ctx;
    return (async () => {
      let store: ExamStore | undefined;
      try {
        store = await openExamStore(this.dataDir);
        this.logger.info('exam store opened at %s', store.path);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.logger.warn('exam store open failed; serving degraded health: %s', message);
      }

      const llm = createExamLlm(ctx.llm);
      this.impl = createExamService({ store, llm });

      // DSH 默认模型（agent-default-model 组合 + settings 用户层；为可选服务，
      // 未挂载时回退 resolveLlmRoute 的「第一个 provider」逻辑）。
      // ctx.get 的键受服务名联合约束，agentDefaultModel 未在本包声明 —— 结构化读取。
      const agentDefault = (ctx as unknown as { get(name: string): unknown }).get('agentDefaultModel');
      // t5 P5：默认模型**每个请求**现读（currentSelection 每次调用）——改 DSH 默认
      // 模型即时生效，无需重启；异常视为 undefined（回退第一个 provider）。
      const defaultRouteProvider = (): AgentDefaultRoute | undefined => {
        try {
          if (agentDefault !== undefined && typeof agentDefault === 'object') {
            const selection = (agentDefault as { currentSelection?(): AgentDefaultRoute }).currentSelection?.();
            return selection;
          }
        } catch {
          // 解析失败：视为无默认模型（回退第一个 provider）。
        }
        return undefined;
      };
      // t5 P6：模型信息注册表缓存（resolveLlmRoute 消费 modelInfo）；适配器更新时清空。
      const routeCache = createLlmRouteCache();
      ctx.effect(() => {
        const dispose = ctx.on('llm/adapters-updated', () => routeCache.clear());
        return () => {
          dispose?.();
        };
      });

      // 所有副作用挂到 fiber：卸载时逆序执行（路由注销 → store 关闭）。
      ctx.effect(() => {
        const disposers = registerExamRoutes(
          ctx.webServer,
          this.impl,
          ctx.llm,
          this.logger,
          defaultRouteProvider,
          routeCache,
        );
        return () => {
          for (const dispose of disposers.reverse()) {
            dispose();
          }
          store?.close();
          this.logger.info('exam store closed');
        };
      });
    })();
  }

  // ── ExamService 委托（纯 DTO，不暴露 live 对象）────────────────────────

  health() {
    return this.impl.health();
  }

  listBanks(options?: { includeArchived?: boolean; includeDeleted?: boolean }) {
    return this.impl.listBanks(options);
  }

  createBank(input: CreateBankInput) {
    return this.impl.createBank(input);
  }

  // ── t9：题库生命周期 ──────────────────────────────────────────────────

  renameBank(id: string, name: string) {
    return this.impl.renameBank(id, name);
  }

  archiveBank(id: string) {
    return this.impl.archiveBank(id);
  }

  restoreBank(id: string) {
    return this.impl.restoreBank(id);
  }

  deleteBank(id: string) {
    return this.impl.deleteBank(id);
  }

  // ── Phase 1 委托 ────────────────────────────────────────────────────────

  createQuestion(bankId: string, input: CreateQuestionRequest) {
    return this.impl.createQuestion(bankId, input);
  }

  updateQuestion(id: string, patch: UpdateQuestionRequest) {
    return this.impl.updateQuestion(id, patch);
  }

  deleteQuestion(id: string) {
    return this.impl.deleteQuestion(id);
  }

  restoreQuestion(id: string) {
    return this.impl.restoreQuestion(id);
  }

  getQuestion(id: string) {
    return this.impl.getQuestion(id);
  }

  listQuestionsByBank(bankId: string, filter?: ListQuestionsFilter) {
    return this.impl.listQuestionsByBank(bankId, filter);
  }

  bulkQuestions(input: BulkQuestionOp, opts?: { provider?: string; model?: string; reasoningEffort?: string; signal?: AbortSignal }) {
    return this.impl.bulkQuestions(input, opts);
  }

  resolveQuestionIds(bankId: string, scope: PracticeScopeDto, shuffle?: boolean, seed?: string) {
    return this.impl.resolveQuestionIds(bankId, scope, shuffle, seed);
  }

  startPractice(input: { bankId: string; scope: PracticeScopeDto; shuffle?: boolean; seed?: string; currentIndex?: number }) {
    return this.impl.startPractice(input);
  }

  resumePractice(id: string) {
    return this.impl.resumePractice(id);
  }

  updatePracticeIndex(id: string, currentIndex: number) {
    return this.impl.updatePracticeIndex(id, currentIndex);
  }

  deletePractice(id: string) {
    return this.impl.deletePractice(id);
  }

  gradeAnswer(input: { practiceId: string; questionId: string; answer: unknown }) {
    return this.impl.gradeAnswer(input);
  }

  buildScorecard(id: string) {
    return this.impl.buildScorecard(id);
  }

  finishPractice(id: string) {
    return this.impl.finishPractice(id);
  }

  listWrong(options: { bankId?: string; includeMastered?: boolean }) {
    return this.impl.listWrong(options);
  }

  setMastered(questionId: string, mastered: boolean) {
    return this.impl.setMastered(questionId, mastered);
  }

  // ── Phase 2 委托 ────────────────────────────────────────────────────────

  gradeEssay(input: Parameters<ExamService['gradeEssay']>[0], onDelta?: (delta: string) => void) {
    return this.impl.gradeEssay(input, onDelta);
  }

  getEssayGrading(attemptId: string) {
    return this.impl.getEssayGrading(attemptId);
  }

  getTutorSession(id: string) {
    return this.impl.getTutorSession(id);
  }

  listTutorSessions(limit?: number) {
    return this.impl.listTutorSessions(limit);
  }

  listTutorMessages(sessionId: string) {
    return this.impl.listTutorMessages(sessionId);
  }

  closeTutorSession(id: string) {
    return this.impl.closeTutorSession(id);
  }

  deleteTutorSession(id: string) {
    return this.impl.deleteTutorSession(id);
  }

  chatTutor(input: Parameters<ExamService['chatTutor']>[0], onDelta?: (delta: string) => void) {
    return this.impl.chatTutor(input, onDelta);
  }

  listImportedQuestions(input: Parameters<ExamService['listImportedQuestions']>[0]) {
    return this.impl.listImportedQuestions(input);
  }

  importQuestions(bankId: string, input: Parameters<ExamService['importQuestions']>[1]) {
    return this.impl.importQuestions(bankId, input);
  }

  getImportDraft(id: string) {
    return this.impl.getImportDraft(id);
  }

  discardImportDraft(id: string) {
    return this.impl.discardImportDraft(id);
  }

  listInsight(input?: Parameters<ExamService['listInsight']>[0]) {
    return this.impl.listInsight(input);
  }

  diagnoseInsight(input: Parameters<ExamService['diagnoseInsight']>[0]) {
    return this.impl.diagnoseInsight(input);
  }

  listDiagnoses(limit?: number) {
    return this.impl.listDiagnoses(limit);
  }

  generatePlan(input: Parameters<ExamService['generatePlan']>[0]) {
    return this.impl.generatePlan(input);
  }

  listPlans(limit?: number) {
    return this.impl.listPlans(limit);
  }

  getPlan(id: string) {
    return this.impl.getPlan(id);
  }

  addPlanItems(planId: string, items: Array<string | PlanItemInput>) {
    return this.impl.addPlanItems(planId, items);
  }

  setPlanItemDone(planId: string, itemId: string, done: boolean) {
    return this.impl.setPlanItemDone(planId, itemId, done);
  }

  deletePlan(id: string) {
    return this.impl.deletePlan(id);
  }

  deletePlanItem(planId: string, itemId: string) {
    return this.impl.deletePlanItem(planId, itemId);
  }

  createManualPlan(input: CreateManualPlanRequest) {
    return this.impl.createManualPlan(input);
  }

  listPracticeHistory(limit?: number) {
    return this.impl.listPracticeHistory(limit);
  }

  testLlmStream(input: Parameters<ExamService['testLlmStream']>[0], onDelta?: (delta: string) => void) {
    return this.impl.testLlmStream(input, onDelta);
  }

  // ── Phase 4 委托 ────────────────────────────────────────────────────────

  explainQuestion(input: Parameters<ExamService['explainQuestion']>[0], onDelta?: (delta: string) => void) {
    return this.impl.explainQuestion(input, onDelta);
  }

  getPracticeExplanation(input: Parameters<ExamService['getPracticeExplanation']>[0]) {
    return this.impl.getPracticeExplanation(input);
  }

  explainGenericQuestion(input: Parameters<ExamService['explainGenericQuestion']>[0]) {
    return this.impl.explainGenericQuestion(input);
  }

  // ── t1 知识标注剩余（P2/P3）委托 ──────────────────────────────────────────

  explainTopicSuggestions(input: Parameters<ExamService['explainTopicSuggestions']>[0]) {
    return this.impl.explainTopicSuggestions(input);
  }

  applyTopics(items: Parameters<ExamService['applyTopics']>[0]) {
    return this.impl.applyTopics(items);
  }

  close() {
    this.impl.close();
  }
}

export default ExamPlugin;
