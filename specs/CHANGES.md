# CHANGE.md — 考试助手（exam-assistant）

> 变更记录按时间追加，不重写历史。级别：S=小改(<1h) / M=中改(1h~2天) / L=大改(>2天跨模块)。
> 执行约定：Change Gate 确认后进 glla（/goal 带 Done when 契约），完成过独立 auditor；回归验收必选。

## 变更记录

### 2026-08-10 第一批：P0 功能可用性修复（级别：M）

- **现状**：① SSE 传输异常无恢复路径，讲解/学情 UI 永久卡"思考中…"且输入禁用；② 练习会话完结后 localStorage 残留，下次进刷题页续做已完结会话、且续做丢失已答判分态；③ 设置页刷新后无法显示当前激活模型（服务端无读回接口）；④ 答疑历史回读未过滤首条注入（系统提示词+正确答案原样展示）；⑤ AI 流式调用抛错时 AgentSession 不 dispose（资源泄漏）。
- **目标**：① 流式调用统一封装：断线/异常路径复位 UI 状态并提示，不再永久卡死；② 练习完结清理 localStorage，续做恢复已答判分态；③ 设置页能读回并展示当前激活模型；④ 答疑历史过滤首条注入上下文；⑤ dispose 统一进 finally，错误路径不泄漏。
- **改动点**：
  - `packages/client/src/api/sse.ts`：流式封装加 AbortController + 超时 + 异常回调。超时用原生 `AbortSignal.timeout(30_000)`（ES2022+ 全局对象，不引入依赖）；超时/传输异常统一调 `onError` 回调并返回（不 reject 静默）。
  - `packages/client/src/components/TutorPanel.tsx`、`pages/InsightsPage.tsx`：await/catch 流式调用（当前未 catch），finally 复位 streaming/running 状态；错误提示复用现有 onError 文案。
  - `packages/client/src/pages/QuizPage.tsx`：① finish() 的 scorecard 成功路径（onDone）增加 `localStorage.removeItem(LS_KEY)`（当前只有 reset() 清）；② 续做恢复判分态——挂载时调新增 `api.getPracticeGraded(sessionId)`，把返回的判分结果填充 `gradedById`（替代当前 `setGradedById({})`）。
  - `packages/client/src/pages/SettingsPage.tsx` + `packages/client/src/api/client.ts`：client.ts 新增 `getActiveModel()`；SettingsPage.refresh() 中调用并 `setActive`（当前 active 恒为空串）。
  - `packages/server/src/routes/models.ts`：新增 `GET /api/models/active`，返回 `ActiveModelSelection`（types.ts 已有类型，无需新增）。
  - `packages/server/src/routes/quiz.ts` + `packages/server/src/repositories/attemptRepo.ts`：新增 `GET /api/practice/:id/graded`，返回 `Record<questionId, { isCorrect, attemptId, answeredAt }>`（复用现有 `latestByQuestion`，只读不加表）。
  - `packages/server/src/ai/sessionHistory.ts`：`readSessionHistory` 增加可选参数 `skipFirstUserTurn=false`；history 端点传 true 跳过首条 user 轮（注入的讲解 prompt），默认 false 保持 `LearningDataCollector.collectTutorHighlights` 现有 `.slice(1)` 行为完全不变。
  - `packages/server/src/routes/tutor.ts`、`routes/insights.ts`：`session.dispose()` 移入 finally（幂等）；catch 中先 dispose 再 `sse.error()`，避免 reply 已关闭后写流。
- **影响面**：client 流式消费方（TutorPanel/InsightsPage 为全部调用方）；QuizPage 练习生命周期；SettingsPage 激活模型展示；server tutor/insights 路由（SSE 生命周期）；models/quiz 路由（新增只读接口，无破坏）；sessionHistory（collector 行为不变，零回归风险）。不动 DB schema、不动部署架构。
- **目标验收**（每条可执行）：
  - `pnpm typecheck` 0 错误
  - `pnpm test` 全量通过（现有 32 用例 + 新增：`sessionHistory.test.ts` 过滤用例——skipFirstUserTurn=true 时首条 user 轮被跳过、默认 false 时行为不变；`LearningDataCollector.test.ts` 现有 4 用例保持全绿）
  - `packages/server/smoke-e2e.ts` 冒烟通过（非 AI 全链路断言）
  - 续做判分态：curl `GET /api/practice/:id/graded` 返回非空 `Record<questionId, {isCorrect,attemptId}>`（新建会话→答 2 题→断言 2 条）
  - 历史过滤：curl `GET /api/tutor/history`（有会话时）返回首条 user 轮不含系统提示词关键词（"你是"、"讲解"、题目原文的题干前缀）
  - 远程部署实测（106.37.96.58:6422）：核心流程（配 Provider→导入→刷题→判分→讲解→错题本→学情）走通；SSE 讲解正常流式；设置页刷新后显示当前模型
