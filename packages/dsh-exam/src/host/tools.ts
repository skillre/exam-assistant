/**
 * dsh-exam tools entry（exam-coach preset 的 scoped Tools 注册面）。
 *
 * 本模块是 `@skillre/dsh-exam/tools` 独立入口：在 preset 的 AGENT-PLANE ctx 上
 * 调用 `ctx.tools.register(...)` 注册 10 个 exam_* 工具 + 一条 systemPrompt
 * 引导节，因此**仅 exam-coach 会话可见**（scoped registration shadows
 * globals；preset 外会话零影响）。工具只读写 exam 域数据（ExamService），
 * 不触 shell/fs。
 *
 * 实现约定（对齐 DSH 0.1.0-rc.7 dsh-tools 源码）：
 * - 不 import `@deepseek-ai/dsh-tools`（registry 版本与本机配套树错配）：
 *   这里用最小结构类型直调 `ctx.tools.register(definition)`，definition 为
 *   原始 ToolDefinition（name/description/parameters 原始 JSON Schema +
 *   output{schema, render} + execute）。
 * - output.schema 只使用受支持 JSON Schema 子集（type/properties/required/
 *   additionalProperties/items/enum/const/description；禁 pattern/format/
 *   数值边界）。execute 返回 canonical JSON；ExamServiceError 一律转为
 *   `{ ok:false, code, message }` 包络返回，不抛（错误形态不写 required，
 *   保证 output.schema 校验通过）。
 * - LLM 相关工具（导入/Tutor/诊断/批改）在 execute 内用 ctx.get('llm') 走
 *   index.ts 的 resolveLlmRoute 解析 provider/model 缺省，与 HTTP 层语义一致。
 */
import type { Context } from '@deepseek-ai/cordis';
import { createHash, randomUUID } from 'node:crypto';
import { ExamServiceError } from './errors.ts';
import { normalizeQueryLabel } from './store.ts';
import type { ExamService } from './service.ts';
import type { ExamQuestionType, PracticeScopeDto, PracticeScopeMode } from './contract.ts';
import {
  resolveLlmRoute,
  type AgentDefaultRoute,
  type LlmModelInfoCache,
  type LlmRoute,
  type ResolvedLlmRoute,
} from './index.ts';

// ---------------------------------------------------------------------------
// 结构类型（dsh-tools 的 ToolDefinition 最小面，避免 import 错配树）
// ---------------------------------------------------------------------------

/** 工具渲染产物（ContentBlock 的 text 形态）。 */
interface ExamContentBlock {
  type: 'text';
  text: string;
}

/** 原始 ToolDefinition 的最小结构类型（与 dsh-tools ToolDefinition 兼容）。 */
export interface ExamToolDefinition {
  name: string;
  description: string;
  /** 原始对象根 JSON Schema（type/properties/required/enum/description）。 */
  parameters: Record<string, unknown>;
  output: {
    /** 受支持子集的原始 JSON Schema（校验 execute 返回的 canonical JSON）。 */
    schema: Record<string, unknown>;
    render(args: unknown, value: unknown): ExamContentBlock[];
  };
  execute(args: unknown, exec: { signal: AbortSignal }): Promise<Record<string, unknown>>;
  isConcurrencySafe?(args: unknown): boolean;
}

/** tools / systemPrompt / exam / llm 服务的最小运行面（cordis ctx 的子集）。 */
export interface ExamToolsRuntime {
  get(name: string): unknown;
  tools: { register(definition: ExamToolDefinition): () => void };
  systemPrompt: { section(section: { name: string; order: number; text: string }): () => void };
  /**
   * t5：每请求现读的 DSH 默认模型（可选项）。缺省时回退到
   * `get('agentDefaultModel')` 的 currentSelection()（与 index.ts 插件同款语义）。
   * 测试直接注入确定值。
   */
  defaultRouteProvider?: () => AgentDefaultRoute | undefined;
  /** t5：事件注册面（可选；存在时用于 llm/adapters-updated → 模型信息缓存清空）。 */
  on?: (event: string, handler: () => void) => () => void;
  /** t5：模型信息注册表缓存（可选；缺省 = 直接调用 llm.resolveModelInfo，不做跨请求缓存）。 */
  routeCache?: LlmModelInfoCache;
}

