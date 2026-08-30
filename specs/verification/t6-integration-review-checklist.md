# t6 第一阶段集成终审清单（reviewer 预置，t1/t3 完成后执行）

> 任务：t6「在 t1 和 t3 完成后进行第一阶段集成审查」。本清单供认领 t6 后直接执行。
> 配套脚本：`specs/verification/scripts/check-t6-integration.mjs`（静态一致性断言，退出码门禁）。
> 权威设计：`.codebase-review/16-ai-reliability-idempotency-design.md`（t2，§4 迁移 / §5 契约 / §7 测试矩阵 / §8 顺序）。
> 验收矩阵：`specs/verification/ACCEPTANCE-MATRIX-M0-M4-2026-08-27.md`（t4，基线：dsh-exam 128 测试 / typecheck 0 错误 / build 全绿 @ 328e373）。

---

## 0. 前置动作

- [ ] 阅读 t1 完成报告（变更文件/迁移/测试结果/待衔接 API）与 t3 完成报告（变更文件/需 Host 配合剩余项）
- [ ] `git diff`（相对 328e373）审阅：host 侧 = t1+t5 增量；client 侧 = t3 增量；确认无越界文件（t1 不碰 client、t3 不碰 host）
- [ ] 确认 t5 完成（deps: t1）且其实现与 t2 设计 §9「必做」逐项对得上
- [ ] 快照当前 commit 与工作树；跑脚本 `node specs/verification/scripts/check-t6-integration.mjs` 记录 PASS/FAIL 分布

## 1. 迁移与数据层（设计 §4 + t1）

- [ ] 最终 schemaVersion（user_version）：设计为 6；若 t1 已占用 v6，t5 应为 v7 且无冲突——核对 MIGRATIONS 数组顺序与版本号单调递增
- [ ] v6/v7 内容核对：tutor_turns（state CHECK 五态、client_message_id UNIQUE 可空、级联）、tutor_messages.turn_id、import_batches、questions.import_batch_id/import_item_key + 部分唯一索引、import_drafts、explanations 版本/tokens 列 + 存量回填 UPDATE、essay_gradings provider/tokens 列
- [ ] 迁移幂等：store.test 覆盖「残留半迁移重跑」「存量数据保真」「question_updated_at 回填正确」
- [ ] t1 事务：withTransaction 存在且被多写路径使用（客观判分 recordAttempt+touchWrong、essay attempt+wrong+grading）；与 t5 复用同一实现（无重复实现）
- [ ] t1 定向查询：getLatestAttemptByPracticeQuestion 被 resume/scorecard/history 全量使用（旧 listLatestAttemptByQuestion 仅剩合法用途）；跨会话同题回归测试存在
- [ ] t1 守卫：finished 会话禁止 grade/gradeEssay/patchIndex；gradeEssay 校验 question∈practice；空范围建会话返回稳定领域错误
- [ ] t1 删除策略：删除题目不破坏 active 会话（guard/软删/快照按 t1 定稿）；finished 历史可解释；相关测试存在
- [ ] QuestionRow.type / essay 类型谎言修正，无类型断言泄漏

## 2. 契约一致性（设计 §5）

- [ ] 静态脚本 B/C 组全 PASS：contract.ts 新字段与 7 新错误码、errors.ts 同步、mapServiceError 409/404/400 映射
- [ ] client `types.ts` 仍为 type-only 再导出（`export type *`）——无运行时依赖泄漏
- [ ] client api.ts/sse.ts 与 contract.ts 字段名逐一对齐（clientMessageId/turnId/replayed/draftId/batchId/retryable/sessionId）
- [ ] 破坏性变更检查：`listImportedQuestions` 返回 `{questions, draftId}` 后，tools.ts 与 api.ts 两处消费方同步更新（设计 §6 兼容表）
- [ ] 旧客户端兼容：无 clientMessageId 走 `srv-` 占位（无幂等但状态机/closed guard 生效）；新增响应字段全部可选

## 3. 并发状态一致性

- [ ] TutorTurn：同 clientMessageId 顺序重放（done→replayed）、失败/取消重试复用同 turn（user 消息唯一）、streaming 有在途 → 409、孤儿 streaming（重启后）可重试
- [ ] explain single-flight：非 force/force 双键独立；并发同键一次 LLM；abort 零落库
- [ ] 客户端请求身份：HistoryPage/WrongView/AiTools 各请求独立 AbortController；SSE request token 防乱序（t3 第 4 项）
- [ ] 幽灵会话治理：重试复用 session + TTL 清扫（惰性触发）+ DELETE 路由；listTutorSessions 不误伤有 done turn 的会话
- [ ] 计划/错题/导入客户端状态：无跨组件 abort 串扰（t3 第 3 项 busy 防护）

## 4. 测试面

- [ ] 新增套件存在且通过：store v6 用例、ai trimTutorHistory/budget 用例、service-ai-reliability.test.ts（fake llm 幂等矩阵）、smoke 路由级（SSE 失败元数据/close/delete/draft）、tools signal/defaultRoute
- [ ] 测试总数 > 基线 128（记录新总数与分布）；基线 128 用例零回归
- [ ] t1 新增用例（定向查询/守卫/事务/删除策略）存在且通过

## 5. M0 机器门禁（t1/t3/t5 全部完成后运行）

- [ ] `pnpm --filter @exam/dsh-exam typecheck` 0 错误
- [ ] `pnpm --filter @exam/dsh-exam test` 全绿（记录总数/时长）
- [ ] `pnpm --filter @exam/dsh-exam build` 全绿（tsdown bundle + client-bundle-smoke）
- [ ] 全仓 `pnpm typecheck && pnpm test && pnpm build`（server 110 用例不得回归）
- [ ] 对照验收矩阵执行 M0 清单（迁移/降级/错误码/工具契约）机器部分；记录逐项 PASS/FAIL

## 6. a11y 静态检查（t3 交付面）

- [ ] 脚本 F 组：tab/tabpanel + aria-selected、aria-controls、Overlay focus trap、44px 触达、prefers-reduced-motion、≤860px 媒体查询
- [ ] 人工抽查：AiTools tab 键盘左右切换；计划展开项 aria-expanded/aria-controls 配对；错误区 role=alert
- [ ] emil-design-eng 约束：无新增高频花哨动画（diff 内 animation 数量核对）

## 7. 阻断标准（架构级缺陷才阻断）

- [ ] Host/Client 契约字段不一致导致运行时数据错位（如 turnId 缺失而客户端强依赖）
- [ ] 迁移不幂等或数据丢失风险（存量库升级路径断裂）
- [ ] 并发状态机死锁/重复落库无法通过单测自证
- [ ] 越界文件改动（t1 改 client / t3 改 host 且非必要）
- 非上述项的小型集成/类型/测试问题：**直接修复**（限定 packages/dsh-exam，注明修复项）；架构缺陷 → 列为 blocker 通知 captain，不擅改

## 8. 输出（集成报告）

- [ ] 变更文件清单（t1/t3/t5 实际 diff 摘要）
- [ ] 契约/迁移/并发/测试四维核对表（✅/❌ + 证据）
- [ ] 静态脚本 PASS/FAIL 分布 + M0 机器门禁结果
- [ ] 修复项记录（若修了小型问题）与遗留项（交给后续里程碑）
- [ ] GUI 浏览器场景说明：本阶段仅静态 + 机器门禁；S1-S12 浏览器场景归后续终审任务（preset 安装前置见验收矩阵 §8）
