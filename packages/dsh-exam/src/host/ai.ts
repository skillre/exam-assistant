/**
 * Phase 2 AI 能力层（ai.ts）：essay 批改 / Tutor 上下文 / AI 导入 / 学情诊断 / 学习计划。
 * Phase 4 追加：题目 AI 解析（P 个性化 + G 通用两形态）与解析缓存键归一化。
 *
 * 设计约束（Phase 2 设计 §3）：
 * - 纯函数 + examLlm 注入（createAiEngine 工厂），模块不接触 `ctx`、不持有 live 对象；
 * - 所有 LLM 输出要求"仅一个 JSON"，本模块做提取容错（剥离 ```json 围栏、取首个
 *   {…}/[…]），解析/结构校验失败统一抛 ExamLlmError(EXAM_LLM_STREAM_FAILED)；
 * - gradeEssay 走 streamOnce（onDelta 透传底层 text-delta 供 UI 展示 LLM 原文）；
 *   其余（导入/诊断/计划）走 runOnce 一次性调用；
 * - provider/model 由调用方（service/路由层）解析为具体值后传入，本模块不查注册表。
 *
 * Phase 4 补充约束（设计 §4/§6）：
 * - 解析输出为纯文本（无 Markdown 渲染依赖）：EXPLAIN_SYSTEM（浅档，【】四节）、
 *   EXPLAIN_SYSTEM_DEEP（深档，五节）为 P 个性化形态；G 通用形态用
 *   EXPLAIN_SYSTEM_GENERIC；explainOnce 走流式通道——浅档不设 maxTokens（DSH 按
 *   模型配置材质化），深档由服务层把 maxTokens 解析后显式抬升（见 EXPLAIN 注释）。
 * - P2 知识标注走 parseTopicSuggestions（runOnce 批量判别，容错 + tag 兜底）。
 * - normalizeAnswerNorm 与判分编码对齐（grading.ts / client ui-helpers
 *   identifierToIndex 语义），产出 explanations.answer_norm 缓存键。
 */
import type { ExamLlm } from './llm.ts';
import { ExamLlmError, EXAM_LLM_STREAM_FAILED, userTextMessage } from './llm.ts';
import type { LlmFinishReason, LlmMessage, LlmTokenUsage } from './llm-types.ts';
import { normalizeQueryLabel } from './store.ts';
import type { GradingVerdict, QuestionRow, StoredQuestionType, TutorMessageRow } from './store.ts';
import type {
  DiagnosisDto,
  DiagnosisSuggestionActionDto,
  DiagnosisSuggestionDto,
  ExplainDepth,
  ImportedQuestion,
  InsightSummary,
  PlanDraft,
  PracticeScopeDto,
  TopicSuggestionDto,
} from './contract.ts';

/** gradeEssay 输入（provider/model 已由调用方解析为具体值；signal 可选，透传底层调用）。 */
export interface GradeEssayInput {
  question: QuestionRow;
  /** 学生作答（非空字符串）。 */
  userAnswer: string;
  provider: string;
  model: string;
  /** 调用方取消信号（客户端断开时中止底层调用；中止语义见 llm.ts 的 EXAM_LLM_ABORTED）。 */
  signal?: AbortSignal;
}

/** gradeEssay 结果（reference 缺省省略；model 为实际调用所用模型；t5 附带 usage/finish 供可追溯落库）。 */
export interface GradeEssayResult {
  score: number;
  verdict: GradingVerdict;
  feedback: string;
  reference?: string;
  model: string;
  /** 调用 token 用量（可能 undefined，落库为 NULL）。 */
  usage?: LlmTokenUsage;
  /** 归一化终态（stop/error/aborted/max-tokens）。 */
  finish: LlmFinishReason;
}

/** parseImportedQuestions / generateDiagnosis / generateStudyPlan 的公共路由参数。 */
export interface AiCallOptions {
  provider: string;
  model: string;
  /** 调用方取消信号（透传底层 runOnce；t5 的 JSON 端点断开中止接线用，缺省不取消）。 */
  signal?: AbortSignal;
}

// ---------------------------------------------------------------------------
// Phase 4：题目 AI 解析（P 个性化 / G 通用）
// ---------------------------------------------------------------------------

/** 解析形态：personalized=练习内个性化（含用户作答分析）；generic=题库通用（写回静态字段）。 */
export type ExplainMode = 'personalized' | 'generic';

/**
 * 深档个性化上下文（M4，设计 §3.4 D）：只读现有数据组装，无新端点；仅 deep 档注入。
 * 全部为纯 JSON 可序列化数据，service.ts 组装后传入 ai.ts，由 buildExplainMessages 注入。
 */
export interface ExplainContextDto {
  /** 该题历史答错次数（全量 attempts 按 questionId 聚合；同一题多次答错取累计）。 */
  wrongCountOnQuestion: number;
  /** 该题各知识点 topc 维度的作答正确率聚合（pool 内同 topics 题目）。 */
  topicAccuracy: { topic: string; answered: number; correct: number; accuracy: number }[];
  /** 同知识点且题干关键词重叠≥2 的相似题 stem（≤3 条，轻量规则，无 embedding）。 */
  similarStems: string[];
}

/** buildExplainMessages 的形态参数：P 形态必须注入作答与判分结果，G 形态不传。
 * t1：个人化分支可带 depth（light/deep）与深档 context；generic 保持短篇幅（不升级）。 */
export type BuildExplainOptions =
  | { mode: 'personalized'; userAnswer: unknown; isCorrect: boolean; depth?: ExplainDepth; context?: ExplainContextDto }
  | { mode: 'generic' };

/** explainOnce 输入（provider/model 已由调用方解析为具体值；signal 可选透传底层调用）。 */
export interface ExplainInput {
  question: QuestionRow;
  mode: ExplainMode;
  /** mode='personalized' 必填：学生作答（判分编码原值，如 'A' / ['A','C'] / 'true'）。 */
  userAnswer?: unknown;
  /** mode='personalized' 必填：判分结果。 */
  isCorrect?: boolean;
  provider: string;
  model: string;
  /** 思考深度 id（透传底层 GenerateOptions.reasoningEffort；缺省 = provider 默认）。 */
  reasoningEffort?: string;
  /** 解析深度档（light/deep）；仅影响提示词选档与个性化上下文注入，不改变缓存键（键含 depth）。 */
  depth?: ExplainDepth;
  /** 深档显式输出上限（服务层按 min(模型支持上限, contextWindow/3) 解析后传入）；浅档缺省不设。 */
  maxTokens?: number;
  /** 深档个性化上下文（M4）；仅 deep 档由 buildExplainMessages 注入。 */
  context?: ExplainContextDto;
  /** 调用方取消信号（客户端断开时中止底层调用；取消零落库语义由 service 层保证）。 */
  signal?: AbortSignal;
}