// ---------------------------------------------------------------------------
// 常量与共享 schema 片段
// ---------------------------------------------------------------------------

const QUESTION_TYPE_VALUES: readonly ExamQuestionType[] = ['single', 'multiple', 'boolean', 'essay'];
const SCOPE_MODE_VALUES: readonly PracticeScopeMode[] = ['all', 'undone', 'wrong', 'byType', 'byTag', 'byTopic'];

/** 无参数工具的 parameters schema。 */
const NO_PARAMS: Record<string, unknown> = { type: 'object', properties: {} };

/** 错误形态字段（ok=false 时存在；不写 required 以兼容成功形态）。 */
const ERROR_PROPS: Record<string, unknown> = {
  code: { type: 'string', description: '稳定错误码（ok=false 时存在）' },
  message: { type: 'string', description: '人类可读错误信息（ok=false 时存在）' },
};

const OPTIONAL_LLM_PROPS: Record<string, unknown> = {
  provider: { type: 'string', description: '可选：LLM provider（缺省自动选择第一个可用 provider）' },
  model: { type: 'string', description: '可选：LLM 模型（缺省自动选择该 provider 第一个模型）' },
};

/** 组装工具 output.schema（对象根 + ok + 错误字段 + 工具专属字段）。 */
function outputSchema(extra: Record<string, unknown>): Record<string, unknown> {
  return {
    type: 'object',
    properties: { ok: { type: 'boolean', description: '是否成功' }, ...ERROR_PROPS, ...extra },
  };
}

/** 无可用 llm 时的占位路由（resolveLlmRoute 会抛 EXAM_LLM_NO_PROVIDER）。 */
const EMPTY_LLM_ROUTE: LlmRoute = {
  listProviders: () => [],
  listModels: async () => [],
  // t5：resolveModelInfo stub（缺省降级为无 modelInfo，不阻断调用链——设计 §16 §3.5）。
  resolveModelInfo: async (provider, model) => ({ provider, id: model, name: model }),
};

// ---------------------------------------------------------------------------
// 参数解析（模型参数不可信：raw register 不做 schema 校验，此处防御）
// ---------------------------------------------------------------------------

function asRecord(args: unknown): Record<string, unknown> {
  if (typeof args !== 'object' || args === null || Array.isArray(args)) {
    throw new ExamServiceError('EXAM_INVALID_BODY', 'tool arguments must be a JSON object');
  }
  return args as Record<string, unknown>;
}

function reqString(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  if (typeof value !== 'string' || value.length === 0) {
    throw new ExamServiceError('EXAM_INVALID_BODY', `${key} must be a non-empty string`);
  }
  return value;
}

function optString(args: Record<string, unknown>, key: string): string | undefined {
  const value = args[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'string') {
    throw new ExamServiceError('EXAM_INVALID_BODY', `${key} must be a string`);
  }
  return value;
}

function optBool(args: Record<string, unknown>, key: string): boolean | undefined {
  const value = args[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'boolean') {
    throw new ExamServiceError('EXAM_INVALID_BODY', `${key} must be a boolean`);
  }
  return value;
}

function optNumber(args: Record<string, unknown>, key: string): number | undefined {
  const value = args[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new ExamServiceError('EXAM_INVALID_BODY', `${key} must be a finite number`);
  }
  return value;
}

function optStringArray(args: Record<string, unknown>, key: string): string[] | undefined {
  const value = args[key];
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || !value.every((item) => typeof item === 'string')) {
    throw new ExamServiceError('EXAM_INVALID_BODY', `${key} must be a string array`);
  }
  return value;
}

function reqEnum<T extends string>(
  args: Record<string, unknown>,
  key: string,
  values: readonly T[],
  label: string,
): T {
  const value = reqString(args, key);
  if (!(values as readonly string[]).includes(value)) {
    throw new ExamServiceError('EXAM_INVALID_BODY', `${key} must be one of: ${label}`);
  }
  return value as T;
}

