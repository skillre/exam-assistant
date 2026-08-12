# Task for reviewer

[Read from: /Users/skillre/claude/系统开发/考试助手/plan.md, /Users/skillre/claude/系统开发/考试助手/progress.md]

对 /Users/skillre/claude/系统开发/考试助手 做交付与运维审计（考试助手系统）。读：docker-compose.yml、docker/Dockerfile.api、docker/Dockerfile.web、docker/nginx.conf（如存在）、deploy/README.md、.env.example、.gitignore、.dockerignore、根 package.json、git log --oneline 全部历史。评估并输出：① 部署架构合理性（双容器、nginx SSE 透传、healthcheck、依赖顺序）；② 数据持久化与备份策略（命名卷、无备份方案的风险）；③ 配置管理（APP_SECRET 语义、环境变量、密钥不入镜像的落实情况）；④ 镜像质量（构建缓存、体积、多阶段）；⑤ 文档完备度（deploy README 能否让新人直接部署成功）；⑥ git 历史与开发流程痕迹（提交粒度、glla 阶段证据、有无缺口）。每条给文件:行号/命令输出证据。中文输出，结论分级：正常/风险/缺陷。

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