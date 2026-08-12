All verification complete. Here is the independent review.

---

# 第三批 CHANGE.md（M 级）独立评审

评审对象：`specs/CHANGES.md`「第三批：P2 体验优化与代码卫生」一节。只读评审，逐项与源码核对（共核查 30+ 文件，实跑测试/类型检查）。

## 一、五维逐条核查结论

### 1. 完整性 ✅
11 项（体验 5 + 卫生 6）全部有「现状→目标→改动点→验收→回归→红线」，且与用户确认口径一致（全量、轻量 hash 路由不引依赖、补 parseFile + 路由冒烟测试）。目标验收每条可执行（typecheck / test / smoke / git diff / 远程实测）。

### 2. 一致性 ⚠️ 三处失真（详见下表）
- 卫生⑥「providerRepo.get 死代码」**不准确**：有 2 处内部调用
- 卫生⑧「题型映射 4 处」**低估**：实际 6 处 UI + 2 处 prompt
- 行号引用多处偏移（如 QuestionCard 标注 107-128，实际选项区 96-120，且漏掉 boolean 分支）

### 3. 可行性 ⚠️ 一项设计歧义（卫生⑩，见 concern-1）
其余各项均与源码能力核对通过：`SessionManager.inMemory` 已在 `runOnce` 中验证可用（AiService.ts:77,107）；hash 路由与 Vite/无 router 现状兼容；`app.inject` 链路可行（register\*Routes 均导出、DATA_DIR 可覆盖）。

### 4. 可测试性 ✅
验收命令全部可执行。已实测基线：`vitest run` 58 用例全过（与服务记录一致）、client `tsc --noEmit` 0 错误。小缺口：smoke-e2e.ts 无 npm script（手动执行，见 suggestion-4）。

### 5. 范围控制 ✅
红线明确且全部可行：不重建表（竞态用应用层方案，schema.ts 零改动可达成）；不引依赖（hash 原生、nanoid 是删除项，server/package.json:22）；AI prompt 不变（注：题型映射统一不得触碰 tutorPrompts.ts:43 / parseWithAi.ts:12 两处 prompt 文本）。

## 二、回归专项核查

| 必查项 | 结论 | 证据 |
|---|---|---|
| hash 路由 vs 下钻链（drillToQuiz/drillToWrong/startTaskQuiz） | ⚠️ 可行但必须单一路由收敛 | App.tsx:44-58 三个下钻函数直调 `setTab`；switchTab:62-68 承担闭环④ filter 重置。若 hashchange 监听绕过 switchTab，后退/前进会丢失 filter 重置；若下钻只 setTab 不写 hash，URL 过期。**要求：所有 tab 变更（下钻/switchTab/hashchange）收敛到一个 navigate()** |
| QuestionCard 键盘 vs 现有点击判分 | ✅ 低风险，但范围不全 | onClick（:100）保留、键盘走同一 setter 即可并存；但标注 107-128 仅覆盖单选/多选，boolean 分支（:73-93）同为 div 无键盘，且多选题型用 `role="radio"` 语义错误（应 checkbox/group） |
| insights 改 inMemory vs SSE 流式 | ✅ 无影响 | runOnce 已证明 inMemory+subscribe+prompt+dispose 全链路可用（AiService.ts:74-107）；streamPrompt（:169-180）只用 subscribe+prompt，不依赖 sessionFile |
| 删 validateDrafts vs ImportPanel | ✅ 安全 | ImportPanel 用 `localIssues` 本地校验（ImportPanel.tsx:7,56,247），全仓 0 处调用 client api.validateDrafts（client.ts:184） |
| shared ValidateDraftsRequest/Response 他用 | ✅ 可删 | 仅 shared/types.ts:225,228 定义 + client.ts:29 导入（随方法一起删），server 用自己的 questionSchema.validateDrafts（parseFile/parseWithAi/import.ts 在用，不动） |
| tutorSessionRepo 事务防并发 | ⚠️ 机制按字面不可实现 | 见 concern-1 |

## 三、findings 表

### Blocker
无。

### Concern

