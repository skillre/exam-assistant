审计完成。以下为全面审计报告。

---

# packages/client 前端全面审计报告

审计范围：`packages/client` 全部 17 个源文件（App/main/styles/api×2/pages×5/components×9/vite.config）+ 交叉验证 server 路由（错误形状、SSE 协议、模型接口）与 shared 类型。`tsc --noEmit` 与 `vite build` 均通过（产物 250KB JS / 6KB CSS）。注：任务要求的 `plan.md`/`progress.md` 在仓库中不存在（根目录与全仓 find 均无），不影响客户端审计。

---

## ① 页面/路由结构与导航组织 —— 正常（附风险）

- **Tab 导航而非路由**：无 react-router，`App.tsx:27,42-55` 用 `useState<Tab>` + 条件渲染切换 5 个页（刷题/题库/错题本/学情/设置）。对单用户本地工具可接受，但**无 URL 状态、无深链**，刷新必回刷题页，浏览器前进/后退失效。风险。
- **跨页下钻是亮点**：学情薄弱点→刷题（`App.tsx:34-39`）、成绩单/学情→错题本（`App.tsx:41-44`）经 App 层 `DrillFilter` props 单向传递，结构清晰。但下钻 filter **永不清空**（`App.tsx:28-31` 为常驻 state），用户手动切回刷题页仍被预填上次下钻范围。轻微风险。
- 页内二级视图（题库→题目管理）用组件内 `selectedBankId` 模拟，非路由，正常。

## ② 状态管理方式 —— 风险

- **无全局 store/Context**：全部业务状态页面自持，跨页仅 App 层 2 个下钻 state。切 tab 即卸载重挂（`App.tsx:56-66` 条件渲染）→ **每次切换全量重拉**（刷题页 `QuizPage.tsx:51-53`、错题本 `WrongBookPage.tsx:67-69`、学情 `InsightsPage.tsx:31-36` 各自拉题库/快照）。
- **练习会话经 localStorage 续做**（`QuizPage.tsx:18,58-60,107-114`）✓ 好设计，但有生命周期缺陷：
  - `finish()`（`QuizPage.tsx:163-169`）只看成绩单**不清 LS_KEY**，下次进刷题页会 resume 一个已完结会话，停在最后一题。
  - 续做恢复时 `gradedById` 清空（`QuizPage.tsx:79`），已答过的题在题号导航上显示为未答灰色（依赖 `gradedById`，`QuestionNav.tsx:16-21`），已判分的正确/错误状态丢失。
- 下钻带 filter 时错题本挂载**发两次请求**（filter effect 与 reload effect 先后触发，`WrongBookPage.tsx:57-65` vs `67-69`）。轻微。

## ③ API 层封装与错误处理 —— 正常，SSE 有缺陷

**REST（client.ts）**：
- `req()` 统一封装较好：JSON/FormData/204 分流正确（`client.ts:12-38`），注释解释了 Fastify 空 body 拒 400 的坑（`client.ts:16-22`）。
- 4xx 展示：全仓服务端错误形状统一 `{error}`（已交叉验证 quiz.ts/banks.ts 等 route），`req()` 取 `j?.error` 展示正常（`client.ts:24-27`）。**风险**：Fastify 自动生成的错误（路由未匹配、body 解析失败、500）格式为 `{statusCode, error:'Bad Request', message:'...'}`，`req()` 只读 `j.error` 会显示英文状态名而非 `j.message`。
- **401**：本项目**无鉴权**（server 无任何 auth 路由，交叉验证确认），`req()` 对 401/403 无特判、无登录态处理。当前单用户场景正常，未来加鉴权必须补。

**SSE（sse.ts + 消费方）—— 缺陷**：
- `streamSse`（`sse.ts:14-53`）**无断线重连、无 AbortController、无超时**，任务点名的"断线重连"能力整体缺失。
- 更严重：**传输层异常无恢复路径**。`reader.read()` 抛错（服务端崩溃/代理断连）或流在 `done` 帧前断开时，无任何回调触发（`sse.ts:35-52`）；且 `TutorPanel.runStream`（`TutorPanel.tsx:49-63`）与 `InsightsPage.analyze`（`InsightsPage.tsx:40-49`）**未 await/未 catch** → Promise 未处理拒绝，`streaming`/`running` 永久为 true：讲解面板卡"思考中…"且输入禁用（`TutorPanel.tsx:129-135,147`），学情按钮卡"生成中…"（`InsightsPage.tsx:53-57`）。SSE 服务端正常错误（`error` 帧）能处理 ✓（`sse.ts:75`）。

## ④ 组件复用度与耦合 —— 正常（局部重复）

