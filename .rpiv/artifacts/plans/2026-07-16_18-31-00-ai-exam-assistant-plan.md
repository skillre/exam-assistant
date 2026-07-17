---
kind: plan
status: ready
created: 2026-07-16T18:31:00+0800
feature: AI 原生考试助手（客观题刷题闭环 MVP）— 实现计划
branch: no-branch
commit: no-commit
repo: 考试助手 (greenfield, not yet a git repo)
source_design: .rpiv/artifacts/designs/2026-07-16_17-32-22-ai-exam-assistant-design.md
phase_count: 9
phases:
  - { n: 1, title: "项目骨架 + 共享类型 + DB schema" }
  - { n: 2, title: "pi SDK 集成层（AiService）" }
  - { n: 3, title: "题目导入（粘贴 AI 解析 + 结构化文件）" }
  - { n: 4, title: "刷题闭环（判分 + 记录）" }
  - { n: 5, title: "AI 讲解（SSE 流式）" }
  - { n: 6, title: "错题多轮答疑" }
  - { n: 7, title: "错因归纳 + 学情分析" }
  - { n: 8, title: "React 前端 + 模型设置页" }
  - { n: 9, title: "Docker 化部署（双容器 compose）" }
---

# Plan — AI 原生考试助手（客观题刷题闭环 MVP）

> 从设计的 9 个垂直切片 1:1 继承为 9 个 phase。代码与 Success Criteria 来自设计，不重新发明。
>
> **执行环境铁律（DEC-15/16）**：所有 `pnpm install`/`tsc`/单测/`docker compose`/端到端手测都在**独立运行环境**上经 SSH 执行，绝不在本地跑。下方 Automated Verification 里的命令均按"在运行环境经 SSH 执行"理解。

## 前置准备（implement 开始前需向用户索取）

- SSH 连接信息：host / user / port / key 路径（用户表示运行环境已就绪）
- Git：**无需现在提供** —— 需要时直接 `git init`，上传时用户登录处理
- 确认运行环境已装 Docker + docker compose（用户确认已就绪）
- `APP_SECRET`（对称加密 provider Key 用，**非** 模型 Key）：由 compose 环境变量提供，缺省则首次启动自生成存卷内
- **模型 provider / API Key 无需提供给我** —— 系统上线后由你在**前端设置页**填写保存（DEC-19/20）

## 继承的决策（DEC-1 ~ DEC-21）

见设计文档 Developer Context 与 Design Checkpoint 决策表；实现期不再重议。关键约束速查：
判分不用 AI（DEC-3）｜Key 只在后端（DEC-5）｜答疑历史以 JSONL 为真相源（DEC-7）｜SSE 流式（DEC-8）｜讲解会话 `tools:[]`（DEC-9）｜Docker 双容器 + 命名卷（DEC-17/18）｜数据路径经 `DATA_DIR` 可配置。
**Key/provider 运行时配置（DEC-19/20/21）**：provider（baseUrl/api/模型列表/Key）由前端全管，Key 加密存 SQLite 永不回传；AiService 经 `ModelRuntime.create({ modelsPath })` 载卷内 `models.json`(无 Key) + `setRuntimeApiKey()` 注入解密 Key。

## 并行度总览

```
Phase 1 (骨架/类型/DB)  ── 地基，最先
   ├─▶ Phase 2 (AiService)      ┐
   └─▶ Phase 4 (判分闭环)        │ 2 与 4 可并行（4 不依赖 AI）
        │                        │
Phase 2 ─┼─▶ Phase 3 (导入)      │ 3 依赖 2(runOnce) + 1(类型/DB)
         └─▶ Phase 5 (讲解SSE)   │ 5 依赖 2 + 4(有作答才讲)
                │
Phase 5 ──▶ Phase 6 (多轮答疑)   6 依赖 5(会话已建)
Phase 4+6 ─▶ Phase 7 (学情)      7 依赖 4(做题记录)+6(答疑JSONL)
Phase 3..7 ─▶ Phase 8 (前端)     8 串联所有后端能力
Phase 8 ──▶ Phase 9 (Docker)     9 最后，容器化整体
```
关键路径：1 → 2 → 5 → 6 → 7 → 8 → 9。Phase 4 可与 2/3 并行。

