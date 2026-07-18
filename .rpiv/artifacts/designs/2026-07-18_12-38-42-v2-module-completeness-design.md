---
kind: design
status: ready
created: 2026-07-18T12:38:42+0800
feature: AI 考试助手 v2 — 五大板块功能完整度补齐（系统设计）
branch: main
commit: 678594b
repo: 考试助手
source_frd: .rpiv/artifacts/discover/2026-07-18_12-33-59-v2-module-completeness-frd.md
source_research: .rpiv/artifacts/research/2026-07-18_12-33-59-v2-module-completeness-research.md
---

# Design — v2 五大板块功能完整度补齐

> 在既有 MVP 架构（Fastify + SQLite + pi SDK + React/Vite）之上做**功能补齐**，不做重构（DEC-22）。
> 每个切片 = 一个可独立验证的纵向功能，`## Slices` 边界 1:1 映射 plan 阶段的 phase。

## Developer Context（继承决策，不再重问）

继承 MVP 全部决策 **DEC-1..DEC-21**（见 source_mvp_design）与 v2 新增 **DEC-22..DEC-28**（见 source_frd）。要点复述：

- DEC-22：功能补齐，不重构；建立在既有栈上。
- DEC-24：结构化数据走 REST 即时返回；AI 生成走 SSE 流式。
- DEC-25：进度持久化落 SQLite，不引新存储。
- DEC-26：可视化不引重型图表库，纯 CSS/SVG。
- DEC-27：连接测试用已存解密 Key 发最小请求，结果回传但 Key 绝不回传。
- DEC-28：错题"已掌握"软标记，不物删 attempts。

## 关键约束（research 阶段确认）

- **无 migration 机制**：`db/index.ts` 只 `exec(SCHEMA_SQL)`，全是 `CREATE TABLE IF NOT EXISTS`。v2 新表追加建表 SQL 即可；**新列**需要在 `getDb()` 里加幂等 `ALTER TABLE` 守卫（catch 已存在错误），因为 `ALTER TABLE ... ADD COLUMN` 无 `IF NOT EXISTS`。本设计**优先新表、避免加列**，规避该问题。
- **attempts 是 append-only**：每答一题 INSERT 一行，无 upsert。"最新作答"用 `ORDER BY answered_at DESC LIMIT 1`。
- **类型贯通**：所有新 API 契约进 `@exam/shared`（NFR3）。
- **前端 REST 统一走 `client.ts` 的 `req<T>()`**；SSE 走 `sse.ts` 的 `streamSse()`。
- **provider 变更需 `ai.reloadProviders()`**：连接测试只读不写，无需 reload。

## Architecture Overview

无新增架构层。改动集中在：

```
packages/shared/src/types.ts          ← 新增 v2 契约（PracticeScope/Scorecard/WrongBookItem/ConnTestResult...）
packages/server/src/db/schema.ts      ← 追加 2 张新表（practice_sessions, wrong_book_state）
packages/server/src/repositories/     ← 新增 practiceRepo, wrongBookRepo；扩展 attemptRepo/questionRepo 查询
packages/server/src/routes/           ← 扩展 quiz.ts / insights.ts / providers.ts；REST 新端点
packages/client/src/api/client.ts     ← 新增 REST 调用
packages/client/src/pages/            ← 5 页增强
packages/client/src/components/       ← 新增 Scorecard/QuestionNav/WeakTagChart/DraftEditor 等
```

数据流不变：结构化 → REST（`req<T>`），AI 文本 → SSE（`streamSse`）。

---

## Slices（1:1 映射 plan phase）

### Slice 1 — 共享契约与数据层地基（shared + schema + repos）

**目标**：一次性把 v2 所有新类型、新表、新仓储查询建好，后续切片只消费不再改地基。

**shared 新增类型**（`packages/shared/src/types.ts`）：
```ts
// 练习范围与会话
export type PracticeMode = 'all' | 'undone' | 'wrong' | 'byType' | 'byTag';
export interface PracticeScope {
  bankId: string;
  mode: PracticeMode;
  type?: QuestionType;   // mode=byType
  tag?: string;          // mode=byTag
  shuffle?: boolean;
}
export interface PracticeSession {
  id: string;
  bankId: string;
  questionIds: string[];  // 定序后的题目 id 列表
  currentIndex: number;
  createdAt: number;
  scope: PracticeScope;
}
export interface StartPracticeRequest { scope: PracticeScope; }
export interface UpdatePracticeRequest { currentIndex: number; }

// 成绩单
export interface Scorecard {
  sessionId: string;
  total: number;
  answered: number;
  correct: number;
  accuracy: number;           // 0..1
  byType: { type: QuestionType; total: number; correct: number }[];
  byTag: { tag: string; total: number; correct: number }[];
  wrongQuestionIds: string[];
}

// 错题本增强
export interface WrongBookItem {
  question: Question;
  wrongCount: number;
  lastWrongAt: number;
  mastered: boolean;
}
export interface WrongBookQuery { bankId?: string; type?: QuestionType; tag?: string; includeMastered?: boolean; }

// 连接测试
export interface ConnTestResult { ok: boolean; message: string; latencyMs?: number; }
```

