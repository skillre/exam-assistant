# t6 第一阶段集成终审报告（Host↔Client 集成审查）

> 审查人：reviewer｜时间：2026-08-27 17:20｜commit：328e373 + 工作树（dsh-exam 未跟踪）
> 审查对象：t1（领域正确性，completed）、t3（客户端加固，completed）、t8（跨模块闭环，completed）；
> t5（AI 可靠性实施，**in_progress**——机器门禁延后，见 §6）
> 依据：t4 验收矩阵、t2 设计 §16（.codebase-review/16-ai-reliability-idempotency-design.md）、t6 清单
> 配套脚本：`specs/verification/scripts/check-t6-integration.mjs`

---

## 1. 结论摘要

- **无架构级缺陷**（未触发阻断标准）。t1/t3/t8 交付面与现有契约、矩阵、t2 设计相互一致。
- 静态检查 **24 通过 / 29 失败**——29 项失败全部为 **t5 未落地项**（tutor_turns 状态机、import 批次/草稿、single-flight、TTL 清扫、clientMessageId 接线等，脚本按 t2 设计 §5 预置断言），非回归。
- **1 项集成预警（需 t5 遵守）**：schema 版本号——t1 已占用 **v6**（questions.deleted_at 软删除）；t2 设计 §4 的 AI 三表（tutor_turns/import_batches/import_drafts）必须落 **v7**，否则迁移冲突。已写入 §5 移交 t5 完成核对。
- **机器门禁（typecheck/test/build）延后**：t5 正在实时编辑 host 文件（store/service/store.test 17:15-17:16 仍在写），此刻跑门禁会捕获 t5 中途态，按队长纪律不强行运行；t5 收口后由终审立即补跑（§6 已列精确命令与当前待核疑点）。

## 2. t1 交付面核对（✅ 全部落地且一致）

| 项 | 证据 | 结论 |
|---|---|---|
| 空范围建会话 → 稳定错误 | practice.ts:87-90 `EXAM_EMPTY_PRACTICE_SCOPE`；contract.ts/errors.ts/index.ts 三处同步；index.ts:163 → **400** | ✅ |
| finished 会话守卫 | practice.ts:121/144（gradeAnswer/updateIndex → `EXAM_PRACTICE_FINISHED`）；service.ts:599（gradeEssay）；index.ts:186 → **409**；smoke 覆盖 | ✅ |
| gradeEssay 归属校验 | service.ts（question∈practice、finished 预检 JSON 非 SSE，index.ts:542） | ✅ |
| 会话域最新作答 | store.listLatestAttemptByPracticeQuestions（store.ts:454/1007）+ getLatestAttemptByPracticeQuestion（:464/1043）；resume（practice.ts:107）、scorecard（:335）、history answeredCount（service.ts:917）全切换；practice.ts:271 保留 listLatestAttemptByQuestion 仅用于 undone scope（跨会话语义**正确**） | ✅ |
| tiebreak 修正 | answered_at DESC, rowid DESC（后写者胜），消除同毫秒 flake | ✅ |
| 多写事务 | #withTransaction（store.ts:1500）+ recordGradedAttempt（:974）+ recordGradedEssay（:1192） | ✅ |
| 软删除安全策略 | v6 迁移（函数式条目+列存在守卫，崩溃/回拨重放幂等，store.ts:763-777）；deleteQuestion 置 deleted_at 幂等；活跃路径排除已删；getQuestionIncludingDeleted 供历史可解释；updateQuestion/判分/解析对已删题 404 | ✅ |
| QuestionRow.type 诚实化 | StoredQuestionType（essay 不再谎报）+ deletedAt；DTO 透出（向后兼容） | ✅ |
| 测试 | 128→152 全绿（t1 自报 10 连跑稳定）；跨会话同题回归、删题判分 404、事务回滚、软删除均有用例 | ✅ |
| 越界 | 全程未碰 client 文件 | ✅ |