function optEnum<T extends string>(
  args: Record<string, unknown>,
  key: string,
  values: readonly T[],
  label: string,
): T | undefined {
  const value = optString(args, key);
  if (value !== undefined && !(values as readonly string[]).includes(value)) {
    throw new ExamServiceError('EXAM_INVALID_BODY', `${key} must be one of: ${label}`);
  }
  return value as T | undefined;
}

/** scope 参数（startPractice）：{ mode, type?, tag?, topic? }。 */
function parseScopeArg(value: unknown): PracticeScopeDto {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new ExamServiceError('EXAM_INVALID_BODY', 'scope must be an object');
  }
  const obj = value as Record<string, unknown>;
  const mode = optEnum(obj, 'mode', SCOPE_MODE_VALUES, 'all|undone|wrong|byType|byTag|byTopic');
  if (mode === undefined) {
    throw new ExamServiceError('EXAM_INVALID_BODY', 'scope.mode is required');
  }
  const scope: PracticeScopeDto = { mode };
  const type = optEnum(obj, 'type', QUESTION_TYPE_VALUES, 'single|multiple|boolean|essay');
  if (type !== undefined) scope.type = type;
  const tag = optString(obj, 'tag');
  if (tag !== undefined) scope.tag = tag;
  // t1：byTopic 筛选值（topics 包含匹配）；与原 tag 语义一致地规范化。
  const topic = optString(obj, 'topic');
  if (topic !== undefined) scope.topic = topic;
  return scope;
}

// ---------------------------------------------------------------------------
// 执行骨架
// ---------------------------------------------------------------------------

/** 取 ExamService；未挂载 → EXAM_STORE_UNAVAILABLE 包络。 */
function requireExam(runtime: ExamToolsRuntime): ExamService {
  const exam = runtime.get('exam');
  if (exam === undefined) {
    throw new ExamServiceError('EXAM_STORE_UNAVAILABLE', 'exam service is not mounted');
  }
  return exam as ExamService;
}

/**
 * 解析 provider/model 缺省（与 HTTP 路由层同语义——设计 §16 §3.5）：
 * - defaultRouteProvider **每个请求**现读（改 DSH 默认模型即时生效；异常视为 undefined）；
 * - modelInfo 经可选 runtime.routeCache 注册表缓存（llm/adapters-updated 时 clear）；
 *   无缓存或解析失败均降级为无 modelInfo，不阻断调用链。
 * 返回完整 ResolvedLlmRoute（含 reasoningEffort 与 modelInfo，调用方按需消费）。
 */
async function resolveLlm(
  runtime: ExamToolsRuntime,
  provider: string | undefined,
  model: string | undefined,
): Promise<ResolvedLlmRoute> {
  const llm = (runtime.get('llm') as LlmRoute | undefined) ?? EMPTY_LLM_ROUTE;
  return resolveLlmRoute(
    llm,
    provider,
    model,
    runtime.defaultRouteProvider ?? readAgentDefaultRoute(runtime),
    runtime.routeCache,
  );
}

/** 从 runtime.get('agentDefaultModel') 解析每请求 DSH 默认模型（与 index.ts 插件同款）。 */
function readAgentDefaultRoute(runtime: ExamToolsRuntime): () => AgentDefaultRoute | undefined {
  return () => {
    try {
      const agentDefault = runtime.get('agentDefaultModel');
      if (agentDefault !== undefined && typeof agentDefault === 'object') {
        const selection = (agentDefault as { currentSelection?(): AgentDefaultRoute }).currentSelection?.();
        return selection;
      }
    } catch {
      // 解析失败：视为无默认模型（回退第一个 provider）。
    }
    return undefined;
  };
}

/** 统一包络：成功透传；ExamServiceError → { ok:false, code, message }，不抛。 */
async function runTool(
  fn: () => Promise<unknown> | unknown,
): Promise<Record<string, unknown>> {
  try {
    const value = await fn();
    if (typeof value !== 'object' || value === null) {
      return { ok: true, result: value };
    }
    return value as Record<string, unknown>;
  } catch (error) {
    if (error instanceof ExamServiceError) {
      return { ok: false, code: error.code, message: error.message };
    }
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, code: 'EXAM_INTERNAL', message };
  }
}

