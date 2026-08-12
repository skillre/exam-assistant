# Task for reviewer

[Read from: /Users/skillre/claude/系统开发/考试助手/plan.md, /Users/skillre/claude/系统开发/考试助手/progress.md]

对 /Users/skillre/claude/系统开发/考试助手 做代码质量与安全审计（考试助手系统，pnpm monorepo，packages/server + shared + client）。重点检查：① 测试现状——列出全部 *.test.ts，跑 pnpm test 验证是否通过，评估覆盖缺口（哪些核心逻辑无测试）；② 类型安全——跑 pnpm typecheck，列出现有类型错误；③ 安全——模型 API Key 加密存储链路（secretBox AES-GCM、APP_SECRET 生成与持久化）、CORS/SSRF 风险（provider Base URL 任意性）、SQL 注入面、输入校验边界（导入解析、批量操作参数）、敏感信息泄漏（日志/错误回显）；④ 死代码与未用导出；⑤ 依赖健康度（package.json 依赖是否必要、有无过时/风险项）。每条给文件:行号或命令输出证据。中文输出，结论分级：正常/风险/缺陷。

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