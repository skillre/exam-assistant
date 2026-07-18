---
kind: research
status: ready
created: 2026-07-18T12:33:59+0800
feature: AI 考试助手 v2 — 五大板块功能完整度补齐
branch: main
commit: 678594b
repo: 考试助手
source_frd: .rpiv/artifacts/discover/2026-07-18_12-33-59-v2-module-completeness-frd.md
---

# Research — v2 五大板块功能完整度补齐

> 针对 FRD 的 OQ1..OQ6，用并行 codebase-analyzer 逐一落到 file:line 证据。结论供 design 阶段直接消费。

## Developer Context（继承决策）

继承 MVP 的 DEC-1..21 + v2 FRD 的 DEC-22..28。核心约束：**不重构架构、不引入重型依赖、结构化数据走 REST、AI 内容走 SSE、Key 永不回传**。

## 关键架构事实（证据）

| 事实 | 证据 |
|------|------|
| 无 migration 机制 | `db/index.ts:29` `exec(SCHEMA_SQL)`，全为 `CREATE TABLE IF NOT EXISTS`，无版本表 |
| attempts 是 append-only | `attemptRepo.ts:21-33` 每次 `INSERT` 一行，无 upsert |
| 错题判定口径 | `attemptRepo.ts:64-73` `SELECT DISTINCT q.* JOIN attempts WHERE is_correct=0`，做对也保留 |
| 校验用 Zod | `questionSchema.ts:1` `import { z }`，`superRefine` 按题型交叉校验 answer |
| commit 二次校验 | `import.ts:68` 入库前再 `validateDrafts()`，不信任前端 |
| snapshot 已算好但没回传 | `insights.ts:15` `collect()` 得完整 `LearningSnapshot`，仅喂 AI prompt（`insights.ts:23`），从不 JSON 返回 |
| runOnce 是最小请求路径 | `AiService.ts:71-89` `runOnce` 用 `inMemory` 会话跑一次 prompt，可复用作连接测试 |
| provider 解密 Key 内存注入 | `providerRepo.listWithKeys()`（`:55-63`）解密；`modelRuntimeSetup.ts:20-37` `registerProvider` 注入内存 |
| 前端 fetch wrapper | `client.ts:8-21` `req<T>()` 统一处理 JSON/error/204 |
| 路由风格 | `app.post<{ Body }>`，内联手动校验，`{ error }` 格式，无中间件 |

## OQ1 — 练习进度/会话如何落库

**结论：新建 `practice_sessions` 表（方案A）**，不改 attempts。
- 表：`(id TEXT PK, bank_id TEXT REFERENCES banks ON DELETE CASCADE, mode TEXT, question_ids TEXT/*JSON 顺序*/, current_index INTEGER, filter TEXT/*JSON 范围条件*/, created_at, updated_at)`。
- 续做：读 `current_index` + 该 session 的 `question_ids` 顺序；对错状态由 attempts 派生。
- 理由：符合"每实体一表"风格；不破坏 attempts append-only 语义；迁移只需在 SCHEMA_SQL 追加建表。

## OQ2 — "仅未做/仅错过"判定口径

- **未做**：`SELECT 1 FROM attempts WHERE question_id=? LIMIT 1` 无行 = 未做（现无此查询，需新增）。
- **错过**：沿用 `attemptRepo.ts:64-73` 口径 —— 存在 `is_correct=0` 记录即错题（做对也保留）。
- **多次作答取最新**：`ORDER BY answered_at DESC LIMIT 1`，保持 append-only，不加 is_latest 列。

## OQ3 — 错题"已掌握"软标记落点