- **复用良好**：`ImportPanel` 双模式复用（新建库/追加库，`BanksPage.tsx:170,242` + 自身 `targetBankId` props）；`DraftEditor`（ImportPanel + BankDetail 两处）；`QuestionCard`（刷题/错题本）；`TutorPanel`（同）；`QuestionNav`/`Scorecard`/`InsightsPanel` 单一职责。
- **重复点**：
  - 题型中文映射重复 4 份：`BanksPage.tsx:26-28` `typeLabel`、`QuestionCard.tsx:30-33` 内联三目、`Scorecard.tsx:5-9` `TYPE_LABEL`、`QuizPage.tsx:255-263` 内联 select。可并入 `@exam/shared`。
  - `flash()` 三份拷贝（`BanksPage.tsx:47`、`BanksPage.tsx:205`、`ImportPanel.tsx:95`）。
  - 删除题库逻辑重复：`QuizPage.tsx:170-181` `removeBank` vs `BanksPage.tsx:85-101` `deleteBank`（且一个用 `confirm` 一个用 `window.confirm`）。
  - `BankDetail` 内联 `BanksPage.tsx` 同文件，单文件 460+ 行（`BanksPage.tsx:110-460`），建议拆文件。

## ⑤ UI/UX 问题与死代码

**死代码/未用（有证据）**：
| 位置 | 内容 |
|---|---|
| `src/shared-check.ts:1-7` | Phase 1 占位文件，全仓 0 引用 |
| `client.ts:144-148` | `api.validateDrafts` 无任何调用（导入校验走本地 `localIssues`，`ImportPanel.tsx:9-31`） |
| `TutorPanel.tsx:16,30-40` | `autoLoadHistory` 分支无调用方传 true（QuizPage.tsx:214、WrongBookPage.tsx:126 均不传）→ 配套 `api.tutorHistory`（`client.ts:157-161`）同步成为死路径，"错题本回读答疑历史"功能实际未启用 |
| `InsightsPage.tsx:11` + `App.tsx:65` | `onDrillToWrong` 在 Props 声明、App 传入，但组件体未解构（`InsightsPage.tsx:5` 只解构 `onDrillToQuiz`）→ **静默丢弃**；且 InsightsPanel 本身也无下钻错题本 UI |
| `QuestionCard.tsx:7` | `disabled` prop 无调用方传值 |
| `styles.css:252-257` | `.weak-row/.weak-label/.weak-track/.weak-fill/.weak-val` 5 个类零使用（InsightsPanel 用 `bar-row/bar-fill`，`InsightsPanel.tsx:52-62`） |

**UI/UX 问题**：
- **无障碍缺陷**：题目选项是纯 `div` + `onClick`（`QuestionCard.tsx:107-128`），无 `role/tabindex/onKeyDown`，键盘用户无法作答；批量勾选的 checkbox 是原生控件 ✓。
- **缺陷（功能）**：SettingsPage 无法读回当前激活模型——`active` 初始 `''`（`SettingsPage.tsx:10`），仅 `selectModel` 本地 set（`SettingsPage.tsx:67-75`），`refresh()`（`SettingsPage.tsx:28-37`）不加载；服务端 `settingsRepo.getActiveModel()`（settingsRepo.ts:24）只在 `AiService.create` 内部用，`routes/models.ts` 仅 GET 列表 + POST 切换。**刷新页面后下拉恒显"— 选择模型 —"，用户看不到当前生效模型**。
- `selectModel` 先 `setActive` 后调 API，失败不回滚（`SettingsPage.tsx:70-75`）→ 界面与后端不一致。轻微风险。
- 错题本无 loading 态，加载瞬间显示"没有符合条件的错题"（`WrongBookPage.tsx:135`）。
- 刷题页"删除题库"危险按钮紧贴题库下拉（`QuizPage.tsx:287-293`），有 confirm 兜底。
- `ProviderForm` 用 `alert` 报校验错（`ProviderForm.tsx:57-61`），与全局内联 error 风格不一致；`apiType` 自由文本无校验（`ProviderForm.tsx:77-81`）。

**正常项**：类型全走 `@exam/shared`（无私有定义）；Markdown XSS 消毒到位（`Markdown.tsx:9-14` marked+DOMPurify）；`StrictMode`（`main.tsx:9`）；`key={current.id}` 重置题目状态（`QuizPage.tsx:214`）；本地校验与后端同口径（`ImportPanel.tsx:9-31`）；vite 代理/构建配置干净（`vite.config.ts`）；导入 CSV 模板带 BOM、Blob URL 正确释放（`ImportPanel.tsx:139-151`）。

---

## 结论汇总

| 级别 | 项 |
|---|---|
| **缺陷** | ① SSE 传输层断线/异常无恢复 → UI 永久卡"思考中/生成中"（sse.ts:35-52、TutorPanel.tsx:49-63、InsightsPage.tsx:40-49）；② 无"读回当前激活模型"接口 → 设置页刷新后无法显示当前模型（SettingsPage.tsx:10,67-75；server routes/models.ts）；③ 练习完成不清理 localStorage → 下次续做已完结会话（QuizPage.tsx:163-169） |
| **风险** | 无路由深链；下钻 filter 不清空；续做丢失已答判分态（QuizPage.tsx:79）；Fastify 默认错误显示英文状态名（client.ts:24-27）；选项不可键盘操作；401 无特判（无鉴权，未来需补）；selectModel 失败不回滚；错题本双请求/无 loading |
| **正常** | REST 封装、4xx 展示、SSE 协议解析、组件复用、XSS 防护、类型贯通、构建/类型检查 |

未对任何文件做修改（review-only）。