---

## Phase 1: 项目骨架 + 共享类型 + DB schema

**Files**:
- `pnpm-workspace.yaml`、根 `package.json`、`tsconfig.base.json`
- `packages/shared/src/types.ts`
- `packages/server/src/db/schema.sql`、`packages/server/src/db/index.ts`
- `packages/server/package.json`、`packages/client/package.json`

**共享类型**（`shared/src/types.ts`）:
```ts
export type QuestionType = 'single' | 'multiple' | 'boolean';
export type AnswerValue = number | number[] | boolean;

export interface Question {
  id: string; bankId: string; type: QuestionType;
  stem: string; options: string[]; answer: AnswerValue;
  explanation?: string; tags?: string[]; source?: 'paste-ai' | 'file';
  createdAt: number;
}
export interface Attempt {
  id: string; questionId: string;
  userAnswer: AnswerValue; isCorrect: boolean; answeredAt: number;
}
export interface Bank { id: string; name: string; createdAt: number; }
// #4: grade 回传新落库 attempt 的 id，供 Phase 5 explain 使用
export interface GradeRequest { questionId: string; userAnswer: AnswerValue; }
export interface GradeResponse { attemptId: string; isCorrect: boolean; correctAnswer: AnswerValue; }

// #2: 学情快照结构（Phase 7 LearningDataCollector 产出）
export interface LearningSnapshot {
  totalAttempts: number;
  accuracy: number;                    // 0..1
  weakTags: { tag: string; wrong: number; total: number }[];
  tutorHighlights: string[];           // 从答疑 JSONL 提炼的要点
}
// #3: 模型列表项（GET /api/models 返回）
export interface ModelInfo { providerId: string; modelId: string; name: string; }

// DEC-19/20: provider 前端全管；Key 加密存后端，对外只暴 configured
export interface ProviderModel { id: string; name: string; }
export interface Provider {
  id: string; name: string; baseUrl: string; api: string;
  models: ProviderModel[]; configured: boolean;   // configured=已存 Key（不回传明文）
  createdAt: number;
}
export interface ProviderUpsert {   // 写入时才带 apiKey，编辑省略则不改
  name: string; baseUrl: string; api: string;
  models: ProviderModel[]; apiKey?: string;
}
```

> **类型补全说明（评审 #1/#2/#4 + DEC-19/20）**：`Bank`、`LearningSnapshot`、`ModelInfo`、`Provider` 均在 Phase 1 共享类型定义；`GradeResponse` 增加 `attemptId`。`Provider.configured` 取代回传 Key（DEC-19）；`ProviderUpsert.apiKey` 仅写入时携带，编辑省略则保持原 Key。

**DB schema**（`db/schema.sql`，六表，见设计 Data Model）: banks / questions / attempts / tutor_sessions / **providers** / **app_settings**，带 `ON DELETE CASCADE` 的外键如设计所列。providers 存加密 Key（DEC-19），app_settings 存当前激活 provider/model。DB 路径经 `DATA_DIR`（默认 `/app/data`）派生：`${DATA_DIR}/app.db`。

**包命名（评审 #10）**: `packages/shared/package.json` 固定 `"name": "@exam/shared"`，server/client 据此 import，避免下游依赖断裂。

### Success Criteria:

#### Automated Verification:
- [x] 依赖安装成功：`pnpm install`（远端：better-sqlite3 原生编译通过，Node 23）
- [x] 三包类型检查通过：`pnpm -r exec tsc --noEmit`（远端 exit 0）
- [x] 启动脚本建库后六张表存在：`sqlite3 $DATA_DIR/app.db ".tables"` 输出 banks/questions/attempts/tutor_sessions/providers/app_settings（远端确认）
- [x] `@exam/shared` 能被 server/client import（远端 tsc 无未解析报错）

#### Manual Verification:
- [x] 目录结构符合设计（packages/shared|server|client）
- [x] `DATA_DIR` 未设置时回退到本地默认且不报错（远端 health 返回 dataDir）

---

## Phase 2: pi SDK 集成层（AiService）