| # | 项 | 证据 | 最小修改建议 |
|---|---|---|---|
| C1 | **卫生⑩「db.transaction 内先查后插」按字面不可实现**：better-sqlite3 事务是同步块，不能 await；jsonlPath 依赖慢速异步 `ai.createTutorSession`，必须先于事务。且现有流程 getByQuestion(tutor.ts:44) → createTutorSession(await, :47) → create(:50) 的竞态窗口正在 AI 调用期间 | db/index.ts:34-40（同步代理+WAL）；tutor.ts:44-51；tutorSessionRepo.ts:27-43（无事务、question_id 无 UNIQUE，schema.ts:33-35） | 二选一：① AI 先建 → 事务内 `SELECT 再查，有则复用`（败者 dispose + unlink 其 JSONL，防新孤儿）；② 更简：AiService/tutor 路由层加 `Map<questionId, Promise>` in-flight 去重（单容器足够，~10 行，连 AI 调用都只发一次）。文档需写明 AI 调用在事务外，否则实现者会照字面写出不可用代码 |
| C2 | **体验② a11y 范围不全 + 语义错误**：标注 QuestionCard:107-128 只覆盖单选/多选分支；boolean 分支（:73-93）同样不可键盘操作会漏掉；多选题型 `role="radio"` 违背 ARIA（radio=单选互斥） | QuestionCard.tsx:73-93（boolean div）、96-120（选项 div） | 改动点补一句「boolean 分支同处理」；多选用 `role="checkbox"` 或 `role="group"`+button；验收远程实测补多选/判断各一次键盘操作 |
| C3 | **体验① hash 路由与下钻链/闭环④ 的耦合**（见回归表第 1 行） | App.tsx:44-68 | 改动点补明：单一 `navigate(tab)` 收口三处下钻 + switchTab + hashchange；hashchange 触发时同样执行 filter 重置逻辑 |
| C4 | **卫生⑥ providerRepo.get 非死代码**：create(:74) 与 update(:93) 内部调用它。删除需同步内联 2 处，文档未提 | providerRepo.ts:51-53, 74, 93；全仓无外部调用（routes/providers.ts 只用 list/create/update/remove） | 改动点补「providerRepo.get 有内部调用，删除时内联」；或改为私有 `getRow` |
| C5 | **卫生⑧「题型映射 4 处」低估**：实际 UI 6 处（Scorecard:10 / QuestionCard:57 / BanksPage:27 / QuizPage:277 / WrongBookPage:162 / DraftEditor:59）+ server prompt 2 处。若只统一 4 处，QuizPage/WrongBookPage/DraftEditor 三处 select 仍是重复文本，目标未完全达成 | 上述行号 | 明确 `QUESTION_TYPE_LABEL` 覆盖全部 6 处 UI（3 处 select 复用 `options={...}` 或映射取值）；prompt 内文本（tutorPrompts.ts:43、parseWithAi.ts:12）保持不动以守「AI prompt 不变」红线 |
| C6 | **体验⑤ apiType 下拉收窄风险**：shared 类型 `api: string`（types.ts:135），SDK KnownApi 有 10 个值（pi-ai types.d.ts:14），历史自由文本可能存了其他值 → 编辑该类 provider 时 select 显示空白 | ProviderForm.tsx:37（input value=apiType）；types.ts:135 | 枚举外兜底：select 无匹配时把现值作为额外 option（编辑模式），或改用 `<input list>`（datalist 提示+可自由输入） |
| C7 | **体验③ 验收措辞「显示中文 message」难达成**：Fastify 默认错误 `message` 是英文（如 "Body cannot be empty..."），路由手动 send 的 `{error:'中文'}` 今天经 j.error 已能显示中文。改为 j.message 优先只能让英文更可读，不会变中文 | client.ts:52-56；server 无 setErrorHandler（index.ts 全文无） | 验收改「400 显示 message 而非裸 'Bad Request'」；如确实要中文，加 Fastify setErrorHandler 映射（新增工作，需在改动点声明） |

### Suggestion

| # | 项 | 证据 | 建议 |
|---|---|---|---|
| S1 | 卫生⑨ 新方法必须跳过 sessionFile 空值检查；insights.ts:50 的类型标注要换到新方法返回类型 | AiService.ts:144-147（createTutorSession 对空 sessionFile 抛错）；insights.ts:50 | createInMemoryTutorSession 不查 sessionFile；类型标注同步 |
| S2 | 删 client validateDrafts 后，`/api/import/validate` 端点（routes/import.ts:60-66）将无消费方 | import.ts:60-66；client 唯一调用方将删 | 同一批次顺带删除（防二次卫生债），或明示保留理由 |
| S3 | routes.smoke.test.ts 不能 import index.ts（顶层 app.listen），且必须用 DATA_DIR 指到临时目录 | index.ts:44-49（listen at import）；paths.ts:6-7（DATA_DIR 可覆盖） | 测试内自建 Fastify 实例、按 register\*Routes 组装、注入 AiService 桩（不依赖真实 AI，仅覆盖 quiz/import/bank/providers 非 AI 路由） |
| S4 | smoke-e2e.ts 无 npm script，验收命令化打折 | packages/server/package.json scripts 无 smoke 项 | 加 `"smoke": "tsx smoke-e2e.ts"` script（一行） |
| S5 | hash 初始值需白名单校验（`#/bogus` 回退刷题页），验收只提了「无 hash」 | App.tsx:12-18 TABS 键 | 改动点补一句非法 hash 回退默认 tab |

## Review 总结
- **Correct**：现状 11 项全部属实（唯一例外 providerRepo.get 归类不准）；基线实测 58 测试全过、client typecheck 0 错误；红线（不重建表/不引依赖/AI prompt 不变）全部可行；validateDrafts 删除与 inMemory 会话两处高风险点已核实安全。
- **Blocker**：无。
- **Concern**：7 项，均非致命但 C1（事务机制按字面不可实现）必须修订文档措辞后才能动手，C3（下钻链收敛）是回归验收的隐含前提。
- **Note**：行号引用多处偏移不影响结论，但修订版应顺手校正。