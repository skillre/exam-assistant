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

### 2026-08-10 第二批：P1 流程闭环补齐（级别：L，待第一批完成后单独走三问）

- **状态**：未开始（占位）

### 2026-08-10 第三批：P2 体验优化与代码卫生（级别：M，待第二批完成后单独走三问）

- **状态**：未开始（占位）

### 2026-08-10 第四批：P3 功能增值（级别：L，待第三批完成后单独走三问）

- **状态**：未开始（占位）