## 3. t3/t8 客户端交付面核对（✅ 静态证据齐备）

| 项 | 证据 | 结论 |
|---|---|---|
| Insights 图表 CSS 协议 | 改用 --exam-assistant-bar/--exam-assistant-type-fill（t3 自述修复 inline 与 scaleX/Y 协议错位） | ✅（GUI 复验归浏览器场景） |
| WrongView 独立取消域 | 5 个 AbortController 拆分 + Abort 静默 + 掌握失败行级错误 | ✅ |
| Insights 计划 busy/取消域 | 5 独立取消域 + busy 防护（F2 通过） | ✅ |
| AiTools 状态 | history request identity（historyRequestRef）+ SSE isCurrent 令牌防过期帧 + commit 失败快照恢复 DraftEdit[] | ✅ |
| ARIA/键盘 | ExamWorkspace: roving tabIndex(0/-1)、aria-selected/controls/labelledby、onTabKeyDown；AI 2 tab 同构；计划/错题行 aria-controls；Overlay 完整 focus trap（Tab 循环 + focusin 逃逸拉回 + 初始焦点关闭钮 + 还原触发元素） | ✅ |
| 移动端 | ≤640px 抽屉化/换行/44px 触达（styles.css 6 处 44px 规则）+ ≤860px 布局 + prefers-reduced-motion | ✅ |
| 跨模块闭环（t8） | practiceIntent/goPractice/practiceReturnTab（错题/学情→练习→返回来源）；WrongView「去练习这些错题」「重做此题」；Insights 薄弱题型 chips + 错题 Top10 开练；状态保留（5 tabpanel 常驻 + hidden）；emil 零新增动画 | ✅ |
| 契约 | client/types.ts 为 type-only 再导出（单端来源=host contract.ts）→ 任何 Host 契约漂移必被 client typecheck 捕获 | ✅ |
| 越界 | 纯 client，未动 host | ✅ |

## 4. Host↔Client 契约一致性（t1 增量）

- 新错误码 EXAM_EMPTY_PRACTICE_SCOPE(400)/EXAM_PRACTICE_FINISHED(409) 三处同步 + HTTP 映射正确；客户端经通用错误渲染路径展示 code+message（t1 注明 UI 文案为可选后续）——**非破坏**。
- ExamQuestionDto.deletedAt 为新增可选字段，旧 UI 忽略；client types.ts 再导出自动同步。✅

## 5. 移交 t5 完成后的核对点（t6 续）

1. **schema 版本**：AI 三表必须为 **v7**（v6 已被 t1 占用）；MIGRATIONS 数组单调递增；tutor_turns 五态 CHECK / client_message_id UNIQUE 可空 / 级联；import_batches / import_drafts 全 DDL 对照 t2 设计 §4。
2. **静态脚本归零**：`node specs/verification/scripts/check-t6-integration.mjs` 应从 24/29 翻转为全 PASS（或仅剩可解释偏差）。
3. **t3 报告的 host 侧遗留**：t3 曾报「全量 typecheck 被 service.ts 4 处、ai.test.ts 3 处 deletedAt/StoredQuestionType 错误卡住」——t1 自报 typecheck ✅，两说矛盾，需在 t5 收口后以权威运行裁决（疑为 t5 中间态或 t7 改动引入，非定论）。
4. **门禁**：§6 命令全跑 + 与基线（128 测试 / 0 错误）对比；smoke 新用例（SSE 失败元数据、close/delete、draft 路由、批次重放）逐个核对。
5. 旧方法 listLatestAttemptByQuestion 仅剩 undone scope 一处合法用途（已核），t5 不得新增回退使用。

## 6. 机器门禁（t5 收口后立即执行；此刻树未稳定，结果不可信）

```bash
cd packages/dsh-exam
pnpm typecheck        # 期望 0 错误
pnpm test             # 期望 ≥152（t1 基线）+ t5 新增全绿
pnpm build            # 期望 tsc build + tsdown bundle + client-bundle-smoke 全绿
cd ../.. && pnpm typecheck && pnpm test   # 全仓（server 110 不得回归）
```