- **回归验收**（旧功能未坏，逐条可执行）：
  - `pnpm typecheck` + `pnpm test` 全量 + smoke-e2e 冒烟全绿
  - `LearningDataCollector.test.ts` 4 用例全绿（collector 依赖 readSessionHistory，默认参数必须保持其现有输出）
  - 远程回归（具体步骤）：① 练习：新建练习→答 1 题→刷新页面→自动恢复到该题（续做不丢进度）；② 错题本：答错 1 题→错题本出现该题→标记已掌握→消失；③ 导入：粘贴文本 AI 解析→预览→入库→题库题数 +1；④ 判分：单选/多选/判断各答 1 题，判定与预设答案一致；⑤ SSE：讲解中断（kill 浏览器网络或服务端重启）后按钮恢复可点、不卡"思考中…"
- **范围红线**：安全项（无鉴权/SSRF/依赖漏洞）不碰；备份方案不做；部署架构/DB schema 不变；不引入新依赖（超时用原生 AbortSignal.timeout）。
- **状态**：已完成（2026-08-10）
  - 本地：typecheck 0 错误、36 测试全过（含新增 sessionHistory 4 用例）、smoke-e2e 43 断言全过、graded/active 接口 curl 实测通过
  - 远程（106.37.96.58:6422）：双容器重建 healthy、models/active 读回真实配置、history 过滤生效、SSE 错误链路正常
  - 遗留已清：SSE 流式实测通过（541 delta 帧 + done，0 error）；断连验证通过（流中 kill api 容器，客户端 curl 正常退出码 0 无挂死）；容器重启恢复 healthy、数据完好。运维观察：docker kill 后 restart: unless-stopped 未自动拉起（Docker Desktop 特性），需 docker compose up -d 手动恢复

---

### 2026-08-10 第二批：v3 AI 学习教练全量落地 + P1 流程闭环补齐（级别：L，评审修订版）