/** explainOnce 结果（model 为实际调用所用模型；t5 附带 usage/finish 供可追溯落库）。 */
export interface ExplainResult {
  content: string;
  model: string;
  /** 调用 token 用量（可能 undefined，落库为 NULL）。 */
  usage?: LlmTokenUsage;
  /** 归一化终态（stop/error/aborted/max-tokens）。 */
  finish: LlmFinishReason;
}

/**
 * P2 知识标注的输入题项（服务层组装，ai.ts 只消费 read-only 字段）：
 * 全部为纯 JSON 数据，不引用 live 对象。
 */
export interface TopicSuggestionSource {
  questionId: string;
  stem: string;
  currentTopics: string[] | null;
  currentTags: string[] | null;
}

/** AI 能力门面。 */
export interface AiEngine {
  /**
   * essay 批改：流式调用一次，每段 text-delta 经 onDelta；输出解析为
   * { score 0..100, verdict, feedback, reference? }；解析/结构失败抛
   * ExamLlmError(EXAM_LLM_STREAM_FAILED)。
   */
  gradeEssay(input: GradeEssayInput, onDelta?: (delta: string) => void): Promise<GradeEssayResult>;

  /** AI 文本导入：从资料抽取至多 8 道客观题草稿（runOnce；无效条目过滤，全无效抛错）。 */
  parseImportedQuestions(text: string, opts: AiCallOptions): Promise<ImportedQuestion[]>;

  /** 学情诊断：输入统计摘要，输出 { summary, weaknesses[], suggestions[] }（runOnce）。 */
  generateDiagnosis(insight: InsightSummary, opts: AiCallOptions): Promise<DiagnosisDto>;

  /** 学习计划草稿：输出至多 7 条 { title, note? }（runOnce；无效条目过滤，全无效抛错）。 */
  generateStudyPlan(insight: InsightSummary, opts: AiCallOptions): Promise<PlanDraft[]>;

  /**
   * 题目 AI 解析（Phase 4）：按形态/深度组装消息流式调用一次（onDelta 透传 LLM 原文），
   * 输出纯文本【】小节解析；空输出抛 ExamLlmError(EXAM_LLM_STREAM_FAILED)。
   * - shallow（light）档：不设 maxTokens（DSH 按模型配置材质化输出上限）；
   * - deep 档：显式抬升 maxTokens（调用方解析后传入 input.maxTokens）与高思考档。
   */
  explainOnce(input: ExplainInput, onDelta?: (delta: string) => void): Promise<ExplainResult>;

  /**
   * 知识标注（P2，M5）：对给定客观题列表（含题干与现有 tags/topics）批量调用 LLM 判别知识点。
   * 建议 topics 规范化（trim/小写/去空白）、去重、≤4；缺失/空 → 退化 [首个主题 tag]；
   * 无 tag → []。输出 TopicSuggestionDto[]（含 currentTopics/currentTags/suggestedTopics）。
   */
  parseTopicSuggestions(items: readonly TopicSuggestionSource[], opts: AiCallOptions): Promise<TopicSuggestionDto[]>;
}

const GRADE_ESSAY_SYSTEM = `你是资深学科批改教师。用户会提供一道主观题（含题干，可能有参考答案要点）与一名学生的作答。
请输出**仅一个 JSON 对象**，不要任何多余文字、不要代码围栏，格式：
{"score": 0 到 100 的整数, "verdict": "correct" 或 "partial" 或 "incorrect", "feedback": "中文评语，指出优点、不足与改进建议", "reference": "参考答案要点（可省略该字段）"}
score 与 verdict 须一致：score>=60 为 correct，40-59 为 partial，<40 为 incorrect。`;

const IMPORT_SYSTEM = `你是出题专家。请从用户提供的资料中抽取至多 8 道高质量客观题（单选/多选/判断）。
仅输出一个 JSON 数组，不要任何多余文字、不要代码围栏，每题格式：
{"type": "single" 或 "multiple" 或 "boolean", "stem": "题干", "options": ["A. 选项一", "B. 选项二", ...], "answer": 单选为选项标识如 "A"；多选为标识数组如 ["A","C"]；判断为 "true" 或 "false", "explanation": "解析（可省略）", "tags": ["标签"]（可省略）}
要求：options 每项以大写字母加句点开头（"A. "）；判断题的 options 为空数组 []; answer 必须与 options 标识一致；题干与选项忠于资料。`;

const DIAGNOSIS_SYSTEM = `你是学情分析专家。用户会提供一名学生的学情统计（JSON）。请输出**仅一个 JSON 对象**，不要任何多余文字、不要代码围栏：
{"summary": "总体学情概述（中文，2-4 句）", "weaknesses": ["薄弱点1", "薄弱点2", ...], "suggestions": [{"text": "建议1", "action": {"mode": "byType" 或 "byTag" 或 "wrong" 或 "all", "type": "single"|"multiple"|"boolean"|"essay"（byType 时提供）, "tag": "标签"（byTag 时提供）}, ...]}
weaknesses 与 suggestions 各 2-5 条。suggestions 每条为对象：text 为中文建议；action 可省略，仅当该建议对应一次可直接开始的练习时提供（按薄弱题型练 → byType；按薄弱标签/知识点练 → byTag；重练错题 → wrong；全面练习 → all）。`;

const PLAN_SYSTEM = `你是学习规划师。根据用户的学情统计（JSON），制定一份可执行的学习计划。
仅输出一个 JSON 数组（至多 7 条），不要任何多余文字、不要代码围栏，每条：
{"title": "计划项标题（中文，简洁）", "note": "补充说明（可省略）", "actionType": "practice" 或 "reviewError" 或 "read" 或 "tutor"（可省略）, "scope": {"mode": "all" 或 "undone" 或 "wrong" 或 "byType" 或 "byTag", "type": "single"|"multiple"|"boolean"|"essay"（byType 时需要，可省略）, "tag": "标签"（byTag 时需要，可省略）}（可省略，供一键开始练习）, "priority": 数字 0 到 9（越小越优先，可省略）, "dueAt": 到期时间 epoch 毫秒（可省略）}
按优先级排序，聚焦薄弱环节；复习类条目尽量给出 scope（练习/复习错题时用）。`;