## 7. 阻断判定

- 本阶段未发现架构级缺陷，无 blocker。
- 若 t5 收口后出现：迁移版本冲突（未按 v7）、契约字段错位、幂等状态机无法单测自证、或越界文件改动 → 升级为 blocker 并通知 captain。

## 8. 待办（已入 t6 输出与队长消息）

- [ ] t5 完成通知 → 立即补跑 §6 门禁 + §5 核对点 → 更新本报告终版
- [ ] GUI 浏览器场景（S1-S12）归后续终审任务（preset 安装前置）

---

## 9. 验收重点复核（队长确认三项，2026-08-27 17:22 静态只读）

### 9.1 t1 六项 × t3/t8 client 一致性（✅ 全链一致）

| t1 项 | Host 落地 | Client 一致性 |
|---|---|---|
| 会话域隔离 | resume/scorecard/history 全切 listLatestAttemptByPracticeQuestions | PracticeView:325 消费 resumePractice.latestAttempts 作唯一进度源（:331 注释「服务端已按题去重」）；api.ts:254 契约未变 |
| finished 守卫 | grade/gradeEssay/updateIndex → 409 EXAM_PRACTICE_FINISHED | 历史列表 active→「续做」、finished→「成绩单」/删除（PracticeView:299/317/346-356）；409 走通用错误渲染 |
| 空范围 | startPractice → 400 EXAM_EMPTY_PRACTICE_SCOPE | 通用错误路径展示 code+message（无专用文案，可后续） |
| 事务批改 | #withTransaction + recordGradedAttempt/recordGradedEssay | 纯服务端，client 无感知 |
| 软删除 | deleteQuestion 置 deleted_at（HTTP DELETE 204 不变）；活跃路径排除、历史 getQuestionIncludingDeleted | BankDetail onDelete → deleteQuestion → load() + onQuestionsChanged()（:271-273 联动题库徽章/错题本）；成绩单渲染 DTO 无感知 |
| 类型修正 | StoredQuestionType + deletedAt 可选 | client types.ts type-only 再导出自动同步；无 `.type as` 残留 |

### 9.2 `as string` 残留扫描（✅ 生产链干净）

- 生产代码全部 `as` 均安全：validateQuestionType 成员校验后收窄（store.ts:1711-1715）；行水合 String(raw.type)（DB v3 CHECK 含 essay，store.ts:681 兜底）；answer 值 cast（ai.ts:701，single 答案字符串编码合法）；plan items 数组校验（index.ts:1444/1455）。
- tools.ts:299 为类型化比较 `q.type === type`，无谎言。
- 唯一残留：store.test.ts:722/738 断言用 `created.type as string`（测试文件、非生产；可选清理，不阻塞）。

### 9.3 152 用例与 128 兼容（✅ 静态计数自洽，权威数字待门禁）

- 静态计数（grep test(/it( 行）：store 27 / practice 11 / insights 3 / ai 40 / tools 20 / smoke 34 / grading 8 / llm 9 = **152**
- 构成：128 基线 + t1 新增 11（store+2、practice+4、smoke+5）+ t7 新增 13（ai 27→40）——与 t1「128→152」自述一致（t7 属中间任务叠加）
- 兼容性：t1 对既有测试仅语义等价调整（smoke 同毫秒建题断言改顺序无关，因 tiebreak 改为 rowid 后写者胜）；对外契约形状零破坏（resume/scorecard/history 响应、DELETE 204、deletedAt 可选）
- 注意：静态计数为近似（多行 test 名少计），权威总数以 t5 收口后 `pnpm test` 实跑为准。

### 9.4 结论

三项验收重点全部通过（静态证据）。无阻断；机器门禁仍待 t5 收口后复跑（§6 命令）。