/** 工具定义装配器：统一 output.render（可读文本摘要）。 */
function defineExamTool(
  runtime: ExamToolsRuntime,
  options: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
    outputSchema: Record<string, unknown>;
    execute(runtime: ExamToolsRuntime, args: Record<string, unknown>, signal: AbortSignal): Promise<unknown> | unknown;
    concurrencySafe?: boolean;
  },
): ExamToolDefinition {
  return {
    name: options.name,
    description: options.description,
    parameters: options.parameters,
    output: {
      schema: options.outputSchema,
      render: (_args, value) => [{ type: 'text', text: formatExamResult(value) }],
    },
    // t5：exec.signal 透传（P10）——LLM 工具在调用方中止时随之中止底层调用，不浪费 token。
    execute: (args, exec) => runTool(() => options.execute(runtime, asRecord(args), exec.signal)),
    ...(options.concurrencySafe === true ? { isConcurrencySafe: () => true } : {}),
  };
}

// ---------------------------------------------------------------------------
// 10 个工具定义
// ---------------------------------------------------------------------------

function buildExamToolDefinitions(runtime: ExamToolsRuntime): ExamToolDefinition[] {
  return [
    defineExamTool(runtime, {
      name: 'exam_list_banks',
      description: '列出全部题库（id/name/createdAt）。',
      parameters: NO_PARAMS,
      outputSchema: outputSchema({
        banks: { type: 'array', items: { type: 'object' }, description: '题库列表' },
      }),
      concurrencySafe: true,
      execute: (ctx) => {
        const exam = requireExam(ctx);
        return { ok: true, banks: exam.listBanks() };
      },
    }),
    defineExamTool(runtime, {
      name: 'exam_get_questions',
      description: '按题库列出题目（可选 type/tag/topic 过滤）；每题含题干/选项/答案/解析/标签/知识点。',
      parameters: {
        type: 'object',
        properties: {
          bankId: { type: 'string', description: '题库 ID（exam_list_banks 获取）' },
          type: { type: 'string', enum: QUESTION_TYPE_VALUES, description: '可选：按题型过滤' },
          tag: { type: 'string', description: '可选：按标签过滤（tags 包含匹配）' },
          topic: { type: 'string', description: '可选：按知识点过滤（topics 包含匹配）' },
        },
        required: ['bankId'],
      },
      outputSchema: outputSchema({
        bankId: { type: 'string' },
        count: { type: 'integer', description: '返回题目数' },
        questions: { type: 'array', items: { type: 'object' }, description: '题目列表' },
      }),
      concurrencySafe: true,
      execute: (ctx, args) => {
        const exam = requireExam(ctx);
        const bankId = reqString(args, 'bankId');
        const type = optEnum(args, 'type', QUESTION_TYPE_VALUES, 'single|multiple|boolean|essay');
        const rawTag = optString(args, 'tag');
        const tag = rawTag === undefined ? undefined : normalizeQueryLabel(rawTag);
        const rawTopic = optString(args, 'topic');
        const topic = rawTopic === undefined ? undefined : normalizeQueryLabel(rawTopic);
        const questions = exam
          .listQuestionsByBank(bankId)
          .filter(
            (q) =>
              (type === undefined || q.type === type) &&
              (tag === undefined || (q.tags ?? []).includes(tag)) &&
              (topic === undefined || (q.topics ?? []).includes(topic)),
          )
          .map((q) => ({
            id: q.id,
            type: q.type,
            stem: q.stem,
            options: q.options,
            answer: q.answer,
            explanation: q.explanation,
            tags: q.tags,
            topics: q.topics,
          }));
        return { ok: true, bankId, count: questions.length, questions };
      },
    }),
    defineExamTool(runtime, {
      name: 'exam_create_bank',
      description: '新建题库；name 去首尾空白后须非空。',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: '题库名称' },
        },
        required: ['name'],
      },
      outputSchema: outputSchema({
        bank: { type: 'object', description: '新建题库（id/name/createdAt）' },
      }),
      execute: (ctx, args) => {
        const exam = requireExam(ctx);
        const name = reqString(args, 'name');
        const bank = exam.createBank({ name });
        return { ok: true, bank: { id: bank.id, name: bank.name, createdAt: bank.createdAt } };
      },
    }),
    defineExamTool(runtime, {
      name: 'exam_create_question',
      description: '向题库录入一道题目（支持 single/multiple/boolean/essay）。',
      parameters: {
        type: 'object',
        properties: {
          bankId: { type: 'string', description: '目标题库 ID' },
          type: { type: 'string', enum: QUESTION_TYPE_VALUES, description: '题型' },
          stem: { type: 'string', description: '题干' },
          options: {
            type: 'array',
            items: { type: 'string' },
            description: '选项列表（boolean/essay 传空数组）',
          },
          answer: {
            description: '答案：single=选项标识字符串；multiple=字符串数组；boolean="true"/"false"；essay=null',
          },
          explanation: { type: 'string', description: '可选：解析' },
          tags: { type: 'array', items: { type: 'string' }, description: '可选：标签' },
        },
        required: ['bankId', 'type', 'stem', 'answer'],
      },
      outputSchema: outputSchema({
        question: { type: 'object', description: '新建题目（id/type/stem/answer/tags）' },
      }),
      execute: (ctx, args) => {
        const exam = requireExam(ctx);
        const bankId = reqString(args, 'bankId');
        const type = reqEnum(args, 'type', QUESTION_TYPE_VALUES, 'single|multiple|boolean|essay');
        const stem = reqString(args, 'stem');
        const options = optStringArray(args, 'options') ?? [];
        if (args.answer === undefined) {
          throw new ExamServiceError('EXAM_INVALID_BODY', 'answer is required');
        }
        const explanation =
          args.explanation === undefined ? undefined : args.explanation === null ? null : optString(args, 'explanation');
        const tags = args.tags === undefined ? undefined : args.tags === null ? null : optStringArray(args, 'tags');
        const question = exam.createQuestion(bankId, { type, stem, options, answer: args.answer, explanation, tags });
        return {
          ok: true,
          question: {
            id: question.id,
            type: question.type,
            stem: question.stem,
            answer: question.answer,
            tags: question.tags,
          },
        };
      },
    }),
    defineExamTool(runtime, {
      name: 'exam_import_from_text',
      description: '把资料纯文本交给 LLM 生成客观题草稿；commit=true（默认）直接入库到 bankId。',
      parameters: {
        type: 'object',
        properties: {
          text: { type: 'string', description: '资料纯文本（至少 50 字符）' },
          bankId: { type: 'string', description: '目标题库 ID（commit=true 时必填）' },
          commit: { type: 'boolean', description: 'true=生成草稿并直接入库（默认）；false=仅生成草稿预览' },
          ...OPTIONAL_LLM_PROPS,
        },
        required: ['text'],
      },
      outputSchema: outputSchema({
        commit: { type: 'boolean', description: '是否已入库' },
        drafts: { type: 'array', items: { type: 'object' }, description: 'commit=false 时：生成的题目草稿' },
        imported: { type: 'object', description: 'commit=true 时：入库结果 { count, questions }' },
      }),
      execute: async (ctx, args) => {
        const exam = requireExam(ctx);
        const text = reqString(args, 'text');
        const commit = args.commit === undefined ? true : optBool(args, 'commit') === true;
        const { provider, model } = await resolveLlm(ctx, optString(args, 'provider'), optString(args, 'model'));
        const drafts = await exam.listImportedQuestions({ text, provider, model });
        if (!commit) {
          return { ok: true, commit: false, drafts };
        }
        const bankId = reqString(args, 'bankId');
        const imported = exam.importQuestions(bankId, drafts);
        return {
          ok: true,
          commit: true,
          imported: {
            count: imported.count,
            questions: imported.questions.map((q) => ({
              id: q.id,
              type: q.type,
              stem: q.stem,
              answer: q.answer,
              tags: q.tags,
            })),
          },
        };
      },
    }),
    defineExamTool(runtime, {
      name: 'exam_tutor_ask',
      description: '向 AI 学习 Tutor 提问（可绑定题目/题库；返回完整回复文本）。',
      parameters: {
        type: 'object',
        properties: {
          sessionId: { type: 'string', description: '可选：续用会话 ID（缺省新建会话）' },
          questionId: { type: 'string', description: '可选：绑定题目（附带题目上下文与最近作答）' },
          bankId: { type: 'string', description: '可选：绑定题库（无 questionId 时）' },
          message: { type: 'string', description: '向 Tutor 提问的内容' },
          ...OPTIONAL_LLM_PROPS,
        },
        required: ['message'],
      },
      outputSchema: outputSchema({
        sessionId: { type: 'string', description: '会话 ID' },
        messageId: { type: 'string', description: '助手消息 ID' },
        reply: { type: 'string', description: 'Tutor 完整回复' },
        model: { type: 'string', description: '实际使用的模型（可省略）' },
      }),
      execute: async (ctx, args) => {
        const exam = requireExam(ctx);
        const message = reqString(args, 'message');
        const { provider, model } = await resolveLlm(ctx, optString(args, 'provider'), optString(args, 'model'));
        const result = await exam.chatTutor({
          sessionId: optString(args, 'sessionId'),
          questionId: optString(args, 'questionId'),
          bankId: optString(args, 'bankId'),
          message,
          provider,
          model,
        });
        return {
          ok: true,
          sessionId: result.sessionId,
          messageId: result.messageId,
          reply: result.reply,
          ...(result.model !== undefined ? { model: result.model } : {}),
        };
      },
    }),
    defineExamTool(runtime, {
      name: 'exam_start_practice',
      description: '开始一次练习（范围 all/undone/wrong/byType/byTag/byTopic，可选乱序），返回练习会话。',
      parameters: {
        type: 'object',
        properties: {
          bankId: { type: 'string', description: '题库 ID' },
          scope: {
            type: 'object',
            properties: {
              mode: { type: 'string', enum: SCOPE_MODE_VALUES, description: '范围模式' },
              type: { type: 'string', enum: QUESTION_TYPE_VALUES, description: 'byType 筛选值' },
              tag: { type: 'string', description: 'byTag 筛选值' },
              topic: { type: 'string', description: 'byTopic 筛选值（topics 包含匹配）' },
            },
            required: ['mode'],
          },
          shuffle: { type: 'boolean', description: '可选：乱序出题' },
          seed: { type: 'string', description: '可选：固定随机种子（确定性乱序）' },
        },
        required: ['bankId', 'scope'],
      },
      outputSchema: outputSchema({
        practice: { type: 'object', description: '练习会话（id/questionIds/currentIndex/status）' },
      }),
      execute: (ctx, args) => {
        const exam = requireExam(ctx);
        const bankId = reqString(args, 'bankId');
        const scope = parseScopeArg(args.scope);
        const shuffle = args.shuffle === undefined ? undefined : optBool(args, 'shuffle');
        const seed = optString(args, 'seed');
        const practice = exam.startPractice({ bankId, scope, shuffle, seed });
        return { ok: true, practice };
      },
    }),
    defineExamTool(runtime, {
      name: 'exam_get_insight',
      description:
        '学情洞察：统计摘要（总答题/正确率/趋势/题型准确率/错题 Top10/薄弱点）；diagnose=true 附带 LLM 诊断（建议含可执行 action）。',
      parameters: {
        type: 'object',
        properties: {
          diagnose: { type: 'boolean', description: 'true=附带 LLM 诊断（summary/weaknesses/suggestions）' },
          window: { type: 'number', description: '趋势窗口天数：7（默认）/14/30' },
          bankId: { type: 'string', description: '可选：按题库过滤统计' },
          ...OPTIONAL_LLM_PROPS,
        },
      },
      outputSchema: outputSchema({
        insight: { type: 'object', description: '学情统计摘要' },
        diagnosis: { type: 'object', description: 'diagnose=true 时的 LLM 诊断（含 id；建议为 {text, action?}）' },
      }),
      concurrencySafe: true,
      execute: async (ctx, args) => {
        const exam = requireExam(ctx);
        const diagnose = args.diagnose === undefined ? false : optBool(args, 'diagnose') === true;
        const windowRaw = optNumber(args, 'window');
        const window = windowRaw !== undefined ? Math.round(windowRaw) : undefined;
        const bankId = optString(args, 'bankId');
        const insight = exam.listInsight({
          ...(window !== undefined ? { windowDays: window } : {}),
          ...(bankId !== undefined ? { bankId } : {}),
        });
        if (!diagnose) {
          return { ok: true, insight };
        }
        const { provider, model } = await resolveLlm(ctx, optString(args, 'provider'), optString(args, 'model'));
        const diagnosis = await exam.diagnoseInsight({ provider, model });
        return { ok: true, insight, diagnosis };
      },
    }),
    defineExamTool(runtime, {
      name: 'exam_grade_essay',
      description: 'essay 主观题 AI 批改：给定题目与作答，返回分数/评语/参考答案要点。',
      parameters: {
        type: 'object',
        properties: {
          questionId: { type: 'string', description: 'essay 题目 ID' },
          practiceId: { type: 'string', description: '可选：所属练习会话 ID' },
          userAnswer: { type: 'string', description: '学生作答文本（非空）' },
          ...OPTIONAL_LLM_PROPS,
        },
        required: ['questionId', 'userAnswer'],
      },
      outputSchema: outputSchema({
        attemptId: { type: 'string', description: '作答记录 ID' },
        grading: { type: 'object', description: '批改结果（score/verdict/feedback/reference/isCorrect）' },
      }),
      execute: async (ctx, args) => {
        const exam = requireExam(ctx);
        const questionId = reqString(args, 'questionId');
        const userAnswer = reqString(args, 'userAnswer');
        const { provider, model } = await resolveLlm(ctx, optString(args, 'provider'), optString(args, 'model'));
        const result = await exam.gradeEssay({
          questionId,
          practiceId: optString(args, 'practiceId'),
          userAnswer,
          provider,
          model,
        });
        return { ok: true, attemptId: result.attemptId, grading: result.grading };
      },
    }),
    defineExamTool(runtime, {
      name: 'exam_list_plans',
      description: '列出学习计划（含 AI 生成与手动新建）。',
      parameters: NO_PARAMS,
      outputSchema: outputSchema({
        plans: { type: 'array', items: { type: 'object' }, description: '学习计划列表' },
      }),
      concurrencySafe: true,
      execute: (ctx) => {
        const exam = requireExam(ctx);
        return { ok: true, plans: exam.listPlans().plans };
      },
    }),
  ];
}

