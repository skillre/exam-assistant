# 设计：AI 解析深度升级 · Tag 体系改造 · 面板固定栏

- 日期：2026-08-28
- 范围：`@exam/dsh-exam`（考试助手）
- 状态：**已定稿待实施**（决策均经用户拍板，见 §2）
- 关联设计：`specs/design-reconciliation-2026-08-10.md`（Phase 2/4 基线）、`.codebase-review/16-ai-reliability-idempotency-design.md`（AI 可靠性）

---

## 1. 背景与目标

### 1.1 AI 解析深度不足
练习判分后「✦ AI 解析」（P 形态，`EXPLAIN_SYSTEM`）存在 5 个已确认的限制：

| # | 限制 | 代码事实 |
|---|---|---|
| 1 | 输出总长 ≤350 字 | `EXPLAIN_SYSTEM` 第 2 条硬上限 |
| 2 | 只要求「为什么答案正确」，不要求逐项排除干扰项 | 【正确答案解析】单选项无逐项排除要求 |
| 3 | 思考档位吃默认 | 练习请求体 `{practiceId, questionId, force}` 不带 `reasoningEffort` |
| 4 | 一次性、无追问 | 解析卡仅有「重新解析」，无对话入口 |
| 5 | 缓存固化 | 缓存键 `(question_id, answer_norm)` 无深度维度；浅解析缓存会挡住深解析 |

**目标**：解析支持深度档 + 对话追问 + 个性化上下文；输出**不设字数限制**（以内容完整性约束替代）。

### 1.2 Tag 粒度失真
`questions.tags` 是字符串数组（JSON），筛选/弱项统计均为**字面匹配**。现状：题目 tag 大量为题库/章节级（如 `togaf 9.2`），导致：

- `weakTags` 按字面分组 → 全库同 tag = 全库平均，**无区分度**；
- 解析/讲解注入「标签」对知识点无信息量；
- 计划 byTag = 整个题库；
- 字面匹配 + 大小写/空格不归一（`TOGAF 9.2` vs `togaf9.2`）→ 同义 tag 分桶错乱。

**目标**：引入**知识点（topics）**作为细粒度统计/讲解维度，tag 规范化；配套批量标注与自动标注管道。

### 1.3 面板滚动无固定栏
滚动容器事实：`.exam-assistant-overlay-dialog`（flex column，固定高）→ `.exam-assistant-overlay-header`（标题+关闭，**已固定，不随滚动**）→ `.exam-assistant-overlay-body`（`flex:1; min-height:0; overflow:auto`，**唯一滚动容器**，`padding: 18px`）。

问题：`.exam-assistant-overlay-body` 内为文档流，tab 栏（题库/练习/错题本/AI 学习/学情）与各模块工具条**全部随内容滚走**；用户下滑后既无法切换模块，也看不到当前上下文的进度/操作入口。

**目标**：tab 栏全局吸顶；各模块「上下文工具条」按需二级吸顶；不改变滚动容器结构。

### 1.4 SSE 流式等待期显示占位文本
所有流式输出在「已连接、未收到首个 token」（delta 为空）时，内容区显示括号占位文本，共 4 处、同一模式：

| 位置 | 现状文案 |
|---|---|
| `PracticeView.tsx` AI 解析流 | `（等待首个 token…）` |
| `PracticeView.tsx` essay 批改流 | `（等待首个 token…）` |
| `AiTools.tsx` Tutor 对话流 | `（等待回复…）` |
| `ExamWorkspace.tsx` LLM 流式测试 | `（等待首个 token…）` |

问题：占位文本出现在「内容区」，视觉上像无效输出/错误信息；且被 `aria-live="polite"` 朗读，屏幕阅读器会把占位当成内容。

**目标**：等待期用统一的**骨架占位**（共享组件+共享样式），内容区不出现任何括号占位文本；状态语义由卡片头 meta（如「AI 解析生成中…」）承担。

---

## 2. 已拍板决策（用户确认，按建议执行）

| # | 决策 | 结论 |
|---|---|---|
| 1 | 知识点存储 | 独立 `questions.topics: string[]` 列（不动 `tags` 语义；可索引、可迁移） |
| 2 | P2 存量批量标注 | **草稿确认制**（复用 AI 导入的预览/确认工作流；不自动写回） |
| 3 | P3 深解析副产品知识点 | **自动写回 + 频次保护**（同一题多次生成的候选取高频者；写回记录来源） |
| 4 | 深档 maxTokens | `min(模型支持上限, contextWindow × 1/3)`；`defaultMaxTokens` 仅兜底 |
| 5 | G 形态（题库通用解析） | **保持短篇幅**不随深度档升级（列表/详情展示够用；长文本只走 P 档，不写回 explanation） |
| 6 | 实施顺序 | T1（规范+topics 列+P1 提示词）→ A+B（两档+缓存分档）→ C（追问）→ D（个性化上下文）→ P2/P3 |
| 7 | 输出字数 | **不设字数限制**（提示词去掉"350 字"，以完整性约束替代；上限由 maxTokens 策略保护） |

