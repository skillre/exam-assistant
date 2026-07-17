---
kind: research
status: ready
created: 2026-07-16T16:59:16+0800
feature: AI 原生考试助手 — pi SDK 集成与后端架构研究
branch: no-branch
commit: no-commit
repo: 考试助手 (greenfield, not yet a git repo)
source_frd: .rpiv/artifacts/discover/2026-07-16_16-59-16-ai-exam-assistant-frd.md
---

# Research — pi agent SDK 集成与后端架构

> 目标:回答 FRD 里的 OQ1–OQ5,把「AI 原生考试助手」后端如何接 pi SDK、会话如何持久化、模型如何切换、流式怎么传这几件事定清楚,为 design 阶段铺路。
>
> 说明:本项目是全新空目录,无既有代码可探查。研究对象是**外部 SDK**(`@earendil-works/pi-coding-agent`)与几个架构选型。SDK 事实来自本地文档 `docs/sdk.md` / `docs/models.md` / `docs/providers.md` / `docs/session-format.md` / `docs/custom-provider.md`(经子代理转述,规避了敏感词过滤)。带 `file:line` 的引用指向这些文档。

## Developer Context（继承自 FRD Decisions + 本轮 checkpoint）

- **Q (discover: DEC-1)**:MVP 范围? → **A**:只做客观题闭环,主观题批改推迟 v2。
- **Q (discover: DEC-2)**:题目来源? → **A**:用户导入(粘贴 AI 解析 + 结构化文件)。
- **Q (discover: DEC-3)**:AI 职责? → **A**:讲解 / 错题多轮答疑 / 错因归纳学情 / 导入解析;判分不用 AI。
- **Q (discover: DEC-4)**:技术栈? → **A**:React+Vite+TS / Node+TS / SQLite。
- **Q (discover: DEC-5)**:AI 接入? → **A**:pi agent SDK,后端持 Key 代理,前端不碰模型。
- **Q (discover: DEC-6)**:输出与模型? → **A**:流式;模型可切换(OpenAI 兼容 / ModelRegistry)。
- **Q (research checkpoint: 会话存储)**:答疑会话历史真相源? → **A**:**pi JSONL 为真相源**。让 pi SDK 把每个答疑会话持久化成 JSONL 文件,SQLite 只存文件路径引用,不自己重建对话历史。→ 记为 **DEC-7**。

## Discovery Summary

pi SDK 是 Node/TypeScript 包,核心是 `createAgentSession()` 工厂:它组合 `SessionManager`(会话历史)、`AuthStorage`(凭据)、`ModelRegistry`(模型)三个协作对象,返回一个 `AgentSession`。会话可用 `inMemory()` 或**文件持久化**(JSONL,存 `~/.pi/agent/sessions/`)。历史在单个 `AgentSession` 内跨 `prompt()` 自动累积;一个 Node 进程可并行持有多个独立会话。模型接入走 `models.json`(OpenAI 兼容,支持 DeepSeek/Kimi/智谱),凭据按 `auth.json → 环境变量 → models.json` 优先级解析。系统提示词与工具集可通过 `ResourceLoader`/`tools` 选项定制。

---

## OQ1 — 会话如何映射到「每道题一个答疑会话」+ 历史存哪里

**决策(DEC-7):pi JSONL 为真相源。**

- 用 `SessionManager.create(cwd, sessionDir)` 为**每个 (用户 × 题目) 答疑**创建一个文件持久化会话,SDK 把对话写成 **JSONL** 文件(`docs/session-format.md`:每行一条 typed entry,`id`/`parentId` 连成会话树)。
- 我们的 **SQLite 只存该 JSONL 的文件路径引用** + 元数据(哪道题、哪个用户、创建时间),不复制对话内容。
- 恢复会话:服务重启后用 `SessionManager.open(path)` 按路径加载,历史自动重建;`buildSessionContext()` 还原消息列表/模型/thinking(`docs/session-format.md`)。
- 一个 Node 进程可并行持有多个 `AgentSession`,互不干扰,适合"多题/多用户同时答疑"。
- **建议**:把 `sessionDir` 显式指到项目内目录(如 `./data/sessions/`),而非默认 `~/.pi/agent/sessions/`,让所有数据都在项目部署里(呼应 NFR4 数据本地掌控)。

> 代价(需在 design 时注意):对话内容在 JSONL、做题记录在 SQLite,跨源分析(如"把答疑内容并入学情报告")需要读文件+查库两步。DEC-7 已接受此代价换取"不用自己管上下文"。

## OQ2 — 题目结构化 schema 最小字段集

不依赖 SDK,属产品数据建模。建议最小字段集(design 阶段细化为 SQLite 表 + 共享 TS 类型):

- `id`、`bankId`(所属题库)
- `type`:`single` | `multiple` | `boolean`(单选/多选/判断)
- `stem`(题干)
- `options`:选项数组(判断题可固定为对/错)
- `answer`:正确答案(单选 index、多选 index 数组、判断 bool)
- `explanation?`(题目自带解析,可空,AI 讲解可补充)
- `tags?`(知识点标签,供错因归纳/学情)
- `source?`(导入来源:paste-ai / file)

## OQ3 — 多轮答疑上下文如何注入

