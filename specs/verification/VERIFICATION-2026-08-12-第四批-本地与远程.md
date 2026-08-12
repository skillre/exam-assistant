# 第四批验证记录（2026-08-12）

目标：导出 CSV + 练习历史 + 标签复习（CHANGE.md 2026-08-12 第四批节，M 级，评审 1 blocker+7 concerns 修订清零后用户确认）

## 本地验证（全部通过）

| 契约项 | 结果 |
| --- | --- |
| ① typecheck | `pnpm typecheck` → 0 error TS |
| ② 全量测试 | 93 passed（旧 79 + csv.test 8 + practiceRepo.test 4 + routeHash history 1 + routes.smoke 第四批链路 1）；Test Files 15 passed |
| ③ 本地 curl（临时 server，DATA_DIR 独立临时目录） | 见下 |
| ④ smoke | `pnpm --filter @exam/server smoke` → 51 项断言通过（不降） |
| ⑤ git diff | 零新依赖；schema.ts/docker/nginx/compose 零改动 |
| ⑥ 回归 | InsightsPage 零改动；WrongBookPage 仅加导出按钮；QuizPage 其余 mode 未动；旧用例全绿 |

### ③ curl 实测输出（节选）

```
=== questions.csv ===
type,stem,options,answer,explanation,tags        ← BOM + 表头 6 列
single,"含逗号,引号""和换行\n的题","[""A"",""B""]",0,解释,标签X   ← 逗号/引号/换行转义正确
=== wrong.csv ===
type,stem,options,answer,explanation,tags,wrong_answer          ← 7 列含追加列
=== tags/counts ===
[{"tag":"标签X","count":1}]     ← 按库计数正确
no-bankId: 400                 ← bankId 必填
=== history ===
history len: 1 → {bankName: 'Curl验证库', questionCount: 1, completed: False, correct: 0, total: 1, accuracy: 0}
finish 后 completed: True      ← 与快照联动
```

## 精确值断言补充（auditor 第 2 轮否决项，2026-08-12）

routes.smoke.test.ts 第四批 it-block 造已知答案组合：导入 2 题（single 特殊转义题 + boolean），答对 1 / 答错 1，断言 history 聚合**精确值**：

```
expect(mine.correct).toBe(1);          // 1 对
expect(mine.total).toBe(2);            // 2 题
expect(mine.accuracy).toBeCloseTo(0.5);
expect(mine.answered).toBe(2);         // 全部已答
```

修复前仅 `typeof correct === "number"` / `total > 0`（0/0 也能过）；现聚合错误会直接失败。wrong.csv 断言同步改为匹配答错题（`boolean,地球是圆的,[],true,,,false` 含 wrong_answer 列）。

## 远程部署验证（106.37.96.58:8080）

- commit 887a0d5 push 成功；`docker compose up --build -d` 双容器重建 healthy
- 远程 `/api/tags/counts?bankId=<TOGAF库>` → `[]`（该库题目无标签，接口正常）
- 远程 `/api/history/practices` → 7 条真实会话（用户练习数据，字段齐全）
- 远程 `/api/export/<bankId>/questions.csv` → BOM + 6 列表头
- 远程 `/api/export/wrong.csv` → 7 列表头含 wrong_answer

## 过程中修复的问题（比计划内更有价值的发现）

1. **routes.smoke.test 数据污染 bug（第三批遗留）**：路由模块静态 import 链使 `config/paths.ts` 在模块加载时锁定 DATA_DIR（beforeAll 里设置已无效），测试数据曾写入默认 `packages/server/data/`（已清理）。改为 beforeAll 内动态 import 路由后修复——第四批新 it 的数据隔离验证暴露此问题。
2. **Content-Disposition 非 ASCII 文件名 500**：导出 header 改用 bank.id（ASCII），中文文件名由前端 `a.download` 指定。
3. **practiceRepo.listRecent 同毫秒排序不稳**：SQL 加 `rowid DESC` tie-break。
