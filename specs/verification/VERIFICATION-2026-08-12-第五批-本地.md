# 第五批（主观题 + AI 评分）本地验证 — 2026-08-12

## 测试

- `pnpm typecheck`：0 错误
- `pnpm test`：**100 passed / 16 files**（旧 93 全绿 + parseFile essay 4 新用例 + routes.smoke essay 链路 + migrate 2 用例）
- `pnpm --filter @exam/server smoke`：51 断言 ✅ 不降

## 新增测试用例（契约②）

| 用例 | 断言 |
| --- | --- |
| questionSchema essay 合法 | type=essay + string answer 通过 |
| questionSchema essay 空参考答案 | 空串/纯空白拒绝 |
| parseFile JSON essay | answer=参考文本 |
| parseFile CSV essay 行 | answer 列裸文本 → string；options=[] |
| parseFile CSV essay 往返（评审 #6） | 导出 JSON 编码 answer 列（RFC4180 `"""SYN, ACK"""`）再导入还原为文本 |
| routes.smoke essay 链路 | 导入→判对（feedback 字段）→判错（进错题本）→AI 失败 502 不落库→非法输出 502→缺 feedback 502→空答案 400→wrong.csv/questions.csv essay 行转义 |
| migrate 旧库迁移 | 旧 CHECK 拒 essay → 迁移后可插；幂等不重复改写 |

## 过程中修复的既有 bug

- **attemptRepo.latestWithAnswers 同毫秒排序不稳**：`ORDER BY answered_at DESC` 无 tie-break，同毫秒多次作答时可能取错「最新」（第四批 practiceRepo.listRecent 同款问题，由 essay 链路测试暴露）→ 加 `rowid DESC`

## 本地 curl（tsx 起临时 server，PORT=3799）

```
POST /api/import/commit essay 题 → {"bankId":"...","count":1}
GET  /api/banks/:id/questions   → type: essay | answer: SYN, SYN-ACK, ACK
POST /api/quiz/grade essay（无 AI key）→ 502 {"error":"主观题批改失败：没有可用模型：请先在设置页配置 provider 与 API Key"}（降级路径）
POST /api/quiz/grade essay 空答案 → 400 {"error":"essay 题答案不能为空"}
POST /api/quiz/grade single     → {"attemptId":"...","isCorrect":true,...}（客观题同步契约不变）
GET  /api/export/:bankId/questions.csv → essay,简述 TCP 三次握手,[],"""SYN, SYN-ACK, ACK""",评分要点：三个报文段,网络（RFC4180 转义正确）
```

## 技术要点

- **迁移机制**：better-sqlite3 默认开 `SQLITE_DBCONFIG_DEFENSIVE` 禁止改 sqlite_master → migrate 用 `{ unsafeMode(true) }` 独立连接执行 `PRAGMA writable_schema=ON` 改写 questions 建表语句（幂等 + 备份 + 校验回滚 + schema_version 递增），主连接保持安全模式
- **essay answer 存储**：库层统一 JSON.stringify（与 number/boolean 同构），读取统一 JSON.parse 还原；CSV 往返靠 flatRowToRaw 剥 JSON 引号
- **评分输出**：zod（essayGradingSchema）校验 {isCorrect, feedback}，非法/超时/失败一律 502 不落库

## 远程部署抽查（106.37.96.58:8080，2026-08-12）

- docker compose 重建：api/web 双容器 Healthy
- **迁移生效**：容器内查 sqlite_master，questions 表 CHECK 已含 'essay'（writable_schema 迁移在存量库成功，数据零丢失）
- **真实 AI 评分**（远程已配置 provider key）：
  - 正确答案「客户端发 SYN，服务端回 SYN-ACK，客户端再发 ACK」→ `{"isCorrect":true,"feedback":"回答正确，准确描述了TCP三次握手中SYN、SYN-ACK、ACK三个报文段的发送顺序，要点完整。"}`
  - 错误答案「TCP 不需要握手」→ `{"isCorrect":false,"feedback":"回答错误。TCP 建立连接确实需要三次握手，正确过程为：..."}`
- wrong.csv essay 行（7 列）：`essay,简述 TCP 三次握手的过程,[],"""客户端发送 SYN...""",评分要点：...,网络,"""TCP 不需要握手"""`（answer/wrong_answer 转义正确）
- questions.csv essay 行：同上 6 列 + options 空
- 客观题回归：single 题同步判分 `{"isCorrect":true}` 不变
