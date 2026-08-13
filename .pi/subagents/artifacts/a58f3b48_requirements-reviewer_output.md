已复读 specs/CHANGES.md 第六批节（行 207-227）：文档未被修订，盘点清单、"待确认"状态与证据引用均与评审时一致，以下为截断部分。

| # | severity | dimension | requirement-ref | finding | recommendation |
|---|----------|-----------|-----------------|---------|----------------|
| 2 | blocker | completeness | 第六批-回归验收 | 回归交互清单（切 tab/刷题链路/导出 CSV/历史重练继续/学情下钻）漏 4 条既有功能链路，且全落在本批样式重写面上：① 错题本"标记已掌握"状态切换（WrongBookPage.tsx:214 `className={mastered ? "btn ghost" : "btn"}`，样式随态互换）；② 导入拖拽（ImportPanel.tsx:176 dropzone，恰是盘点漏掉的类）；③ 设置页交互（模型切换/ProviderForm 下拉，SettingsPage selectModel 链）；④ 第三批交付的键盘无障碍 focus 态（QuestionCard 单选/多选/判断键盘操作，focus-visible 样式在 CSS 层，重写即可能丢失且无人检查）——任一回归截图若未展开对应状态即漏检 | 回归验收逐条补：标记已掌握切换前后各截图一次、导入拖拽一次、设置页切换模型一次、tab/方向键操作时 focus 可见性核查（至少代码核查） |
| 3 | concern | consistency | 第六批-改动点② vs 目标验收② | "InsightsPanel 条形图红→品牌色系"列在"组件 className 微调"下，但 5 文件名单（App/History/Banks/WrongBook/InsightsPage）不含 InsightsPanel，验收锁"6 文件以内（styles.css+5 组件）"：按组件改即 7 文件，`git diff --stat` 验收必失败（InsightsPanel.tsx:59 用 `className="bar-fill bad"`） | 明确条图改色仅 CSS 层（重定义 `.bar-fill.bad` 的 background token），组件零改动，6 文件红线保持 |
| 4 | concern | feasibility | 第六批-改动点② | "BanksPage/WrongBookPage 删除按钮→danger ghost"与代码不符：WrongBookPage.tsx 全文件 grep danger/删除/onDelete 零命中，该页无删除按钮，仅 BanksPage.tsx:168,476 两处 `btn danger` 属实 | 改动点删除 WrongBookPage 措辞，只保留 BanksPage 两处删除按钮 |
| 5 | concern | completeness | 第六批-影响面-风险② | "无深色残留"验收与现状冲突：styles.css 无 `color-scheme` 声明（全文件 grep 零命中），深色 OS 下原生 select 下拉/checkbox/滚动条仍渲染深色，截图目测易漏检 | 新增 `color-scheme: light` 并显式给表单控件配色，验收补原生控件展开态截图 |
| 6 | concern | testability | 第六批-目标验收③④/回归验收 | 全部视觉验收依赖 kimi-webbridge：仓库零历史使用证据（specs/verification/ 仅 4 份手工验证文件，无 webbridge 产物），且第三批状态记录"浏览器自动化实测经用户决定取消"——验收可执行性未证实 | 确认前先验证 webbridge 可用，否则补 fallback（手动截图落盘 + getComputedStyle 脚本断言 body 背景/主按钮色/.content 宽度） |
| 7 | concern | feasibility | 第六批-改动点① | 琥珀警示 token 未给具体值：若按惯例 #F59E0B 作文字色，白底对比≈2.15:1 远不达验收的 4.5:1（绿 #15803D≈5.0:1、玫瑰红 #E11D48≈4.7:1 已验可过），"对比度抽查均 AA"与琥珀用法内建矛盾 | 限定琥珀仅作背景色配深色前景，或直接给足暗琥珀色值（≥4.5:1） |
| 8 | suggestion | testability | 第六批-影响面-风险③ | prefers-reduced-motion 降级列入风险点但无对应验收条目，动效是否降级不可观测 | 补一条验收：模拟 reduced-motion 下断言无 transition/animation（或代码核查） |
| 9 | suggestion | feasibility | 第六批-现状/改动点 | 确认属实：styles.css:1-10 深色 token（#0f1115/#4f8cff）与现状一致；styles.css 现 257 行与"约 257→450"一致；.history-table（HistoryPage.tsx:86）在用但 styles.css 无定义、essay-input（QuestionCard.tsx:173）同理，"补齐/重设"前提成立 | 无需修改 |
| 10 | suggestion | feasibility | 第六批-改动点② | 确认属实：App.tsx topbar/.tabs/.tab 结构 + navigate 收口存在；InsightsPage.tsx:172,179,186 确为三连 `btn` 主色按钮；HistoryPage 每行恰 2 个主色按钮（重练/重开|继续 + 详情，7 行≈14 与现状描述一致） | 无需修改 |
| 11 | suggestion | feasibility | 第六批-影响面 | 确认属实：全 src 组件 inline style 仅间距/字号、无硬编码 hex（grep 零命中），深色残留风险确仅存于 CSS 层，全量重写可根治；"零逻辑改动"与 100 测试+smoke 51 断言兜底逻辑成立 | 无需修改 |

**BLOCKERS:**
- #1 第六批-改动点③：className 盘点清单漏 4 个在用静态类（tab/option/dropzone/qnav-cell）+5 个状态类（selected/correct/wrong/current/active）、"静态 35/动态 4"计数与自列 28+3 不符，"新 CSS 全覆盖，无遗漏类"断言被代码证伪——重写按此清单走将丢答题选项选中态/导入拖拽区/题号导航/顶栏激活态样式（已在前段输出）。
- #2 第六批-回归验收：交互回归清单漏 4 条既有功能链路——错题本"标记已掌握"状态切换（WrongBookPage.tsx:214）、导入拖拽（ImportPanel.tsx:176 dropzone）、设置页模型切换、第三批键盘无障碍 focus 态——均处本批样式重写面，存在无验收覆盖的视觉回归滑过路径。