// ---------------------------------------------------------------------------
// render：模型可读的文本摘要
// ---------------------------------------------------------------------------

function formatExamResult(value: unknown): string {
  const obj = typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null;
  if (obj === null) return JSON.stringify(value);
  if (obj.ok === false) {
    return `[exam 工具失败] ${String(obj.code ?? 'EXAM_UNKNOWN')}: ${String(obj.message ?? '')}`;
  }
  const parts: string[] = [];
  if (Array.isArray(obj.banks)) {
    parts.push(obj.banks.length === 0 ? '题库：无' : `题库：\n${obj.banks.map((b) => `- ${formatBank(b)}`).join('\n')}`);
  }
  if (Array.isArray(obj.questions)) {
    parts.push(
      obj.questions.length === 0 ? '题目：无' : `题目：\n${obj.questions.map((q) => `- ${formatQuestion(q)}`).join('\n')}`,
    );
  }
  if (Array.isArray(obj.drafts)) {
    parts.push(
      obj.drafts.length === 0 ? '草稿：无' : `草稿：\n${obj.drafts.map((q) => `- ${formatQuestion(q)}`).join('\n')}`,
    );
  }
  if (obj.commit === false) parts.push('未入库（仅生成草稿）');
  if (obj.imported !== undefined) {
    const imported = obj.imported as Record<string, unknown>;
    parts.push(`已入库 ${String(imported.count)} 道`);
  }
  if (obj.bank !== undefined) parts.push(`题库：${formatBank(obj.bank)}`);
  if (obj.question !== undefined) parts.push(`题目：${formatQuestion(obj.question)}`);
  if (obj.practice !== undefined) parts.push(`练习会话：${formatPractice(obj.practice)}`);
  if (typeof obj.reply === 'string') parts.push(`Tutor 回复：${obj.reply}`);
  if (obj.insight !== undefined) parts.push(`学情摘要：${JSON.stringify(obj.insight)}`);
  if (obj.diagnosis !== undefined) parts.push(`诊断：${JSON.stringify(obj.diagnosis)}`);
  if (obj.grading !== undefined) parts.push(`批改结果：${JSON.stringify(obj.grading)}`);
  if (Array.isArray(obj.plans)) {
    parts.push(
      obj.plans.length === 0 ? '学习计划：无' : `学习计划：\n${obj.plans.map((p) => `- ${formatPlan(p)}`).join('\n')}`,
    );
  }
  return parts.length > 0 ? parts.join('\n') : JSON.stringify(value);
}