---

## 3. AI 解析深度升级（A + B + C + D）

### 3.1 A：提示词完全重写（两档共用骨架）

**浅档（默认）**：
- 保留【】分节结构，但升级内容要求：**逐项排除**（单/多选都逐个讲错误选项为什么不成立）、**推理链**（见到题先想什么 → 为什么排除 → 锁定答案）、结合知识点（见 §4）讲考点背景、答错时写**错误根因 + 知识缺口**。
- 提示词内保留"凝练优先（≤400 字引导）"但**不设硬上限**（软引导）。

**深档**：
- 结构（重写）：【思路拆解】→【逐项排除】→【考点延伸】→【你的作答分析】→【易错陷阱】；内容完整性约束替代字数（每节完整、不省略推理步骤）。
- 新增：输出末尾附加一个小 JSON `{"topics": [...]}`（知识点候选，见 §4 P3），与正文分离（约定"最后单独一行 JSON"），服务端剥离。
- 要求结合 T4（§3.4）个性化上下文。

`EXPLAIN_PROMPT_VERSION +1`；**按档位分别失效**：浅档/深档各自独立缓存键，互不挤占。

### 3.2 B：浅/深两档 + 缓存分档 + maxTokens 策略

| 维度 | 浅档（默认） | 深档（「⚡ 深入讲解」按钮） |
|---|---|---|
| 输出 | 结构精简、快速；≤400 字软引导 | 无字数限制、完整推理链 |
| 思考档 | `reasoningEffort` 跟随 DSH 默认（显式接入请求体） | `high/max`（读模型注册表配置，不写死 id） |
| maxTokens | 不设（沿用 DSH 材质化默认） | `min(模型支持上限, contextWindow × 1/3)` |
| 缓存键 | `(question_id, answer_norm, depth='light', prompt_version)` | `(question_id, answer_norm, depth='deep', prompt_version)` |
| 成本 | 低 | 高（UI 标注 + 展示上次 token 用量——usage 已落库） |

**截断保护**：deep 档落库 `finish_reason`（已有）；`finish=max-tokens` → UI 提示「内容被截断，重试或转追问」；预留**自动续写**（P2 增强：把「已生成 + 请继续」再发一次拼接），本期不实施、接口留位。

**请求接线**：练习 `explainAnswerSse` 请求体增加 `depth` 与 `reasoningEffort`（可选）；`resolveLlmRoute` 按 depth 解析对应档位；`withLlmOptions` 复用。

### 3.3 C：追问入口（解析卡 ↔ Tutor 联动）

- 解析卡底部常驻「💬 有疑问？与 AI 对话」；
- 点击：跳 AI 学习 tab，**自动创建/复用**绑定「本题 + 你的作答 + 当前解析内容」的 Tutor 会话；首条 user 消息预填「我看了解析，还有疑问：」；
- 复用现有链路（`buildTutorContext` / 绑定题目 DTO），**无新后端端点**；
- 深档不可达的"无穷深度"由对话承接，重生成只负责结构化讲解。

### 3.4 D：个性化上下文增强（基于 topics，不再依赖字面 tag）

深档请求注入（只读现有数据，无新端点）：
- 该题**第几次做错**（会话域计数）；
- 该题**知识点正确率**（topics 维度聚合，见 §4）；
- 同知识点**相似题**（轻量规则：topics 相同 + 题干关键词重叠 ≥2；不做 embedding）；
- 该知识点在**错题本的分布**。

---

## 4. Tag 体系改造（T1）

### 4.1 分层语义
- **主题 tag（现状 `questions.tags`）**：题库/章节级（如 `togaf 9.2`）——保留现有展示/筛选/练习语义；
- **知识点（新增 `questions.topics: string[]`）**：知识单元级（如 `架构治理`、`数据架构`、`识别架构领域`）——供统计、讲解、计划、个性化上下文。

### 4.2 Tag 规范化（立即，成本极低）
- 入库时 `trim + 小写 + 多空格/连字符归一`（`TOGAF 9.2` / `togaf9.2` 收进同一桶）；
- 覆盖：`createQuestion` / `patchQuestion` / `bulkQuestions(op:'tag')` / AI 导入写回；
- 影响：现有同义 tag 统计分桶立即修复。

### 4.3 知识点来源（三条管道）

