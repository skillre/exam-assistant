# Task for reviewer

[Read from: /Users/skillre/claude/系统开发/考试助手/plan.md, /Users/skillre/claude/系统开发/考试助手/progress.md]

对 /Users/skillre/claude/系统开发/考试助手 的 packages/server 做全面架构审计（这是考试助手系统的后端）。逐文件读：index.ts、db/schema.ts、db/index.ts、routes/*.ts（banks/quiz/import/tutor/insights/providers/models/sseWriter）、repositories/*.ts、ai/*.ts（AiService/sdkModel/tutorPrompts/insightsPrompts/sessionHistory/modelRuntimeSetup/verify）、import/*.ts、grading/grade.ts、insights/LearningDataCollector.ts、crypto/secretBox.ts、config/paths.ts。评估并输出：① 分层与模块边界是否清晰（路由/仓储/AI 服务职责）；② 数据模型设计（SQLite schema 表结构、JSONL 会话存储、外键与级联）；③ 核心数据流：导入→判分→错题本→洞察、AI 讲解 SSE 流、tutor 多轮会话的完整链路；④ API 设计（REST 风格、错误码、输入校验、批量操作）；⑤ 潜在缺陷与风险（竞态、事务、SQL 注入、越权、资源泄漏），每条给文件:行号证据。中文输出，结论分级：正常/风险/缺陷。

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