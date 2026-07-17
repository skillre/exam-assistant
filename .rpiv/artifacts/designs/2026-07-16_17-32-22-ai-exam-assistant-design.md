---
kind: design
status: ready
created: 2026-07-16T17:32:22+0800
feature: AI 原生考试助手（客观题刷题闭环 MVP）— 系统设计
branch: no-branch
commit: no-commit
repo: 考试助手 (greenfield, not yet a git repo)
source_research: .rpiv/artifacts/research/2026-07-16_16-59-16-pi-sdk-integration-research.md
source_frd: .rpiv/artifacts/discover/2026-07-16_16-59-16-ai-exam-assistant-frd.md
---

# Design — AI 原生考试助手（客观题刷题闭环 MVP）

> 把 research 阶段定下的架构拆成可实现的垂直切片。每个切片 = 一个可独立验证的纵向功能，`## Slices` 边界将 1:1 映射为 plan 阶段的 phase 边界。

## Developer Context（继承的决策，不再重问）

| 决策 | 内容 |
|------|------|
| DEC-1 | MVP 只做客观题闭环（单选/多选/判断），主观题批改推迟 v2 |
| DEC-2 | 题目来源 = 用户导入（粘贴 AI 解析 + 结构化文件） |
| DEC-3 | AI 职责 = 讲解 / 错题多轮答疑 / 错因归纳学情 / 导入解析；判分不用 AI |
| DEC-4 | 技术栈 = React+Vite+TS / Node+TS / SQLite |
| DEC-5 | pi agent SDK 接入，后端持 Key 代理，前端不碰模型 |
| DEC-6 | AI 流式输出；模型可切换（OpenAI 兼容 / ModelRegistry） |
| DEC-7 | 答疑会话历史以 pi JSONL 为真相源，SQLite 只存路径引用，`sessionDir=./data/sessions/` |
| DEC-8 | 流式用 SSE（POST + fetch ReadableStream），非 WebSocket/EventSource |
| DEC-9 | 讲解/答疑会话 `tools: []` 关闭工具，agent 只做纯对话 |
| DEC-10 | 模型经 `models.json` 配置，`.env` 提供 Key，`setModel()` 运行时切换 |

## Design Checkpoint 决策（本轮新增）

| 决策 | 内容 | 理由 |
|------|------|------|
| DEC-11 | 导入解析用**一次性 `inMemory` 会话**，用完 `dispose()` | 无需多轮上下文，不落 JSONL，避免污染会话目录 |
| DEC-12 | 错因/学情输入 = **做题记录(SQLite) + 读回答疑 JSONL** | 更丰富的学情信号；接受 DEC-7 的跨源读取代价，用 `LearningDataCollector` 抽象封装 |
| DEC-13 | 删除题库/题目时**级联删除对应 JSONL 文件** | 数据一致，不留孤儿会话文件 |
| DEC-14 | 后端框架用 **Fastify** | 原生 stream/SSE 支持好，插件化清晰，TS 类型友好 |
| DEC-15 | **Docker 部署，绝不在本地运行/构建/测试**；所有构建/运行/测试在独立运行环境上 | 用户明确约束：本地不装任何依赖 |
| DEC-16 | **SSH 直连 + Git 中转**：代码在本机编写并 push，运行环境 `git pull`；构建/跑容器/看日志/测试由助手经 SSH 远程执行 | 用户指定协作方式 |
| DEC-17 | **双容器 docker compose**：`web`(Nginx 托 React 静态产物 + 反代后端) + `api`(Fastify + pi SDK) | 用户指定拓扑 |
| DEC-18 | **Docker 命名卷持久化**：`app-data` 卷挂到 `/app/data`，装 SQLite + JSONL；容器重建不丢 | 用户指定持久化方式 |
| DEC-19 | **API Key 由前端页面填写，后端存 SQLite（加密），永不回传前端**（只回"已配置"状态）；取代原 `.env`+`models.json` 静态方案 | 用户明确：Key 走前端配置、运行时保存使用；仍满足 NFR1 |
| DEC-20 | **provider 由前端全管（增删改）**：名称/baseUrl/api 类型/模型列表/Key 都在设置页配置，存后端 | 用户指定 |
| DEC-21 | AiService 运行时经 `ModelRuntime.create({ modelsPath })` 载入卷内 `models.json`（只含 baseUrl/api/模型列表，**不含 Key**），并对每个 provider 调 `setRuntimeApiKey(解密 Key)` 注入；Key 只在内存 | Explore 核实 SDK 支持：`setRuntimeApiKey` 不落 auth.json（sdk.md:433/452），`modelsPath` 可指卷内路径（sdk.md:448-452），`pi.registerProvider` 立即生效（custom-provider.md:189） |