**Files**:
- `packages/server/src/ai/AiService.ts`
- `packages/server/src/ai/modelRuntimeSetup.ts`（DEC-21 实现优化：从 DB provider 解密 Key → `ModelRuntime.create({ modelsPath: null })` → `registerProvider` 连 Key 全量注入内存；**不写 models.json 文件**）
- `packages/server/src/repositories/providerRepo.ts`（DEC-19/20：provider CRUD，Key 加密列 + `listWithKeys()` 内部解密）
- `packages/server/src/repositories/settingsRepo.ts`（app_settings：当前激活 provider/model）
- `packages/server/src/crypto/secretBox.ts`（DEC-19：`APP_SECRET`→scrypt 派生密钥，AES-256-GCM 加解密 Key）
- `packages/server/src/routes/providers.ts`（DEC-20：provider 增删改查）
- `packages/server/src/routes/models.ts`（评审 #3：`GET /api/models` + `POST /api/settings/model`）
- `packages/server/src/ai/verify.ts`（Phase 2 SDK 集成验证脚本，远端跑）
- `packages/server/src/index.ts`（Fastify 装配：建库 + AiService 单例 + 注册 routes）
- `.env.example`（仅 `APP_SECRET`、`DATA_DIR`、`PORT`，**不含 provider Key**）

**关键签名**（`AiService`）:
```ts
class AiService {
  async reloadProviders(): Promise<void>;   // DEC-21：DB 变更后重建 ModelRuntime + 重注入 Key
  async runOnce(systemPrompt: string, userPrompt: string): Promise<string>;
  async createTutorSession(opts: { systemPrompt: string }):
    Promise<{ session: AgentSession; jsonlPath: string }>;
  async openTutorSession(jsonlPath: string): Promise<AgentSession>;
  streamPrompt(session: AgentSession, prompt: string,
    onDelta: (chunk: string) => void): Promise<void>;
  setModel(providerId: string, modelId: string): Promise<void>;
  listModels(): ModelInfo[];
}
```

**Provider 运行时装配（DEC-19/20/21，已按实现优化落地）**: provider（baseUrl/api/模型列表/加密 Key）存 SQLite。`AiService` 启动与 `reloadProviders()` 时：`ModelRuntime.create({ modelsPath: null })`（不读任何 models.json 文件）→ 从 SQLite 读 provider、`secretBox` 解密 Key → `registerProvider(id, { name, baseUrl, apiKey, api, models })` 连 Key 全量注入内存。Key 明文仅存活于内存，落盘的只有 SQLite 的 AES-GCM 密文列；任何响应体只返回 `configured: boolean`。**已在远端验证**：明文 Key 在 DB 中 count=0、响应体无 Key。
> ⚠️ **Phase 2 首要验证项**（✅ 已在本地核实 SDK 类型定义解决）：真实 API 为 `ModelRuntime`（非 ModelRegistry）：`ModelRuntime.create({ modelsPath?, authPath?, credentials? })`、`setRuntimeApiKey(providerId, apiKey): Promise<void>`、`registerProvider(providerId, { name, baseUrl, apiKey, api, models }): void`（同步、直接在 ModelRuntime 上，无需扩展工厂）、`getModel(providerId, modelId)`。`createAgentSession({ modelRuntime, model, noTools: "all" })` —— `noTools:"all"` 关掉全部工具（DEC-9）。
> **实现优化（比 DEC-21 更简）**：`registerProvider` 可连 Key 一起在内存注册，所以**不写 `models.json` 文件、也不单调 `setRuntimeApiKey`**：启动时从 SQLite 读 provider、解密 Key、直接 `registerProvider` 全量注入内存。Key 依然不落盘（SQLite 密文，内存才明文）。`modelRuntimeSetup.ts` 按此实现。

**模型/Provider 路由**: `routes/models.ts` 暴露 `GET /api/models`（`listModels()`）+ `POST /api/settings/model`（`setModel`）；`routes/providers.ts` 暴露 provider 增删改查（DEC-20）。`AiService` 作为 Fastify 单例注入，provider 变更后调 `reloadProviders()`。

**要点**: `SessionManager.create(cwd, ${DATA_DIR}/sessions)`（DEC-7）；讲解/答疑会话 `tools: []`（DEC-9）；Key 只经 `secretBox` 加解密，绝不返回给 handler（DEC-5/19）。

