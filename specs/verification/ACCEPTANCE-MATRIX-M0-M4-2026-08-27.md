# 考试助手（dsh-exam）全量回归与验收矩阵 M0–M4

> 作者：reviewer（终审与验证工程师）｜日期：2026-08-27｜任务：t4（只读基线 + 验收矩阵，零实现修改）
> 适用对象：本优化周期全部四个里程碑的**机器测试**与 **GUI 验收**清单，供后续终审任务按序直接执行。
> 目标代码面：`packages/dsh-exam`（本周期优化对象）；`packages/server|client|shared` 为既有已验证应用（基线仅登记，不重复展开）。

---

## 0. 基线快照（2026-08-27 15:07 本地实测，commit `328e373`）

| 项 | 命令 | 结果 |
|---|---|---|
| typecheck | `pnpm typecheck`（4 包递归 tsc --noEmit） | ✅ 0 错误（exit 0） |
| test | `pnpm test` | ✅ **dsh-exam 128/128 通过**（node --test，~8.7s）；**server 110/110 通过**（vitest 16 文件，~2.5s）；shared/client 无测试脚本 |
| build | `pnpm build` | ✅ 全绿：dsh-exam `tsc -p tsconfig.build.json` + bundle（tsdown 264.16 kB client.js / gzip 50.54 kB，client-bundle-smoke ok）；server `tsc`；client `tsc --noEmit && vite build`（269.92 kB） |
| 已知失败 | — | 无 |
| 已知警告 | — | 无（tsdown/vite 输出干净；tsconfig 未开 noUnusedLocals，无未使用符号告警源） |

- 基线日志存档：`.agent-teams/exam-comprehensive-optimization/artifacts/baseline-test-328e373.log`
- 注意：`packages/dsh-exam/` 在 git 中为**未跟踪新目录**（基线 = HEAD 328e373 + 当前工作树）；t1/t2/t3 并行实施中，终审执行时应以**收口后新基线**复跑本表，再判回归。
- dsh-exam 测试分布（128，按文件实测）：store 25 / smoke 29 / ai 27 / tools 20 / llm 9 / grading 8 / practice 7 / insights 3。

### 模块/API 地图（矩阵引用依据）

