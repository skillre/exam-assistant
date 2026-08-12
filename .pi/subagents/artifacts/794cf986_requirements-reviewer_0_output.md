评审基于 specs/CHANGES.md:103-114（第四批）与现状代码核对（quiz.ts / practiceRepo.ts / schema.ts / banks.ts / QuizPage.tsx / App.tsx / parseFile.test.ts）。

## BLOCKERS

- CHANGES.md:106,108 vs quiz.ts:24-55 + banks.ts:29 —— `GET /api/tags/counts` 只写"allTags + 题量计数"，未限定按 bank 计数；而 byTag 起练是 bank 内过滤（resolveScopeQuestions 先 listByBank 再 filter tag）。多题库、标签跨库复用场景下，下拉显示 N>0 但所选题库内 0 题 → 点"选中即开练"必触发 409"该范围下没有题目"，目标验收③无法成立；零题量标签也未定义是否展示。**必须修订**：counts 端点带 bankId 参数（或客户端按所选 bank 过滤计数），零题量标签置灰/隐藏，409 仅作删除竞态兜底。

## CONCERNS

- CHANGES.md:108 vs 110 —— 改动点列了 4 条新路由（export×2 + history + tags/counts），影响面却写"quiz.ts 新增 3 端点"；且未指明各路由落哪个文件。若 history 路由进新文件，"复用现有函数 buildScorecard"（quiz.ts:283 模块私有、未导出）会静默要求一次未列出的导出改动。建议按文件点名（tags/counts 归 banks.ts:29 旁，history 归 quiz.ts 或明写导出 buildScorecard）。
- CHANGES.md:106,113 vs schema.ts:57,88 —— practice_sessions.bank_id 与 insight_snapshots.bank_id 均 ON DELETE CASCADE：删除题库会连带清空该库全部练习历史与完成态，而删除确认文案（QuizPage.tsx:195）只列"题目/作答记录/答疑历史"未提练习历史；影响面/红线均未交代此联动。建议在影响面明示"删库即删其历史行"（可接受但必须声明）。
- CHANGES.md:106 —— "一键重练"语义未定义：重练若用 session.scope 重走 start（mode=undone/wrong 时 resolveScopeQuestions 重算），完成过的 undone 会话重练会得缩水题集，全部答完时直接 409。建议重练=用会话已存 questionIds 开新会话（新会话同题集），或明写重解析语义。
- CHANGES.md:109 vs QuizPage.tsx:84-113 —— "续做"入口机制未定义：现 QuizPage 仅靠 localStorage LS_KEY 挂载续做，HistoryPage 续做需新增 prop/入口，且与"已存在未完成 localStorage 会话"的优先级冲突未定义；回归验收（CHANGES.md:112）也未含"历史页续做仍恢复判分态"（P0-2 同路径）。建议写明跨页衔接方式并补该回归用例。
- CHANGES.md:111 —— 远程验收"浏览器抽查导出/历史/标签三入口"无具体断言（前几批均有编号步骤）；历史仅"列表单测"证明不了倒序/完成态/正确率/重练续做的端到端正确。建议给抽查列断言（列表倒序、完成态正确、重练/续做各走一次）。
- CHANGES.md:106,108 —— wrong.csv 列布局与筛选语义未定义：WrongBookPage 有 includeMastered/bank/type/tag 筛选，导出是否跟随当前筛选？若附加错次数列则不再"与导入模板同构"（模板 6 列，parseFile.test.ts:42-52）；且验收只查"头/转义"无 导出→再导入 round-trip 证明"同构"。建议定义 wrong.csv 列（模板 6 列+可选附加列）并加导出产物可回导测试。

## SUGGESTIONS

- CHANGES.md:110 —— "navigate/parseTabFromHash 参数化已支持新增 key"不准确：parseTabFromHash 确为参数化（App.tsx:23），但 navigate 入参是闭联合 `Tab`（App.tsx:12），加 history 需手改 Tab 联合 + TABS 数组 + 渲染分支 + 导入。建议改动点列出这 4 处 App.tsx 具体编辑。

BLOCKERS: 1（标签计数未按 bank 限定，与"选中即开练"+409 兜底直接冲突，必须修订确认）；其余 6 项为建议修订。