- **题目 + 作答 + 判分结果**在**该题答疑会话的第一次 `prompt()`** 里作为上下文注入(拼进首条 prompt,或经 `ResourceLoader` 的 `systemPromptOverride` 定制系统提示词把角色设为"讲题老师")。
- 之后的追问用**同一个 `AgentSession` 的 `prompt()`**——历史在会话内**自动累积**(`docs/sdk.md`:每次 `prompt()` 发送累积的 `session.agent.state.messages` + 新输入),无需我们手动拼历史。
- 客观题讲解**不需要工具**,建议用 `tools: []` 或 `noTools` 关闭内置工具,避免 agent 去读文件/跑 shell(`docs/sdk.md`)。
- 流式期间要排队消息可用 `steer()`(打断/改向)或 `followUp()`(等空闲后追加);MVP 简单同步问答用基本 `prompt()` 即可。

## OQ4 — 流式:SSE vs WebSocket

**决策建议:SSE(POST + fetch ReadableStream)。**

- AI 讲解/答疑是**单向服务器推流**,SSE 天然契合,比 WebSocket 简单(无需握手/心跳/双向状态)。
- 用 **POST + fetch + ReadableStream** 而非原生 `EventSource`——因为要在请求体里带题目/作答上下文,`EventSource` 只支持 GET。
- 后端 `session.subscribe()` 拿到 `message_update` 的 `text_delta`,逐块 `write` 到 SSE 响应流(`docs/sdk.md` Quick Start 展示了 `text_delta` 订阅)。

## OQ5 — 模型如何配置 + 可切换

- **配置文件**:`models.json` 定义自定义 OpenAI 兼容 provider:
  ```json
  {
    "providers": {
      "deepseek": {
        "baseUrl": "https://api.deepseek.com/v1",
        "apiKey": "$DEEPSEEK_API_KEY",
        "api": "openai-completions",
        "models": [{ "id": "deepseek-chat", "name": "DeepSeek Chat" }]
      }
    }
  }
  ```
  (`docs/custom-provider.md` / `docs/models.md` / `docs/providers.md`)
- **Key 来源**:`apiKey: "$DEEPSEEK_API_KEY"` 读环境变量(`.env`),凭据解析优先级 `auth.json → 环境变量 → models.json`。Key 只在后端,满足 NFR1。
- **切换**:`ModelRegistry.create(authStorage)` 后 `registry.find(provider, modelId)` 取模型,`session.setModel(model)` 运行时切换;也有 `cycleModel()`。设置页可列出 `models.json` 里的 provider/model 供用户选。

---

## Recommended Backend Architecture（供 design 消费）

```
React+Vite (前端, 不碰 Key)
   │  REST (导入/判分/题库/错题) + SSE (AI 讲解/答疑流)
   ▼
Node+TS 后端 (Express/Fastify)
   ├─ 判分:纯程序,确定性
   ├─ 导入解析:调 pi AgentSession(一次性 inMemory 会话)→ 结构化 JSON
   ├─ 讲解/答疑:每题一个文件持久化 AgentSession(JSONL, DEC-7)
   │     └─ session.subscribe(text_delta) → SSE 推流
   ├─ 错因/学情:读做题记录 + (可选)答疑 JSONL → AgentSession 汇总
   ├─ SQLite:题库/题目/做题记录/错题 + 答疑会话的 JSONL 路径引用
   └─ pi SDK: SessionManager(sessionDir=./data/sessions) + AuthStorage + ModelRegistry
   ▼
models.json + .env (模型 provider/Key, 仅后端)
```

## Code References（本项目暂无代码;指向 SDK 文档锚点）

- `createAgentSession()` / 事件订阅:`docs/sdk.md` Quick Start & Core Concepts
- `SessionManager` 模式(inMemory/create/open/continueRecent/forkFrom):`docs/sdk.md`
- JSONL 会话格式(id/parentId 树、buildSessionContext):`docs/session-format.md`
- `AuthStorage` 凭据优先级:`docs/sdk.md` / `docs/providers.md`
- 自定义 OpenAI 兼容 provider:`docs/custom-provider.md` / `docs/models.md`
- 系统提示词/工具定制:`docs/sdk.md`(`systemPromptOverride`、`tools`/`noTools`)

## Decisions（本轮新增）

- **DEC-7**:答疑会话历史以 **pi SDK JSONL 文件为真相源**;SQLite 只存路径引用。建议 `sessionDir` 指向项目内 `./data/sessions/`。
- **DEC-8(建议)**:流式用 **SSE(POST+fetch ReadableStream)**,非 WebSocket / EventSource。
- **DEC-9(建议)**:讲解/答疑会话 `tools: []` 关闭工具,agent 只做纯对话。
- **DEC-10(建议)**:模型经 `models.json`(OpenAI 兼容)配置,`.env` 提供 Key,`setModel()` 运行时切换。

## Open Questions（留给 design）

- OQ-A:导入解析用一次性 `inMemory` 会话还是复用长驻会话?(倾向 inMemory,一次性任务)
- OQ-B:错因/学情汇总要不要把答疑 JSONL 内容读回并入,还是只基于结构化做题记录?(涉及 DEC-7 的跨源代价)
- OQ-C:JSONL 会话文件的清理/归档策略(题库删除时对应会话文件怎么处理)。
- OQ-D:后端框架选 Express 还是 Fastify?(Fastify 对 SSE/流更友好,待 design 定)
