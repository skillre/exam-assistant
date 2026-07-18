---
kind: plan
status: ready
created: 2026-07-18T12:40:49+0800
feature: AI 考试助手 v2 — 五大板块功能完整度补齐（实施计划）
branch: main
commit: 678594b
repo: 考试助手
source_design: .rpiv/artifacts/designs/2026-07-18_12-38-42-v2-module-completeness-design.md
source_frd: .rpiv/artifacts/discover/2026-07-18_12-33-59-v2-module-completeness-frd.md
source_research: .rpiv/artifacts/research/2026-07-18_12-33-59-v2-module-completeness-research.md
---

# Plan — v2 五大板块功能完整度补齐

> 7 个 phase 1:1 映射 design 的 7 个 slice。Phase 1 是地基，Phase 2-7 依赖它。
> 构建/测试遵循 DEC-15/16：本地不跑，经 Git 中转到运行环境（或按需在本地仅做 `tsc` 类型检查）。

## Developer Context

继承 DEC-1..DEC-28。关键约束：
- 无 migration → 全部 `CREATE TABLE IF NOT EXISTS`，优先新表不加列。
- attempts append-only → "最新作答" 用 `ORDER BY answered_at DESC LIMIT 1`。
- 新 API 契约一律进 `@exam/shared`（NFR3）。
- 结构化走 REST（`req<T>`），AI 文本走 SSE（`streamSse`）。
- 可视化纯 CSS/SVG，禁引图表库（DEC-26）。

---

## Phase 1 — 共享契约与数据层地基

**改动**：
- `packages/shared/src/types.ts`：新增 `PracticeMode/PracticeScope/PracticeSession/StartPracticeRequest/UpdatePracticeRequest/Scorecard/WrongBookItem/WrongBookQuery/ConnTestResult`。
- `packages/server/src/db/schema.ts`：追加 `practice_sessions`、`wrong_book_state` 两表 + `idx_practice_bank` 索引。
- 新建 `packages/server/src/repositories/practiceRepo.ts`：`create/get/updateIndex/remove`。
- 新建 `packages/server/src/repositories/wrongBookRepo.ts`：`setMastered/getState/listStates`。
- 扩展 `attemptRepo.ts`：`listWrongDetailed()`、`answeredQuestionIds(bankId)`、`latestByQuestion(qids)`。

### Success Criteria:
- [ ] `pnpm --filter @exam/shared build` 与 `pnpm --filter server build`（tsc）通过。
- [ ] 新表建表幂等：在已有 DB 上重启不报错（`CREATE TABLE IF NOT EXISTS`）。
- [ ] 新仓储遵循既有 Row-interface + `toXxx()` 风格，命名参数 `@xxx`。

---

## Phase 2 — 练习会话后端

**依赖**：Phase 1
**改动**（`packages/server/src/routes/quiz.ts`）：
- `POST /api/practice/start`：按 `scope`（all/undone/wrong/byType/byTag）解析题集，可选 Fisher-Yates 乱序，落 `practiceRepo.create`，返回 `PracticeSession`；空集返回 409。
- `GET /api/practice/:id`：返回 `PracticeSession`（续做）。
- `PATCH /api/practice/:id`：`updateIndex`，返回 204。
- `GET /api/practice/:id/scorecard`：对 session.questionIds 取每题最新 attempt，聚合 byType/byTag/wrongQuestionIds，返回 `Scorecard`。

### Success Criteria:
- [ ] `pnpm --filter server build` 通过。
- [ ] curl 走通 start→patch→scorecard。
- [ ] `undone` 排除已作答题；`wrong` 排除已掌握题；`shuffle` 两次顺序不同。
- [ ] 空范围返回 409 `{error}`。

---

## Phase 3 — 练习会话前端

**依赖**：Phase 2
**改动**：
- `packages/client/src/api/client.ts`：新增 `startPractice/getPractice/updatePractice/getScorecard`。
- `packages/client/src/pages/QuizPage.tsx`：重构加"开始练习"配置区（范围/题型/标签/乱序），题号导航，进度续做（localStorage 存 sessionId），成绩单入口，键盘操作。
- 新建 `packages/client/src/components/QuestionNav.tsx`：题号网格，标记已答/未答/对错，点击跳转。
- 新建 `packages/client/src/components/Scorecard.tsx`：正确率/分布/错题入口，纯 CSS 条形。

### Success Criteria:
- [ ] `pnpm --filter client build` 通过。
- [ ] 可选范围+乱序开始练习；题号导航跳转正常；刷新后续做。
- [ ] 走完一套见成绩单（正确率/分布/错题入口）。

