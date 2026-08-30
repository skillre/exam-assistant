# t9–t10 集成终审报告（2026-08-28）

> 审查类型：**只读最终集成终审**（t10 并行实施中）。本报告仅新增本文件，未修改任何 `.ts/.tsx/.css` 实现或测试文件。
> 审查对象：`packages/dsh-exam`（宿主 `src/host/*`、客户端 `src/client/*`、测试 `src/host/*.test.ts`、验收矩阵 `specs/verification/ACCEPTANCE-MATRIX-M0-M4-2026-08-27.md`）。
> 门禁快照时间：2026-08-28 12:06–12:08（Asia/Shanghai）。

---

## 0. 执行摘要（TL;DR）

| 层 | 状态 | 说明 |
|---|---|---|
| 宿主层（Host） | ✅ **全部落地且绿** | `tsc -p tsconfig.build.json`（宿主构建）通过；测试 **167/167 全绿**；迁移/契约/错误码/领域不变量/AI 可靠性全部核实。 |
| 客户端（Client，t10） | ⚠️ **半成品 / 重构进行中** | `src/client/api.ts` 刚由「signal 传参」迁移为「options/filter 传参」（与 Host t9 一致），但 `BankDetail/PracticeView/WrongView/ExamWorkspace` 等调用点未全部同步 → **当前 typecheck 与 client-dts 构建失败**。 |
| 交付判断 | ❌ **暂不可交付** | 阻塞项为 t10 客户端迁移收口（编译期签名不一致），非行为性缺陷。Host 层已达到可交付标准。**待 t10 完成后重跑门禁再下最终结论。** |

> 关键区分：本次 `typecheck`/`build` 失败是 t10 **进行中的重构中间态**（调用点与签名不同步），不是既有功能的回归。宿主构建与 `tsdown` runtime bundle 均通过（`client.js 282.90 kB / gzip 55.52 kB`，「Build complete」），唯一失败点是 client 的 `tsc -p tsconfig.client-dts.json` `.d.ts` 类型校验步骤。宿主行为 167/167 全绿，零回归。

---

## 1. 逐项核对结论（证据 file:line）

### 1.1 迁移完整性 —— ✅ 通过

- **v6/v7/v8 三组追加 + schemaVersion=8**：`MIGRATIONS` 现共 8 组（`store.ts:899`）：
  - v6 = 题目软删除（`questions.deleted_at`）`store.ts:1043-1057`；
  - v7 = AI 可靠性三新表 `tutor_turns` / `import_batches` / `import_drafts` + 若干列增补 `store.ts:1058-1163`；
  - v8 = 题库生命周期（`banks.deleted_at/archived_at`）+ 掌握模型列（`wrong_book_state` 4 列）+ 计划可执行（`plan_items` 重建扩 CHECK 增 6 列）`store.ts:1164-1238`。
- **schemaVersion 常量 = MIGRATIONS.length = 8**：`health()` 三处 `schemaVersion: MIGRATIONS.length`（`store.ts:1261/1271/1279`）。无独立字面量常量，以 `MIGRATIONS.length` 作为单端来源，符合「不再漂移」。
- **幂等（查列守卫）**：所有 `ADD COLUMN` 均以 `PRAGMA table_info(...)` 查列再执行（v6 `1048-1056`、v7 `1079-1138`、v8 `1174-1236`）；`plan_items` 重建用 v3 同款「新表→复制→删旧→改名→重建索引」+ `PRAGMA foreign_keys=OFF` 包裹、`DROP TABLE IF EXISTS plan_items_new` 前置（`1204-1236`）。
- **`PRAGMA foreign_key_check` 保留**：`migrate()` 末尾完整性验证（`store.ts:2515-2520`）。
- **层级推进正确**：`migrate()` 以 `version >= current` 从下一个未应用版本起跑（`2503-2511`），`applied` 时跑 `foreign_key_check`，`user_version = MIGRATIONS.length`（`2522-2524`）。重放幂等。
- **测试回归**：`store.test.ts` 迁移用例全部断言 `schemaVersion === 8`（`47/225/274/646/1151/1172/1242/1291`），逐级升级/存量保留/中途失败重试全绿。
- ⚠️ 小瑕疵（P2）：测试**标题** `store.test.ts:218` 仍写「全新库 schemaVersion=7」，但断言已为 8 —— 标题陈旧，不改功能。

