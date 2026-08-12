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
- **状态**：已完成（2026-08-12）
  - 本地：typecheck 0 错误、58 测试全过（36 旧 + masteryService 3 + snapshotRepo 3 + snapshotHistory 4 + planRepo 4 + aiSchemas 8）、smoke-e2e 51 断言（含 v3 新表 7 项）
  - 远程（106.37.96.58:6422）端到端：面板 REST 即时、诊断 SSE 流式+11 条落库+4 类错因、计划生成落两表（8 任务）、一键开练、快照→趋势点、连续 3 次答对 mastered:true+错题本联动、历史回读、AI 降级 error 帧
  - 实测修复 3 处：extractJson 误抽 phases 数组、AI 编造 bankId（prompt 注入真实题库）、全局计划 bank_id NULL（新表定义）
  - 证据：specs/verification/VERIFICATION-2026-08-10-第二批-v3远程端到端.md
### 2026-08-10 第三批：P2 体验优化与代码卫生（级别：M，评审前修订版）

- **现状**（审计 + 本次核查）：① Tab 切换无 URL 状态，刷新必回刷题页、无深链；② 题目选项纯 div 无键盘可操作（QuestionCard:107-128）；③ Fastify 默认错误（{statusCode,error,message}）前端只读 j.error 显示英文状态名（client.ts:54）；④ selectModel 先 setActive 后调 API，失败不回滚（SettingsPage:70-75）；⑤ ProviderForm 用 alert 报错 + apiType 自由文本；⑥ 死代码：shared-check.ts、api.validateDrafts、attemptRepo.listWrongQuestions、wrongBookRepo.getState、providerRepo.get；⑦ nanoid 死依赖（package.json:22，src 零 import）；⑧ 题型中文映射重复 4 份 + flash() 3 份拷贝 + 删除题库逻辑 2 份；⑨ insights analyze 每次产生孤儿 JSONL（AiService.createTutorSession 文件持久化，跑完不删）；⑩ tutor 会话并发双建竞态（question_id 无 UNIQUE，tutorSessionRepo:32-35）；⑪ 测试缺口：parseFile 解析 0 测试、路由层 0 测试、provider Key 链路 0 测试。
- **目标**：体验 5 项（深链/无障碍/错误文案/选择回滚/表单统一）+ 卫生 6 项（死代码/nanoid/重复合并/孤儿 JSONL/竞态/测试补缺）全量落地。
- **改动点**：
  - **体验① 轻量 hash 路由（评审 C3/S5 修订）**：App.tsx 用原生 `location.hash`（`#/quiz` 等 5 tab）；**单一 `navigate(tab)` 收口**——三处下钻（drillToQuiz/drillToWrong/startTaskQuiz）、switchTab（含闭环④ filter 重置）、hashchange 监听全部走 navigate，后退/前进不丢 filter 重置；初始化读 hash 决定初始 tab（**非法 hash 回退刷题页**）；**不引入依赖**。
  - **体验② 无障碍（评审 C2 修订）**：QuestionCard **单选/多选/boolean 三分支**的选项区统一加键盘支持（单选 `role="radio"`+方向键，多选 `role="checkbox"`+Tab+空格，判断同单选；tabIndex 可聚焦），键盘与现有点击走同一判分 setter 并存。验收补多选/判断键盘操作各一次。
  - **体验③ 错误文案**：client.ts `req()` 失败时先读 `j.message`（Fastify 默认错误），再读 `j.error`，回退英文状态名不再裸显。
  - **体验④ selectModel 回滚**：SettingsPage.selectModel 先 `await api.setActiveModel` 成功后再 `setActive`（失败仅报错不假选）。
  - **体验⑤ ProviderForm 统一（评审 C6 修订）**：alert → 内联错误区；apiType 自由文本 → 下拉枚举（openai-completions / anthropic-messages）+ **编辑模式兜底：现值不在枚举内时作为额外 option 显示**（历史自由文本不空白，types.ts:135 api 是 string）。
  - **卫生⑥ 死代码清扫（评审 C4/S2 修订）**：删除 shared-check.ts、client api.validateDrafts + shared 的 ValidateDraftsRequest/Response 类型、attemptRepo.listWrongQuestions、wrongBookRepo.getState；**providerRepo.get 有内部调用（create:74/update:93）——改为私有 getRow 内联**（非纯删除）；practiceRepo.remove 保留（smoke-e2e 在用）；**顺带删除无消费方的 POST /api/import/validate 端点**（S2，防二次卫生债，server questionSchema.validateDrafts 内部校验不动）。
  - **卫生⑦ nanoid**：删 package.json 依赖（pnpm-lock 同步）。
  - **卫生⑧ 重复合并（评审 C5 修订）**：题型中文映射抽到 `@exam/shared`（`QUESTION_TYPE_LABEL` 常量）**覆盖全部 6 处 UI**（Scorecard/QuestionCard/BanksPage/QuizPage/WrongBookPage/DraftEditor，含 3 处 select 复用）；**tutorPrompts/parseWithAi 两处 prompt 文本不动**（AI prompt 红线）；`flash()` 抽公共 util（3 份合一）；删除题库逻辑统一 confirm 风格。
  - **卫生⑨ 孤儿 JSONL（评审 S1 修订）**：AiService 新增 `createInMemoryTutorSession`（SessionManager.inMemory 变体，**不检查 sessionFile**——区别于 createTutorSession:144-147 的空值检查），insights analyze 改用之（类型标注同步换新方法返回类型），不再落盘孤儿文件。
  - **卫生⑩ 竞态（评审 C1 修订：不用事务——better-sqlite3 事务是同步块不能 await，且 AI 调用必须在事务外）**：tutor 路由层加 in-flight 去重 `Map<questionId, Promise<Session>>`——同一题并发 explain 时第二个请求复用第一个进行中的会话（AI 调用也只发一次）；请求完成/失败后清理 Map。~10 行，不动 schema/不重建表。
  - **卫生⑪ 测试（评审 S3/S4 修订）**：新增 `parseFile.test.ts`（JSON/CSV/xlsx 解析正确性 + 畸形输入容错）+ `routes.smoke.test.ts`（**自建 Fastify 实例按 register*Routes 组装 + AiService 桩，不 import index.ts（顶层 listen）**，DATA_DIR 指临时目录，`app.inject` 走 HTTP 层：建库→导入→练习→判分→错题→graded + provider 配 Key→密文入库→列显脱敏，不依赖真实 AI）；server package.json 加 `"smoke": "tsx smoke-e2e.ts"` script。