/** Tutor 系统提示词（buildTutorContext 与 service 自由问答路径共用；导出供 service.ts 复用）。 */
export const TUTOR_SYSTEM = '你是备考讲题助手。请用中文循序渐进地讲解题目思路、考点与易错点；若学生追问，针对性补充解答。';

/**
 * 题目解析系统提示词（P 个性化形态·浅档，设计 §3.1 A）：纯文本、【】固定四节，
 * 升级为逐项排除 + 推理链 + 结合知识点讲考点；「≤400 字软引导」但**不设硬上限**。
 * G 通用形态见 EXPLAIN_SYSTEM_GENERIC（省略【你的作答分析】节且不注入作答）。
 */
export const EXPLAIN_SYSTEM = `你是严谨的考试辅导老师。根据题目、标准答案与学生作答，输出简明解析。
要求：
1. 纯文本，禁用 Markdown 符号（# * \` 等）；每节以【】前缀开头，节间空一行；
2. 语言与题干一致（中文题中文答）；不确定的内容不要编造；判断题说明判定依据；
3. 讲解要求：逐项排除（单选题也讲清错误选项为什么不成立；多选题逐个讲每个选项对错）；展示推理链（拿到题先想什么 → 为什么排除 → 锁定答案）；结合知识点讲考点背景；学生答错时写明错误根因与知识缺口。
4. 凝练优先（全文 ≤400 字软引导），但不设硬上限——以内容完整性优先。
固定输出结构：
【正确答案解析】为什么该答案是正确的（单选题讲清关键；多选题逐项解释每个选项对错）
【你的作答分析】学生答案与标准答案的具体差异、错误根因与知识缺口（答对则写"思路正确，注意…补充提醒"）
【考点】本题考察的知识点（结合题目知识点 topics 与主题标签 tags）
【易错提示】此类题最常见的坑`;

/**
 * 题目解析系统提示词（P 个性化形态·深档，设计 §3.1 A 重写）：无字数限制、内容完整性
 * 优先；固定【思路拆解】【逐项排除】【考点延伸】【你的作答分析】【易错陷阱】五节；
 * 末尾要求**单独一行**输出 `{"topics":[...]}`（知识单元级候选，服务端剥离并写回）。
 */
export const EXPLAIN_SYSTEM_DEEP = `你是严谨的考试辅导老师。根据题目、标准答案、学生作答与个性化上下文，输出深入透彻的讲解（无字数限制，内容完整性优先）。
要求：
1. 纯文本，禁用 Markdown 符号（# * \` 等）；每节以【】前缀开头，节间空一行；
2. 语言与题干一致（中文题中文答）；不确定的内容不要编造；判断题说明判定依据；
3. 内容完整性优先：每节完整、不省略推理步骤；单/多选都**逐个**讲每个选项为什么不成立/为什么成立；完整展示推理链（先想什么 → 为什么排除 → 锁定答案）。
4. 结合题目知识点（topics）讲考点背景并延伸到相邻考点；结合「个性化上下文」（若有）针对性分析，尤其指出该知识点你的既往正确率、历史答错点与相似题。
5. 输出结束前，在**最后单独一行**输出一个 JSON 对象（不要代码围栏，其后不得再有其他任何文字）：
{"topics":["知识点1","知识点2"]}
   要求：2~4 个知识单元级知识点；不得等于题目主题 tag 或题目原文（题干/选项文字）；来源结合题干、考点延伸与你的作答分析；不确定宁可少给。
固定输出结构（每节之间空一行）：
【思路拆解】拿到题先想什么、如何定位考点、逐步推理到答案
【逐项排除】逐个讲每个选项对错（单选与多选均逐项）
【考点延伸】本题考察的知识点及其相邻考点背景
【你的作答分析】指出学生答案与标准答案的具体差异、错误根因与知识缺口；答对则指出思路亮点与可提升处
【易错陷阱】此类题最常见的坑与辨别方法`;

/** 题目解析系统提示词（G 通用形态）：同上但无学生作答，省略【你的作答分析】节。 */
export const EXPLAIN_SYSTEM_GENERIC = `你是严谨的考试辅导老师。根据题目与标准答案，输出简明解析。
要求：
1. 纯文本，禁用 Markdown 符号（# * \` 等）；每节以【】前缀开头，节间空一行；
2. 总长不超过 350 字；语言与题干一致（中文题中文答）；
3. 不确定的内容不要编造；判断题说明判定依据。
固定输出结构：
【正确答案解析】为什么该答案是正确的（多选题逐项过）
【考点】本题考察的知识点（结合题目 tags）
【易错提示】此类题最常见的坑`;

/**
 * 题目解析提示词版本（解析缓存失效键，设计 §16 §3.8、§3.1 A）。
 * 修改 EXPLAIN_SYSTEM / EXPLAIN_SYSTEM_DEEP 的**语义**时必须 +1：
 * explanations 缓存行落 prompt_version，命中要求等于当前版本（服务层接线，
 * 见 t5）；版本不匹配自动 miss、按需再生成——浅/深两档缓存均随本次 +1 自然失效
 * （键含 depth，两档互不挤占）。当前模板即 v2（A：提示词重写两档）。
 */
export const EXPLAIN_PROMPT_VERSION = 2;

/**
 * 解析不单独设置 maxTokens：DSH 运行时（LlmRuntime.adapterStream →
 * resolveCallWithInfo）在调用方省略 maxTokens 时按模型配置材质化默认输出上限
 * （settings.yaml 中该模型的 maxTokens，如 opencode-go 的 384000）。
 * 考试助手只消费模型配置，不做重复限制（设计 §6 的 350 字约束在提示词内）。
 */

const IMPORT_MAX_QUESTIONS = 8;
const PLAN_MAX_ITEMS = 7;

/** P2 知识标注：一次 runOnce 处理的题量（批量判别，8-10 题/批）。 */
const TOPIC_SUGGESTION_BATCH_SIZE = 10;