---

## Architecture Overview

**Monorepo（pnpm workspace）三包结构**，让前后端共享类型（容器内工作目录 `/app`）：

```
考试助手/
├─ packages/
│  ├─ shared/          # 共享 TS 类型（题目/作答/会话/API 契约）
│  ├─ server/          # Fastify + pi SDK + SQLite
│  └─ client/          # React + Vite
├─ data/               # → 挂载到 Docker 命名卷 app-data（DEC-18）
│  ├─ app.db           # SQLite 单文件
│  └─ sessions/        # pi SDK JSONL 会话文件（DEC-7）
├─ docker/
│  ├─ Dockerfile.api   # Fastify 后端镜像
│  ├─ Dockerfile.web   # 多阶段构建 React → Nginx 静态托管（DEC-17）
│  └─ nginx.conf       # 托前端 + 反代 /api（含 SSE 免缓冲）
├─ docker-compose.yml  # 双容器编排（web + api），app-data 命名卷
├─ models.json         # 模型 provider 配置（DEC-10）
├─ .env                # API Key（仅 api 容器读，DEC-5）
└─ pnpm-workspace.yaml
```

> **部署形态（DEC-15/16/17/18）**：不在本地跑任何东西。代码经 Git 中转到独立运行环境，环境上 `docker compose up --build`。数据全在 `app-data` 命名卷里（`/app/data` → SQLite + JSONL），容器重建不丢。`sessionDir` 在容器内即 `/app/data/sessions`。

**请求流**：

```
React ──REST──▶ Fastify ──▶ 判分(纯程序) / 题库CRUD / 导入 ──▶ SQLite
      ──SSE───▶ Fastify ──▶ AiService ──▶ pi AgentSession ──▶ text_delta 推流
                                              └─▶ JSONL(./data/sessions) + SQLite路径引用
```

---

## Data Model（SQLite schema + 共享类型）

```sql
CREATE TABLE banks (           -- 题库
  id TEXT PRIMARY KEY, name TEXT NOT NULL, created_at INTEGER NOT NULL
);
CREATE TABLE questions (       -- 题目
  id TEXT PRIMARY KEY,
  bank_id TEXT NOT NULL REFERENCES banks(id) ON DELETE CASCADE,
  type TEXT NOT NULL CHECK(type IN ('single','multiple','boolean')),
  stem TEXT NOT NULL,
  options TEXT NOT NULL,       -- JSON 数组
  answer TEXT NOT NULL,        -- JSON: number | number[] | boolean
  explanation TEXT,
  tags TEXT,                   -- JSON 字符串数组
  source TEXT,                 -- 'paste-ai' | 'file'
  created_at INTEGER NOT NULL
);
CREATE TABLE attempts (        -- 做题记录
  id TEXT PRIMARY KEY,
  question_id TEXT NOT NULL REFERENCES questions(id) ON DELETE CASCADE,
  user_answer TEXT NOT NULL,   -- JSON
  is_correct INTEGER NOT NULL, -- 0/1
  answered_at INTEGER NOT NULL
);
CREATE TABLE tutor_sessions (  -- 答疑会话（DEC-7：只存 JSONL 路径引用）
  id TEXT PRIMARY KEY,
  question_id TEXT NOT NULL REFERENCES questions(id) ON DELETE CASCADE,
  jsonl_path TEXT NOT NULL,    -- ./data/sessions/xxx.jsonl
  created_at INTEGER NOT NULL
);
CREATE TABLE providers (       -- 模型 provider（DEC-19/20：前端配置，Key 加密存后端）
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,          -- 展示名，如 "DeepSeek"
  base_url TEXT NOT NULL,
  api TEXT NOT NULL,           -- 'openai-completions' 等
  models TEXT NOT NULL,        -- JSON: [{ id, name }]
  api_key_enc TEXT NOT NULL,   -- 加密后的 Key（DEC-19：永不回传前端）
  created_at INTEGER NOT NULL
);
CREATE TABLE app_settings (    -- 单实例全局设置：当前激活的 provider/model
  key TEXT PRIMARY KEY,        -- 如 'active_provider_id' / 'active_model_id'
  value TEXT NOT NULL
);
```

