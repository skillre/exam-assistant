# Task for requirements-reviewer

独立评审存量修改 Change Gate 文档（评审对象：/Users/skillre/claude/系统开发/考试助手/specs/CHANGES.md 中「第一批：P0 功能可用性修复」一节）。
背景：这是考试助手系统（exam-assistant，pnpm monorepo：packages/server Fastify+SQLite+pi SDK / packages/client React+Vite）的优化方案第一批，只修 5 个功能可用性缺陷，用户已确认影响面全栈、回归验收含远程部署实测、范围红线=安全项/备份/部署架构不碰。
要求：
1. 只读评审，不看任何采访对话，以 specs/CHANGES.md 第一批内容 + 项目源码现状为准；
2. 从五个维度逐条检查：完整性（现状/目标/改动点/验收是否齐全）、一致性（改动点与目标是否对应、验收是否可衡量）、可行性（改动点是否与实际代码结构匹配——可读源码核对：sse.ts、TutorPanel.tsx、InsightsPage.tsx、QuizPage.tsx、SettingsPage.tsx、routes/models.ts、ai/sessionHistory.ts、routes/tutor.ts、routes/insights.ts、shared/types.ts）、可测试性（目标验收是否命令化）、范围控制（红线是否清晰、有无蔓延）；
3. 必查回归项：目标验收与回归验收是否一一对应，缺回归=blocker；
4. 输出 blocker/concern/suggestion 三类表格，每项带证据（文件:行号或文档原文）与最小修改建议。

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