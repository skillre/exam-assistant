# Task for requirements-reviewer

复核考试助手 specs/CHANGES.md 第四批节修订版 v2（2026-08-12 节）。

背景：上一轮评审出 1 blocker（/api/tags/counts 未限定 bank，多题库场景 409 矛盾）+ 7 concerns，均已按修订意见更新为 v2。

要求：
1. 只读：读 /Users/skillre/claude/系统开发/考试助手/specs/CHANGES.md 的 2026-08-12 第四批节（修订 v2 版）。
2. 逐条核对上轮 blocker 与 7 concerns 是否在 v2 中清零：
   - blocker: tags/counts 按 bankId 限定 + 零题量不展示 + 409 仅竞态兜底
   - c1: 路由落点按文件点名（quiz.ts 3 + banks.ts 1，共 4 端点）+ buildScorecard 导出明写
   - c2: 删库 CASCADE 清历史已声明
   - c3: 重练/重开语义区分已定义
   - c4: 续做入口与 localStorage 优先级已定义
   - c5: 远程抽查断言已具体化
   - c6: wrong.csv 列布局已定义（6+1 列含 wrong_answer）
   - c7: navigate 表述修正
3. 输出：每条 blocker/concern 一行（已清零/未清零+理由），新发现的 BLOCKERS 用「BLOCKERS:」节，无则 BLOCKERS: none。报告 ≤ 30 行。

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