> 错题本 = `attempts` 上 `is_correct=0` 的视图查询，不单建表。
> Key 加密：用 `APP_SECRET`（compose 环境变量，非 provider Key）做对称加密；缺省时首次启动生成并存卷内。前端读 provider 列表时 `api_key_enc` 一律脱敏为 `{ configured: true }`（DEC-19）。

---

## Slices

每个切片自带 **目的 / 涉及文件 / 关键类型与签名 / Success Criteria**。切片按依赖排序，1:1 成为 plan 的 phase。

### Slice 1 — 项目骨架 + 共享类型 + DB schema

**目的**：立起 monorepo，定义贯通前后端的类型，建 SQLite 表。这是所有切片的地基。

**涉及文件**：
- `pnpm-workspace.yaml`、根 `package.json`、`tsconfig.base.json`
- `packages/shared/src/types.ts`（题目/作答/会话/API 契约类型）
- `packages/server/src/db/schema.sql`、`packages/server/src/db/index.ts`（better-sqlite3 连接 + 建表）
- `packages/server/package.json`、`packages/client/package.json`

**关键类型**（`shared/src/types.ts`）：
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
// API 契约（前后端共用）
export interface GradeRequest { questionId: string; userAnswer: AnswerValue; }
export interface GradeResponse { isCorrect: boolean; correctAnswer: AnswerValue; }
```

**Success Criteria**：
- `pnpm install` 成功，三包互相可引用（`@exam/shared` 被 server/client import 不报错）
- 运行 server 启动脚本时 `data/app.db` 被创建且四张表存在（`sqlite3 data/app.db ".tables"` 显示 banks/questions/attempts/tutor_sessions）
- `tsc --noEmit` 在三包均通过

### Slice 2 — pi SDK 集成层（AiService）

**目的**：把 pi SDK 封装成一个后端服务，屏蔽 SessionManager/AuthStorage/ModelRegistry 细节；提供"建一次性会话"和"建/开文件持久化会话"两种能力。

**涉及文件**：
- `packages/server/src/ai/AiService.ts`
- `packages/server/src/ai/modelConfig.ts`（从 SQLite `providers` 读配置 → 写卷内 `${DATA_DIR}/models.json`(无 Key) → `ModelRuntime.create({ modelsPath })` + `setRuntimeApiKey` 注入解密 Key，DEC-21）
- `packages/server/src/crypto/keyCipher.ts`（用 `APP_SECRET` 对称加解密 Key，DEC-19）
- `packages/server/src/repositories/providerRepo.ts`、`settingsRepo.ts`

> ⚠️ **Phase 2 首要验证项**：Explore 两轮对承载对象命名不完全一致（`ModelRegistry` vs `ModelRuntime`）。实现时先用独立脚本确认 `setRuntimeApiKey` / `modelsPath` 的确切归属对象与调用方式，再封装 AiService。查 SDK 细节走 Explore 子代理转述（规避敏感词过滤）。

**关键签名**：
```ts
class AiService {
  // 一次性会话（DEC-11：导入解析用），用完 dispose
  async runOnce(systemPrompt: string, userPrompt: string): Promise<string>;