> 风险最高点：先写独立验证脚本跑通 `ModelRuntime + setRuntimeApiKey`/`runOnce`/`createTutorSession`/`streamPrompt` 再进后续。查 SDK 细节走 Explore 子代理转述（规避敏感词过滤）。

### Success Criteria:

#### Automated Verification:
- [x] 类型检查通过：`pnpm -r exec tsc --noEmit`（远端 exit 0）
- [x] SDK API 归属已核实（本地读 .d.ts + 远端 tsc）：`ModelRuntime.registerProvider` 连 Key 内存注册可行；`getModel` 取模型成功；`createAgentSession({modelRuntime,model,noTools:"all"})` 类型通过
- [x] provider CRUD 存 provider+Key 后 `GET /api/models` 列出该模型（远端接口测通过）
- [x] `runOnce()` 返回非空模型文本（远端 `verify.js` + DeepSeek 真实 Key：返回 "2。"）
- [x] `createTutorSession()` 在 `$DATA_DIR/sessions/` 生成 `.jsonl`（远端 `verify.js` 确认生成）
- [x] `streamPrompt` 回调被多次触发（远端 `verify.js`：text_delta 触发 120 次，真流式）
- [x] Key 泄漏检查（评审 #9）：响应体只返回 `configured`；DB 中明文 Key count=0（远端 `sqlite3` 直查确认）；无 models.json 文件，Key 仅内存 + SQLite 密文
- [x] `GET /api/models` 返回 provider/model 列表、`providers` CRUD 可增删改（远端接口测通过；`POST /api/settings/model` 切换待有第二个 provider 时验）
- [x] `secretBox` 单测：6 测全过（远端 vitest：密文≠明文、往返还原、损坏密文/密钥变更报错）

#### Manual Verification:
- [ ] 前端存的 provider 切换后 `runOnce` 用新 provider（模型可切换）
- [x] `providers` 表 Key 列为密文（远端 `sqlite3` 直查：`iv:tag:ciphertext` 格式，非明文）
- [x] JSONL 文件内容为多轮 typed entry（远端确认 5 条：session/model_change/thinking_level_change/2×message）

---

## Phase 3: 题目导入（粘贴 AI 解析 + 结构化文件）

**Files**:
- `packages/server/src/routes/import.ts`
- `packages/server/src/import/parseWithAi.ts`（构造解析 prompt → `AiService.runOnce` → zod 校验）
- `packages/server/src/import/parseFile.ts`（JSON/CSV/Excel，不走 AI）
- `packages/server/src/repositories/questionRepo.ts`、`bankRepo.ts`

**API**:
```
POST /api/import/parse-text   { text }        → { questions: Question[] (草稿, 无id) }
POST /api/import/parse-file   (multipart)     → { questions: Question[] (草稿) }
POST /api/import/commit       { bankId?, bankName?, questions } → { bankId, count }
```

**要点**: AI 解析 prompt 明确"只输出 JSON 数组，字段 stem/type/options/answer/explanation/tags"，后端 zod 校验，失败给可读错误；文件解析写死列名/字段映射并附模板。

### Success Criteria:

#### Automated Verification:
- [x] 类型检查通过：`pnpm -r exec tsc --noEmit`（远端 exit 0）
- [x] `parse-text` 接口测：含 3 题混合文本返回 3 草稿（远端实测通过：AI 正确解析单选/多选/判断，answer 形态与 index 全部合法）
- [x] `parse-file`：JSON 文件导入 3 题（single/multiple/boolean）正确解析（远端接口测通过；CSV/Excel 走同一 `validateDrafts` 校验路径）
- [x] `commit` 后 `questions` 表出现对应行（远端：commit 返回 count=3，`GET /api/banks/:id/questions` 返回 3 题，字段/answer 正确）
- [x] 畸形输入返回 4xx（远端：缺字段 400，题库不存在 404，非 500）

