# 独立评审：第二批 v3 AI 学习教练全量落地 + P1 流程闭环补齐（CHANGE.md，L 级）

评审方式：只读核对 `specs/CHANGES.md:53-76`、`.rpiv/artifacts/designs/2026-07-18_16-37-31-deep-ai-insights-design.md`（2428 行主设计 + slice1-code.md 554 行）、8 个 slice tsx 文件（共 853 行）、FRD、以及实际代码（QuizPage/App/InsightsPage/WrongBookPage/quiz.ts/types.ts/schema.ts/36 个测试/smoke-e2e）。未看任何采访对话。plan.md/progress.md 在仓库中不存在（含子目录查找），已以 specs/CHANGES.md + .rpiv 文档为评审源。

---

## 总体结论

现状 5 项描述、目标与 FRD 对应、范围红线继承 FRD Non-Goals、36 用例/smoke 43 断言数字均核实无误。但存在 **3 个 blocker**（表名与表数三套命名冲突、slice3 finish() 会回退第一批 P0-2 的 localStorage 清理、已 approved 的 slice 文件之间类型互相矛盾），以及若干 concern。当前状态**不应直接确认**，需先对齐设计基准确认层（哪份文档是唯一权威）再落地。

## Blocker

| # | 问题 | 证据 | 最小修改建议 |
|---|------|------|--------------|
| B1 | **表名/表数三套命名互相矛盾，执行无法定稿**：CHANGE.md 写"4 表（mastery_state … / plan_tasks）"，`mastery_state`、`plan_tasks` 这两个名字在设计文档中**完全不存在**；主设计 Summary 是 4 表（`mastery_states`/`learning_tasks`），schema 一节是 **5 表**（`question_mastery` + `diagnosis_results` + …），slice1-code.md 是 4 表且**没有 `diagnosis_results`**；且 CHANGE.md Slice1 又列了 `diagnosisRepo.ts`（其 SQL 写 `diagnosis_results`，主设计 migration notes 也列 5 表） | CHANGE.md:58；design.md:19,56,208,244（schema 5 表）；slice1-code.md:158-187（4 表无 diagnosis_results）；design.md:579-646（diagnosisRepo INSERT INTO diagnosis_results） | 在 CHANGE.md 明确**唯一权威**（建议 = slice1-code.md 的 `mastery_states`/`insight_snapshots`/`learning_plans`/`learning_tasks` + 补 `diagnosis_results` 第 5 表 DDL，或删除 diagnosisRepo 改存其它表），并把"新增 4 表"改为实际表清单 |
| B2 | **Slice 3 finish() 会静默回退第一批 P0-2**：第一批在 `finish()` 成功路径加了 `localStorage.removeItem(LS_KEY)`（练习完结清续做标记）。设计的 slice3-QuizPage.tsx 整函数替换 finish()，**没有保留 removeItem**；服务器 finish 端点只落快照、不标记会话完结，resumeSession 仍会续做已完结会话——正是 P0-2 修的 bug | QuizPage.tsx:147-157（现 finish 含 removeItem）；slice3-QuizPage.tsx:1-12（替换版无 removeItem）；design.md:734-753（finish 端点只存快照）；CHANGE.md:60（未提保留 LS 清理） | 在 CHANGE.md slice3 显式要求：新 finish() 必须保留 `localStorage.removeItem(LS_KEY)`（或服务器加 finished 标记并让 resume 跳过）；并把"练习完结后不进续做"加进远程回归步骤 |
| B3 | **已 approved 的 slice 代码之间类型互相矛盾**，CHANGE.md 却称"slice 代码已在 design 文档中 approved"为单一整体：`FinishPracticeResponse` 主设计是 `{scorecard, snapshotId}`、slice1-code 是 `extends Scorecard`；`snapshotRepo.save` 主设计为 7 位置参数返回 string、slice1-code 为对象参数返回 `InsightSnapshot\|null`（finish 端点按主设计位置参数调用）；`TrendPoint` 主设计 `{ts,...}`、slice1-code `{timestamp,...}` 且 TrendChart.tsx 用 `pt.ts`；`DiagnosisResult` 主设计为扁平 `{errorCategory,distractorNote}`、slice1-code 为聚合 `{errorDiagnoses[],distractorStats[]...}` 而 slice5-DiagnosisPanel.tsx 用扁平字段；`GradeResponse.mastered` 主设计必填、slice1-code 可选 | design.md:117-130 vs slice1-code.md:15,30-37,79-91,107-116；design.md:742-753 vs slice1-code.md:280-330；slice4-TrendChart.tsx:22,86 vs slice1-code.md:30-37；slice5-DiagnosisPanel.tsx:38,91-93 vs slice1-code.md:44-52；design.md:709-731（mastered 必填）vs slice1-code.md:91-100（可选） | 执行前做一次"设计对账"：选一份权威类型（建议 slice1-code.md 但以主设计 finish 端点/DiagnosisPanel 为准回改），统一 FinishPracticeResponse/save 签名/TrendPoint/DiagnosisResult/GradeResponse.mastered 可选，产出修订版 slice1-code 并让 auditor 复核 |

## Concern

