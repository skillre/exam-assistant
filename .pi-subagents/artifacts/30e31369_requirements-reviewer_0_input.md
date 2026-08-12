# Task for requirements-reviewer

独立评审存量修改 Change Gate 文档（评审对象：/Users/skillre/claude/系统开发/考试助手/specs/CHANGES.md 中「第二批：v3 AI 学习教练全量落地 + P1 流程闭环补齐」一节，级别 L）。
背景：考试助手系统（exam-assistant，pnpm monorepo：server Fastify+SQLite+pi SDK / client React+Vite）第二批优化。v3 依据已 approved 的设计文档 .rpiv/artifacts/designs/2026-07-18_16-37-31-deep-ai-insights-design.md（含 6 个 slice 的逐文件代码级设计）+ FRD（DEC-29..36 已确认）；另有 5 个流程闭环小项。用户已确认：v3 全量+闭环 5 项、接受全量影响面、新增单测+远程端到端验收、按 slice 顺序执行。
要求：
1. 只读评审，不看采访对话，以 CHANGE.md 第二批节 + 设计文档 + 源码现状为准；
2. 五维逐条检查：完整性（现状/目标/改动点/验收齐全）、一致性（改动点与目标对应、验收可衡量）、可行性（与设计文档 slice 文件清单、实际代码结构核对——可抽查 design 文档的 D1-D8 决策与 slice 划分是否与 CHANGE.md 描述一致）、可测试性（目标验收命令化）、范围控制（红线清晰无蔓延，含 FRD Non-Goals 继承）；
3. 必查回归项：第二批是 L 级大改（新增 4 表+新路由+页面改造），目标验收与回归验收是否覆盖「既有 36 测试全绿 + 第一批 5 项 P0 不回归 + 既有表零改动」；
4. 特别核查：slice3 会改 quiz.ts 的 finish（第一批刚改过清 localStorage），确认无冲突；新增 4 表是否只加不改既有表；AI 深度产出（诊断/计划）验收依赖真实模型调用是否已明确；
5. 输出 blocker/concern/suggestion 三类表格，每项带证据与最小修改建议。

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