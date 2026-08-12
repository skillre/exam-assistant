# Task for requirements-reviewer

评审考试助手 specs/CHANGES.md 的 2026-08-12 第四批节（M 级：导出 CSV + 练习历史 + 标签复习）。

要求：
1. 只读项目：读 /Users/skillre/claude/系统开发/考试助手/specs/CHANGES.md（重点第四批节，前三批节作背景）+ 抽查 packages/server/src/routes/quiz.ts、packages/server/src/repositories/、packages/client/src/pages/QuizPage.tsx、packages/client/src/App.tsx、packages/server/src/import/parseFile.test.ts 验证第四批改动点与现状描述是否一致。
2. 按变更门标准评审：目标验收/回归验收是否可执行可验证（命令/文件态）；改动点是否有遗漏或描述错误；影响面是否覆盖依赖方；范围红线是否与改动点矛盾（如 409 兜底 vs 标签题量显示）；回归验收是否与目标验收分开。
3. 输出格式：BLOCKERS（必须修订才能确认）/ CONCERNS（建议修订）/ SUGGESTIONS（可选）三节，每条一行带文件:行号或命令证据。
4. 评审范围仅第四批节——不评审前三批已完成的代码本身。
5. 报告 ≤ 60 行。以 BLOCKERS: 结尾（或 BLOCKERS: none）。

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