### 1.2 契约单端来源 —— ✅ 通过

- **Host 唯一 DTO 来源**：`src/host/contract.ts`（头注释 `1-8`），全部为纯 JSON 可序列化 DTO，不引用 live 对象。
- **Client 零运行时垫片**：`src/client/types.ts:9` `export type * from '../host/contract.ts';` —— 单端再导出，bundle 零运行时依赖；既有导入点（`api.ts`/`sse.ts`/各组件）不用改名即可用。
- **t9 字段两侧一致**：因 client 直接再导出 contract，两侧必然一致，无需手工对账。核对 t9 字段在 contract 定义齐备：
  - bank `deletedAt/archivedAt`（`contract.ts:32-41`）；
  - wrong 掌握字段 `consecutiveCorrect/lastResult/lifetimeWrongCount/masterySource`（`contract.ts:276-290`，与 `store.ts:224-237`、`practice.ts:446-457` 同形）；
  - insight 新指标 `firstAttemptAccuracy/currentMastery/coverage/accuracy7d/weakTags`（`contract.ts:366-385`，实现 `insights.ts:108-161`，测试 `insights.test.ts:141-172`）；
  - plan item `actionType/scope/status/note/dueAt/priority/sourceDiagnosisId`（`contract.ts:578-615`，实现 `store.ts:421-455`，`toPlanItemDto` `service.ts:1799-1813`）。
- 校验：`client/contract.ts` 为 type-only module 声明合并装配（`contract.ts:14-17`），非 DTO 来源。

### 1.3 错误码三方同步 —— ⚠️ 一处不一致（P1）

- **职责划分正确**：`errors.ts` = 服务层 `ExamServiceErrorCode`；`index.ts mapServiceError` = HTTP 状态映射；`contract.ts ExamErrorCode` = client 侧词汇（含 HTTP 层码）。
- **400/404/409/503 映射一致**（`index.ts:157-217`）：
  - 400：`EXAM_BANK_NAME_REQUIRED/INVALID_BODY/INVALID_QUESTION/INVALID_SCOPE/QUESTION_NOT_IN_PRACTICE/EMPTY_PRACTICE_SCOPE/NOT_ESSAY/ESSAY_ANSWER_REQUIRED/TUTOR_MESSAGE_REQUIRED/IMPORT_EMPTY/IMPORT_PARSE_FAILED/IMPORT_DUPLICATE_ITEM`；
  - 404：`EXAM_BANK_NOT_FOUND/QUESTION_NOT_FOUND/PRACTICE_NOT_FOUND/TUTOR_SESSION_NOT_FOUND/PLAN_NOT_FOUND/PLAN_ITEM_NOT_FOUND/ESSAY_GRADING_NOT_FOUND/EXPLANATION_NOT_FOUND/IMPORT_DRAFT_NOT_FOUND`；
  - 409：`NOT_GRADED/PRACTICE_FINISHED/TUTOR_SESSION_CLOSED/TUTOR_TURN_IN_FLIGHT/TUTOR_TURN_CONFLICT/IMPORT_DRAFT_CONSUMED/IMPORT_BATCH_CONFLICT`；
  - 503：`STORE_CLOSED/STORE_UNAVAILABLE/LLM_NO_PROVIDER/LLM_NO_MODEL/LLM_UNAVAILABLE`；default → 500（`EXAM_INTERNAL` 等）。