- **影响面**：client 全站轻触（App 路由/QuestionCard 键盘/req 错误路径/Settings/ProviderForm/两页去重）；server 局部（AiService 新增方法、insights 会话方式、tutorSessionRepo 事务、删 4 个导出）；shared 加 1 常量。DB schema/部署架构/nginx/compose 零改动。
- **目标验收**（每条可执行）：
  - `pnpm typecheck` 0 错误
  - `pnpm test` 全量通过：现有 58 用例全绿 + 新增 parseFile 用例（JSON/CSV/xlsx 各解析正确 + 畸形输入不抛）+ routes.smoke 用例（HTTP 全链路 + provider 密文）
  - `smoke-e2e.ts` 51 断言保持全绿
  - `git diff` 确认：无新增依赖（nanoid 为删除）、无既有表结构改动、docker/compose 零改动
  - 代码级验证（浏览器自动化实测经用户决定取消，2026-08-12）：`parseTabFromHash` 纯函数单测覆盖合法/空/非法 hash（含 #/bogus 回退）；App.tsx 单一 navigate 收口 + hashchange 监听代码核查；QuestionCard 三分支键盘 handler 代码核查；client req() 读 j.message 代码核查
- **回归验收**（旧功能未坏）：全量测试 + smoke 51 全绿；远程回归：Tab 切换/刷题判分/错题本筛选（applyFilter）/导入/学情四面板与第二批一致；无 hash 时默认进刷题页（兼容旧入口）。
- **范围红线**：安全项（无鉴权/SSRF/依赖漏洞）与备份方案不碰；部署架构/nginx/compose 不变；**不重建既有表**（竞态用应用层事务，schema 零改动）；不引入新依赖（hash 路由用原生）；AI prompt/行为不变。
- **状态**：已完成（2026-08-12，auditor 三轮 approved）
  - 本地：typecheck 0 错误、79 测试全过（58 旧 + parseFile 10 + routes.smoke 7 + routeHash 4）、smoke 51 断言（script）
  - 契约⑤按用户决定取消浏览器实测，改 parseTabFromHash 纯函数单测（4 用例）+ 代码核查
  - auditor 否决项修复：useFlashNotice 三处实际调用（原 hook 死代码）、删除题库 confirm 文案统一（669e4f8）
  - 远程：已部署 healthy；零新增依赖（nanoid 删除）、schema/docker 零改动

### 2026-08-12 第四批：P3 功能增值——导出 + 练习历史 + 标签复习（级别：M）（修订 v2：评审 1 blocker + 7 concern 全部修订）

