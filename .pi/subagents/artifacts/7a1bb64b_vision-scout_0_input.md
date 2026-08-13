# Task for vision-scout

UI 视觉审查。用 read 工具读图：/tmp/exam-ui/01-quiz.png（刷题页）。
然后立即输出（≤50 行）：
1. 布局结构：顶部栏、内容区、表单元素排列
2. 配色：主色调、背景、按钮、文字颜色
3. 组件观感：按钮/下拉/卡片/复选框的样式质量
4. 间距与对齐：留白、对齐、拥挤或空洞之处
5. 明显问题：视觉混乱点、对比度、层级、可用性缺陷
最后 3 行综合印象。结尾 BLOCKERS: none。
效率：只 read 这一张图，5 次工具调用内完成。

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