- **❌ 唯一不一致（P1）**：`EXAM_ESSAY_GRADING_NOT_FOUND` 在 `errors.ts:41` 定义、并在 `index.ts:184` 映射 404、由 `handleGradingPrefix` 对 `GET /grading/:attemptId` 无批改时抛出（`index.ts:760-763`）—— 该码必然可达 client，但 **`contract.ts ExamErrorCode`（`55-100`）未含此码**。client 侧类型词汇缺失此码（运行时靠「未知码原样透传」兜底，见 `contract.ts:54` 注释，非崩溃）。建议把 `EXAM_ESSAY_GRADING_NOT_FOUND` 补入 `ExamErrorCode`。
- 中立观察（非阻塞）：`contract.ts` 含 `EXAM_INVALID_BODY/EXAM_METHOD_NOT_ALLOWED/EXAM_NOT_FOUND`（HTTP 层码，不在 `errors.ts`），属设计使然；LLM 运行时错误码（`TIMEOUT/ABORTED/TOOL_CALL/PROVIDER_ERROR/STREAM_FAILED`）未显式映射，在 SSE 端点为流内 error 事件（正确），在 JSON 端点会落入 default 500（可接受，但与 503 语义略不一致，建议后续仲裁）。

### 1.4 领域不变量 —— ✅ 通过

- **会话域最新作答贯穿**：`resumePractice`（`practice.ts:113`）、`buildScorecard`（`practice.ts:372`）、`listPracticeHistory`（`service.ts:1363`）均用 `listLatestAttemptByPracticeQuestions`（`store.ts:1542-1568`，`practice_id` 精确匹配 + `rowid DESC` 后写者胜）；隔离测试 `store.test.ts:1387-1418`。
- **finished guard 409**：客观 `gradeAnswer`（`practice.ts:148-153`）、essay `gradeEssay`（`service.ts:865-870`）、`patchIndex`/`updateIndex`（`practice.ts:125-130`），路由层流前亦守卫（`index.ts:696-704`）。测试 `practice.test.ts:186-200`、`smoke.test.ts:2157-2180`。
- **空范围 400**：`startPractice` 空范围拒绝建 active 空会话（`practice.ts:94-99`）；测试 `practice.test.ts:170-180`、`smoke.test.ts:2091-2114`。
- **gradeEssay 归属校验**：题目属于该会话题单（`service.ts:871-876`）；测试 `smoke.test.ts:2189-2221`。`gradeAnswer` 同款（`practice.ts:156-161`）+ essay 走批改（`practice.ts:164-168`、`service.ts:851-856`）。
- **软删除排除但历史可解释**：列表/错题本/练习范围排除 —— `listQuestionsByBank`（`store.ts:1484` `deleted_at IS NULL`）、`listWrong`（`store.ts:1687`，含 bank/question 排除）、`wholeQuestions` 范围（`practice.ts`）；历史可解释用 `getQuestionIncludingDeleted`（`store.ts:1457`、`practice.ts:380`），scorecard 含软删题（`practice.ts:379-381`）。测试 `store.test.ts:367`、`ai.test.ts`。
- ⚠️ 口径小不一致（P2）：`listQuestionsByBank`（`1484`）只排除已删题目，**未排除已归档/已删除题库**的题目；而 `listWrong`（`1687`）同时排除 `bk.deleted_at IS NULL AND bk.archived_at IS NULL`。若对已归档题库直连 `GET /banks/:id/questions` 会返回其题目（业务上通常不能到达该态，属边界口径差异）。建议 t10 收口时与「已归档题库」选择器口径对齐协商。

### 1.5 AI 可靠性 —— ✅ 通过

- **tutor_turns 状态机 + clientMessageId 幂等**（`service.ts:966-1157`）：
  - done 重放零 LLM（`1009-1024`）；cross-session 409 `EXAM_TUTOR_TURN_CONFLICT`（`1003-1007`）；closed guard（`991-996/1041-1046`）；in-flight 并发 409 `EXAM_TUTOR_TURN_IN_FLIGHT`（`1025-1031`）；pending/failed/cancelled/孤儿 streaming 复用既有 turn（`1032-1038`）。
  - 取消零落库（`1117-1120`）；失败置 `failed`（可重试）、取消置 `cancelled`，错误 meta 携带 `sessionId/turnId/retryable`（`1144-1153`）。SSE error 事件扩 `sessionId/turnId/retryable`（`contract.ts:502-514`，`index.ts:855`）。