**P1 建题/导入提示词升级**：
- `IMPORT_SYSTEM` 输出追加 `topics: string[]`（2~4 个，知识单元级）；
- 服务端校验：数量 1~4；**不得等于主题 tag/题库名**（违规丢弃该字段）；
- 手建/编辑表单：topics 输入（CSV，复用 tags 交互样式）。

**P2 存量批量标注（草稿确认制）**：
- 新端点「AI 知识标注」：对选定题库/全部题目，LLM 批量生成 topics 候选（上下文带题干 + 现有 tag）；
- 返回**草稿**（复用 AI 导入逐题预览/确认工作流），用户确认后写回；
- 无把握时建议「沿用主题 tag」兜底（宁缺毋滥）；
- 入口：题库详情「标签一览」（见 §4.5）。

**P3 深解析副产品（自动写回 + 频次保护）**：
- 深档提示词末尾输出 `{"topics":[...]}`（§3.1）；
- 服务端校验后写入 topics，记录来源（`topic_source`：'ai-deep'/'manual'/'import'/'batch'）与时间；
- **频次保护**：同一题多次生成候选取高频者；与现有 topics 冲突（不同名但判定同义）时保留现有、累计频次——防单次模型抖动漂移；
- 浅档不产 topics（省成本）。

### 4.4 统计/讲解/计划侧
- `weakTags`（Insights 弱项）主键改为 **topics 优先、tags 退化**；明细显示「主题 × 知识点」两维；`byTag` 练习入口增加 `byTopic`；
- 解析/讲解上下文注入顺序：topics（知识单元）→ tags（主题）→ 个性化（§3.4）；
- 学习计划 scope 增加 `byTopic`；
- **分桶语义**：topics 与 tags 均字面规范化后匹配（沿用 json_each 包含语义）。

### 4.5 标签管理工具
- 题库详情新增「标签一览」：聚合该库所有 tags + topics（频次、正确率）、一键按现有 tag 移动到 topics（P2 迁移入口）。

---

## 5. 面板固定栏（UI）

### 5.1 问题建模
- 滚动容器：`.exam-assistant-overlay-body`（唯一）；
- 已固定：`.exam-assistant-overlay-header`（面板标题 + 关闭）；
- 未固定：`.exam-assistant-tabs`（模块切换）与所有模块工具条 → 下滑即不可达。

### 5.2 方案选型

| 方案 | 内容 | 评价 |
|---|---|---|
| ① CSS sticky（推荐） | tab 栏 + 模块工具条 `position: sticky` | 改动面最小（纯 CSS + 少量 DOM 顺序调整）；单滚动容器内行为稳定；无结构性重构 |
| ② 结构重构（不取） | tab/header 移出滚动容器，改为「固定头 + 内容滚动」布局 | 行为最确定但需重排所有模块挂载结构、风险大、收益与 ① 等同 |

**选型：①**。实现要点：
- `.exam-assistant-tabs`：`position: sticky; top: 0; z-index: 20;` + 主题背景（`--dsw-alias-bg-layer-1`）+ 底部阴影/边框分隔；水平方向**全宽贴边**：`margin: 0 -18px; padding: 0 18px;`（补偿 body padding）；
- 二级工具条 `top: var(--exam-assistant-sticky-tabs-h)`（tab 栏实际高度常量，CSS 变量）；
- z-index 分层：tab 20 / 二级工具条 10 / 卡片菜单与弹层 30+（现有 z-index 审计后保持）；
- 深色模式：全部用主题变脸变量，不写死颜色；
- `prefers-reduced-motion`：sticky 无动画，不受影响。

### 5.3 各模块吸顶清单
| 模块 | 吸顶内容 | 优先级 |
|---|---|---|
| 练习（session） | 合并工具条：`第 n/N 题 · 已答 x 题 · 正确率 y%` + 答题导航头（展开/收起）+ 退出练习按钮 | **P0**（最长页面：题目卡+选项+essay/解析卡） |
| 题库列表 | 「题库」标题 + 含归档/刷新操作行 | P1 |
| 题库详情 | 返回行 + 题库名 + 统计 | P1 |
| 错题本 | 筛选/动作工具行（题库切换 + 重练按钮） | P1 |
| 学情 | 概要不长，暂不吸顶；若后续加长再补 | P2 |
| AI 学习 | Tutor 布局自身滚动（`.exam-assistant-tutor__layout`），无需额外 | — |

### 5.4 移动端
- ≤640px：仅吸 tab 栏（高度 44px 触达已保证）；二级条不吸（避免双栏占屏）；
- 二级条吸顶时若内容换行，高度自适应（不设固定高），仅依赖 tab 高度常量。

