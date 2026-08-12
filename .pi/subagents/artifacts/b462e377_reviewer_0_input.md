# Task for reviewer

独立评审存量修改 Change Gate 文档（评审对象：/Users/skillre/claude/系统开发/考试助手/specs/CHANGES.md 中「第三批：P2 体验优化与代码卫生」一节，级别 M）。只读评审，不看任何采访对话。
背景：考试助手（exam-assistant，pnpm monorepo：server Fastify+SQLite+pi SDK / client React+Vite）第三批优化。前两批已完成并通过审计（P0 修复 5 项 + v3 AI 学习教练全量）。第三批 = 体验 5 项（hash 路由/无障碍/错误文案/selectModel 回滚/ProviderForm）+ 卫生 6 项（死代码/nanoid/重复合并/孤儿JSONL/竞态/测试补缺）。用户已确认：全量、轻量 hash 路由（不引依赖）、补 parseFile+路由冒烟测试。
要求：
1. 五维逐条检查：完整性/一致性/可行性（逐项与源码核对：shared-check.ts 存在、nanoid 无 import、题型映射 4 处、insights createTutorSession 文件持久化、tutorSessionRepo 无事务、AiService 是否有 inMemory 会话方法）、可测试性（验收命令化）、范围控制（红线含不重建表/不引依赖）；
2. 必查回归项：目标验收与回归验收对应；特别核查——hash 路由改动 App.tsx 是否影响已有 drillToQuiz/drillToWrong/startTaskQuiz 下钻链、QuestionCard 键盘改动是否破坏现有点击判分、insights 改 inMemory 会话是否影响 SSE 流式、删 validateDrafts 是否有其他引用（ImportPanel 本地校验路径）；
3. 特别核查：validateDrafts 删除是否安全（共享类型 ValidateDraftsResponse 是否他用）；AiService 现有 runOnce 已用 SessionManager.inMemory（audit 记录），insights 改 inMemory 会话方案是否与现有能力重叠可复用；tutorSessionRepo 事务防重是否真能防并发（SQLite 串行写语义）；
4. 输出 blocker/concern/suggestion 三类表格，每项带证据（文件:行号）与最小修改建议。

## Acceptance Contract
Acceptance level: attested
Completion is not accepted from prose alone. End with a structured acceptance report.

Criteria:
- criterion-1: Return concrete findings with file paths and severity when applicable

Required evidence: review-findings, residual-risks

Finish with a fenced JSON block tagged `acceptance-report` in this shape:
Use empty arrays when no items apply; array fields contain strings unless object entries are shown.
`criteriaSatisfied[].status` must be exactly one of: satisfied, not-satisfied, not-applicable.
`commandsRun[].result` must be exactly one of: passed, failed, not-run.
`manualNotes` and `notes` are optional strings; an empty string means no note and does not satisfy `manual-notes` evidence.
```acceptance-report
{
  "criteriaSatisfied": [
    {
      "id": "criterion-1",
      "status": "satisfied",
      "evidence": "specific proof"
    }
  ],
  "changedFiles": [
    "src/file.ts"
  ],
  "testsAddedOrUpdated": [
    "test/file.test.ts"
  ],
  "commandsRun": [
    {
      "command": "command",
      "result": "passed",
      "summary": "short result"
    }
  ],
  "validationOutput": [
    "validation output or concise summary"
  ],
  "residualRisks": [
    "none"
  ],
  "noStagedFiles": true,
  "diffSummary": "short description of the diff",
  "reviewFindings": [
    "blocker: file.ts:12 - issue found, or no blockers"
  ],
  "manualNotes": "anything else the parent should know"
}
```