/** P2 知识标注系统提示词：输入题项 JSON 数组，输出同序 topics 判别（容错解析）。 */
const TOPIC_SUGGESTION_SYSTEM = `你是考试科目知识图谱标注员。用户给出一组客观题（含题干、现有主题标签 tags、现有知识点 topics），请为每题判别 1~4 个**知识单元级**知识点（粒度细于主题 tag：如「架构治理」「数据架构」，而非「togaf 9.2」）。
仅输出一个 JSON 数组，不要任何多余文字、不要代码围栏，每条：
{"index": 题目列表中的序号, "topics": ["知识点1", ...]}
要求：
1. topics 为知识单元级短语（每个 2~8 个中文字符，避免句子或 1 个字）；
2. **不得等于该题的主题 tag 或题干/选项文字的抄录**；
3. 宁缺毋滥：无法可靠判别时输出空数组 []（服务端回退 [首个主题 tag]，无 tag 则 []）；
4. 每题至少给出 1 个条目（index 必须覆盖所有输入编号）。`;

const OBJECTIVE_TYPES: readonly string[] = ['single', 'multiple', 'boolean'];
const GRADING_VERDICTS: readonly string[] = ['correct', 'partial', 'incorrect'];
const PLAN_ACTION_TYPES: readonly string[] = ['practice', 'reviewError', 'read', 'tutor'];

/** 学习计划条目的 actionType 归一化（非法值忽略）。 */
function normalizePlanActionType(value: unknown): PlanDraft['actionType'] {
  if (typeof value === 'string' && (PLAN_ACTION_TYPES as readonly string[]).includes(value)) {
    return value as PlanDraft['actionType'];
  }
  return undefined;
}

/** 学习计划条目的 scope 归一化（PracticeScopeDto 形状校验；非法忽略保留 title/note）。 */
function normalizePlanScope(value: unknown): PlanDraft['scope'] {
  if (typeof value !== 'object' || value === null) return undefined;
  const record = value as Record<string, unknown>;
  const mode = record.mode;
  if (typeof mode !== 'string') return undefined;
  const scope: PracticeScopeDto = { mode: mode as PracticeScopeDto['mode'] };
  if (typeof record.type === 'string' && (OBJECTIVE_TYPES as readonly string[]).includes(record.type)) {
    scope.type = record.type as PracticeScopeDto['type'];
  }
  if (typeof record.tag === 'string' && record.tag.length > 0) {
    scope.tag = record.tag;
  }
  // questionIds 显式集合（t9 错题重练）——数组全字符串时保留。
  if (Array.isArray(record.questionIds) && record.questionIds.every((id) => typeof id === 'string')) {
    scope.questionIds = record.questionIds as string[];
  }
  const validModes: readonly string[] = ['all', 'undone', 'wrong', 'byType', 'byTag'];
  if (!validModes.includes(scope.mode)) return undefined;
  return scope;
}

/** 学习计划条目的 priority 归一化（0..9 整数；非法忽略）。 */
function normalizePlanPriority(value: unknown): PlanDraft['priority'] {
  if (typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 9) return value;
  return undefined;
}