- **import 事务 + 批次 + 草稿**：`commitImport` 原子提交（`service.ts:1827-1876`）——batchId 命中重放零写（`1839-1853`）；否则 `withTransaction` 内逐题创建+写批次行（`1858-1874`）；同批重复 item_key → `EXAM_IMPORT_DUPLICATE_ITEM` 整批回滚（`1861-1866`）；draftId 与 batch 同 commit 置 committed（`1871-1873`）；草稿持久化恢复（`listImportedQuestions` `1178-1182`、`getImportDraft` `1225-1235`）。
- **explanation 版本 + single-flight**：命中条件 `promptVersion`+`questionUpdatedAt`（`isExplanationHit` `1591-1593`）；single-flight `inFlightExplains` 同键共享一次 LLM（`1373-1396`，force/普通键隔离）；取消零落库（`565`，`service.ts:528/563`）。
- **JSON AbortSignal**：`runJsonEndpoint` 客户端断开 → `controller.abort()` 透传 service（`index.ts:619-641`）；全部 JSON LLM 端点接线（import/generate `1049-1057`、diagnose `1164-1167`、plans/generate `1238-1247`、bulk explain-generic `1415-1423`、explain-generic `1449-1458`）。
- **每请求动态默认模型**：`defaultRouteProvider()` 每请求现读 DSH 默认模型（`index.ts:2159-2169`），`resolveLlmRoute` 内联调用（`387-393`），改默认模型即时生效。
- 测试覆盖：`ai.test.ts`（gradeEssay signal 透传/取消、import/generate/diagnose/plan signal、explainOnce 五形态）、`smoke.test.ts`（SSE 断开中止 `1319-1406`、取消零落库 `1728-1833`）、`store.test.ts`。

### 1.6 客户端一致性 —— ✅ 通过（结构齐备；t10 编译期暂红）

- **practiceIntent 跨模块闭环**：`ExamWorkspace.goPractice`/`selectTab`/`practiceReturnTab`（`ExamWorkspace.tsx:65-79`）；错题→练习 `onPracticeWrong`（`ExamWorkspace.tsx:405`，`WrongView.tsx:263-271/381-390`「去练习这些错题」）；学情→练习 `onPractice`（`ExamWorkspace.tsx:432`，`Insights.tsx:395-435`，含 `byType`/`wrong` 一键开练）；学情→错题 `onOpenWrong`（`Insights.tsx:439-440`）；题库题目→AI 绑定 Tutor `onAskAi`（`ExamWorkspace.tsx:374-378`）。
- **ARIA**：`role=tablist/tab/tabpanel` + `aria-selected/aria-controls` + roving `tabIndex`（`ExamWorkspace.tsx:206-221`，`AiTools.tsx:468-501`）；焦点陷阱（`ExamOverlay.tsx:24-97`，`role=dialog`+`aria-modal`+`aria-labelledby`+Tab 循环+focusin 拉回+Esc+mask 关闭）；`aria-live`（错误/流式）、`role=alert/status/progressbar`、`aria-expanded/aria-controls`（计划/错题/列表展开）、44px 触达（`styles.css:2107/2198-2223` 等）。
- **5 面板常驻 hidden**：题库/练习/错题/AI/学情五个 `role=tabpanel` `hidden={tab!==...}` 常驻挂载（`ExamWorkspace.tsx:225-434`），保留钻取/表单/流式/会话状态。
- **Insights 图表变量协议**：以 CSS 变量 `--exam-assistant-bar` / `--exam-assistant-type-fill` 传值（`Insights.tsx:341/345/374`，`as React.CSSProperties` 标准做法，非裸 hex）；空档日 `maxDailyTotal = Math.max(1, ...)`（`Insights.tsx:288`）+ 全 0 显示「暂无数据」（`Insights.tsx:333-334`）。
- ⚠️ 编译期暂红：见 §2（t10 重构中间态）。

### 1.7 测试缺口对账（G1–G10 & S1–S12）—— 宿主多数覆盖；下述为缺口