  // 文件持久化会话（DEC-7：答疑用），返回会话 + 其 JSONL 路径
  async createTutorSession(opts: { systemPrompt: string }):
    Promise<{ session: AgentSession; jsonlPath: string }>;

  // 按已存路径恢复会话（服务重启后追问用）
  async openTutorSession(jsonlPath: string): Promise<AgentSession>;

  // 订阅 text_delta，逐块回调（供 SSE 用）
  streamPrompt(session: AgentSession, prompt: string,
    onDelta: (chunk: string) => void): Promise<void>;

  setModel(providerId: string, modelId: string): Promise<void>;
  listModels(): { providerId: string; modelId: string; name: string }[];
}
```

**设计要点**：
- `SessionManager.create(cwd, './data/sessions')` 指定会话目录（DEC-7）
- 讲解/答疑会话传 `tools: []`（DEC-9）
- Key 从 SQLite `providers.api_key_enc` 解密后经 `setRuntimeApiKey()` 注入内存（DEC-19/21），不落 `.env`/`models.json`/auth.json；`AiService` 绝不把 Key 返回给任何 handler

**Success Criteria**：
- 配好一个 OpenAI 兼容 provider + `.env` Key 后，`runOnce()` 能返回模型文本（写一个临时脚本验证）
- `createTutorSession()` 在 `./data/sessions/` 生成 `.jsonl` 文件，`streamPrompt` 回调被多次触发（流式）
- grep 全代码库确认 API Key 不出现在任何 HTTP 响应体构造处

### Slice 3 — 题目导入（粘贴 AI 解析 + 结构化文件）

**目的**：跑通两条导入路径 —— 粘贴文本经 AI 解析成结构化题目（DEC-11 一次性会话）、JSON/CSV/Excel 文件按 schema 直接入库。都先返回预览供确认，再入库。

**涉及文件**：
- `packages/server/src/routes/import.ts`
- `packages/server/src/import/parseWithAi.ts`（构造解析 prompt，调 `AiService.runOnce`，校验产出 JSON）
- `packages/server/src/import/parseFile.ts`（JSON/CSV/Excel → Question[]，用 `xlsx`/`csv-parse`）
- `packages/server/src/repositories/questionRepo.ts`

**关键 API**：
```
POST /api/import/parse-text   { text }        → { questions: Question[] (草稿, 无id) }
POST /api/import/parse-file   (multipart)     → { questions: Question[] (草稿) }
POST /api/import/commit       { bankId?, bankName?, questions } → { bankId, count }
```

**设计要点**：
- AI 解析 prompt 里明确要求"只输出 JSON 数组，字段为 stem/type/options/answer/explanation/tags"，后端用 zod 校验，解析失败给出可读错误
- 文件解析不走 AI（可靠、零成本），列名/字段映射写死约定并在 `.md` 里给模板

**Success Criteria**：
- 粘贴一段含 3 道题的混合文本，`parse-text` 返回 3 个结构正确的草稿题（type/answer 合法）
- 上传一个符合模板的 xlsx/csv/json，`parse-file` 正确解析
- `commit` 后 `questions` 表出现对应行，`bankId` 关联正确
- 非法/畸形输入返回 4xx + 明确错误信息，不 500

### Slice 4 — 刷题闭环（判分 + 记录）

**目的**：纯程序确定性判分（不经 AI，DEC-3），记录每次作答，为错题本/学情铺数据。

**涉及文件**：
- `packages/server/src/routes/quiz.ts`
- `packages/server/src/grading/grade.ts`（按 type 判分：single 相等、multiple 集合相等、boolean 相等）
- `packages/server/src/repositories/attemptRepo.ts`

**关键 API**：
```
GET  /api/banks                      → Bank[]
GET  /api/banks/:id/questions        → Question[]
POST /api/quiz/grade  { questionId, userAnswer } → { isCorrect, correctAnswer } + 落 attempt
GET  /api/quiz/wrong                  → 错题列表（attempts.is_correct=0 join questions）
```

**Success Criteria**：
- 三种题型判分正确：单选 index 相等、多选顺序无关的集合相等、判断布尔相等
- 每次 `grade` 在 `attempts` 落一行且 `is_correct` 与判分一致
- `/api/quiz/wrong` 只返回做错过的题，去重到题粒度

### Slice 5 — AI 讲解（SSE 流式）

**目的**：判分后对该题生成"为什么对/为什么错"讲解，SSE 流式推给前端（DEC-8）。此切片创建该题的答疑会话（DEC-7），首条 prompt 注入题目+作答+判分上下文（OQ3）。

**涉及文件**：
- `packages/server/src/routes/tutor.ts`（SSE 端点）
- `packages/server/src/ai/tutorPrompts.ts`（system prompt = "讲题老师"角色 + 上下文拼装）
- `packages/server/src/repositories/tutorSessionRepo.ts`
- 前端 `packages/client/src/api/sse.ts`（POST + fetch ReadableStream 读流）

**关键 API**：
```
POST /api/tutor/explain (SSE)
  body: { questionId, attemptId }
  → 建 tutorSession(该题) → JSONL 路径入 tutor_sessions 表
  → 首条 prompt 注入 { 题干/选项/正确答案/用户答案/对错 }
  → session.subscribe(text_delta) 逐块 SSE: event:delta data:<chunk>
  → 结束 event:done