/** 用 examLlm 构造 AI 能力门面。 */
export function createAiEngine(llm: ExamLlm): AiEngine {
  return {
    async gradeEssay(input, onDelta) {
      const text = await llm.streamOnce(
        {
          provider: input.provider,
          model: input.model,
          system: GRADE_ESSAY_SYSTEM,
          messages: [userTextMessage(`题目：\n${renderQuestion(input.question)}\n\n学生作答：\n${input.userAnswer}`)],
          signal: input.signal,
        },
        onDelta,
      );
      const parsed = parseJsonObject(text.text);
      const score = parsed.score;
      if (!Number.isInteger(score) || (score as number) < 0 || (score as number) > 100) {
        throw llmOutputError(`invalid score in grading output: ${String(score)}`);
      }
      const verdict = parsed.verdict;
      if (typeof verdict !== 'string' || !GRADING_VERDICTS.includes(verdict)) {
        throw llmOutputError(`invalid verdict in grading output: ${String(verdict)}`);
      }
      const feedback = parsed.feedback;
      if (typeof feedback !== 'string' || feedback.trim().length === 0) {
        throw llmOutputError('missing feedback in grading output');
      }
      const reference = parsed.reference;
      if (reference !== undefined && typeof reference !== 'string') {
        throw llmOutputError('invalid reference in grading output');
      }
      return {
        score: score as number,
        verdict: verdict as GradingVerdict,
        feedback: feedback.trim(),
        ...(reference !== undefined ? { reference } : {}),
        model: text.model,
        usage: text.usage,
        finish: text.finish,
      };
    },

    async parseImportedQuestions(text, opts) {
      const output = await llm.runOnce({
        provider: opts.provider,
        model: opts.model,
        system: IMPORT_SYSTEM,
        messages: [userTextMessage(`资料：\n${text}`)],
        signal: opts.signal,
      });
      const items = parseJsonArray(output);
      const questions: ImportedQuestion[] = [];
      for (const item of items) {
        const question = normalizeImportedQuestion(item);
        if (question !== undefined) questions.push(question);
        if (questions.length >= IMPORT_MAX_QUESTIONS) break;
      }
      if (questions.length === 0) {
        throw llmOutputError('imported questions parse failed: no valid questions in llm output');
      }
      return questions;
    },

    async generateDiagnosis(insight, opts) {
      const output = await llm.runOnce({
        provider: opts.provider,
        model: opts.model,
        system: DIAGNOSIS_SYSTEM,
        messages: [userTextMessage(`学情统计：\n${JSON.stringify(insight)}`)],
        signal: opts.signal,
      });
      const parsed = parseJsonObject(output);
      const summary = parsed.summary;
      if (typeof summary !== 'string' || summary.trim().length === 0) {
        throw llmOutputError('missing summary in diagnosis output');
      }
      const weaknesses = parsed.weaknesses;
      // t13 结构化建议：兼容 LLM 退化输出字符串条目（→ 仅 text）；文本为空的条目丢弃。
      const suggestions = Array.isArray(parsed.suggestions)
        ? parsed.suggestions
            .map(parseDiagnosisSuggestion)
            .filter((item): item is DiagnosisSuggestionDto => item !== undefined)
        : [];
      return {
        summary: summary.trim(),
        weaknesses: isStringArray(weaknesses) ? weaknesses : [],
        suggestions,
      };
    },

    async generateStudyPlan(insight, opts) {
      const output = await llm.runOnce({
        provider: opts.provider,
        model: opts.model,
        system: PLAN_SYSTEM,
        messages: [userTextMessage(`学情统计：\n${JSON.stringify(insight)}`)],
        signal: opts.signal,
      });
      const items = parseJsonArray(output);
      const drafts: PlanDraft[] = [];
      for (const item of items) {
        if (drafts.length >= PLAN_MAX_ITEMS) break;
        if (typeof item !== 'object' || item === null) continue;
        const record = item as Record<string, unknown>;
        const title = record.title;
        if (typeof title !== 'string' || title.trim().length === 0) continue;
        const note = record.note;
        if (note !== undefined && typeof note !== 'string') continue;
        const draft: PlanDraft = { title: title.trim() };
        if (note !== undefined && typeof note === 'string') draft.note = note;
        const actionType = normalizePlanActionType(record.actionType);
        if (actionType !== undefined) draft.actionType = actionType;
        const scope = normalizePlanScope(record.scope);
        if (scope !== undefined) draft.scope = scope;
        const priority = normalizePlanPriority(record.priority);
        if (priority !== undefined) draft.priority = priority;
        const dueAt = record.dueAt;
        if (dueAt !== undefined && typeof dueAt === 'number' && Number.isFinite(dueAt) && dueAt >= 0) {
          draft.dueAt = dueAt;
        }
        const sourceDiagnosisId = record.sourceDiagnosisId;
        if (sourceDiagnosisId !== undefined && typeof sourceDiagnosisId === 'string') {
          draft.sourceDiagnosisId = sourceDiagnosisId;
        }
        drafts.push(draft);
      }
      if (drafts.length === 0) {
        throw llmOutputError('study plan parse failed: no valid items in llm output');
      }
      return drafts;
    },

    async parseTopicSuggestions(items, opts) {
      const suggestions: TopicSuggestionDto[] = [];
      for (let offset = 0; offset < items.length; offset += TOPIC_SUGGESTION_BATCH_SIZE) {
        const batch = items.slice(offset, offset + TOPIC_SUGGESTION_BATCH_SIZE);
        const output = await llm.runOnce({
          provider: opts.provider,
          model: opts.model,
          system: TOPIC_SUGGESTION_SYSTEM,
          messages: [
            userTextMessage(
              `题目列表（JSON）：\n${JSON.stringify(
                batch.map((item, index) => ({
                  index,
                  stem: item.stem,
                  tags: item.currentTags,
                  topics: item.currentTopics,
                })),
              )}`,
            ),
          ],
          signal: opts.signal,
        });
        // 容错：整批解析失败时按「未能判别」处理（回退 tag/[]），不整链抛错。
        let parsed: unknown[] = [];
        try {
          parsed = parseJsonArray(output);
        } catch {
          parsed = [];
        }
        const byIndex = new Map<number, string[]>();
        for (const entry of parsed) {
          if (typeof entry !== 'object' || entry === null) continue;
          const record = entry as Record<string, unknown>;
          if (typeof record.index !== 'number') continue;
          if (!isStringArray(record.topics)) continue;
          byIndex.set(record.index, record.topics);
        }
        for (let index = 0; index < batch.length; index++) {
          suggestions.push(normalizeTopicSuggestion(batch[index]!, byIndex.get(index)));
        }
      }
      return suggestions;
    },

    async explainOnce(input, onDelta) {
      const messages = buildExplainMessages(
        input.question,
        input.mode === 'generic'
          ? { mode: 'generic' }
          : // 缺 userAnswer/isCorrect 时由 buildExplainMessages 抛错（编程期契约）。
            {
              mode: 'personalized',
              userAnswer: input.userAnswer,
              isCorrect: input.isCorrect as boolean,
              ...(input.depth !== undefined ? { depth: input.depth } : {}),
              ...(input.context !== undefined ? { context: input.context } : {}),
            },
      );
      const text = await llm.streamOnce(
        {
          provider: input.provider,
          model: input.model,
          reasoningEffort: input.reasoningEffort,
          messages,
          // 浅档不设 maxTokens（DSH 按模型配置材质化输出上限，见 EXPLAIN 注释）；
          // 深档由服务层把 input.maxTokens 解析后显式抬升输出上限。
          ...(input.maxTokens !== undefined ? { maxTokens: input.maxTokens } : {}),
          signal: input.signal,
        },
        onDelta,
      );
      const content = text.text.trim();
      if (content.length === 0) {
        throw llmOutputError('llm returned an empty explanation');
      }
      return { content, model: text.model, usage: text.usage, finish: text.finish };
    },
  };
}

/**
 * 组装 Tutor 多轮对话消息（纯函数，不调用 LLM）：
 * [system 讲题助手, user 题目题干+选项/参考答案或学生作答, ...历史轮次, user 新提问]。
 */
export function buildTutorContext(
  question: QuestionRow,
  userAnswer: string | null | undefined,
  history: readonly TutorMessageRow[],
  newMessage: string,
): LlmMessage[] {
  const messages: LlmMessage[] = [{ role: 'system', content: [{ type: 'text', text: TUTOR_SYSTEM }] }];
  messages.push({ role: 'user', content: [{ type: 'text', text: renderTutorQuestion(question, userAnswer) }] });
  for (const entry of history) {
    messages.push({ role: entry.role, content: [{ type: 'text', text: entry.content }] });
  }
  messages.push({ role: 'user', content: [{ type: 'text', text: newMessage }] });
  return messages;
}

/**
 * 组装题目解析消息（纯函数，不调用 LLM；Phase 4）：
 * [system 解析提示词, user 题目上下文]。
 * - system 按形态/深度选择：generic→EXPLAIN_SYSTEM_GENERIC；deep→EXPLAIN_SYSTEM_DEEP；
 *   浅档（缺省）→EXPLAIN_SYSTEM。
 * - P 形态注入学生作答 + isCorrect（供【你的作答分析】节）；G 形态省略作答行。
 * - deep 档且提供 context（M4）时，在 user 消息尾部追加「个性化上下文」段。
 */
export function buildExplainMessages(question: QuestionRow, options: BuildExplainOptions): LlmMessage[] {
  if (options.mode !== 'generic') {
    if (typeof options.isCorrect !== 'boolean' || options.userAnswer === undefined) {
      throw new Error('buildExplainMessages: personalized mode requires userAnswer and isCorrect');
    }
  }
  const depth = options.mode === 'personalized' ? (options.depth ?? 'light') : 'light';
  const system =
    options.mode === 'generic'
      ? EXPLAIN_SYSTEM_GENERIC
      : depth === 'deep'
        ? EXPLAIN_SYSTEM_DEEP
        : EXPLAIN_SYSTEM;
  let userText =
    options.mode === 'generic'
      ? renderExplainQuestion(question)
      : renderExplainQuestion(question, { userAnswer: options.userAnswer, isCorrect: options.isCorrect });
  if (depth === 'deep' && options.mode === 'personalized' && options.context !== undefined) {
    userText = `${userText}\n\n个性化上下文：\n${renderExplainContext(options.context)}`;
  }
  const messages: LlmMessage[] = [{ role: 'system', content: [{ type: 'text', text: system }] }];
  messages.push({ role: 'user', content: [{ type: 'text', text: userText }] });
  return messages;
}