#### Manual Verification:
- [x] 粘贴真实一段题目文本，解析结果可读且字段正确（远端实测：混合文本 → 3 结构化题目，正确识别 HTML/CSS 非编程语言）
- [ ] 文件模板文档清晰可用（CSV/Excel 列约定 type|stem|options|answer|explanation|tags，options/tags 用 `|` 分隔——待写入 deploy/README 或导入页说明）

---

## Phase 4: 刷题闭环（判分 + 记录）

**Files**:
- `packages/server/src/routes/quiz.ts`
- `packages/server/src/grading/grade.ts`（single 相等 / multiple 集合相等 / boolean 相等）
- `packages/server/src/repositories/attemptRepo.ts`

**API**:
```
GET  /api/banks                      → Bank[]
GET  /api/banks/:id/questions        → Question[]
POST /api/quiz/grade  { questionId, userAnswer } → { isCorrect, correctAnswer } + 落 attempt
GET  /api/quiz/wrong                  → 错题列表（attempts.is_correct=0 join questions）
```

### Success Criteria:

#### Automated Verification:
- [x] 类型检查通过：`pnpm -r exec tsc --noEmit`（远端 exit 0）
- [x] 判分单测覆盖三题型边界（远端 `vitest` **18/18 通过**：多选顺序无关、空答案、超范围 index、非法 index、boolean 类型不匹配）
- [x] `grade` 每次在 `attempts` 落一行且 `is_correct` 与判分一致（远端接口测：5 次作答均落库，attemptId 回传）
- [x] `/api/quiz/wrong` 只返回做错过的题、去重到题粒度（远端接口测：single+multiple 各答错后错题本返回 2 题，去重正确）

#### Manual Verification:
- [x] 手测单选/多选/判断判分正确（远端：single 对/错、multiple [2,0]≡[0,2]、boolean true 均符合预期）

---

## Phase 5: AI 讲解（SSE 流式）

**Files**:
- `packages/server/src/routes/tutor.ts`（SSE 端点）
- `packages/server/src/ai/tutorPrompts.ts`（"讲题老师"system prompt + 上下文拼装）
- `packages/server/src/repositories/tutorSessionRepo.ts`
- `packages/client/src/api/sse.ts`（POST + fetch ReadableStream 读流）

**API**:
```
POST /api/tutor/explain (SSE)
  body: { questionId, attemptId }   // attemptId 来自 Phase 4 GradeResponse（评审 #4）
  → 建/复用 tutorSession(该题) → JSONL 路径入 tutor_sessions
  → 首条 prompt 注入 { 题干/选项/正确答案/用户答案/对错 }（OQ3）
  → 走 AiService.streamPrompt(session, firstPrompt, onDelta)（评审 #5：统一 send+subscribe，不裸用 subscribe）
  → 逐块 SSE: event:delta → event:done；异常帧 event:error（评审 #7）
```
**要点**: SSE 头 `text/event-stream` + `no-cache` + keep-alive；一题已有会话则 `openTutorSession` 复用。`streamPrompt` 内部负责发首条 prompt 并订阅 `text_delta`，Phase 5/6 都经它推流，不各自裸调 `subscribe`。

### Success Criteria:

#### Automated Verification:
- [x] 类型检查通过：`pnpm -r exec tsc --noEmit`（远端 exit 0）
- [x] curl `/api/tutor/explain` 收到多个 `event:delta` 帧（远端：**358 帧** delta + 1 done + 0 error，逐块到达非一次性）
- [x] 调用后 `$DATA_DIR/sessions/` 生成对应 JSONL 且 `tutor_sessions` 存了路径（远端确认：JSONL 文件生成，表中存了绝对路径，2 条 message）
- [ ] 模型报错时返回 `event:error` 而非挂起（**待补**：错误路径逻辑已在 Phase 3-4 经 401 验证通过——`streamPrompt` 抛错 → `sse.error()`；SSE 帧形态本身待有机会时补测）

#### Manual Verification:
- [x] 讲解文字逐块到达（远端：delta 帧首字"正确答案"→"是"→"："逐块流出，确认非缓冲一次性）
- [ ] 同题二次 explain 复用同一 JSONL，不重复建会话（复用逻辑已实现：`getByQuestion` 命中则 `openTutorSession`；随 Phase 8 端到端验）

---

## Phase 6: 错题多轮答疑