- **现状**：① 无任何导出能力（题库/错题只能留在系统内）；② 练习历史不可查（practice_sessions/attempts 有数据但无界面，做完即忘）；③ 标签复习只能手输标签（QuizPage byTag 用自由 input，易输错、看不到可用标签；后端 byTag scope 与 GET /api/tags 已完整支持）
- **目标**：① 题库/错题一键导出 CSV（RFC4180 转义，列与导入模板同构）；② 新增「历史」页签（#/history）：练习会话倒序列表（题库/题数/正确率/完成态）→ 详情（成绩单）→ 重练/重开/继续；③ 标签复习改下拉（按所选 bank 显示标签题量），选中即开练
- **改动点**：
  - server（4 个新端点，无既有路由改动）：
    - `GET /api/export/:bankId/questions.csv`（quiz.ts）：该题库全部题目，列 = 导入模板 6 列同构（type,stem,options,tags,answer,explanation），RFC4180 转义（含逗号/引号/换行的字段加引号、引号翻倍），UTF-8 BOM 头（Excel 中文兼容）
    - `GET /api/export/wrong.csv`（quiz.ts）：全库错题（各题最新一次作答 is_correct=0），列 = questions.csv 6 列 + wrong_answer 追加列（用户错误作答 JSON）
    - `GET /api/history/practices`（quiz.ts，limit 30）：practice_sessions 倒序，每项 { id, bankId, bankName, questionCount, scope, createdAt, completed(insight_snapshots.session_id 存在), correct/total/accuracy(buildScorecard 聚合) }
    - `GET /api/tags/counts?bankId=`（banks.ts，GET /api/tags 旁）：该 bank 内 {tag,count}[]（按 questionRepo.listByBank 统计），count=0 不返回（零题量标签不展示）
    - 配套：`buildScorecard` 由 quiz.ts 模块私有改导出（纯函数，逻辑零改动，仅加 export 关键字）
  - client：
    - BanksPage 题库行「导出 CSV」按钮 + WrongBookPage「导出错题 CSV」按钮（Blob 下载，native URL.createObjectURL，文件名 exam-{bank}-YYYYMMDD.csv / exam-wrong-YYYYMMDD.csv）
    - 新页面 HistoryPage（列表：题库/题数/正确率/完成态徽标；详情：复用 GET /api/practice/:id/scorecard 渲染成绩单；按钮三态：完成→「重练」、未完成静态范围→「重开」、未完成→「继续」）
    - App.tsx tab 加 history（第 6 个 tab，navigate 收口处追加分支；routeHash.test 补 history 合法用例）
    - QuizPage byTag 的 input 改 select 下拉（数据源 GET /api/tags/counts?bankId=当前选中 bank，显示「标签（N 题）」；未选 bank 时提示先选择题库；选后 scope.tag 链路零改动）
- **影响面**：
  - quiz.ts 新增 3 端点 + buildScorecard 导出（无行为变化）；banks.ts 新增 1 端点；App.tsx tab 定义 + navigate 分支；BanksPage/WrongBookPage/QuizPage 各加按钮/换控件（不动既有逻辑）；routeHash.test 补用例
  - 已声明事实：删除题库会 CASCADE 连带清除该库练习历史/快照（现有行为，非本批引入，删除 confirm 文案已含"相关作答/错题/答疑记录一并删除"）
  - 重练语义：静态范围（all/byType/byTag）重开=同范围新会话；动态范围（undone/wrong）重开=按当前作答状态重算题集（题集可能缩水，属预期，文案标「重开」）
  - 续做：HistoryPage「继续」写入现有 localStorage 续做键 + navigate("quiz")，复用 QuizPage 既有恢复逻辑（与现有续做唯一入口一致，无冲突）
- **目标验收**：
  - `pnpm typecheck` 0 错误；`pnpm test` 全量通过（新增 exportCsv 转义单测：逗号/引号/换行/BOM；history 聚合单测；routeHash history 用例；旧 79 用例必须全绿）
  - curl 本地验证：`/api/export/:bankId/questions.csv` 表头 6 列 + 转义正确；`/api/export/wrong.csv` 7 列含 wrong_answer；`/api/tags/counts?bankId=` 只含该库标签且计数正确；`/api/history/practices` 含 completed/correct/total
  - smoke 冒烟全绿（51 断言不降）
  - 远程部署后抽查（证据落盘 specs/verification/）：导出的 CSV 用 Excel 打开中文不乱码、WrongBookPage 导出按钮存在且文件可下载、历史页出现最近会话且完成态正确、标签下拉显示「标签（N 题）」且 N 与题面一致
- **回归验收**：
  - `pnpm test` 全量（旧 79 用例全绿）+ smoke 51 断言
  - hash 路由 5 旧 tab + 非法回退 + 下钻链（drillToQuiz/drillToWrong/startTaskQuiz）+ 错题本 applyFilter + 学情四面板与第三批一致（InsightsPage 零改动）
  - QuizPage 其余 mode（all/undone/wrong/byType）与练习闭环（start→答题→判分→finish 快照）行为不变；BanksPage 创建/删除/导入题库流程不变
- **范围红线**：主观题批改不做（留待评估）；不新增依赖（CSV 手写转义）；既有表零改动（practice_sessions/attempts/schema 零迁移，tags/counts 为读聚合）；AI prompt/行为不变；安全项/备份方案不碰；部署架构/nginx/compose 不变
- **状态**：已确认（2026-08-12，评审 1 blocker + 7 concern 修订清零后确认）

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
- **状态**：已完成（2026-08-12，auditor 三轮 approved）
  - 本地：typecheck 0 错误、79 测试全过（58 旧 + parseFile 10 + routes.smoke 7 + routeHash 4）、smoke 51 断言（script）
  - 契约⑤按用户决定取消浏览器实测，改 parseTabFromHash 纯函数单测（4 用例）+ 代码核查
  - auditor 否决项修复：useFlashNotice 三处实际调用（原 hook 死代码）、删除题库 confirm 文案统一（669e4f8）
  - 远程：已部署 healthy；零新增依赖（nanoid 删除）、schema/docker 零改动
