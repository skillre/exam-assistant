# Task for vision-scout

你是 UI 视觉审查员。用 read 工具查看这 6 张截图（考试助手 Web 应用页面）：
/tmp/exam-ui/01-quiz.png（刷题页）
/tmp/exam-ui/02-banks.png（题库页）
/tmp/exam-ui/03-wrong.png（错题本页）
/tmp/exam-ui/04-insights.png（学情页）
/tmp/exam-ui/05-history.png（历史页）
/tmp/exam-ui/06-settings.png（设置页）

对每张图输出（每页 5-8 行）：布局结构、配色（主色/背景/文字）、组件样式（按钮/卡片/输入框/表格）、间距对齐、明显问题。
最后给综合问题清单（按严重度排序）+ 一句话整体设计印象。
报告 ≤120 行，结尾 BLOCKERS: none。
效率要求：每张图只 read 一次，6 张图总共 ≤10 次工具调用，尽快产出。

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