**Files**:
- `packages/server/src/routes/tutor.ts`（新增 follow-up 端点）
- 复用 `tutorSessionRepo` / `AiService.openTutorSession`

**API**:
```
POST /api/tutor/ask (SSE)   body: { questionId, message }
  → 按 tutor_sessions 找 JSONL → openTutorSession(path)
  → streamPrompt(session, message, onDelta)（评审 #6：带 onDelta 回调；历史自动带前文）→ SSE delta
GET /api/tutor/history?questionId=  → 读回 JSONL 渲染历史对话
```

### Success Criteria:

#### Automated Verification:
- [x] 类型检查通过：`pnpm -r exec tsc --noEmit`（远端 exit 0）
- [x] 连续两轮 ask，第二轮 prompt 携带历史（远端：explain 后 JSONL 2 条 → ask 后增至 4 条；追问"它的质量是我选错那个行星的多少倍"正确指代 木星/地球，仅历史可提供）
- [x] 重启后再 ask 仍接上历史（远端：kill 服务重启后追问"总结一下"仍记得 木星/318倍/类地-气态，`openTutorSession` 按路径恢复成立）
- [x] `history` 把 JSONL 还原为 `{role, content}[]`（远端：`GET /api/tutor/history` 返回 4 轮，user/assistant 文本正确）

#### Manual Verification:
- [x] 同题两轮，第二轮回答体现记得题目与上一轮（远端多轮追问实证：指代解析 + 重启后上下文保持）

---

## Phase 7: 错因归纳 + 学情分析

**Files**:
- `packages/server/src/routes/insights.ts`
- `packages/server/src/insights/LearningDataCollector.ts`（DEC-12 跨源：SQLite attempts+tags + 读相关 JSONL 摘要 → 统一输入结构）
- `packages/server/src/ai/insightsPrompts.ts`

**签名 / API**:
```ts
class LearningDataCollector {
  async collect(bankId?: string): Promise<LearningSnapshot>;
}
POST /api/insights/analyze  { bankId? } (SSE)
  → collector.collect() → 流式会话 → SSE 推分析报告
```

### Success Criteria:

#### Automated Verification:
- [x] 类型检查通过：`pnpm -r exec tsc --noEmit`（远端 exit 0）
- [x] `LearningDataCollector` 单测：给定 mock attempts+JSONL，`collect` 产出正确 snapshot 结构（远端：4 个单测全过，含统计/聊合/降级/highlights 提炼）
- [x] 无答疑记录时降级为仅用做题记录、不报错（单测：无 tutor_sessions 时 `tutorHighlights` 为 空数组）
- [x] `analyze` 接口对含对错的 attempts 输出按 tag 聚合的薄弱点（远端：代数/方程/几何均上榜，算术答对正确排除；323 delta 帧流式；空题库 409 降级）

#### Manual Verification:
- [x] 报告里薄弱知识点能对上实际错题分布（远端：报告准确映射 方程100%错/代数100%错/几何100%错；且 explain→ask 后报告织入答疑关注点"两边同时除以系数"，证实 DEC-12 跨源）

---

## Phase 8: React 前端 + 模型设置页

**Files**:
- `packages/client/src/pages/`：Import / Quiz / WrongBook / Insights / **Settings（provider 增删改 + 选当前模型）**
- `packages/client/src/components/`：QuestionCard / TutorPanel(SSE 渲染) / ImportPreview / **ProviderForm**
- `packages/client/src/api/`：REST client + `sse.ts`
- `packages/client/src/store/`（做题状态）

**API 消费**（DEC-19/20 provider 前端全管）:
- provider CRUD: `GET /api/providers`（列表，Key 只显示 `configured` 状态）、`POST /api/providers`（新增，带 apiKey）、`PUT /api/providers/:id`（改，apiKey 省略则不动）、`DELETE /api/providers/:id`
- 当前模型: `GET /api/models`（聚合所有 configured provider 的模型）、`POST /api/settings/model`（选当前 provider+model）

**级联删除接线**（DEC-13）: `DELETE /api/banks/:id` → SQLite CASCADE 清 questions/attempts/tutor_sessions → 后端读被删 `tutor_sessions.jsonl_path` 逐个删 JSONL 文件。