**schema 新增表**（`schema.ts`，追加到 `SCHEMA_SQL`）：
```sql
CREATE TABLE IF NOT EXISTS practice_sessions (
  id           TEXT PRIMARY KEY,
  bank_id      TEXT NOT NULL REFERENCES banks(id) ON DELETE CASCADE,
  question_ids TEXT NOT NULL,       -- JSON string[]
  current_index INTEGER NOT NULL DEFAULT 0,
  scope        TEXT NOT NULL,       -- JSON PracticeScope
  created_at   INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS wrong_book_state (
  question_id TEXT PRIMARY KEY REFERENCES questions(id) ON DELETE CASCADE,
  is_mastered INTEGER NOT NULL DEFAULT 0,
  mastered_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_practice_bank ON practice_sessions(bank_id);
```

**新仓储**：
- `practiceRepo.ts`：`create(scope, questionIds)` / `get(id)` / `updateIndex(id, idx)` / `remove(id)`。遵循 attemptRepo 的 Row-interface + `toXxx()` 风格。
- `wrongBookRepo.ts`：`setMastered(qid, bool)` / `getState(qid)` / `listStates()`（返回 map）。
- `attemptRepo.ts` 扩展：`listWrongDetailed()` 返回 `{questionId, wrongCount, lastWrongAt}` 聚合（`GROUP BY question_id`，`SUM(is_correct=0)`、`MAX(answered_at) WHERE is_correct=0`）；`answeredQuestionIds(bankId)`（去重已作答集）；`latestByQuestion(qids)`（每题最新一次对错）。
- `questionRepo.ts` 扩展：`listByBankFiltered(bankId, {type,tag})` 或在路由层过滤（题量小，路由层过滤更简单）。

**验证**：`tsc` 编译 shared+server 通过；新表建表幂等（重启不报错）。

---

### Slice 2 — 练习会话后端（范围/筛选/乱序/进度/成绩单）

**目标**：Quiz 的服务端能力：按范围选题、定序、存进度、算成绩单。

**新端点**（`routes/quiz.ts` 扩展）：
- `POST /api/practice/start`（Body `StartPracticeRequest`）→ 按 `scope` 解析题目集：
  - `all`：`questionRepo.listByBank`
  - `undone`：全集 − `attemptRepo.answeredQuestionIds(bankId)`
  - `wrong`：`listWrongDetailed` 过滤未 mastered 的题
  - `byType`/`byTag`：过滤
  - `shuffle`：Fisher-Yates 打乱
  - 落 `practiceRepo.create`，返回 `PracticeSession`。
- `GET /api/practice/:id` → 返回 `PracticeSession`（续做用）。
- `PATCH /api/practice/:id`（Body `UpdatePracticeRequest`）→ `updateIndex`，返回 204。
- `GET /api/practice/:id/scorecard` → 组装 `Scorecard`：对 session.questionIds 取每题最新 attempt，聚合 byType/byTag、wrongQuestionIds。

**空集处理**：解析出 0 题返回 409 `{error:'该范围下没有题目'}`（沿用 insights 空记录 409 风格）。

**验证**：`tsc` 通过；curl 走通 start→patch→scorecard；乱序两次顺序不同。

---

### Slice 3 — 练习会话前端（QuizPage 重构 + 成绩单/导航组件）

**目标**：QuizPage 接入范围选择、题号导航、进度续做、成绩单。

- QuizPage 增加"开始练习"配置区（范围下拉 + 题型/标签 + 乱序开关），调用 `POST /api/practice/start`。
- 新组件 `QuestionNav.tsx`：题号网格，标记已答/未答/对错，点击跳转（FR1.4）。
- 作答后 `PATCH` 保存 currentIndex；页面加载时若 localStorage 存有 sessionId 则 `GET /api/practice/:id` 续做（FR1.3）。
- 走到最后一题后"查看成绩单"→ `GET .../scorecard`，渲染新组件 `Scorecard.tsx`（正确率/分布/错题入口，纯 CSS 条形，DEC-26）。
- 键盘操作（FR1.6，渐进增强）：数字键选项、Enter 提交、←/→ 翻题，绑在 QuizPage useEffect。

**验证**：`pnpm --filter client build` 通过；手动走一套练习→成绩单；刷新后续做。

---

### Slice 4 — 错题本增强（后端聚合 + 掌握标记 + 前端筛选/分组）

**目标**：WrongBook 从只读列表升级为可管理复习工具。

**后端**（`routes/quiz.ts`）：
- 改造 `GET /api/quiz/wrong`：接 query `bankId/type/tag/includeMastered`，返回 `WrongBookItem[]`（JOIN `attemptRepo.listWrongDetailed` + `wrongBookRepo.listStates`，默认排除已掌握）。
- `POST /api/quiz/wrong/:questionId/master`（Body `{mastered:boolean}`）→ `wrongBookRepo.setMastered`，返回 204。

