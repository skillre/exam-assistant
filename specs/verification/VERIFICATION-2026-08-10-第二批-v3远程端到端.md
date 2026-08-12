# 第二批 v3 远程验收原始证据（106.37.96.58:6422）

> 采集时间：2026-08-12。真实 AI（DeepSeek）端到端验证，契约⑤⑥⑦ 对应。均为 ssh 执行的真实命令+原始输出。

===== v3 第二批远程验收证据（106.37.96.58:6422）=====

## ⑤a 学情面板 REST 即时

totalAttempts: 17 weakTags: 2

## ⑤b 趋势接口（快照后出现时间序列点）

overall: 1 byTag: 1

## ⑤c/⑤d 诊断缓存与计划列表

诊断条数: 11 createdAt: True
计划数: 1

- 三阶段纠错强化：从 21.4% 迈向及格线 | 阶段: 3

## ⑤g 任务两表落地

任务数: 8

- 验收错题重做：针对计算失误与审题失误逐题复盘 | wrong
- 验收知识点专项覆盖再练，确保举一反三 | byTag
- 判断题专项：纠正越界作答与未审清题面问题 | byType

## ⑤h 一键开练（任务 scope 直接起练习）

开练会话: c7780acb-7775-40bf-a

## ⑤i 掌握联动（连续3次答对→mastered:true）

{"attemptId":"15f1e373-4361-4422-b559-b7bea650e751","isCorrect":true,"correctAnswer":1}
{"attemptId":"1edba4c7-6c51-4153-ac74-684648ea3525","isCorrect":true,"correctAnswer":1}
{"attemptId":"f361a48d-4cff-459a-859f-d8c70bc0c4a3","isCorrect":true,"correctAnswer":1,"mastered":true}

## ⑤ 错题本掌握联动（默认视图消失/含已掌握显示）

默认视图含该题: False
含已掌握视图 mastered: True

## ⑤ 任务状态 API（204 成功/404 不存在）

 HTTP204
 HTTP404

## ⑤⑧ AI 降级路径（无错题库→error 帧提示不挂）

event: error
data: {"message":"暂无错题记录，无需诊断"}

## ⑤ 错题本历史回读

历史轮数: 2