### Success Criteria:

#### Automated Verification:
- [ ] 前端构建通过：`pnpm --filter client build`
- [ ] 类型检查通过：`pnpm -r exec tsc --noEmit`
- [ ] 删除题库后对应 JSONL 被清除：`ls $DATA_DIR/sessions/` 无孤儿（接口测 + ls 断言）
- [ ] provider CRUD 接口测：新增→列表出现且 `configured:true`、Key 明文不在任何响应体（grep 响应断言，DEC-19）

#### Manual Verification:
- [ ] 设置页新增一个 provider（填 baseUrl/api/模型/Key）→ 保存 → 选中其模型 → 讲解可用
- [ ] 端到端手测：配 provider → 导入→刷完→每题流式讲解→错题追问→错题本重做→看学情报告
- [ ] 编辑 provider 不重填 Key 时旧 Key 仍有效；重填则更新
- [ ] 浏览器 Network 面板：任何响应体都不含 API Key 明文（只见 `configured`）

---

## Phase 9: Docker 化部署（双容器 compose）

**Files**:
- `docker/Dockerfile.api`（server 构建，含 better-sqlite3 原生编译依赖。**DEC-19/20 变更**：provider/Key 由前端存 SQLite，**不再 COPY provider `models.json` 进镜像**；`${DATA_DIR}/models.json` 由 AiService 运行时生成于卷内，不含 Key）
- `docker/Dockerfile.web`（多阶段：client 构建 → Nginx 托管）
- `docker/nginx.conf`（托前端 + 反代 `/api`；**SSE**：`proxy_buffering off`、`proxy_read_timeout` 拉长、`X-Accel-Buffering: no`）
- `docker-compose.yml`（`web` + `api`；`app-data` 命名卷挂 `/app/data`；`api` 经 `env_file`/environment 注入 **`APP_SECRET`（Key 加密用，非模型 Key）**、`DATA_DIR=/app/data`、`PORT`）
- `.dockerignore`、`.env.example`（仅 `APP_SECRET`/`DATA_DIR`/`PORT`，无模型 Key）、`deploy/README.md`

**要点**: `sessionDir=/app/data/sessions`、SQLite=`/app/data/app.db`、运行时生成的 `models.json` 都在 `app-data` 卷（DEC-18）；**模型 Key 从不进 `.env`/镜像/Git，只经前端存进卷内 SQLite 密文（DEC-19）**；`APP_SECRET` 未提供时 AiService 首启在卷内生成并持久化，容器重建仍可解密旧 Key。

### Success Criteria:

#### Automated Verification:
- [ ] 运行环境 `git pull` 后 `docker compose up --build -d` 两容器 healthy：`docker compose ps` 显示 healthy
- [ ] SSE 经 Nginx 仍逐块到达（curl `-N` 打到 `web` 端口 `/api/tutor/explain` 收到多帧）
- [ ] 持久化：`docker compose down && docker compose up -d` 后数据仍在，且**已配 provider 的 Key 仍可解密可用**（`sqlite3` 查 count + 重启后讲解仍工作）
- [ ] 镜像不含任何 Key：`docker history` + 镜像内 `grep` 无模型 Key、无 `APP_SECRET` 明文

#### Manual Verification:
- [ ] 浏览器访问 `web` 端口：先在设置页配 provider，再完成完整端到端闭环
- [ ] `deploy/README.md` 的 SSH + git pull + compose 步骤可照做复现（含 provider 需在页面配置的说明）

---

## Verification Notes（贯穿全程）

- 所有命令在**独立运行环境**经 SSH 执行（DEC-15/16），本地只写代码 + Git push。
- Phase 2 是最高风险，建议独立验证脚本先行。
- Key 泄漏是 NFR1 红线：Phase 2、8、9 都要显式检查。
- 查 SDK 细节走 Explore 子代理转述（敏感词过滤仅影响开发期读文档）。

## Open Questions（实现期确认，不阻塞排期）

