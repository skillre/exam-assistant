审计完成。所有指定文件已逐行读完，typecheck 干净、32 个测试全过。以下为完整审计报告。

---

# 考试助手 packages/server 架构审计报告

> 前置说明：任务要求先读 `plan.md` / `progress.md`，两文件在仓库根目录均不存在（已 find 全库确认），本次审计以源码为准。

## ① 分层与模块边界 —— 正常（两处轻微越界）

职责划分清晰，符合"路由薄、仓储纯、AI 隔离"的目标：

| 层 | 文件 | 职责 |
|---|---|---|
| 路由 | routes/*.ts | 参数校验 + 编排 + 错误码映射，无 SQL |
| 仓储 | repositories/*.ts | 纯数据访问，返回领域对象，无业务编排 |
| AI 集成 | ai/AiService.ts | 唯一接触 pi SDK 的层，屏蔽 ModelRuntime/SessionManager |
| 判分 | grading/grade.ts | 确定性纯函数，不经 AI（DEC-3 正确落实） |
| 导入解析 | import/*.ts | 与判分/题库解耦，统一经 `validateDrafts` 把关 |
| 洞察 | insights/LearningDataCollector.ts | 跨源汇集（SQLite + JSONL） |

正常项：
- `AiService` 封装到位：`runOnce` / `createTutorSession` / `openTutorSession` / `streamPrompt` / `listModels` / `setModel` / `testProvider`，路由层拿不到 Key、不碰 SDK 细节。
- 仓储返回领域对象、路由不拼 SQL，`@exam/shared` 类型双向贯通无私定义。
- 判分与 AI 严格分离：判分错误不会拖垮 AI 链路，反之亦然。

轻微问题：
- `insights/LearningDataCollector.ts:10` 直接 `import { db }` 跨过仓储层做聚合 SQL。有意的聚合查询设计，但与其 `tutorSessionRepo` 混用形成"两套数据访问风格"，可接受。
- 会话生命周期管理散在路由层（`tutor.ts:46` dispose），`AiService` 提供原语而非封装生命周期——导致 D2（dispose 不放 finally）。

## ② 数据模型设计 —— 正常（两处约束缺失）

8 表 schema（`db/schema.ts`），设计合理：

- **FK 与级联正确**：`banks → questions → attempts / tutor_sessions / wrong_book_state` 全部 `ON DELETE CASCADE`，且 `db/index.ts:17-18` 显式开启 `foreign_keys = ON`（SQLite 默认关闭，已正确补上）。`wrong_book_state.question_id` 直接作 PK + 级联，干净。
- **JSONL 会话存储**（DEC-7 落实到位）：`tutor_sessions` 只存 `jsonl_path` 引用（schema.ts:33-40），对话真相源是 pi SDK 写的 JSONL，不复制内容；删除题库/题目前先清 JSONL 文件（`banks.ts:63-72`、`quiz.ts:154-164`），避免孤儿。
- **索引齐全**：questions(bank_id)、attempts(question_id)、tutor_sessions(question_id)、practice_sessions(bank_id) 都有对应索引。
- **JSON 列**：options/answer/tags/question_ids 存 JSON 字符串，读写均有 `JSON.parse` + zod 前置校验，一致。

缺陷/风险：
- **R1（风险）`tutor_sessions.question_id` 无 UNIQUE 约束**（schema.ts:33-40）：并发两个 explain 同一题会各建一个会话，`getByQuestion`（tutorSessionRepo.ts:32-35）只取最早的，后建的 JSONL 成孤儿。且 `ORDER BY created_at LIMIT 1` 无 id 决胜，同毫秒竞态下选择不确定。
- **R6（风险）`practice_sessions.question_ids` 是 JSON 数组**（schema.ts:55-62），无法 FK 约束：题目被删后残留 stale id，成绩单 `questionRepo.get` 返回 undefined 跳过（quiz.ts:180-200），会话题目数与实际不符，无清理机制。
- `attempts` 无独立索引覆盖 `is_correct` 过滤（有 question_id 索引，实际查询走 join 可用，量小时无碍）。

## ③ 核心数据流 —— 链路完整，三处缺陷

**导入 → 判分 → 错题本 → 洞察**：
1. 导入：`parse-text`/`parse-file` → 草稿（zod `validateDrafts`）→ 前端确认 → `commit`（import.ts:70-98）服务端**再次**校验（"不信任前端"）→ `insertMany` 事务原子入库 ✓
2. 判分：`POST /api/quiz/grade` → `gradeQuestion`（纯函数，非法答案一律判错不抛）→ `attemptRepo.record` 落库 → attemptId 回传供 explain 关联 ✓
3. 错题本：`attempts JOIN questions` 聚合 wrongCount/lastWrongAt + `wrong_book_state` 软标记"已掌握" ✓
4. 洞察：`LearningDataCollector` 汇 SQLite 做题记录 + JSONL 追问要点 → 快照 → AI 分析 SSE ✓

**AI 讲解 SSE / tutor 多轮**：
- explain：查/建会话（一题一会话复用）→ 首条 prompt 注入题目+作答+判分上下文（OQ3）→ `streamPrompt` 逐 delta 推 SSE ✓
- ask：`openTutorSession(jsonlPath)` 恢复历史续聊 ✓
- history：`readSessionHistory` 读回 JSONL 渲染 ✓

三处缺陷：
- **D1（缺陷）insights/analyze 每次调用产生永久孤儿 JSONL**：insights.ts:36 调用 `ai.createTutorSession`，而该方法是**文件持久化**会话（AiService.ts:142 `SessionManager.create(this.cwd, SESSIONS_DIR)`），返回的 jsonlPath 既不登记 `tutor_sessions` 也不删除。注释（insights.ts:4-6）声称"临时讲解会话跑完即弃"，实现却落盘。每次学情分析在 `data/sessions/` 留下一个永不清理的文件。应改用 inMemory 会话（如 `runOnce` 的 `SessionManager.inMemory`，AiService.ts:107）。
- **D3（缺陷）`/api/tutor/history` 未过滤首条注入上下文**：`readSessionHistory`（sessionHistory.ts:30-48）注释声明"过滤掉首条注入的上下文（可选）"，但代码只过滤角色（:44），首条 prompt（含完整 `TUTOR_SYSTEM_PROMPT` + 题目 + **正确答案**）以 user 角色存在 JSONL 中 → 前端历史会把系统提示词和答案原样展示给学生。对照证据：`LearningDataCollector.ts:92` 用 `slice(1)` 跳过了首条，说明这是已知问题但 history 端点漏处理。
- **D2（缺陷）SSE 错误路径 session 泄漏**：tutor.ts:45-49、70-74 与 insights.ts:30-34 中 `streamPrompt` 抛错时只进 catch 调 `sse.error()`，`session.dispose()` 被跳过（不在 finally）。模型调用失败时 AgentSession 的订阅/底层连接不释放。

## ④ API 设计 —— 整体一致，两处校验缺口

正常项：
- REST 风格基本统一：`POST 201 / PATCH 204 / DELETE 204 / 404 / 409 / 400`，错误体 `{ error: 中文消息 }` 可读。
- 双段校验：路由手写必填校验 + 题目走 zod（`questionDraftSchema.superRefine` 按题型收紧 answer 形态与选项越界），import commit 服务端复检。
- 批量操作（move-copy / apply-tags / insertMany）全部 `db.transaction` 原子、返回 `{ affected }` 实际影响条数。
- SSE 事件协议统一 `delta | done | error`（sseWriter.ts:22-38）。

缺陷：
- **D5（缺陷）`PUT /api/providers/:id` 无 body 守卫**：providers.ts:24 `providerRepo.update(req.params.id, req.body)` 直接透传，其它路由均用 `req.body ?? {}`。客户端传空 body 或缺字段 → `input.name` 处 TypeError → 500；POST 有必填校验（:12-15）而 PUT 完全没有，两侧不一致。
- **D4（缺陷）`/api/import/parse-file` 超限文件返回 500**：import.ts:32-34 的 `await req.file()` / `file.toBuffer()` 在 try 块**外**，@fastify/multipart 超限抛 `RequestFileTooLargeError` → 未被捕获 → Fastify 500，应映射为 4xx（multipart limits 5MB 在 index.ts:18 已配置，但错误处理缺失）。

轻微：
- providers `test` 路由"未配置 Key/无模型"返回 `200 + { ok:false }`（providers.ts:35-43），与 REST 4xx 风格不一致——为 ConnTestResult 契约而设，可接受。
- 错误消息直传 `(err as Error).message`（import.ts:41、44）可能泄漏模型/内部细节，本地工具可接受。

## ⑤ 潜在缺陷与风险（含竞态、资源泄漏、安全）

### 缺陷（需修复）

| # | 位置 | 问题 |
|---|---|---|
| D1 | insights.ts:36 + AiService.ts:142-147 | 学情分析每次落盘孤儿 JSONL，永不清理 |
| D2 | tutor.ts:45-49/70-74、insights.ts:30-34 | 错误路径不 dispose AgentSession，资源泄漏 |
| D3 | sessionHistory.ts:44（对比 LearningDataCollector.ts:92） | history 首条 user 消息含系统提示词+正确答案，未过滤 |
| D4 | import.ts:32-34 | multipart 超限在 try 外 → 500 而非 4xx |
| D5 | providers.ts:22-26 | PUT 无 body 校验 → 空 body 500；与 POST 校验不一致 |

### 风险

- **R1** schema.ts:33-40、tutorSessionRepo.ts:32-35：tutor 会话并发创建竞态（无 UNIQUE），第二个 JSONL 成孤儿。建议 `UNIQUE(question_id)` + `INSERT OR IGNORE` 冲突重查。
- **R2** index.ts:38：`host: '0.0.0.0'` + 全 API 无鉴权。局域网内任意人可读全部题库/作答/学情、注入 provider Key 用服务器 IP 调用 AI（费用/滥用风险）、无限触发讲解/分析。个人本机工具可接受，但建议默认绑 `127.0.0.1` 或加简单 token。
- **R3** sseWriter.ts:26-38、tutor.ts:37-49：客户端断开后 `reply.raw.write` 到已销毁 socket 会触发 response 流 'error' 事件（无监听 → 有 uncaughtException 风险），且 AI 流不会中止，浪费模型调用。
- **R4** providerRepo.ts:45-52、modelRuntimeSetup.ts:15、secretBox.ts:45-57：`APP_SECRET` 变更后所有已存 Key 密文不可解密，`listWithKeys` 在 `reloadProviders` 时同步抛错 → 启动失败、全部 AI 功能挂。无预检/降级。
- **R5** attemptRepo.ts:80-96、114-125：`listWrongDetailed` 全表 join+group、`latestByQuestion` 每题一次查询（N+1），数据量大时阻塞（better-sqlite3 同步）。个人工具规模可接受。
- **R6** schema.ts:55-62：practice_sessions 残留已删题 id，无清理。
- **R7** sseWriter.ts:12-13：未调用 `reply.hijack()`。Fastify 的 `sent` getter 检查 `raw.writableEnded`（reply.js:104-105），每次 SSE 正常结束后 handler 返回时 `send` 会打 `FST_ERR_REP_ALREADY_SENT` 警告日志（reply.js:155-157）——不崩但每条 SSE 请求刷一条误导性 warn，且 hijack 本应接管超时/信号管理。

### 正常项（验证通过）

- **无 SQL 注入面**：全库所有查询走 `prepare` + `?`/命名参数，无字符串拼接 SQL。
- **事务正确**：`insertMany` / `moveOrCopy` / `addTags`（questionRepo.ts:76-97、149-173）均 `db.transaction` 原子。
- **级联删除闭环**：删库/删题前先清 JSONL（banks.ts:63-72、quiz.ts:154-164），再 CASCADE 清行，无孤儿文件（除 D1 场景）。
- **Key 安全**：AES-256-GCM + scrypt 派生（secretBox.ts:40-57），`toPublicProvider` 脱敏（providerRepo.ts:31-37），明文 Key 只存活内存、永不回传；`/test` 接口也只回 ok/message/latency。
- **安全细节**：随机 IV（同明文两次加密密文不同，测试验证）、secret 文件 0o600、篡改密文 tag 校验抛错。
- **验证结果**：`tsc --noEmit` 通过；`vitest run` 4 文件 32 测试全过（判分 18、secretBox 6、questionRepo 4、collector 4）。

---