/** 深档个性化上下文 → 文本段（pure；仅注入 user 消息尾部）。 */
function renderExplainContext(context: ExplainContextDto): string {
  const lines: string[] = [];
  lines.push(`- 该题历史答错 ${context.wrongCountOnQuestion} 次；`);
  for (const stat of context.topicAccuracy) {
    const pct = Math.round(stat.accuracy * 100);
    lines.push(`- 知识点「${stat.topic}」正确率 ${pct}%（作答 ${stat.answered} 题，对 ${stat.correct} 题）；`);
  }
  if (context.similarStems.length > 0) {
    const stems = context.similarStems.map((stem) => `「${stem}」`).join('、');
    lines.push(`- 相似题：${stems}；`);
  }
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Phase 4：解析缓存键归一化（answer_norm）
// ---------------------------------------------------------------------------

/**
 * 归一化用户作答为解析缓存键 answer_norm（设计 §4，与判分编码对齐——判分见 grading.ts，
 * 客户端提交编码见 PracticeView：single/multiple 为选项字母标识、boolean 为 'true'/'false'）：
 * - single   → 选项索引字符串（复用 ui-helpers identifierToIndex 语义：'A'→'0'，数字串→规范数字串；
 *              其余非空字符串原样保留，保证不同标识不碰撞）
 * - boolean  → 'true' | 'false'（接受原生 boolean 与字符串，语义同 grading.normalizeBoolean）
 * - multiple → 索引升序逗号串（顺序无关 + 去重，集合语义同 grading.gradeMultiple；
 *              无法解析索引的标识以 '#'+原文参与排序，仍顺序无关）
 * - 其他/非法编码（含 essay 等未支持题型）→ 'json:' + JSON.stringify 兜底：
 *              确定性且与上述规范键空间不冲突（G 形态恒 ''，亦不冲突）。
 * t1：type 参数接受 StoredQuestionType（essay 等落到 default 兜底，运行时不会进入
 * 解析路径——P/G 形态在服务层已拒绝 essay）。
 */
export function normalizeAnswerNorm(type: StoredQuestionType, rawUserAnswer: unknown): string {
  switch (type) {
    case 'boolean':
      if (rawUserAnswer === true || rawUserAnswer === 'true') return 'true';
      if (rawUserAnswer === false || rawUserAnswer === 'false') return 'false';
      return jsonFallbackNorm(rawUserAnswer);
    case 'single': {
      if (typeof rawUserAnswer === 'string' && rawUserAnswer.length > 0) {
        const index = optionIdentifierToIndex(rawUserAnswer);
        return index !== null ? String(index) : rawUserAnswer;
      }
      return jsonFallbackNorm(rawUserAnswer);
    }
    case 'multiple': {
      if (
        Array.isArray(rawUserAnswer) &&
        rawUserAnswer.length > 0 &&
        rawUserAnswer.every(
          (item): item is string => typeof item === 'string' && item.length > 0,
        )
      ) {
        const tokens = new Set<string>();
        for (const identifier of rawUserAnswer) {
          const index = optionIdentifierToIndex(identifier);
          tokens.add(index !== null ? String(index) : `#${identifier}`);
        }
        return [...tokens].sort(compareNormToken).join(',');
      }
      return jsonFallbackNorm(rawUserAnswer);
    }
    default:
      return jsonFallbackNorm(rawUserAnswer);
  }
}

/** 选项标识 → 下标（镜像 client ui-helpers identifierToIndex：'A'-'Z' 字母或安全整数数字串）。 */
function optionIdentifierToIndex(identifier: string): number | null {
  if (/^[A-Z]$/.test(identifier)) return identifier.charCodeAt(0) - 65;
  if (/^\d+$/.test(identifier)) {
    const n = Number(identifier);
    return Number.isSafeInteger(n) ? n : null;
  }
  return null;
}

/** 规范键兜底：'json:' 前缀 + JSON 序列化（不可序列化退化为 String），绝不与规范键/G 空键重合。 */
function jsonFallbackNorm(value: unknown): string {
  const serialized = JSON.stringify(value);
  return `json:${serialized === undefined ? String(value) : serialized}`;
}

/** 键内 token 排序：纯数字串按数值升序，其余按字典序（确定性、顺序无关）。 */
function compareNormToken(a: string, b: string): number {
  if (/^\d+$/.test(a) && /^\d+$/.test(b)) return Number(a) - Number(b);
  return a < b ? -1 : a > b ? 1 : 0;
}

// ---------------------------------------------------------------------------
// 可靠性：Tutor 历史 token 预算（设计 §16 §3.4；纯函数，供 t5 服务层接线）
// ---------------------------------------------------------------------------

/**
 * 默认 token 估计：1 字符 ≈ 1 token（中文内容的保守上界；偏安全方向——宁可多裁，
 * 不可超窗）。英文内容会高估（浪费少量上下文），属可接受的安全偏差。
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length);
}

/**
 * 模型上下文信息（DSH `LlmRuntime.resolveModelInfo` 的窄化子集；由路由层
 * resolveLlmRoute 解析后传入服务层，服务层只消费、不查注册表）。
 */
export interface TutorModelContextInfo {
  /** 模型总上下文窗口（请求 + 响应 token）。 */
  contextWindow?: number;
  /** 模型配置的输出上限（defaultMaxTokens）；缺省按 contextWindow/4 且 ≤4096 预留。 */
  defaultMaxTokens?: number;
}

/** 输出预留缺省上限（模型未声明 defaultMaxTokens 时）。 */
const TUTOR_OUTPUT_RESERVE_CAP = 4096;
/** 上下文安全余量（token）：给 system/题目渲染等固定开销的估计误差留白。 */
const TUTOR_CONTEXT_SAFETY_MARGIN = 512;

/**
 * 计算 Tutor 单次调用的输入 token 预算：contextWindow − 输出预留 − 安全余量。
 *
 * 只**消费** DSH 模型配置做预算，绝不自行限制模型输出（调用方不设 maxTokens，
 * 输出上限仍由 DSH 按模型配置材质化，见 EXPLAIN 注释同款约定）。
 * 任一字段缺失或预算 ≤0 → undefined（调用方退回无预算兜底裁剪）。
 */
export function computeTutorInputBudget(modelInfo?: TutorModelContextInfo): number | undefined {
  if (modelInfo === undefined || typeof modelInfo.contextWindow !== 'number' || modelInfo.contextWindow <= 0) {
    return undefined;
  }
  const outputReserve =
    typeof modelInfo.defaultMaxTokens === 'number' && modelInfo.defaultMaxTokens > 0
      ? modelInfo.defaultMaxTokens
      : Math.min(TUTOR_OUTPUT_RESERVE_CAP, Math.floor(modelInfo.contextWindow / 4));
  const budget = modelInfo.contextWindow - outputReserve - TUTOR_CONTEXT_SAFETY_MARGIN;
  return budget > 0 ? budget : undefined;
}

/** trimTutorHistory 的裁剪选项。 */
export interface TutorTrimOptions {
  /**
   * 可用于**历史**的 token 上限（不含 system / 题目上下文 / 新提问等固定开销；
   * 调用方先用 estimateTokens 计算固定开销并从 computeTutorInputBudget 结果中扣除）。
   * 缺省 undefined = 无预算，走兜底：保留最近 maxMessages 条消息（保序）。
   */
  maxHistoryTokens?: number;
  /** 历史消息条数硬上限（有预算与无预算都套用）；缺省 60。 */
  maxMessages?: number;
  /** token 估计函数；缺省 estimateTokens（1 字符 ≈ 1 token）。 */
  estimateTokens?: (text: string) => number;
}

/**
 * 裁剪 Tutor 历史为**完整轮次**（user+assistant 成对；孤儿 assistant 并入前组，
 * 末尾未完成的 user 自成一组），保序返回应从旧到新的保留子集。
 *
 * 预算语义：
 * - 有 maxHistoryTokens：从**最新轮次向旧**累加，超预算即停；最新一轮即使单独
 *   超预算也保留（尽力而为，保证回复上下文完整）；
 * - 无预算：兜底保留最近 maxMessages 条消息（保序）；
 * - maxMessages 硬上限最后套用（消息条数，取尾部；可能切开最旧一组的半轮，
 *   属消息级上限的已知取舍）。
 */
export function trimTutorHistory(
  history: readonly TutorMessageRow[],
  options: TutorTrimOptions = {},
): TutorMessageRow[] {
  const { maxHistoryTokens, maxMessages = 60, estimateTokens: estimate = estimateTokens } = options;
  if (history.length === 0) return [];

  if (maxHistoryTokens === undefined) {
    // 兜底：最近 maxMessages 条（保序）。
    return history.slice(Math.max(0, history.length - maxMessages));
  }

  const turns = groupTurns(history);
  const kept: TutorMessageRow[][] = [];
  let used = 0;
  for (let index = turns.length - 1; index >= 0; index--) {
    const turn = turns[index]!;
    const cost = turn.reduce((sum, message) => sum + estimate(message.content), 0);
    // 最新一轮无条件保留（kept 为空时）；其后仅当累计不超预算。
    if (kept.length === 0 || used + cost <= maxHistoryTokens) {
      kept.unshift(turn);
      used += cost;
    } else {
      break;
    }
  }
  const result = kept.flat();
  return result.length > maxMessages ? result.slice(result.length - maxMessages) : result;
}

/** 消息序列 → 轮次分组：user 开新组，assistant 并入当前组（孤儿 assistant 自成组）。 */
function groupTurns(messages: readonly TutorMessageRow[]): TutorMessageRow[][] {
  const turns: TutorMessageRow[][] = [];
  for (const message of messages) {
    if (message.role === 'user') {
      turns.push([message]);
    } else if (turns.length > 0) {
      turns[turns.length - 1]!.push(message);
    } else {
      turns.push([message]);
    }
  }
  return turns;
}

// ---------------------------------------------------------------------------
// 辅助：题目渲染 / JSON 提取容错 / 输出校验
// ---------------------------------------------------------------------------

function renderQuestion(question: QuestionRow): string {
  const lines = [`题干：${question.stem}`];
  if (question.options.length > 0) {
    lines.push(`选项：\n${question.options.map((option) => `- ${option}`).join('\n')}`);
  }
  if (question.answer !== null && question.answer !== undefined) {
    lines.push(`参考答案：${JSON.stringify(question.answer)}`);
  }
  if (question.explanation !== null && question.explanation !== undefined) {
    lines.push(`解析：${question.explanation}`);
  }
  return lines.join('\n');
}

/** 题目 + 学生作答 → Tutor 上下文渲染（导出供 service 层 token 预算估算固定开销，t5）。 */
export function renderTutorQuestion(question: QuestionRow, userAnswer: string | null | undefined): string {
  const lines = [`题目：${question.stem}`];
  if (question.options.length > 0) {
    lines.push(`选项：\n${question.options.map((option) => `- ${option}`).join('\n')}`);
  }
  if (question.answer !== null && question.answer !== undefined) {
    lines.push(`参考答案：${JSON.stringify(question.answer)}`);
  }
  if (userAnswer !== null && userAnswer !== undefined && userAnswer.trim().length > 0) {
    lines.push(`我的作答：${userAnswer}`);
  }
  return lines.join('\n');
}

/** 解析用户消息模板（设计 §6）：题干 + 题型 + 选项 + 标准答案 + tags；P 形态追加作答与判定。 */
function renderExplainQuestion(
  question: QuestionRow,
  personalized?: { userAnswer: unknown; isCorrect: boolean },
): string {
  const typeLabel =
    question.type === 'single' ? '单选' : question.type === 'multiple' ? '多选' : question.type === 'boolean' ? '判断' : String(question.type);
  const lines = [`题型：${typeLabel}`, `题干：${question.stem}`];
  if (question.options.length > 0) {
    lines.push(`选项：\n${question.options.map((option) => `- ${option}`).join('\n')}`);
  }
  if (question.answer !== null && question.answer !== undefined) {
    lines.push(`标准答案：${JSON.stringify(question.answer)}`);
  }
  if (personalized !== undefined) {
    const answer = typeof personalized.userAnswer === 'string'
      ? personalized.userAnswer
      : JSON.stringify(personalized.userAnswer);
    lines.push(`学生作答：${answer}`);
    lines.push(`判定结果：${personalized.isCorrect ? '正确' : '错误'}`);
  }
  // t1：知识点（topics）优先于主题 tag 注入，供讲解/考点引用（设计 §4.4）。
  if (question.topics !== null && question.topics.length > 0) {
    lines.push(`知识点：${question.topics.join(', ')}`);
  }
  if (question.tags !== null && question.tags.length > 0) {
    lines.push(`标签：${question.tags.join(', ')}`);
  }
  return lines.join('\n');
}

/**
 * JSON 提取容错：整段直解 → 剥离 ```json 围栏 → 取首个 {…}（对象）/[…]（数组）。
 * 失败抛 ExamLlmError(EXAM_LLM_STREAM_FAILED)。
 */
function parseJsonObject(text: string): Record<string, unknown> {
  const parsed = extractJson(text, '{', '}');
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw llmOutputError('llm output is not a JSON object');
  }
  return parsed as Record<string, unknown>;
}

