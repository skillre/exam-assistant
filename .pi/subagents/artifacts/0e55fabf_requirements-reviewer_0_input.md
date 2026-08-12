# Task for requirements-reviewer

独立评审 /Users/skillre/claude/系统开发/考试助手/specs/CHANGES.md 的第五批节（2026-08-12 第五批：主观题 + AI 评分，位于文件末尾新增节）。
评审要求：
1. 只评审第五批节，不评审历史批次（前四批已完成归档）。
2. 按完整性/一致性/可行性/可测试性/范围控制五维度对抗性评审，重点检查：
   - 目标验收每条是否可执行、有无可观察产物；
   - 回归验收是否覆盖旧功能（客观题判分/导入导出/学情闭环/路由）；
   - 与既有系统事实是否一致（可读代码验证：packages/shared/src/types.ts 的 QuestionType/AnswerValue/GradeResponse、packages/server/src/grading/grade.ts、packages/server/src/routes/quiz.ts grade 端点、packages/server/src/ai/AiService.ts runOnce、packages/client/src/components/QuestionCard.tsx、packages/server/src/import/parseFile.ts、attempts 表 schema）；
   - 边界情形是否覆盖（essay 空答案、AI 超时、AI 返回非 JSON、错题本/重练语义）；
   - 范围红线是否清晰无遗漏（schema 零迁移、零新依赖）。
3. 输出：阻断项（blocker，必须修订）/建议项（concern）/确认项表格，每项带证据（文件:行号或代码事实）与最小修改建议。
4. 只读评审，不修改任何文件。
5. 报告控制在 120 行内，结尾 BLOCKERS: 段（blocker 列表或 none）。

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