```

**设计要点**：
- SSE 响应头 `Content-Type: text/event-stream`、`Cache-Control: no-cache`、`Connection: keep-alive`
- 一题已存在 tutorSession 则复用（`openTutorSession`），不重复建

**Success Criteria**：
- 调 `/api/tutor/explain` 时前端能看到文字逐块到达（非一次性整段）
- `./data/sessions/` 生成对应 JSONL，`tutor_sessions` 表存了其路径
- 断网/模型报错时 SSE 发 `event:error` 而非挂起，前端有兜底提示

### Slice 6 — 错题多轮答疑

**目的**：在某题的答疑会话里继续追问，AI 记得题目上下文（同一 `AgentSession`，历史自动累积，OQ3）。

**涉及文件**：
- `packages/server/src/routes/tutor.ts`（新增 follow-up 端点）
- 复用 Slice 5 的 `tutorSessionRepo` / `AiService.openTutorSession`

**关键 API**：
```
POST /api/tutor/ask (SSE)
  body: { questionId, message }
  → 按 tutor_sessions 找该题 JSONL → openTutorSession(path)
  → streamPrompt(session, message) → 历史自动带上前文
  → SSE 推 delta
GET /api/tutor/history?questionId=  → 读回 JSONL 渲染历史对话
```

**Success Criteria**：
- 就同一题连续问 2 轮，第 2 轮回答体现出记得第 1 轮/题目上下文
- 服务重启后再追问仍能接上（`openTutorSession` 按路径恢复历史）
- `history` 能把 JSONL 里的多轮对话正确还原为 {role, content}[]

### Slice 7 — 错因归纳 + 学情分析

**目的**：基于做题记录 + 读回答疑 JSONL（DEC-12），让 AI 汇总薄弱知识点/常见错因。

**涉及文件**：
- `packages/server/src/routes/insights.ts`
- `packages/server/src/insights/LearningDataCollector.ts`（DEC-12 的跨源抽象：查 SQLite attempts+tags + 读相关 JSONL 摘要 → 统一喂给 AI 的输入结构）
- `packages/server/src/ai/insightsPrompts.ts`

**关键签名 / API**：
```ts
class LearningDataCollector {
  // 汇集：错题分布(按 tag) + 做题正确率 + 答疑会话要点
  async collect(bankId?: string): Promise<LearningSnapshot>;
}
POST /api/insights/analyze  { bankId? } (SSE)
  → collector.collect() → runOnce/流式会话 → SSE 推分析报告
