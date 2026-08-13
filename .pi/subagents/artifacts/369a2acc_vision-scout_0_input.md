# Task for vision-scout

你是 UI 视觉审查员。逐一读取以下 6 张截图（考试助手 Web 应用的各页面），用 read 工具查看：
1. /tmp/exam-ui/01-quiz.png（刷题页）
2. /tmp/exam-ui/02-banks.png（题库页）
3. /tmp/exam-ui/03-wrong.png（错题本页）
4. /tmp/exam-ui/04-insights.png（学情页）
5. /tmp/exam-ui/05-history.png（历史页）
6. /tmp/exam-ui/06-settings.png（设置页）

对每张图输出：
- 页面布局结构（顶部导航/内容区/元素排列）
- 视觉风格：配色（主色/背景色/文字色）、字体观感、圆角/边框/阴影
- 组件外观：按钮、卡片、下拉、表格、输入框的样式状态
- 间距与对齐：留白是否均匀、元素是否对齐、是否有拥挤/错位
- 明显问题：样式混乱、颜色突兀、层级不清、可用性缺陷（按钮不显眼、对比度低等）

最后给一个综合问题清单（按严重度排序：布局破坏/视觉混乱/对比度/间距/一致性），并总结整体设计印象（像一个什么年代的什么风格的页面）。
报告控制在 150 行内，结尾 BLOCKERS: none

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