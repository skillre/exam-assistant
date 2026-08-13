# Task for vision-scout

用 read 工具查看 6 张新截图（浅色主题重做后）：
/tmp/exam-ui-new/01-quiz.png
/tmp/exam-ui-new/02-banks.png
/tmp/exam-ui-new/03-wrong.png
/tmp/exam-ui-new/04-insights.png
/tmp/exam-ui-new/05-history.png
/tmp/exam-ui-new/06-settings.png

对每张输出 3-5 行：① 是否浅色主题（确认无深色残留）② 布局/组件观感 ③ 明显样式问题（样式丢失/错位/对比度/留白失衡）。
最后：① 是否有任何页面仍显深色或样式崩坏 ② 整体是否比深色版更现代干净 ③ 遗留问题清单（按严重度）。
报告 ≤90 行，结尾 BLOCKERS: none。
效率：每张图 read 一次，总工具调用 ≤12 次。

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