```

**Success Criteria**：
- 有一批含对错的 attempts 后，`analyze` 输出按知识点标签聚合的薄弱点（能对上实际错题分布）
- `LearningDataCollector` 单测：给定 mock 的 attempts+JSONL，`collect` 产出正确的 snapshot 结构
- 无答疑记录时降级为仅用做题记录，不报错

### Slice 8 — React 前端 + 模型设置页

**目的**：把闭环在浏览器串起来：导入 → 刷题 → 判分 → 讲解 → 答疑 → 错题本 → 学情；设置页选模型（DEC-10）。前端全程不碰 Key（DEC-5）。

**涉及文件**：
- `packages/client/src/pages/`：Import / Quiz / WrongBook / Insights / Settings
- `packages/client/src/components/`：QuestionCard / TutorPanel(SSE 渲染) / ImportPreview
- `packages/client/src/api/`：REST client + `sse.ts`（Slice 5 已起头）
- `packages/client/src/store/`（做题状态）

**关键 API 消费**（provider/模型全由前端管，DEC-19/20）：
```
GET    /api/providers                 → Provider[]（Key 脱敏为 { configured:true }）
POST   /api/providers  { name, baseUrl, api, models, apiKey } → 新增（Key 加密入库）
PUT    /api/providers/:id             → 编辑（apiKey 省略则不改）
DELETE /api/providers/:id             → 删除
GET    /api/models                    → 汇总所有 provider 的可选模型
POST   /api/settings/model  { providerId, modelId } → 切换当前激活模型
```
Settings 页新增 **Provider 管理面板**：增删改 provider、填/换 Key（Key 输入框永不回填已存值，只显示"已配置"）、选当前模型。前端全程不碰已存 Key（DEC-5/19）。

**级联删除接线**（DEC-13）：
```
DELETE /api/banks/:id → SQLite ON DELETE CASCADE 清 questions/attempts/tutor_sessions
                       → 后端读被删 tutor_sessions.jsonl_path 逐个删 JSONL 文件