对照 `ACCEPTANCE-MATRIX` §7：
- G1 Tutor 幂等/重试去重：服务端已实现（见 1.5），但**无 HTTP 级并发 in-flight 409 用例**（`smoke.test.ts` 无 `TURN_IN_FLIGHT` 断言之用例）→ **缺口**。
- G2 导入事务原子性：实现 + `store.test.ts`/`smoke.test.ts` 有覆盖 → ✅。
- G3 导入草稿持久/恢复：实现（`service.ts:1178-1182/1225-1235`）→ 有覆盖 ✅。
- G4 计划状态机：`store.test.ts`「t12 计划状态自动机」断言 completed/回退 → ✅。
- G5 计划→练习 scope 映射：Host 支持（`PlanItemDto.scope`）；**缺**「一键开练」的集成/解析测试 → 目标态覆盖不足（**缺口**，与 GUI 目标态 I4 对齐）。
- G6 错题重练闭环：`wrong` scope 解析（`practice.ts`）+ `onPracticeWrong`（client）；缺「答对后列表联动」集成测试 → 部分缺口。
- G7 题库 type/tag 组合过滤：`store.test.ts`「t9 题目列表过滤」覆盖 → ✅。
- G8 工具非法参数矩阵：`tools.test.ts`「非法参数 → EXAM_INVALID_BODY，服务不被调用」+ `store.test.ts` → ✅（部分）。
- G9 客户端组件逻辑：**零客户端自动化测试**（client 无 *.test.tsx/.ts）→ 持续缺口（任务点 7 亦列）。
- G10 学情口径 GUI 对账：`insights.test.ts` + `smoke.test.ts` 服务端断言齐备；GUI 对账属手工场景 → 服务端 ✅，GUI 需浏览器验收。
- 任务点 7 点名四项缺口 **全部确认**：
  1. **tools signal 未转发测试**：`tools.ts:295-296` 已转发 `exec.signal`，但 `tools.test.ts` 仅有 `EXEC = { signal: ... }` 常量（`29`），**无断言** signal 透传到底层工具 → 缺口。
  2. **in-flight 并发 409 无 HTTP 测试**：`smoke.test.ts` 无对应用例 → 缺口。
  3. **JSON abort 无 HTTP 测试**：JSON 端点（import/generate/diagnose/plans generate）无「客户端断开 → 底层 signal 中止」的 HTTP 用例（SSE 端点有，如 `1320-1406/1765/1828`）→ 缺口。
  4. **bulk explain-generic 无测试**：`smoke.test.ts` 有 bulk tag/move/delete/restore（`2603-2626`），但无 bulk `op:'explain-generic'` 多题批量用例 → 缺口。

### 1.8 潜在回归扫描 —— ✅ 三项目前干净 + 一个编译期暂红

- **`as string` 扩宽**：client ts/tsx 无残留 `as string` 扩宽断言（扫描为空）。
- **裸 hex 颜色**：client ts/tsx 无内联裸 hex（颜色全部走 `styles.css`/`styles.generated.ts`；图表用 CSS 变量）。
- **死代码 / 未用**：未发现明显死分支（`overlay-store`/`ui-helpers` 均被引用；无未使用的对外导出标志位）。
- **客户端对不存在 Host 字段的引用**：client 通过 `export type *` 复用 contract，类型由 `tsc` 强制；当前 tsc 报错均为签名不匹配（`AbortSignal` vs `ListBanksOptions/ListQuestionsFilter`），**无**「引用不存在的 Host 字段」类错误。→ 待 t10 收口后重跑确认。

---

## 2. 门禁结果（2026-08-28 实测快照）

| 门禁 | 命令 | 结果 | 备注 |
|---|---|---|---|
| typecheck | `pnpm --filter @exam/dsh-exam run typecheck` | ❌ **FAIL** | `tsc -p tsconfig.json`：`BankDetail.tsx(123)`、`PracticeView.tsx(285/328)`、`WrongView.tsx(75/110)` 报 `TS2559: AbortSignal 与 ListQuestionsFilter/ListBanksOptions 无共同属性`（t10 重构中间态）。**同一命令在 12:06 首跑曾 PASS**（当时 api.ts 尚未切到 filter 签名），说明源码正在被并行编辑。 |
| test | `pnpm --filter @exam/dsh-exam run test` | ✅ **PASS（167/167）** | `node --test src/host/*.test.ts`：`tests 167 / pass 167 / fail 0`（约 8.7s）。宿主行为零回归。 |
| build | `pnpm --filter @exam/dsh-exam run build` | ❌ **FAIL** | `tsc -p tsconfig.build.json`（宿主）✅ 通过；`tsdown` 打包 `client.js 282.90 kB / gzip 55.52 kB`，「Build complete」✅；**唯一失败**点为 `tsc -p tsconfig.client-dts.json`（client `.d.ts` 类型校验）报与 typecheck 相同的 `TS2559`。 |