| # | 问题 | 证据 | 最小修改建议 |
|---|------|------|--------------|
| C1 | `idx_attempts_question_time ON attempts(question_id, answered_at DESC)` 加在**既有表**上，与回归验收"既有表结构零改动（仅新增表）"字面冲突；且 D1 已选 Option A 增量列（明确"不查历史 attempts"），该索引是死重 | design.md:264-266（索引）；design.md:76-84（D1 Option A）；design.md:2372-2373（"mastery hook O(1)…不查历史 attempts"）；CHANGE.md:74 | 删除该索引（D1 下不需要），或在 CHANGE.md 显式豁免为"仅新增表 + 1 个 attempts 索引" |
| C2 | **闭环 5 项中 4 项（①③④⑤）没有任何验收条目**：目标验收 ①-⑦ 只覆盖 ②（对应⑦错题本历史回读）。①onDrillToWrong 接通、③CSV/Excel 文档、④filter 切页重置、⑤错题本 loading/双请求合并均无可执行验收 | CHANGE.md:64（闭环 5 项）vs CHANGE.md:66-70（目标验收仅 7 条）vs CHANGE.md:71-74（回归验收） | 每条闭环项补一条可执行验收（如：①学情薄弱点点击→错题本带 tag 筛选打开；③导入页/README 存在列约定说明；④下钻后切 tab 再回来 filter 为空；⑤错题本挂载仅 1 个 listWrong 请求且有 loading） |
| C3 | `GradeResponse.mastered` 若按主设计**必填**，现有 P0-2 的 graded 端点（quiz.ts:207-231 构造不含 mastered 的响应）会 typecheck 失败，与回归验收"typecheck 0 错误"冲突 | design.md:709-716（必填）vs slice1-code.md:91-100（可选）vs quiz.ts:207-231 | 统一为 `mastered?: boolean`（可选），不动 graded 端点 |
| C4 | D8 写"MASTERY_THRESHOLD=3 可通过环境变量覆盖"但设计代码硬编码 `const MASTERY_THRESHOLD = 3`；D5 决策文本"返回 Scorecard"与代码 `{scorecard, snapshotId}` 不符 | design.md:109-111（D8）vs design.md:646-660（硬编码）；design.md:97-99（D5 文本）vs design.md:752（代码） | 删除"环境变量覆盖"表述或补实现；D5 文本改为"返回 {scorecard, snapshotId}" |
| C5 | 影响面"**4 新组件**"实际为 3 个（TrendChart/DiagnosisPanel/PlanPanel）；Slice 4 引"**D2**/D34"——D2 是计划/任务两表模型，与趋势无关（应为 D34） | CHANGE.md:65（4 新组件）；design.md:916,1492,1720（3 组件）；CHANGE.md:61（D2/D34）vs design.md:87-89（D2 两表）/FRD DEC-34 | 改"3 新组件"；Slice4 引用改"D34" |
| C6 | 目标验收未给 Slice5/6 的 zod schema（diagnosisSchema/planSchema）与 prompts 列单测，AI 结构化产出只有远程 E2E 兜底；远程 AI 失败时验收无法在本地复现 | CHANGE.md:68（新增单测仅 masteryService/snapshotRepo/planRepo/snapshotHistory） | 补 2-3 个最小单测：错因枚举非法值被 zod 拒绝、AiPhase 缺 scope 被拒（parseWithAi 范式已有同类测试可抄） |

## 已核实正确（Correct）

- **现状 5 项全部属实**：`onDrillToWrong` 在 Props 声明但组件只解构 `onDrillToQuiz`（InsightsPage.tsx:10-11,21）；`autoLoadHistory` 无调用方（TutorPanel.tsx:16-42，QuizPage/WrongBookPage 均不传 true，tutor.ts:96 端点存在）；CSV 模板文档遗留 `[ ]`（plans/2026-07-16…plan.md:220）；App.tsx 无 filter 清理逻辑（:32-39）；WrongBookPage 挂载双请求（:55-69 listBanks+reload）无 loading。
- **数字全部对上**：现有单测 4+6+18+4+4=36；smoke-e2e 43 个断言调用（44 个 `ok(` 含 1 处 assert.ok 定义）；slice tsx 合计 853 行。
- **FRD 继承与红线**：范围红线与 FRD Non-Goals（:46-50）逐条一致；DEC-29..36 映射正确（D31 一键开练复用 PracticeScope、D34 趋势双维、D35 按需触发、D36 全量）；"本地不跑构建"与 FRD NFR7(:94) 一致。
- **D1-D8 与 slice 划分对应**：D1/D8→Slice2、D5→Slice3、D34→Slice4、D7→Slice5、D2+D31→Slice6，均与 CHANGE.md 描述相符。
- **回归验收覆盖面**：36 测试全绿（CHANGE.md:68,72）+ 第一批 5 项 P0（:72-73）+ git diff 零依赖/零部署改动（:74）均在案；AI 验收明确依赖真实模型调用（:70"真实 AI key 已生效"）。
- **只加不改既有表**：除 C1 索引外，新表 DDL 均 `CREATE TABLE IF NOT EXISTS`，无 ALTER，既有表数据零迁移成立。

## Suggestion

- CHANGE.md 第 58 行把表名写全（含诊断表归属），第 64 行把"实现或移除"二选一在确认时定死，避免执行中摇摆。
- 远程验收 ②③⑥⑦ 依赖真实 AI，建议加一句"AI 调用失败时的降级路径（错误提示/不落库）也视为通过条件之一"，防止验收依赖单次模型运气。
- 建议在 CHANGE.md 状态改为"待确认"前，先产出上述 B3 的"设计对账修订"并让 auditor 独立复核一次，再进 glla 拆任务。

---