```

**Success Criteria**：
- 端到端手测：导入一套题 → 刷完 → 每题看到流式讲解 → 对错题追问 → 错题本可重做 → 看学情报告
- 设置页切换模型后，后续讲解由新模型产生（可通过响应风格或日志确认）
- 删除题库后 `data/sessions/` 对应 JSONL 文件被清除（无孤儿文件）
- 浏览器 Network 面板检查：任何响应体都不含 API Key

### Slice 9 — Docker 化部署（双容器 compose）

**目的**：把整个应用容器化，让它只在独立运行环境上通过 `docker compose up --build` 跑起来（DEC-15/16/17/18）。本地不安装/不构建/不运行——一切经 Git 中转、SSH 远程执行。

**涉及文件**：
- `Dockerfile.api`（`packages/server` 构建：pnpm 安装 + build，暴露 Fastify 端口；含 better-sqlite3 的原生编译依赖）
- `Dockerfile.web`（多阶段：`packages/client` 构建 React 静态产物 → 复制进 Nginx 镜像）
- `nginx.conf`（托管前端静态资源 + 反代 `/api` 到 `api` 容器；**SSE 关键**：`proxy_buffering off`、`proxy_read_timeout` 拉长、`X-Accel-Buffering: no`）
- `docker-compose.yml`（`web` + `api` 两服务；`app-data` 命名卷挂 `api` 的 `/app/data`；`api` 经环境变量注入 `APP_SECRET`（加密 Key 用，**非** provider Key）与 `DATA_DIR=/app/data`）
- `.dockerignore`、`.env.example`、`deploy/README.md`（SSH + git pull + compose 操作说明）

**关键约定**：
- `api` 容器内 `sessionDir=/app/data/sessions`、SQLite=`/app/data/app.db`、`models.json=/app/data/models.json`（运行时生成，无 Key），全在 `app-data` 命名卷（DEC-18），容器重建不丢。
- provider API Key 由前端填写、加密存 SQLite（DEC-19），**不进 `.env`、不进镜像、不进 `models.json`**；容器只需 `APP_SECRET`。
- `web` 容器 Nginx 对 `/api/tutor/*` 与 `/api/insights/*` 这类 SSE 端点必须**关闭代理缓冲**，否则流式讲解会被 Nginx 缓冲成一次性返回。

**Success Criteria**（全部在独立运行环境上、经 SSH 执行验证）：
- 运行环境 `git pull` 后 `docker compose up --build` 两容器均 healthy
- 浏览器访问 `web` 容器端口，能完成端到端闭环（导入→刷题→流式讲解→答疑）
- SSE 讲解在浏览器逐块到达（确认 Nginx 未缓冲）
- `docker compose down && up` 后数据仍在（题库/做题记录/答疑历史 + **已配置的 provider/Key** 未丢——验证命名卷持久化）
- `docker history` / 镜像内检查：镜像层不含任何 provider Key，`APP_SECRET` 不硬编码进镜像
- 前端填一个 provider+Key 保存后，`GET /api/providers` 返回的 Key 字段已脱敏（DEC-19）

---

## Cross-Slice Contracts（切片间共享约定）

- **共享类型**：所有切片从 `@exam/shared` import `Question`/`Attempt`/`AnswerValue`/API 契约，禁止各包私自重定义。
- **AiService 单例**：Slice 2 产出的 `AiService` 由 Fastify 依赖注入（`fastify.decorate('ai', ...)`），Slice 3/5/6/7 复用同一实例。
- **Repository 层**：所有 SQLite 访问经 `*Repo`，路由不直接写 SQL。
- **SSE 事件协议**：统一 `event: delta | done | error`，`data` 为 JSON 或纯文本 chunk，前端 `sse.ts` 统一解析。
- **数据路径**：所有涉及 `data/`（SQLite、`sessions/`）的代码用可配置的基路径（默认 `/app/data`，本地开发可用环境变量覆盖），不硬编码相对路径，以适配容器卷挂载（DEC-18）。
- **执行环境**：任何构建/测试/运行命令都在独立运行环境经 SSH 执行，本地只做编写与 Git push（DEC-15/16）。

## Verification Notes

- **执行位置（DEC-15/16）**：所有 `pnpm install` / `tsc` / 单测 / `docker compose` / 端到端手测都在**独立运行环境**上经 SSH 执行，绝不在本地跑。各切片 Success Criteria 里凡涉及命令执行的，均按"远端执行"理解。实现阶段会先向用户索取 SSH 连接信息（host/user/key）与运行环境的 Git 远端地址。
- Slice 2 是风险最高点（外部 SDK 行为、Key 安全）——建议先写一个独立验证脚本跑通 `runOnce`/`createTutorSession`/`streamPrompt` 再进后续切片。
- 判分（Slice 4）必须有单测覆盖三种题型的边界（多选顺序、空答案、超范围 index）。
- Key 泄漏是 NFR1 红线：Slice 2 与 Slice 8 都要显式 grep/Network 检查。
- 敏感词过滤（读 SDK 文档时遇到过）不影响运行期，仅影响开发期读文档；实现时若需再查 SDK 细节，走 Explore 子代理转述。

## Open Questions（留给 plan/implement）

- 是否需要用户系统？当前设计隐含"单用户"（attempts 无 user_id），部署为 Docker 单实例。若要多用户，需在 5 张表加 `user_id` 并在会话路径分目录 —— 建议 MVP 先单用户。
- **Git 无需现在给信息**（用户确认）：需要时直接 `git init`，上传时用户登录处理。运行环境已就绪。
- **`APP_SECRET` 缺省策略**：compose 未提供时首次启动自动生成并存卷内 `${DATA_DIR}/.app_secret`；若用户换 secret，已加密的 provider Key 需重填。实现期确认是否要求 compose 必填 `APP_SECRET`。
- pnpm workspace vs npm workspace：默认 pnpm，若环境无 pnpm 可回退 npm workspaces（Slice 1 定）。
- better-sqlite3（同步、简单）vs 其他驱动：建议 better-sqlite3，Slice 1 定。