### 5.5 风险与对策
- **吸顶遮不住穿过内容**：必须背景 + 阴影；深色模式验证；
- **sticky 与 flex gap**：`.exam-assistant-workspace` 为 flex column + gap，sticky 子元素正常（现代浏览器）；验证 Safari/Firefox；
- **面板内部局部滚动**（tutor messages / 答题导航展开滚动条）：不受 sticky 影响；
- **回归**：原 h1/副标题已移除，吸顶后首屏为 tab 栏，信息层级不变。

### 5.6 SSE 流式等待期：骨架占位规范（共享组件）

**状态定义**（流式输出的三个可见阶段）：
1. **TTFT 等待**：SSE 已连接、delta 为空（模型推理/网络准备）；
2. **生成中**：已收到首个 delta，内容逐字追加；
3. **终态**：done / error / aborted。

**视觉规范**：
- TTFT 等待期：内容区渲染**骨架占位**（共享组件 `StreamingPlaceholder`）——3 条骨架线（宽 100% / 92% / 78%，高 12px、圆角、呼吸动画复用 `exam-assistant-pulse`）；**不出现任何括号占位文本**；
- 生成中：内容 + 呼吸光标（复用 `--streaming::after '▌'`）不变；光标**只在有真实 delta 后**出现；
- 终态：现有 done/error/取消语义不变。

**共享实现**：
- 新组件 `src/client/Streaming.tsx`：`<StreamingPlaceholder lines={3} ariaHidden />`（零依赖，纯 div）；
- 新样式 `.exam-assistant-streaming-placeholder` / `.exam-assistant-skeleton-line`（主题变量：`--dsw-alias-interactive-bg-hover`；`prefers-reduced-motion` 时停止动画——沿用现有 2729 行规则）；
- 4 处调用点统一替换（§1.4 清单）；**替换后无任何占位文本残留**（grep 断言：`等待首个 token` / `等待回复` 匹配为 0）。

**可访问性**：
- 骨架占位容器 `aria-hidden="true"`（非内容，不朗读）；
- 状态语义由卡片头 meta（如「AI 解析生成中…」）承担，保持 `aria-live` 语义正确；流式内容 pre 保留 `aria-live="polite"`；
- 等待 > 8s 时 meta 行追加「首次响应可能较慢」（可选项，仅在 meta 区，不占内容区）。

**范围**：练习解析 / essay 批改 / Tutor 对话 / LLM 测试**四端统一**；学情诊断与计划为 runOnce（按钮 loading 文案已在 meta，不属于本规范）。

---

## 6. 实施阶段

| 阶段 | 内容 | 测试锚点 |
|---|---|---|
| M1 | T1 规范化 + `topics` 列（迁移 v9）+ P1 导入/建题提示词 + 标签一览 | store 迁移测试、导入 topics 校验、规范化单测 |
| M2 | A+B：提示词两档 + depth/reasoningEffort 请求接线 + 缓存分档（键/命中/失效）+ 截断提示 | ai.test 快照（两档 prompt_version）、缓存命中矩阵、smoke |
| M3 | C：解析卡追问入口（跳 Tutor 绑定 + 预填消息） | build + 人工验收（无新端点） |
| M4 | D：个性化上下文（第几次错 / 知识点正确率 / 相似题规则） | ai.test 上下文组装断言 |
| M5 | P2 批量标注 + P3 深解析副产品 topics 自动写回 | 服务端草稿/写回/频次保护测试 |
| M6 | UI 固定栏（tab 吸顶 + §5.3 清单）+ SSE 骨架占位（§5.6：`StreamingPlaceholder` + 4 处替换） | 手动滚动验收 + 深色/移动端 + grep 占位文本残留为 0 + typecheck/build |

每个阶段独立可交付、可回滚（迁移仅追加、缓存按档位独立失效）。

## 7. 已知取舍
- deep 档 token 成本显著高于浅档：以 UI 标注 + 用量展示 + 档位缓存隔离控制；不做全局限流（本地单用户工具）；
- 相似题对比用规则（关键词重叠）而非 embedding：低成本、可解释；误配率接受范围内，后续可升级；
- topics 与 tags 共存期两者语义容易混淆：UI 文案明确「主题 / 知识点」；标签一览提供迁移抓手；
- AgentTeams 插件在实例上不可用：本设计实施仍以同会话子代理/直接改动推进（与既有工作流一致）。

## 8. 验收
- typecheck / `pnpm --filter @exam/dsh-exam run test` / build（client bundle 大小、bundle smoke）；
- 人工场景：练习答错 → 浅解析（含逐项排除）→ 深解析（长文 + tops）→ 追问跳 Tutor；题库「标签一览」→ P2 批量标注草稿确认；滚动吸顶（练习/题库/错题本）；深色模式 + 移动端；
- 数据迁移：v9 追加 topics 列，存量行 `topics = NULL`（退化到 tags 统计）。
