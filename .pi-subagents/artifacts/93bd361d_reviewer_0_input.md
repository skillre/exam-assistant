# Task for reviewer

[Read from: /Users/skillre/claude/系统开发/考试助手/plan.md, /Users/skillre/claude/系统开发/考试助手/progress.md]

对 /Users/skillre/claude/系统开发/考试助手 的 packages/client 做全面审计（考试助手系统的 React 前端）。逐文件读：App.tsx、main.tsx、styles.css、api/client.ts、api/sse.ts、pages/*.tsx（Banks/Quiz/WrongBook/Insights/Settings）、components/*.tsx（Scorecard/QuestionCard/InsightsPanel/Markdown/ProviderForm/ImportPanel/DraftEditor/TutorPanel/QuestionNav）、vite.config.ts。评估并输出：① 页面/路由结构与导航组织；② 状态管理方式（如何跨组件共享题库/当前题/错题本状态）；③ API 层封装与错误处理（含 4xx/401 展示、SSE 断线重连）；④ 组件复用度与耦合；⑤ UI/UX 问题与死代码/未用组件，每条给文件:行号证据。中文输出，结论分级：正常/风险/缺陷。

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