- **现状**：① v3（deep-ai-insights，AI 学习教练）FRD/设计/853 行 slice 代码全部悬空未提交未落地（`.rpiv/artifacts/designs/slice*.tsx` + 88KB design + slice1-code.md，7/18 生成后中断）；② 学情→错题本下钻断链（`onDrillToWrong` 静默丢弃，InsightsPage:5,11）；③ "错题本回读答疑历史"死功能（autoLoadHistory 无调用方，tutorHistory 整路径未启用）；④ 导入 CSV/Excel 模板列约定无文档（plan 遗留 `[ ]`）；⑤ 下钻 filter 永不清空（App:28-31）+ 错题本双请求无 loading（WrongBookPage:55-69）。
- **目标**：v3 按设计文档全量落地（DEC-36"一次到位全做"）：诊断（FR1）/计划任务（FR2）/掌握闭环（FR3）/趋势跟踪（FR4）完整链路；同时补上闭环 5 项。
- **设计权威（评审 B1 定稿）**：唯一权威 = `slice1-code.md`（2026-07-18 18:21 最终代码级设计，后于主设计 16:37）。表清单定稿 **5 张新表**：`mastery_states` / `insight_snapshots` / `learning_plans` / `learning_tasks`（4 表名按 slice1-code.md）+ `diagnosis_results`（第 5 表，DDL 按主设计 schema 节，diagnosisRepo 落库需要）。主设计中 `question_mastery` 表名废弃（以 mastery_states 为准）。仅新增表，既有表零改动、零 ALTER、零数据迁移。
- **改动点**（按 slice 顺序执行）：
  - **Slice 0 设计对账（前置，评审 B3）**：统一 slice1-code.md 与主设计/8 个 slice tsx 的类型矛盾，产出修订版类型定稿并提交——① `FinishPracticeResponse` 统一为 `{ scorecard, snapshotId }`；② `snapshotRepo.save` 签名统一（对象参数、返回 `InsightSnapshot | null`，finish 端点按此调用）；③ `TrendPoint` 统一为 `{ timestamp, ... }` 且 TrendChart 用 `pt.timestamp`；④ `DiagnosisResult` 统一为扁平 `{ errorCategory, distractorNote }`（与 DiagnosisPanel 一致）；⑤ `GradeResponse.mastered` 统一为**可选** `mastered?: boolean`（P0-2 的 graded 端点不构造该字段，typecheck 不破）。修订后过 auditor 复核再进 Slice 1。
  - **Slice 1 Foundation**：`shared/types.ts` 加 v3 类型（按 slice0 定稿）；`db/schema.ts` 新增 5 表（表名见设计权威，`CREATE TABLE IF NOT EXISTS` 幂等，**不新增 attempts 索引**——D1 Option A 增量列不需要，评审 C1）；新增 `repositories/masteryRepo.ts`、`snapshotRepo.ts`、`planRepo.ts`、`diagnosisRepo.ts`
  - **Slice 2 Mastery Loop**：新增 `services/masteryService.ts`（连续 N=3 次正确→掌握，D1/D8 硬编码常量，不做环境变量覆盖——评审 C4）；`routes/quiz.ts` grade 挂 streak 钩子；掌握后自动联动错题本软标记（D6）
  - **Slice 3 Snapshot & Finish**：`routes/quiz.ts` 练习 finish 端点落快照（D5，返回 `{ scorecard, snapshotId }`）；`api/client.ts`、`QuizPage.tsx` 适配；**必须保留第一批 P0-2 的 `localStorage.removeItem(LS_KEY)`（评审 B2：slice3-QuizPage.tsx 替换版漏了它，禁止回退）**
  - **Slice 4 Trend Tracking**：新增 `insights/snapshotHistory.ts`（整体+每知识点双维时间序列，D34）；`routes/insights.ts` 加趋势接口；新组件 `TrendChart.tsx`（纯 CSS/SVG，不引图表库）；`InsightsPage.tsx` 接趋势图
  - **Slice 5 Diagnosis**：新增 `insights/diagnosisCollector.ts`（干扰项聚合+错因信号）、`ai/diagnosisPrompts.ts`、`import/diagnosisSchema.ts`（runOnce+zod+固定错因枚举 D7，产出落 `diagnosis_results`）；新 `routes/coach.ts`（诊断部分）；新组件 `DiagnosisPanel.tsx`
  - **Slice 6 Plans & Tasks + 集成**：新增 `ai/planPrompts.ts`、`import/planSchema.ts`；`routes/coach.ts` 计划/任务部分（两表模型 D2、一键开练复用 PracticeScope D31）；新组件 `PlanPanel.tsx`；`InsightsPage.tsx`/`QuizPage.tsx`/`App.tsx` 集成；`index.ts` 注册 coach 路由
  - **闭环 5 项**：① 学情薄弱点→错题本下钻接通（onDrillToWrong 实现）；② **启用**错题本/讲解面板历史回读（autoLoadHistory 传 true，二选一已定死为启用，评审 suggestion）；③ deploy/README 补 CSV/Excel 模板列说明；④ 下钻 filter 切页重置；⑤ 错题本 loading 态 + 双请求合并