- **Host 服务方法**（service.ts）：health / 题库 CRUD / resolveQuestionIds / start·resume·updateIndex·delete·finishPractice / gradeAnswer / buildScorecard / listWrong / setMastered / testLlmStream / gradeEssay / getEssayGrading / Tutor（get·list·chat）/ listImportedQuestions / importQuestions / listInsight / diagnoseInsight / generatePlan / list·get·addItems·setItemDone·createManualPlan / listPracticeHistory / explainQuestion / getPracticeExplanation / explainGenericQuestion。
- **HTTP 路由**（index.ts，前缀 `/exam/api`）：exact：health、banks、llm/test、grading/essay、tutor/chat、tutor/sessions、practice/explain、import/generate、import/commit、insights、insights/diagnose、plans/generate、plans；prefix：grading/<attemptId>、tutor/sessions/<id>、banks/<bankId>/questions、questions/<id>（PUT/DELETE）+ questions/<id>/explain-generic、practice/*、quiz/grade、wrong 与 wrong/<id>/master、plans/*、/exam/api 兜底 404。
- **Agent 工具**（tools.ts，10 个）：exam_list_banks / exam_get_questions / exam_create_bank / exam_create_question / exam_import_from_text / exam_tutor_ask / exam_start_practice / exam_get_insight / exam_grade_essay / exam_list_plans。
- **客户端页面**（client/）：ExamWorkspace（5 tab：题库/练习/错题本/AI 学习/学情）、BankDetail（题库详情+题目 CRUD）、PracticeView（练习+历史续做+essay+P/G 解析）、WrongView（错题分组+掌握标记）、AiTools（Tutor+AI 导入）、Insights（洞察+诊断+计划）、SettingsSection（健康卡）、SidebarAction/ExamOverlay（侧栏入口+全屏面板）。

---

## 1. M0 — 基线工程（数据层迁移 / 构建链路 / 错误矩阵 / 降级）

### 机器测试（自动化，已存在 → 回归；`[]` 为缺口 → 新增）

- [ ] `pnpm typecheck` 0 错误；`pnpm test` dsh-exam 128 + server 110 全绿；`pnpm build` 全绿（三条为每个里程碑前置门禁）
- [ ] 迁移链路：store.test.ts「Phase2+4 迁移：全新库 schemaVersion=5，十一表+全部索引」「Phase2→4：v1 库升级」「Phase2：v2 库升级」「Phase2 迁移：中途失败残留 questions_new 后重试」「Phase4 迁移：v3→v4」——**v1→v5 逐级升级、存量数据保留、幂等重试**均须保持绿
- [ ] 降级路径：smoke.test.ts「store 关闭后 → 503 EXAM_STORE_CLOSED」「store 未打开 → health 503 可读错误 / banks 503 EXAM_STORE_UNAVAILABLE」
- [ ] 路由表：smoke.test.ts「未匹配 /exam/api/* → 404 JSON」+ 405 方法矩阵（tools.test.ts「POST /tutor/sessions/:id → 405」等）；**新增**：重复 register 路由冲突抛错用例（若未覆盖）
- [ ] LLM 错误归一：llm.test.ts 9 用例（timeout/abort/tool-call/stream-failed/stop 全映射）；**新增**：provider/model 缺失（EXAM_LLM_NO_PROVIDER/NO_MODEL）在服务层各入口（tutor/import/insights/plan/essay/explain）的映射一致性
- [ ] 工具契约：tools.test.ts「快照：注册 10 个 exam_* 工具+systemPrompt 引导节」「execute 错误映射 4 例」——工具数、参数、输出形态冻结
- [ ] 错误码 HTTP 映射（index.ts mapServiceError）：400/404/405/500/503 各码至少一条已测；**新增**：contract.ts 错误码词汇表 ↔ errors.ts ↔ 路由映射三方一致检查（脚本或用例）

### GUI 验收（浏览器）

- [ ] DSH Web GUI 打开 → 侧栏底部出现「考试助手」入口（前置：插件已挂载；未挂载时先完成 preset 安装，见 §6 前置条件）
- [ ] 设置页「考试助手」分区健康卡：store ok / schemaVersion=5 / llmReady 与真实配置一致；数据目录路径正确（`.exam-data`）
- [ ] 停止插件/关 store 场景（可选）：health 503 文案可读，不白屏、不无限 loading

---

## 2. M1 — 题库模块（生命周期 / 搜索 / 批量）

### 机器测试

- [ ] store.test.ts「Phase1 题目 CRUD」「Phase1 级联删除：删题清作答/错题；删 bank 级联清题目链」「Phase1 作答 + listLatestAttemptByQuestion」
- [ ] smoke.test.ts「Phase1 题目 CRUD：创建/列表/更新/删除 + 400/404 语义」「POST/GET /exam/api/banks 往返，空名 400，错误方法 405」
- [ ] tools.test.ts「exam_create_bank」「exam_create_question」「exam_get_questions 传 bankId 并支持 type/tag 过滤」「exam_import_from_text commit=false 仅生成草稿 / commit 缺省=true 入库」
- [ ] practice.test.ts「resolveQuestionIds：all / byType / byTag / 缺筛选值回退 all+warn」「shuffleIds：固定 seed 确定性」
- [ ] **新增（搜索/批量）**：`listQuestionsByBank` 按 type/tag 过滤的组合断言（type+tag 同时过滤）；`exam_get_questions` 非法 type/tag 参数 → EXAM_INVALID_BODY 且服务不被调用；批量导入 `importQuestions` 空数组/非数组 → EXAM_INVALID_BODY

### GUI 验收

- [ ] 题库 tab：卡片网格（学士帽封面+题数徽章+建库时间）加载/空/错误三态；新建题库（空名拒绝、成功刷新列表与徽章）
- [ ] 题库详情：4 题型（single/multiple/boolean/essay）新建表单校验（选项非空、多选至少 1 正确、essay 免选项）；列表展示；编辑（PUT 局部字段）；删除（行内二次确认「确认删除？」）
- [ ] **搜索/批量（目标态）**：详情页可按题型/标签筛选题目（API 已支持，GUI 待 client-engineer 补齐；当前为缺口）
- [ ] 题目「AI 讲解」（G 形态）→ 生成后 explanation 写回，列表可见；重复调用覆盖；essay 题提示走批改
- [ ] 批量导入入口（M3 详列）提交后题数徽章即时 +1

---

## 3. M2 — 错题本模块（掌握 / 重练）

### 机器测试

- [ ] store.test.ts「Phase1 错题本：touchWrong 计数、setMastered、listWrong 过滤与排序」
- [ ] practice.test.ts「resolveQuestionIds：undone（从未作答）与 wrong（错题本）语义」
- [ ] smoke.test.ts「Phase1 错题本：答错入册 → 列表 → 掌握标记 → includeMastered 语义」
- [ ] practice.test.ts「setMastered：掌握标记影响 wrong 列表 includeMastered 语义」
- [ ] **新增（重练闭环）**：wrong scope 开练只含错题；错题重练答对后 wrong 列表相应更新（错误计数不变/已掌握迁移语义按需求定稿）；掌握标记后 wrongCount 保留但列表默认隐藏

### GUI 验收

- [ ] 错题本 tab：分组展示（高频 ≥3 次 / 近期 <3 次 / 已掌握），组标题带题数；按题库筛选（bankId）
- [ ] 展开条目：题目+正确答案+最近错误时间；「标记掌握/取消掌握」即时刷新分组
- [ ] 练习页 mode=wrong 开练：只出该题库错题；答完判分；重复答错 wrongCount 递增（回错题本核对）
- [ ] **重练入口（目标态）**：错题本条目/组提供「练习这些错题」→ 直达 wrong scope 练习（当前 GUI 缺口：仅练习页手动选 mode=wrong）

---

## 4. M3 — AI 学习模块（Tutor 幂等 / 导入事务 / 草稿恢复 / essay / 解析）

### 机器测试

- [ ] ai.test.ts 29 用例全绿（gradeEssay 容错解析 6 / parseImportedQuestions 3 / buildTutorContext 2 / generateDiagnosis 2 / generateStudyPlan 2 / normalizeAnswerNorm 4 / buildExplainMessages 4 / explainOnce 5 + 边界）
- [ ] smoke.test.ts「Phase2 Tutor：自由问答+绑题+会话列表+校验错误」「Phase2 essay 批改 SSE 全链路」「Phase2 SSE 断开中止：客户端 abort 后底层 LLM signal 中止」
- [ ] smoke.test.ts「Phase4 P 形态 SSE 全链路（delta→done→落库；缓存命中零 LLM；GET 探测两态；force 覆盖单份最新）」「取消零落库」「answer_norm 多选顺序无关」「G 形态空体请求写回/覆盖/essay 400」「缓存命中不依赖 LLM 路由解析」
- [ ] store.test.ts「Phase2 Tutor：会话/消息 CRUD、closeTutorSession、删题 SET NULL」「Phase4 解析缓存：upsert 单份最新 / get / listByQuestion / 校验 / FK / 级联删除」
- [ ] **新增（Tutor 幂等，t2 目标态）**：chatTutor 流失败重试 → 服务端不产生重复 user 消息（幂等键或失败回滚语义）；同一轮重试消息内容一致时会话历史唯一
- [ ] **新增（导入事务，t1/t2 目标态）**：`importQuestions` 全量成功或全量失败（事务原子性）；中途失败零残留（当前实现为部分提交+message 注明已成功数，为已知缺口）；commit 后 questions/bank 计数一致
- [ ] **新增（草稿恢复，t2/t3 目标态）**：import 草稿在刷新/重开面板后仍可恢复（持久化方案按定稿）；草稿校验失败内联提示后草稿不丢（已有客户端行为，需补测试）

### GUI 验收

- [ ] AI 学习 tab：Tutor 对话（自由问答 / 从题库题目进入的绑题会话），SSE 流式输出、停止生成按钮、历史会话列表与回看
- [ ] **失败重试**：断网/停 LLM 后发送 → 本地气泡被移除、输入回填、错误提示可读；恢复后重试 → 对话历史无重复 user 消息（服务端唯一）
- [ ] AI 导入三步（粘贴 ≥50 字 → 生成预览 ≤8 题 → 选库提交）：草稿逐题编辑（type/stem/options/answer/explanation/tags）、删题、校验失败内联提示且不丢草稿、提交成功提示 count
- [ ] **草稿恢复（目标态）**：生成草稿后刷新页面/重开面板 → 草稿仍可编辑提交
- [ ] 主观题：essay 作答 → AI 批改 SSE（score/verdict/feedback/reference）→ 练习内回看批改卡；quiz/grade 对 essay → 400 提示
- [ ] 练习内 P 形态解析：判分后点「AI 讲解」流式生成；再次进入命中缓存零流式；「重新解析」覆盖；未判分提示 409

---

## 5. M4 — 学情模块（指标口径 / 图表 / 诊断 / 计划状态与动作）

### 指标口径（服务端定稿，机器核对）

- accuracy = correctAttempts / totalAttempts（0..1，无作答为 0）；daily = 近 7 天按**本地日期**归日、**含空档日**、升序；byType = 按题型 {total, answered, correct, accuracy}；wrongTop = 按 wrong_count 降序 Top10 附 stem；weakTypes = answered>0 中 accuracy 最低题型（无作答为空数组）；finishedPractices = 已结束会话数；history answeredCount = 按题去重口径（≠ scorecard.answered，Phase4.3 已修复）

### 机器测试

- [ ] insights.test.ts 3 用例全绿（空库全零+7 天空档 / 聚合正确性含跨日空档 / Top10 截断+weakTypes 空）
- [ ] smoke.test.ts「Phase2 学情：insights 聚合正确性 + diagnose（fake llm）」「Phase2 学习计划：generate 落库 / 手动新建 / 追加 / 完成 / 列表 / 404」「Phase4.3 计数修复：历史 answeredCount 按题去重且含 essay」
- [ ] **新增（计划状态机，t1/t2 目标态）**：全条目 done → plan.status 自动 active→completed（当前 store 仅改条目、计划恒 active，为已知缺口）；再开一条 done=false → 回 active；completedAt 记录
- [ ] **新增（计划可执行动作，t3 目标态）**：计划条目 → 一键开练 scope 映射（byTag/byType/错题）的解析用例；开练后计划条目联动完成（若定稿）

### GUI 验收

- [ ] 学情 tab 洞察卡：总答题/正确/正确率/完成练习 数字与服务端口径一致（与已答练习对账）
- [ ] 近 7 天趋势条形图（绿=正确 / 灰蓝=全部，含 0 天空档日展示「暂无数据」）；题型准确率条；薄弱题型高亮
- [ ] 错题 Top10 点击 → 跳错题本 tab（下钻 intent 已实现）
- [ ] 深度诊断 → SSE 流式 {summary, weaknesses, suggestions}；失败降级错误提示可读
- [ ] 学习计划：AI 生成 / 手动新建 / 展开条目 / 勾选完成（乐观更新）/ 追加条目 / 完成数「N/M 完成」
- [ ] **计划状态（目标态）**：全部勾选完成 → 计划标记「已完成」（列表头与计划卡一致）；取消一项回「进行中」
- [ ] **一键开练（目标态）**：计划条目（或计划）提供开练动作 → 直达对应范围练习并可正常作答

---

## 6. 跨模块横切

### 跨模块 intent（已有 → 回归；缺 → 目标态验收）

| # | 链路 | 现状 | 验收 |
|---|---|---|---|
| I1 | 学情错题 Top10 → 错题本 tab | ✅ 已实现（Insights onDrillWrong） | 点击跳转且列表正确（含筛选上下文） |
| I2 | 题库题目 → AI 讲解 → AI 学习 tab 绑题 Tutor | ✅ 已实现（aiQuestion 携带） | 跳转后 Tutor 会话绑定该题、上下文含题目 |
| I3 | 练习 essay 作答 → AI 批改 | ✅ 已实现 | 批改卡回看（M3 详列） |
| I4 | 计划条目 → 一键开练 → 练习 | ❌ 缺口（GUI 无入口） | M4 目标态验收 |
| I5 | 错题本 → 重练（wrong scope） | ❌ 缺口（GUI 无入口） | M2 目标态验收 |
| I6 | Agent 工具链（exam_* 10 工具） | ✅ 已实现 | 会话中调用 exam_list_banks→exam_get_questions→exam_start_practice→exam_get_insight 全链可用 |

### 状态持久

- [ ] 服务端持久：练习会话/进度/判分态（resumePractice 恢复 latestAttempts）、Tutor 会话与消息、错题/掌握、计划、解析缓存、essay 批改 —— **重启 DSH 进程后数据完好**（GUI：重启后进练习页「历史与续做」可见 active 会话并可续做）
- [ ] 客户端内存态（设计如此，无需持久）：面板开关（overlay-store）、tab 位置、导入草稿（**草稿恢复为目标态，M3**）、AI 生成中间态 —— GUI 确认刷新回默认态不报错
- [ ] `:memory:` 与文件库行为隔离（store.test.ts 已有）；dataDir 可配置（settings 覆盖）GUI 验证一次

### 手机（响应式）与键盘可访问性

- [ ] **移动端**：视口 375px（iPhone SE 级）与 768px 下：题库卡片单列、学情网格单列、Tutor 布局 160px 侧栏、题目条目纵向排列；核心链路（建库→导入→练习→判分→错题→学情）可完成；无横向滚动溢出（除长题干预期内换行）
- [ ] **键盘**：全部交互点为原生控件（input/select/textarea/button/label+radio+checkbox）可 Tab 聚焦；`:focus-visible` 焦点环全局可见（styles.css 已定义）；ARIA：tablist/tab、role=alert（错误）、role=status（成功）、role=progressbar（进度）、aria-expanded（计划展开）、aria-label（图标/表单）
- [ ] `prefers-reduced-motion: reduce` 下骨架屏/流式光标动画关闭（styles.css 已实现）
- [ ] 键盘走全流程：Tab 到侧栏入口 Enter 打开 → 5 tab 切换 → 建库 → 答题（方向键/空格 radio checkbox）→ 提交判分 → 错题标记 → AI 对话发送 → 计划勾选，全程无焦点丢失、无不可达控件

---

## 7. 现有测试缺口清单（终审新增测试的优先级排序）

| # | 缺口 | 归属里程碑 | 建议用例 |
|---|---|---|---|
| G1 | Tutor 幂等/重试去重 | M3 | chatTutor 失败后重试不重复落库 |
| G2 | 导入事务原子性 | M3 | 中途失败零残留；计数一致 |
| G3 | 导入草稿持久/恢复 | M3 | 草稿序列化→恢复→提交 |
| G4 | 计划状态机 | M4 | 全 done→completed；回退→active |
| G5 | 计划→练习 scope 映射 | M4 | 一键开练解析 |
| G6 | 错题重练闭环 | M2 | wrong scope 开练→答对→列表联动 |
| G7 | 题库 type/tag 组合过滤 | M1 | listQuestionsByBank 双条件 |
| G8 | 工具非法参数矩阵 | M1/M3 | exam_get_questions/import_from_text 非法入参 |
| G9 | 客户端组件逻辑 | 横切 | AiTools 失败气泡移除/草稿校验、WrongView 分组、Insights 乐观更新、PracticeView 导航状态机、overlay-store（需引入客户端测试框架或抽出纯函数） |
| G10 | 学情口径 GUI 对账 | M4 | 已答数据 → 页面数字与服务端断言一致 |

---

## 8. 手工浏览器场景清单（后续终审任务直接执行）

**前置条件**
1. dsh-exam 插件已挂载进 DSH Web GUI（GUI 地址 http://127.0.0.1:3080）：检查侧栏底部「考试助手」入口；未挂载时按 `.codebase-review/exam-coach-preset/README.md` 安装 user preset 并重启 DSH（sandbox 限制下需 captain/用户执行 `~/.dsh/.agent-presets/exam-coach/` 安装）。
2. LLM provider/model 已在 DSH 设置中配置（Tutor/导入/诊断/计划/解析需要；纯练习链路不需要）。
3. 数据目录可写（默认 `<cwd>/.exam-data`）；每场景可在独立新库上执行（避免历史数据干扰断言）。

**场景 S1 建库与导入（M1+M3）**：新建题库「测试库」→ 粘贴 ≥50 字资料 → AI 生成草稿 → 编辑 1 题 → 提交 → 详情列表 +N 题、卡片徽章 +N。
**场景 S2 练习判分（M1+M2）**：all 范围开练 → 单选/多选/判断各答 1 题 → 判定与预设一致（多选顺序无关）→ 进度条/导航点正确 → 完成 → 成绩单（总数/已答/正确/正确率/分题型）。
**场景 S3 续做恢复（状态持久）**：练习答 2 题后刷新页面 → 「历史与续做」出现 active 会话 → 续做恢复进度与已答判分态 → 完成后进历史可见成绩单与「重开」。
**场景 S4 错题与掌握（M2）**：故意答错 2 题（其中 1 题错 3 次）→ 错题本「高频/近期」分组正确 → 标记掌握 → 移入「已掌握」→ 取消掌握还原。
**场景 S5 错题重练（M2 目标态）**：错题本点「练习这些错题」→ 仅含错题 → 答对 → 回错题本核对状态。
**场景 S6 Tutor 讲解（M3）**：题目「AI 讲解」→ 跳 AI 学习 tab 绑题会话 → 流式回复 → 追问一轮 → 历史会话列表回看。
**场景 S7 Tutor 失败重试（M3 目标态）**：断网发送 → 气泡移除+输入回填+错误提示 → 恢复后重试 → 历史无重复消息。
**场景 S8 AI 导入事务（M3 目标态）**：构造 1 条非法草稿（如缺答案）与若干合法草稿 → 提交 → 全量失败零入库（或按定稿语义），题数不变。
**场景 S9 学情对账（M4）**：完成 2 次练习（跨两天数据可选）→ 学情数字与成绩单/历史对账 → 趋势图含空档日 → 错题 Top10 点击下钻错题本。
**场景 S10 计划闭环（M4 目标态）**：AI 生成计划 → 逐项勾选 → 全部完成 → 计划变「已完成」→ 一键开练直达练习。
**场景 S11 移动端（横切）**：375px 视口走 S1→S2→S4 核心链路，无溢出、控件可点。
**场景 S12 键盘全流程（横切）**：纯键盘走「打开面板→切 tab→建库→答题→判分→标记掌握→Tutor 发送」，焦点环全程可见。

---

## 9. 执行说明（给终审任务）

1. **顺序**：M0 门禁（typecheck/test/build）→ 各里程碑机器测试（已有套件回归 + `[]` 新增）→ GUI 场景 S1–S12（每场景记录 PASS/FAIL + 证据截图，沿用 `specs/verification/` 既有证据格式）。
2. **标记约定**：✅ 已实现且绿；❌ 已知缺口（见 §0/§4/§5/§6）；`[]` = 待新增测试；目标态项以「（目标态）」标注，执行前先与 t1/t2/t3 定稿实现对齐，避免按旧行为误判。
3. **已知缺口清单（基线时点）**：① chatTutor 无服务端幂等键（失败重试会重复 user 消息）；② importQuestions 非事务（部分提交）；③ 导入草稿仅客户端内存；④ 计划全 done 不自动 completed；⑤ 计划/错题本无「一键开练/重练」入口；⑥ BankDetail 无 type/tag 筛选 UI；⑦ 客户端零自动化测试。①②③④⑤⑥⑦ 分别对应 t1/t2/t3 目标，终审以其定稿验收。
4. **基线漂移**：t1/t2/t3 并行修改中；本矩阵的「基线」断言（128/110/0 错误）仅代表 328e373 时点，终审前须重跑 §0 三命令刷新。