function formatBank(value: unknown): string {
  const bank = value as Record<string, unknown>;
  return `${String(bank.id)}「${String(bank.name)}」`;
}

function formatQuestion(value: unknown): string {
  const q = value as Record<string, unknown>;
  const options = Array.isArray(q.options) && q.options.length > 0 ? ` 选项: ${q.options.join(' / ')}` : '';
  // 回显形状可能裁剪答案（essay 为 null；裁剪形状缺字段为 undefined）——缺省时不渲染该段。
  const answer =
    q.answer === undefined || q.answer === null ? '' : ` 答案: ${JSON.stringify(q.answer)}`;
  const explanation =
    typeof q.explanation === 'string' && q.explanation.length > 0 ? ` 解析: ${q.explanation}` : '';
  const tags = Array.isArray(q.tags) && q.tags.length > 0 ? ` 标签: ${q.tags.join(',')}` : '';
  return `[${String(q.type)}] ${String(q.stem)}${options}${answer}${explanation}${tags}`;
}

function formatPractice(value: unknown): string {
  const p = value as Record<string, unknown>;
  const total = Array.isArray(p.questionIds) ? p.questionIds.length : 0;
  return `${String(p.id)} 状态=${String(p.status)} 进度=${String(p.currentIndex)}/${String(total)}`;
}