- **影响面**：schema 新增 5 表（只加不改，既有表/数据零迁移）；新 coach 路由（/api/coach/*）+ insights 路由扩展；**3 个新组件**（TrendChart/DiagnosisPanel/PlanPanel，评审 C5）+ QuizPage/InsightsPage/App 改造；shared 类型扩展（含 GradeResponse.mastered 可选，向后兼容）。既有 API 契约不变。部署架构/nginx/compose 不变。
- **目标验收**（每条可执行）：
  - `pnpm typecheck` 0 错误（含 GradeResponse.mastered 可选后 graded 端点不破）
  - `pnpm test` 全量通过：现有 36 用例保持全绿 + 新增单测（masteryService streak 判定（N=3 边界、失败清零）、snapshotRepo 落库/幂等/查询、planRepo 计划任务 CRUD、snapshotHistory 趋势聚合、diagnosisSchema/planSchema zod 非法值拒绝（评审 C6））
  - smoke-e2e.ts 扩展断言通过（含新表 CRUD 链路）
  - 远程端到端（106.37.96.58:6422，真实 AI key 已生效）：① 学情页进页即见结构化面板（正确率+薄弱点+趋势图，REST 不耗模型）；② 点"深度诊断"→ SSE 流式错因报告落库 diagnosis_results；③ 点"生成学习计划"→ 分阶段计划+任务列表落库；④ 点击任务"一键开练"→ 跳转对应筛选练习视图并正常刷题；⑤ 练习完成→快照落库→趋势图出现时间序列点；⑥ 连续 3 次答对→任务自动完成+错题本掌握标记联动；⑦ 错题本回读答疑历史正常显示；⑧ AI 调用失败时降级路径（错误提示/不落库）也视为通过条件之一（评审 suggestion）
  - 闭环项验收（评审 C2）：① 学情薄弱点点击→错题本带 tag 筛选打开；③ 导入页/README 存在列约定说明；④ 下钻后切 tab 再回来 filter 为空；⑤ 错题本挂载仅 1 个 listWrong 请求且有 loading
- **回归验收**（旧功能未坏，逐条可执行）：
  - 第一批 5 项 P0 不回归：typecheck + 全量测试（含 sessionHistory 4 用例）+ smoke 43 断言保持全绿；**slice3 改造后练习完结仍清 localStorage、续做仍恢复判分态**（B2 专项）
  - 远程回归：练习续做/判分/错题本标记/导入/SSE 讲解流式/设置页读回模型 与第一批验收时行为一致
  - `git diff` 确认：无新增依赖、既有表结构零改动（仅新增 5 表）、docker/nginx/compose 零改动
- **范围红线**：继承 FRD Non-Goals——不引入新存储/时序库/向量库、不引入重型图表库（趋势图纯 CSS/SVG）、不做主观题/多端/账号、AI 不做进页面自动全分析（按需触发）；安全项/备份方案不碰；本地不跑构建（DEC-15，远程执行）。
- **状态**：待确认（评审 3 blocker + 6 concern 已全部修订）
### 2026-08-10 第三批：P2 体验优化与代码卫生（级别：M，待第二批完成后单独走三问）

- **状态**：未开始（占位）

### 2026-08-10 第四批：P3 功能增值（级别：L，待第三批完成后单独走三问）

- **状态**：未开始（占位）

### 2026-08-10 第二批：v3 AI 学习教练全量落地 + P1 流程闭环补齐（级别：L）

- **现状**：① v3（deep-ai-insights，AI 学习教练）FRD/设计/853 行 slice 代码全部悬空未提交未落地（`.rpiv/artifacts/designs/slice*.tsx` + 88KB design，7/18 生成后中断）；② 学情→错题本下钻断链（`onDrillToWrong` 静默丢弃，InsightsPage:5,11）；③ "错题本回读答疑历史"死功能（autoLoadHistory 无调用方，tutorHistory 整路径未启用）；④ 导入 CSV/Excel 模板列约定无文档（plan 遗留 `[ ]`）；⑤ 下钻 filter 永不清空（App:28-31）+ 错题本双请求无 loading（WrongBookPage:57-69）。
- **目标**：v3 按设计文档全量落地（DEC-36"一次到位全做"）：诊断（FR1）/计划任务（FR2）/掌握闭环（FR3）/趋势跟踪（FR4）完整链路；同时补上闭环 5 项。
- **改动点**（按设计 slice 顺序，slice 代码已在 design 文档中 approved）：
  - **Slice 1 Foundation**：`shared/types.ts` 加 v3 类型（MasteryState/TagStat/InsightSnapshot/Plan/Task 等）；`db/schema.ts` 新增 4 表（mastery_state 增量 consecutive_correct 列 / insight_snapshots / learning_plans / plan_tasks，只加不改既有表）；新增 `repositories/masteryRepo.ts`、`snapshotRepo.ts`、`planRepo.ts`、`diagnosisRepo.ts`
  - **Slice 2 Mastery Loop**：新增 `services/masteryService.ts`（连续 N=3 次正确→掌握，D1/D8）；`routes/quiz.ts` grade 挂 streak 钩子；掌握后自动联动错题本软标记（D6）
  - **Slice 3 Snapshot & Finish**：`routes/quiz.ts` 练习 finish 时落快照（D5）；`api/client.ts`、`QuizPage.tsx` 适配
  - **Slice 4 Trend Tracking**：新增 `insights/snapshotHistory.ts`（整体+每知识点双维时间序列，D2/D34）；`routes/insights.ts` 加趋势接口；新组件 `TrendChart.tsx`（纯 CSS/SVG，不引图表库）；`InsightsPage.tsx` 接趋势图
  - **Slice 5 Diagnosis**：新增 `insights/diagnosisCollector.ts`（干扰项聚合+错因信号）、`ai/diagnosisPrompts.ts`、`import/diagnosisSchema.ts`（runOnce+zod+固定错因枚举 D7）；新 `routes/coach.ts`（诊断部分）；新组件 `DiagnosisPanel.tsx`
  - **Slice 6 Plans & Tasks + 集成**：新增 `ai/planPrompts.ts`、`import/planSchema.ts`；`routes/coach.ts` 计划/任务部分（两表模型 D2、一键开练复用 PracticeScope D31）；新组件 `PlanPanel.tsx`；`InsightsPage.tsx`/`QuizPage.tsx`/`App.tsx` 集成；`index.ts` 注册 coach 路由
  - **闭环 5 项**：① 学情薄弱点→错题本下钻接通（onDrillToWrong 实现或移除）；② 错题本/讲解面板启用历史回读（autoLoadHistory 传 true）或删除死路径；③ deploy/README 或导入页补 CSV/Excel 模板列说明；④ 下钻 filter 切页重置；⑤ 错题本 loading 态 + 双请求合并
- **影响面**：schema 新增 4 表（只加不改，既有表/数据零迁移）；新 coach 路由（/api/coach/*）+ insights 路由扩展；4 新组件 + QuizPage/InsightsPage/App 改造；shared 类型扩展。既有 API 契约全部不变。部署架构/nginx/compose 不变。
- **目标验收**（每条可执行）：
  - `pnpm typecheck` 0 错误
  - `pnpm test` 全量通过：现有 36 用例保持全绿 + 新增单测（masteryService streak 判定（含 N=3 边界、失败清零）、snapshotRepo 落库/查询、planRepo 计划任务 CRUD、snapshotHistory 趋势聚合）
  - smoke-e2e.ts 扩展断言通过（含新表 CRUD 链路）
  - 远程端到端（106.37.96.58:6422，真实 AI key 已生效）：① 学情页进页即见结构化面板（正确率+薄弱点+趋势图，REST 不耗模型）；② 点"深度诊断"→ SSE 流式错因报告落库；③ 点"生成学习计划"→ 分阶段计划+任务列表落库；④ 点击任务"一键开练"→ 跳转对应筛选练习视图并正常刷题；⑤ 练习完成→快照落库→趋势图出现时间序列点；⑥ 连续 3 次答对→任务自动完成+错题本掌握标记联动；⑦ 错题本回读答疑历史正常显示
- **回归验收**（旧功能未坏，逐条可执行）：
  - 第一批 5 项 P0 不回归：typecheck + 全量测试（含 sessionHistory 4 用例）+ smoke 43 断言保持全绿
  - 远程回归：练习续做/判分/错题本标记/导入/SSE 讲解流式/设置页读回模型 与第一批验收时行为一致
  - `git diff` 确认：无新增依赖、既有表结构零改动（仅新增表）、docker/nginx/compose 零改动
- **范围红线**：继承 FRD Non-Goals——不引入新存储/时序库/向量库、不引入重型图表库（趋势图纯 CSS/SVG）、不做主观题/多端/账号、AI 不做进页面自动全分析（按需触发）；安全项/备份方案不碰；本地不跑构建（DEC-15，远程执行）。
- **状态**：待确认