> **门禁判定**：宿主侧门禁（宿主构建 + 宿主测试）**全绿**；客户端 `.d.ts` 类型校验因 t10 中途迁移不稳。按验收矩阵 §0「三条为每个里程碑前置门禁」，**当前整体门禁未全绿**，不能作最终可交付判定。

---

## 3. 遗留问题清单

| 级 | 问题 | 证据 | 建议 |
|---|---|---|---|
| **P0** | 无阻塞性生产缺陷 | — | 无 P0。 |
| **P1** | ① t10 客户端迁移未收口导致 typecheck/build 红（**阻塞交付**，属进行中重构，非回归）。② `EXAM_ESSAY_GRADING_NOT_FOUND` 未入 `contract.ts ExamErrorCode`（三方词汇不一致）。③ 新版 `listBanks(options, signal?)`/`listQuestions(bankId, filter, signal?)` 迁移时需确认所有调用点以「对象 + signal」调用、且**保留 signal 取消语义**。 | ①见 §2；②`errors.ts:41` vs `contract.ts:55-100`，`index.ts:184/760-763`；③`api.ts:145-160` + 各组件调用点 | ①等 t10 收口后重跑门禁；②同步补码至 `contract.ts`；③t10 收口时核对调用点与取消语义。 |
| **P2** | ① `listQuestionsByBank` 未排除已归档/已删除题库题目（口径与 `listWrong` 不一致）。② `store.test.ts:218` 迁移测试标题「schemaVersion=7」陈旧（断言已为 8）。③ JSON 端点 LLM 运行时错误码落入 default 500（与 503 语义略不一致）。④ 客户端零自动化测试（G9）。⑤ 测试缺口四项：tools signal 转发、in-flight 并发 409 HTTP、JSON abort HTTP、bulk explain-generic。 | ①`store.ts:1484` vs `1687`；②`store.test.ts:218`；③`index.ts:209-211`；④client 无 test 文件；⑤见 §1.7 | ①与题库生命周期口径对齐；②改标题；③仲裁 LLM 错误码映射；④需引入客户端测试框架或抽纯函数；⑤补齐 4 条 HTTP/工具级用例。 |

---

## 4. 可交付判断

- **宿主层：已达到可交付标准。** 宿主构建通过、测试 **167/167** 全绿，迁移（v6/v7/v8）、契约单端来源、错误码映射、领域不变量、AI 可靠性（tutor_turns 幂等 / import 事务 / explanation single-flight / AbortSignal / 默认路由）全部核实并验证。
- **整体：暂不可交付 —— 阻塞项为 t10 客户端迁移收口。** 当前客户端 `api.ts` 已切到 options/filter 签名而部分组件调用点未同步，导致 `typecheck` 与 `build`（client-dts 步骤）失败。此为**进行中的重构中间态**，非既有功能回归（宿主 167/167 未受影响）。
- **后续动作**：待 t10 落地后，按验收矩阵 §0 重跑三命令，并确认：
  1. `typecheck` 0 错误；
  2. `test` ≥ 167（预期不变或更高）；
  3. `build` 全绿（宿主 + client-bundle + client-dts + smoke）。
  4. 关闭 P1-②（同步 `EXAM_ESSAY_GRADING_NOT_FOUND` 至 contract）并复核 P2 清单。
- 交付结论（最终版）以 **t10 收口后重跑的门禁结果**为准；本报告的静态审查结论（§1.1–1.8）在 t10 收口后应保持成立（宿主部分已固化）。

---

*本报告由只读集成终审生成；未修改任何实现 / 宿主 / 客户端 / 测试文件。*