function formatPlan(value: unknown): string {
  const p = value as Record<string, unknown>;
  return `${String(p.id)}「${String(p.title)}」${String(p.status)}`;
}

// ---------------------------------------------------------------------------
// 插件入口（preset agent.cordis.yml 引用 @skillre/dsh-exam/tools 的行）
// ---------------------------------------------------------------------------

/** Cordis 插件名（loader 诊断用）。 */
export const name = 'exam-tools';

/** 硬依赖：tools 注册面 + systemPrompt 引导节（就绪前插件进入 waiting）。 */
export const inject = ['tools', 'systemPrompt'];

/**
 * 在调用方 ctx（preset 的 AGENT-PLANE ctx）上注册全部 exam 工具。
 * 返回 disposer 数组；fiber 卸载时注册面随作用域自动回收（tools.register /
 * systemPrompt.section 本身即为 scoped effect，disposer 供显式管理）。
 */
export function apply(ctx: Context): Array<() => void> {
  return createExamToolsPlugin(ctx as unknown as ExamToolsRuntime);
}

/**
 * 核心注册函数（测试直接注入 fake runtime 使用；apply 转发）。
 * 返回 disposer 数组：逐个调用即撤销 section 与全部工具注册。
 */
export function createExamToolsPlugin(runtime: ExamToolsRuntime): Array<() => void> {
  const disposers: Array<() => void> = [];
  disposers.push(
    runtime.systemPrompt.section({
      name: 'tool:exam-coach',
      order: 100,
      text: '考试助手工具（exam_*）：仅操作考试系统数据域（题库/题目/练习/错题本/学情/学习计划），读操作优先，写操作只作用于 exam 数据，不涉及文件系统与命令执行。',
    }),
  );
  for (const definition of buildExamToolDefinitions(runtime)) {
    disposers.push(runtime.tools.register(definition));
  }
  return disposers;
}