**前端**（`WrongBookPage.tsx`）：
- 顶部筛选栏（题库/题型/标签下拉）。
- 每题显示错误次数、最近错误时间（FR2.3）；"标记已掌握"按钮（软移除，可切"显示已掌握"恢复，FR2.1）。
- 可选按标签分组展示（FR2.2）。
- 重做答对后提示"标记掌握"（FR2.4）。

**验证**：`tsc` + client build；curl 标记掌握后列表排除该题，includeMastered=1 时回显。

---

### Slice 5 — 学情可视化（snapshot REST + 面板 + 下钻）

**目标**：把后端已算的 `LearningSnapshot` 以结构化面板即时呈现，AI 文本报告并存。

**后端**（`routes/insights.ts`）：
- 新增 `GET /api/insights/snapshot?bankId=` → `learningDataCollector.collect(bankId)` 直接 `reply.send(snapshot)`（REST，非 SSE；DEC-24）。空记录返回 200 空快照而非 409（面板要能显示"暂无数据"）。
- 保留现有 `POST /api/insights/analyze`（SSE 文本）不变。

**前端**（`InsightsPage.tsx`）：
- 进页即 `GET /api/insights/snapshot` 渲染 `InsightsPanel.tsx`：正确率环/条、`weakTags` 条形（纯 CSS/SVG，DEC-26）、`tutorHighlights` 列表（FR3.1/3.3）。
- "生成 AI 报告"按钮触发原 SSE 文本，面板与文本并存（FR3.2）。
- 薄弱知识点可点击 → 跳转到"按该标签筛选"的错题/刷题视图（FR3.4，用 URL query 或共享 state 传 tag）。

**验证**：client build；进页无需点按钮即见面板；点标签跳转到筛选视图。

---

### Slice 6 — 导入预览可编辑 + 校验（Import）

**目标**：解析后的草稿在入库前可逐题编辑/增删，入库前校验提示。

**后端**（`routes/import.ts`）：
- commit 前用现有 `questionDraftArraySchema` 已校验；新增一个轻量 `POST /api/import/validate`（Body `{questions}`）返回逐条校验结果 `{index, ok, errors[]}[]`，供前端即时反馈（复用 `questionSchema.ts`，收集 issue 而非抛错）。

**前端**（`ImportPage.tsx` + 新 `DraftEditor.tsx`）：
- 预览列表每题可编辑（题干/选项增删/答案/题型/标签/解析），FR4.1。
- 可删除某题、手动新增一题（FR4.2）。
- 入库前对每题做前端校验（答案越界/选项空/多选无答案）并高亮提示（FR4.3），可选调 `/api/import/validate` 二次确认。

**验证**：client build；编辑一题答案后入库，DB 中为编辑后值；非法答案被拦截提示。

---

### Slice 7 — 设置连通性验证（Settings）

**目标**：provider 配置后可测试 Key 是否可用，结果回传但 Key 不回传。

**后端**（`routes/providers.ts`）：
- `POST /api/providers/:id/test` → 用该 provider 已存**解密 Key** 走 `AiService`：临时用该 provider 首个模型 `runOnce(system='ping', user='reply OK')`，成功返回 `{ok:true, latencyMs}`，失败返回 `{ok:false, message}`（DEC-27）。**响应体绝不含 Key**（NFR1）。
  - 实现注意：`runOnce` 用当前激活模型；测试需指定 provider/model，故新增 `AiService.testProvider(providerId, modelId)` 或临时 `setModel` 后 `runOnce` 再恢复。设计选**新增 `testProvider`**，用指定 model 建一次性会话，避免污染全局激活模型。

**前端**（`SettingsPage.tsx` + `ProviderForm.tsx`）：
- 每个 provider 卡片加"测试连接"按钮，展示成功（含延迟）/失败（含原因）（FR5.1/5.2）。

**验证**：`tsc` + client build；curl 测试有效 Key 返回 ok:true、无效 Key 返回 ok:false，响应体不含 Key 明文。

---

## 切片依赖与并行

- **Slice 1 是地基**，Slice 2-7 全部依赖它。
- Slice 2→3（后端先于前端）；Slice 4 前后端可同切片内做。
- Slice 5/6/7 相互独立，Slice 1 完成后可并行。

## 风险与缓解

| 风险 | 缓解 |
|------|------|
| 无 migration，新表在已有 DB 上首启 | 全 `CREATE TABLE IF NOT EXISTS`，天然幂等；避免加列 |
| `testProvider` 临时切模型污染全局激活 | 新增独立 `testProvider(providerId, modelId)`，不碰 `settingsRepo` |
| 进度 localStorage 与后端 session 不一致 | 以后端 `GET /api/practice/:id` 为准，localStorage 只存 id |
| 可视化引入重型库 | 纯 CSS/SVG 条形，禁引 chart 库（DEC-26） |
| shuffle 后续做顺序错乱 | questionIds 定序落库，续做读回原顺序 |

## 验收映射（FRD → Slice）

| FRD FR | Slice |
|--------|-------|
| FR1.1-1.6 答题闭环 | 2 + 3 |
| FR2.1-2.4 错题本 | 1 + 4 |
| FR3.1-3.4 学情可视化 | 5 |
| FR4.1-4.3 导入 | 6 |
| FR5.1-5.2 设置 | 7 |