**结论：新建 `wrong_book_state` 表（方案C）**。
- 表：`(question_id TEXT PK REFERENCES questions ON DELETE CASCADE, is_mastered INTEGER DEFAULT 0, mastered_at INTEGER)`。
- 理由：attempts 加列语义错位（每行都要更新）；questions 加列破坏纯题目语义；独立状态表最贴合 tutor_sessions 的"关联状态"模式，CASCADE 自动清理。
- 联动：错题列表 `LEFT JOIN wrong_book_state`，`is_mastered=1` 的从错题本过滤（软移除，可恢复）。
- 新 `wrongBookRepo.ts` 遵循 `attemptRepo` 的 Row interface + `toXxx()` 映射 + 命名参数风格。

## OQ4 — 学情结构化面板 API

**结论：新增 `GET /api/insights/snapshot?bankId=`（REST，非 SSE）**，与现有 `POST /api/insights/analyze`（SSE 文本）并存。
- `collect(bankId)` 已返回完整 `LearningSnapshot`（`types.ts:104-109` 已定义，无需改 shared 类型）。
- 空记录返回 200 空快照（`totalAttempts:0`）而非 409，让前端面板显示"暂无数据"。
- 前端加 `api.getInsightsSnapshot(bankId?)`，进页面即拉，AI 文本按需再点。

## OQ5 — 连接测试实现

**结论：新增 `POST /api/providers/:id/test`，body `{ modelId }`**。
- 复用 `runOnce` 模式：`providerRepo.get(id)` 存在检查 → `listWithKeys()` 取解密 Key → 独立 `ModelRuntime`+`registerProvider` → `createAgentSession({ noTools:'all', inMemory })` → 发极短 prompt → `dispose()`。
- 超时：外层 `AbortSignal.timeout(15_000)` / `Promise.race`（SDK 无内置超时）。
- 错误归类：`401/403`→认证失败；`ECONNREFUSED/ENOTFOUND`→网络；`ETIMEDOUT/AbortError`→超时；`lastMessageError()`→模型端错误。
- 返回 `{ ok:true }` 或 `{ ok:false, error }`，**Key 绝不回传**（NFR1/DEC-27）。

## OQ6 — 导入预览可编辑

- 现 `ImportPage.tsx:9-14` `drafts` 只读渲染（`:131-146` 静态 div）。
- 改造：`drafts` 可变，`onUpdateDraft(i, partial)` / `onAddDraft()` / `onDeleteDraft(i)`。
- 新建 `DraftEditor` 组件复用 `QuestionCard` 的题型 switch，但渲染改为表单输入（option `<input>` + answer 按 type 联动选择器）。
- **校验复用**：把 `questionSchema.ts` 的 Zod schema 迁移/导出到 `@exam/shared`（schema 本身无 server 依赖），前端 commit 前 `safeParse` 逐题校验；后端 `import.ts:68` 二次校验保留。

## 对 Design 的输入（新增 schema / API / 组件清单）

**SQLite 新增（追加到 SCHEMA_SQL，全部 IF NOT EXISTS）**：
- `practice_sessions`（练习进度）
- `wrong_book_state`（错题掌握标记）

**新增/改动 API**：
- `GET /api/insights/snapshot?bankId=` — 学情结构化快照（REST）
- `POST /api/providers/:id/test` — 连接测试
- `POST /api/practice/sessions` / `GET /api/practice/sessions/:id` / `PATCH .../:id` — 练习会话续做
- `GET /api/quiz/questions?bankId=&mode=&type=&tag=&shuffle=` — 带筛选/乱序的取题
- `POST /api/wrong/:questionId/master` / `DELETE .../master` — 掌握标记切换
- `GET /api/quiz/wrong` 扩展返回 `wrongCount` / `lastWrongAt` / `mastered`

**shared 类型新增**：`PracticeSession`、`PracticeMode`、`QuizFilter`、`WrongBookEntry`（含统计）、`ConnectionTestResult`、迁移 `questionDraftArraySchema` 到 shared。

**前端组件新增**：`DraftEditor`、`ScoreCard`（成绩单）、`QuestionNav`（题号导航）、`InsightsPanel`（结构化可视化，纯 CSS/SVG 条形图）。