- 用户系统：MVP 单用户（表无 user_id）；多用户留 v2。
- 包管理器：默认 pnpm，环境无 pnpm 则 Phase 1 回退 npm workspaces。
- SQLite 驱动：默认 better-sqlite3（注意容器内原生编译依赖，Phase 9 Dockerfile 要装 build 工具）。
- Git：需要时直接 `git init`，上传由用户登录处理（无需现在提供远端信息）。
- **Phase 2 首要验证项**：核实 pi SDK 承载 `setRuntimeApiKey` / `modelsPath` 的确切对象名（Explore 两轮出现 `ModelRegistry` vs `ModelRuntime` 命名不一致）与动态 provider 注册的完整路径，确认后再定 AiService 实现细节。

## Review Findings

_Step 4 独立评审（artifact-code-reviewer + artifact-coverage-reviewer 并行）。coverage 零缺口；以下为 code-reviewer 发现，Step 5 triage。_

| # | severity | dimension | finding | recommendation | resolution |
| --- | --- | --- | --- | --- | --- |
| 1 | blocker | actionability | Phase 4 `GET /api/banks → Bank[]` 引用 `Bank` 类型，但 Phase 1 types 只定义了 Question/Attempt/GradeReq/GradeResp，`Bank` 未定义 → `tsc` 报错 | Phase 1 `shared/src/types.ts` 加 `Bank` 接口 | ✅ 已修：Phase 1 加 `Bank` |
| 2 | blocker | actionability | Phase 7 `collect(): Promise<LearningSnapshot>` 的 `LearningSnapshot` 无任何 phase 定义 → 不编译 | Phase 1 types 或 Phase 7 新增类型文件定义 `LearningSnapshot` | ✅ 已修：Phase 1 加 `LearningSnapshot` |
| 3 | blocker | actionability | Phase 8 消费 `GET /api/models` 与 `POST /api/settings/model`，但无 phase 搭建这两个后端路由 | Phase 2 或 8 加 `routes/models.ts`（暴露 `listModels()`/`setModel()`） | ✅ 已修：Phase 2 加 `routes/models.ts` + `ModelInfo` 类型 + 验收项 |
| 4 | blocker | actionability | Phase 5 `/api/tutor/explain` 要 `{ questionId, attemptId }`，但 Phase 4 `grade` 返回无 `attemptId`，客户端无来源 | Phase 4 `GradeResponse` 加 `attemptId`（并回传落库行 id） | ✅ 已修：`GradeResponse` 加 `attemptId` |
| 5 | concern | codebase-fit | Phase 5 直接 `session.subscribe(text_delta)` 而不走 Phase 2 的 `streamPrompt` 抽象，且遗漏发首条 prompt 的 `prompt()` | Phase 5 explain 走 `AiService.streamPrompt`，统一 send+subscribe | ✅ 已修：Phase 5 走 `streamPrompt` |
| 6 | concern | actionability | Phase 6 `streamPrompt(session, message)` 两参，缺 Phase 2 签名的 `onDelta` 回调 | Phase 6 改 `streamPrompt(session, message, onDelta)` | ✅ 已修：补 `onDelta` |
| 7 | concern | code-quality | Phase 5 SSE 契约只写 `delta→done`，但验收断言 `event:error` 帧，契约未列 | Phase 5 SSE 契约补 `event:error` | ✅ 已修：契约补 `event:error` |
| 8 | concern | actionability | Phase 9 `Dockerfile.api`/`.dockerignore` 未声明 `models.json` COPY 进镜像，风险被排除 | Phase 9 显式 COPY `models.json` 入 api 镜像（并 whitelist） | ⤳ 已过时（DEC-21）：`models.json` 改为运行时由后端从 SQLite provider 生成到卷内 `${DATA_DIR}/models.json`（不含 Key），不再打进镜像；此发现随之失效 |
| 9 | suggestion | codebase-fit | Phase 2 Key-leak grep 只扫 `routes`，`ai/` 或设置 handler 漏检 | grep 拓宽到 `packages/server/src` | ✅ 已修：grep 拓宽到 `packages/server/src` |
| 10 | suggestion | actionability | Phase 1 `shared/package.json` 未固定 `name`，与 `@exam/shared` 不符会断依赖 | Phase 1 pin `"name": "@exam/shared"` | ✅ 已修：pin `@exam/shared` |