function parseJsonArray(text: string): unknown[] {
  const parsed = extractJson(text, '[', ']');
  if (!Array.isArray(parsed)) {
    throw llmOutputError('llm output is not a JSON array');
  }
  return parsed;
}

function extractJson(text: string, open: '{' | '[', close: '}' | ']'): unknown {
  const trimmed = text.trim();
  // 1) 整段直解。
  try {
    return JSON.parse(trimmed);
  } catch {
    // fall through
  }
  // 2) 剥离 ```json / ``` 围栏后直解。
  const fenced = trimmed.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  if (fenced !== trimmed) {
    try {
      return JSON.parse(fenced);
    } catch {
      // fall through
    }
  }
  // 3) 取首个 {…} / [… ] 子串（容忍前后 prose）。
  const start = trimmed.indexOf(open);
  const end = trimmed.lastIndexOf(close);
  if (start !== -1 && end > start) {
    try {
      return JSON.parse(trimmed.slice(start, end + 1));
    } catch {
      // fall through
    }
  }
  throw llmOutputError('llm output contains no parseable JSON');
}

/** 导入草稿条目规范化：结构/编码校验，非法条目返回 undefined（调用方过滤）。 */
function normalizeImportedQuestion(item: unknown): ImportedQuestion | undefined {
  if (typeof item !== 'object' || item === null) return undefined;
  const record = item as Record<string, unknown>;
  const type = record.type;
  if (typeof type !== 'string' || !OBJECTIVE_TYPES.includes(type)) return undefined;
  const stem = record.stem;
  if (typeof stem !== 'string' || stem.trim().length === 0) return undefined;
  const options = record.options;
  if (!isStringArray(options)) return undefined;
  if (type !== 'boolean' && options.length === 0) return undefined;
  const answer = record.answer;
  if (type === 'single') {
    if (typeof answer !== 'string' || answer.trim().length === 0) return undefined;
  } else if (type === 'multiple') {
    if (!isStringArray(answer) || answer.length === 0) return undefined;
  } else {
    if (answer !== 'true' && answer !== 'false') return undefined;
  }
  const explanation = record.explanation;
  if (explanation !== undefined && explanation !== null && typeof explanation !== 'string') {
    return undefined;
  }
  const tags = record.tags;
  if (tags !== undefined && tags !== null && !isStringArray(tags)) return undefined;
  return {
    type: type as ImportedQuestion['type'],
    stem: stem.trim(),
    options: options.map((option) => option.trim()).filter((option) => option.length > 0),
    answer: type === 'single' ? (answer as string).trim() : answer,
    ...(explanation !== undefined && explanation !== null ? { explanation: explanation as string } : {}),
    ...(tags !== undefined && tags !== null ? { tags: tags as string[] } : {}),
  };
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

/**
 * 单条诊断建议解析（t13 结构化）：字符串条目兼容为 { text }；对象条目取 text +
 * 宽容校验 action（mode 合法才保留；type/tag 非字符串丢弃）。非法条目返回 undefined。
 */
function parseDiagnosisSuggestion(item: unknown): DiagnosisSuggestionDto | undefined {
  if (typeof item === 'string') {
    const text = item.trim();
    return text.length > 0 ? { text } : undefined;
  }
  if (typeof item !== 'object' || item === null) return undefined;
  const record = item as Record<string, unknown>;
  const text = record.text;
  if (typeof text !== 'string' || text.trim().length === 0) return undefined;
  let action: DiagnosisSuggestionActionDto | undefined;
  const rawAction = record.action;
  if (typeof rawAction === 'object' && rawAction !== null) {
    const candidate = rawAction as Record<string, unknown>;
    const mode = candidate.mode;
    if (mode === 'all' || mode === 'wrong' || mode === 'byType' || mode === 'byTag') {
      action = {
        mode,
        ...(typeof candidate.type === 'string' ? { type: candidate.type } : {}),
        ...(typeof candidate.tag === 'string' ? { tag: candidate.tag } : {}),
      };
    }
  }
  return { text: text.trim(), ...(action !== undefined ? { action } : {}) };
}

/**
 * 单题知识点建议规范化（P2）：normalizeQueryLabel + 去重 + ≤4；
 * LLM 缺失/空 topics 时回退 [首个主题 tag]（宁缺毋滥），无 tag → []。
 * 返回的 suggestedTopics 为 draft（客户端确认后再写回）；tag 兜底是刻意的草稿语义，
 * 与 apply 时的「不得与 tags 同项」校验分离（确认流程由客户端承接）。
 */
function normalizeTopicSuggestion(item: TopicSuggestionSource, rawTopics: string[] | undefined): TopicSuggestionDto {
  const deduped = [...new Set((rawTopics ?? []).map((t) => normalizeQueryLabel(t)).filter((t) => t.length > 0))].slice(0, 4);
  const firstTag = item.currentTags?.[0];
  const suggestedTopics =
    deduped.length > 0
      ? deduped
      : firstTag !== undefined && firstTag.length > 0
        ? [normalizeQueryLabel(firstTag)]
        : [];
  return {
    questionId: item.questionId,
    stem: item.stem,
    currentTopics: item.currentTopics,
    currentTags: item.currentTags,
    suggestedTopics,
  };
}

function llmOutputError(message: string): ExamLlmError {
  return new ExamLlmError(message, EXAM_LLM_STREAM_FAILED);
}