---

## Phase 4 — 错题本增强（前后端）

**依赖**：Phase 1
**改动**：
- `routes/quiz.ts`：改造 `GET /api/quiz/wrong` 接 query（bankId/type/tag/includeMastered），返回 `WrongBookItem[]`（默认排除已掌握）；新增 `POST /api/quiz/wrong/:questionId/master`（Body `{mastered}`）。
- `client.ts`：`listWrong` 改带 query；新增 `setMastered`。
- `WrongBookPage.tsx`：筛选栏（题库/题型/标签）、错误次数+最近错误时间、"标记已掌握"、可选按标签分组、重做答对后提示标记掌握。

### Success Criteria:
- [ ] `pnpm --filter server build` 与 `pnpm --filter client build` 通过。
- [ ] curl 标记掌握后列表默认排除该题，`includeMastered=1` 回显。
- [ ] 前端显示错误次数与最近错误时间，筛选生效。

---

## Phase 5 — 学情可视化

**依赖**：Phase 1
**改动**：
- `routes/insights.ts`：新增 `GET /api/insights/snapshot?bankId=` → `collect(bankId)` 直接 `reply.send`（REST）；空记录返回 200 空快照；保留 SSE `analyze` 不变。
- `client.ts`：新增 `getInsightsSnapshot(bankId?)`。
- `InsightsPage.tsx`：进页即拉 snapshot 渲染 `InsightsPanel.tsx`（正确率、weakTags 条形、tutorHighlights），"生成 AI 报告"按钮触发原 SSE，面板与文本并存；薄弱点可点击下钻。
- 新建 `InsightsPanel.tsx`：纯 CSS/SVG 可视化。

### Success Criteria:
- [ ] `pnpm --filter server build` 与 `pnpm --filter client build` 通过。
- [ ] 进页无需点按钮即见结构化面板。
- [ ] "生成 AI 报告"仍可流式输出；面板与文本并存。
- [ ] 点薄弱标签跳转到按该标签筛选的视图。

---

## Phase 6 — 导入预览可编辑 + 校验

**依赖**：Phase 1
**改动**：
- `routes/import.ts`：新增 `POST /api/import/validate`（Body `{questions}`）→ 复用 `questionSchema.ts` 收集 issue 返回 `{index, ok, errors[]}[]`（不抛错）。
- `client.ts`：新增 `validateDrafts`。
- `ImportPage.tsx` + 新 `DraftEditor.tsx`：预览列表逐题编辑（题干/选项增删/答案/题型/标签/解析）、删除某题、手动新增一题、入库前校验高亮提示。

### Success Criteria:
- [ ] `pnpm --filter server build` 与 `pnpm --filter client build` 通过。
- [ ] 编辑一题答案后入库，DB 为编辑后值。
- [ ] 非法答案（越界/多选无答案/选项空）被拦截提示。

---

## Phase 7 — 设置连通性验证

**依赖**：Phase 1
**改动**：
- `packages/server/src/ai/AiService.ts`：新增 `testProvider(providerId, modelId)`，用指定 provider/model 建一次性会话发最小请求，不碰 `settingsRepo`（不污染全局激活模型）。
- `routes/providers.ts`：`POST /api/providers/:id/test` → 调 `testProvider`，返回 `ConnTestResult`（成功含 latencyMs，失败含 message）；响应体绝不含 Key。
- `client.ts`：新增 `testProvider(id)`。
- `SettingsPage.tsx`：每个 provider 卡片加"测试连接"按钮，展示成功（延迟）/失败（原因）。

### Success Criteria:
- [ ] `pnpm --filter server build` 与 `pnpm --filter client build` 通过。
- [ ] curl 有效 Key 返回 `ok:true`、无效返回 `ok:false`。
- [ ] 响应体不含 Key 明文（grep 校验）。

---

## 并行与执行顺序

```
Phase 1 (地基)
  ├─ Phase 2 → Phase 3   (Quiz 后端→前端)
  ├─ Phase 4             (错题本)
  ├─ Phase 5             (学情)
  ├─ Phase 6             (导入)
  └─ Phase 7             (设置)
```
Phase 1 完成后，Phase 4/5/6/7 相互独立可并行；Phase 2 先于 3。

## 验证策略

- 每 phase 后跑对应包 `tsc` 编译（本地可做类型检查）。
- 运行时验证（curl / 容器）遵循 DEC-15/16 在运行环境执行。
- 收尾按 FRD 验收标准逐条核对。
