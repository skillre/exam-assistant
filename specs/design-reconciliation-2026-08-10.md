# Slice 0 设计对账定稿（v3 第二批）

> 依据：`slice1-code.md`（最终代码级设计，唯一权威）+ 主设计 `deep-ai-insights-design.md` + 8 个 slice tsx + 评审 B3 清单。
> 统一原则：以 slice1-code 的类型/签名为主，主设计的路由/服务调用处适配；组件消费为准回改类型。

## 类型定稿（shared/types.ts 追加）

| # | 项 | 定稿 | 依据/弃用 |
| --- | ---- | ------ | ---------- |
| T1 | `FinishPracticeResponse` | `{ scorecard: Scorecard; snapshotId: string }` | 弃 slice1-code 的 `extends Scorecard`；主设计 finish 端点返回 shape |
| T2 | `GradeResponse.mastered` | `mastered?: boolean`（可选） | 弃主设计必填（P0-2 graded 端点不构造该字段，typecheck 不破） |
| T3 | `TrendPoint` | `{ ts: number; accuracy: number; total: number }` | 弃 slice1-code 的 `{timestamp, correct}`；TrendChart/snapshotHistory 均用 `ts`，correct 未消费删除 |
| T4 | `TagTrendPoint` | `{ ts: number; tag: string; accuracy: number; total: number }` | 同上 |
| T5 | `DiagnosisResult` | 扁平单题：`{ questionId, stem, userAnswer: string, correctAnswer: string, errorCategory, distractorNote? }` | 弃 slice1-code 聚合结构；DiagnosisPanel/planPrompts 消费扁平字段，答案文本用 AI 产出字符串（diagnosisSchema 口径） |
| T6 | `TaskStatus` | `'pending' \| 'in_progress' \| 'done'` | PlanPanel 的 `'completed'` 改 `'done'`（STATUS_LABEL/ICON/过滤三处） |
| T7 | `ErrorCategory` | `'concept_confusion' \| 'calculation_error' \| 'misread' \| 'knowledge_gap'` | 保留 |
| T8 | 聚合型 `ErrorDiagnosis`/`DistractorStat`/`errorDistribution`/`tagErrorBreakdown` | **不导出**（诊断输入用主设计 `DiagnosisContext`/`DistractorStat {questionId, stem, option, selectedCount, totalAttempts}`） | 弃 slice1-code 聚合版 |

## Schema 定稿（5 表 + 3 索引，只加不改）

`mastery_states` / `insight_snapshots` / `learning_plans` / `learning_tasks`（4 表按 slice1-code DDL）+ `diagnosis_results`（按主设计 DDL：id/bank_id/results/created_at）。
索引：`idx_snapshots_bank` / `idx_tasks_plan` / `idx_plans_bank`；**不建 `idx_attempts_question_time`**（D1 Option A 增量列不需要，评审 C1）。

## Repo/Service 签名定稿

| # | 项 | 定稿 | 适配方 |
| --- | ---- | ------ | -------- |
| R1 | `snapshotRepo.save` | 对象参数 → `InsightSnapshot \| null`（INSERT OR IGNORE 幂等） | 主设计 finish 端点位置参数调用 → 改对象参数 |
| R2 | `snapshotRepo` 列表 | 增加 `listAll(bankId?, limit?)`（保留 listByBank 语义） | snapshotHistory 调 `listAll` |
| R3 | `masteryRepo` | `reset(questionId)`（slice1-code 名） | masteryService 调 `reset`（弃 `resetConsecutive`） |
| R4 | `planRepo.createPlan` | `createPlan(bankId, title, description, phases)` **内部展开 phases[].tasks 创建 learning_tasks 行**，返回 `LearningPlan` | 主设计 coach 调用 `createPlan(title, phases)`（无 bankId、不建 task、返回 {planId,taskCount}）→ 改：传 bankId，taskCount 由 `listTasksByPlan(plan.id).length` 计算 |
| R5 | `planRepo.listTasksByPlan` | `listTasksByPlan(planId)` | coach 路由 `listTasks` → 改 |
| R6 | `planRepo.updateTaskStatus` | 返回 `boolean`（changes>0） | coach 路由 404 判断 |
| R7 | `masteryService.checkMasteryAfterGrade` | 按主设计（答错仅 reset streak 不动已掌握标记） | — |
| R8 | `diagnosisCollector` | 按主设计（`DiagnosisInput`/`DiagnosisContext`/扁平 `DistractorStat`） | — |

## 状态

- [x] 对账定稿（2026-08-10）
- [ ] 类型/表/仓库按定稿落地（Slice 1）
- [ ] 服务/路由按定稿适配（Slice 2-6）
