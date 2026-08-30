# @exam/dsh-exam · 考试助手

考试助手是 [DeepSeek Harness (DSH)](https://github.com/skillre/deepseek-harness) 的原生考试练习插件。它以普通 Host Cordis 插件的形式运行在 DSH 进程内（node:sqlite 存储 + webServer 路由 + settings + llm），并通过 `dsh.client` 浏览器包提供完整交互界面。

## 功能

- **题库管理**：创建题库、CSV 批量导入（自动识别 BOM/GBK 编码、中文题型与表头、字母/多选/判断题答案）、导出往返。
- **练习与测验**：客观题（单选/多选/判断）+ 主观题 essay 题型；客观题毫秒级确定性判分，主观题 AI 评分并给出批改意见。
- **AI 讲解与辅导**：题目讲解、个性化学习计划、AI 学习教练（多轮会话）。
- **学情洞察**：答题统计、正确率/趋势、弱项判定（按正确率阈值 Top5 升序）、题库筛选、多窗口切换（7/30/90 天/全部）、诊断历史与持久化。
- **错题本**：自动收录错题、标记掌握、按题定位跳转。

## 安装

```bash
# 在 DSH 的 profile 中安装本插件包
dsh plugin add @exam/dsh-exam
```

插件作为 **bundle** 加入 profile 的 `dsh.profile.bundles`（参考包内 `cordis.patch.yml` 的说明），或在 profile 的 `cordis.patch.yml` 中 `insert` 插件行：

```yaml
- insert:
    - id: dsh-exam
      name: '@exam/dsh-exam'
      config:
        dataDir: .exam-data
```

`config.dataDir` 为数据目录（SQLite + 答疑 JSONL）。相对路径基于 DSH 启动目录（cwd）解析；不设置时回退 settings `exam.dataDir`，再回退 `<cwd>/.exam-data`。数据目录是可配置路径，绝不包含 API Key（密钥走 DSH credentials）。

## 数据与版本

- 数据保存在 `dataDir` 指向的 SQLite 库中，与 DSH 启动方式、插件版本**解耦**——升级插件时 schema 自动前向迁移，历史数据原地保留。
- 插件运行需要 Node.js >= 24。

## 依赖

peerDependencies（需由宿主 DSH 提供）：

- `@deepseek-ai/cordis`
- `@deepseek-ai/dsh-host-webserver`
- `@deepseek-ai/dsh-llm`
- `@deepseek-ai/dsh-settings`

## 开发

```bash
pnpm install
pnpm run typecheck   # TypeScript 类型检查
pnpm run test        # 单元/集成测试（node:test）
pnpm run build       # 构建 dist（host + client bundle）
```

## 许可证

[MIT](./LICENSE)
