审计完成。所有证据均已核实（测试/类型检查/构建实际运行、audit 实际输出、源码逐文件读过）。

---

# 考试助手系统 代码质量与安全审计报告

说明：任务指定读取的 `plan.md` / `progress.md` 在仓库中不存在（根目录、`packages/`、`.pi-glla/` 均无），审计以 git 最新提交 `1410d48` 的源码与 `.pi-glla/active.jsonl` 状态为准。

## ① 测试现状

**测试文件清单（共 4 个，全部在 server 包）**：
- `packages/server/src/grading/grade.test.ts`（18 用例）
- `packages/server/src/crypto/secretBox.test.ts`（6 用例）
- `packages/server/src/repositories/questionRepo.test.ts`（4 用例）
- `packages/server/src/insights/LearningDataCollector.test.ts`（4 用例）

**运行结果：正常** — `pnpm test` 4 文件 32 用例全过，退出码 0；`pnpm --filter @exam/server build` 退出码 0。

**覆盖缺口（缺陷）**：
| 核心逻辑 | 有无测试 |
|---|---|
| 判分 grade.ts（single/multiple/boolean、越界、类型不匹配） | ✅ 较全 |
| secretBox 加解密（往返/篡改/随机 IV/空串） | ✅ 较全 |
| questionRepo CRUD/移动复制/批量标签 | ✅ 有 |
| LearningDataCollector 聚合 | ✅ 有 |
| **全部 7 个 HTTP 路由层**（providers/models/import/quiz/banks/tutor/insights） | ❌ 0 测试 |
| **parseFile.ts**（JSON/CSV/Excel/docx 导入解析——正是 xlsx 漏洞面所在） | ❌ 0 测试 |
| parseWithAi.extractJsonArray（AI 输出抽取） | ❌ 0 测试 |
| providerRepo（Key 加解密落库链路） | ❌ 0 测试 |
| secretBox.loadOrCreateSecret（APP_SECRET 文件生成/持久化/权限） | ❌ 0 测试 |
| buildScorecard / resolveScopeQuestions（练习会话核心） | ❌ 0 测试 |
| AiService（runOnce/testProvider/流式） | ❌ 0 测试 |
| client 全部（无 test script、无测试框架） | ❌ 0 测试 |

## ② 类型安全

**正常** — `pnpm typecheck` 0 错误。基础配置严格：`strict` + `noUncheckedIndexedAccess` + `noImplicitOverride` + `verbatimModuleSyntax`（tsconfig.base.json:3-16），仓库代码无 `any`/`as unknown` 滥用（仅 3 处 `as never`，均为 SDK 边界 `p.api`，modelRuntimeSetup.ts:23 / verify.ts:38）。

**风险**：
- 运行时 API 边界无 zod 的 route：providers.ts:12-16 仅手动 truthy 检查（`!body?.name`），`models` 数组、`api` 枚举均不校验；PUT /api/providers 完全无 body 校验——`null` body 会 `TypeError` → 500（providerRepo.ts:81 `input.apiKey` 读 null）。
- 批量参数元素未做类型校验：`questionRepo.ts:200` `tags.map((t) => t.trim())` 遇非字符串元素抛 TypeError → 500；`banks.ts:126-145` 的 `questionIds`/`targetBankId` 同理。属信任边界健壮性缺口（SQL 已参数化，无注入风险，仅 500）。

## ③ 安全

**Key 加密链路：正常（设计合理）**
- AES-256-GCM + 随机 12B IV + authTag 校验（secretBox.ts:36-56）；`loadOrCreateSecret` 首启生成 `randomBytes(32)` 并 `mode: 0o600` 写卷（secretBox.ts:20-26）；scrypt 派生 32B 密钥（secretBox.ts:28-33）；明文 Key 仅存内存（modelRuntimeSetup.ts:9-27 注释明确）；对外响应只暴露 `configured` 布尔（providerRepo.ts:40-52）；镜像/Git/日志均无 Key（docker-compose.yml 顶部注释、`.env.example` 明示）。
- **风险**：APP_SECRET 轮换无降级——`decryptSecret` 抛错（secretBox.ts:56-58）→ `listWithKeys` → `buildModelRuntime` → `AiService.create` 失败 → `process.exit(1)`（index.ts:41-43），旧密文在库时改 secret 会直接启动失败，无恢复文档。

**CORS/SSRF：风险**
- 无 CORS 插件、无鉴权、无速率限制；`app.listen(0.0.0.0)`（index.ts:39）。docker 部署 api 未暴露端口（仅 nginx 同源），但 dev 模式下局域网可达即全权读写。
- **SSRF**：`baseUrl` 任意字符串直通 `registerProvider`（modelRuntimeSetup.ts:23），无 scheme/主机/IP 校验；`POST /api/providers/:id/test`（providers.ts:36-47）与答疑/导入会话都会向任意 baseUrl 发起请求**并携带解密后的明文 Key**。单用户自托管属半设计内（用户自配端点），一旦公网暴露即 SSRF + 凭据外发。

**SQL 注入：正常** — 全部 `db.prepare` + `?`/`@` 参数绑定，无字符串拼接（抽查 db/index.ts:18-38、全部 8 个 repo）。

**输入校验边界：正常 + 小缺陷**
- 导入链路把关扎实：commit 前重新 `validateDrafts`（import.ts:74-81「不信任前端」）、zod 交叉校验 answer 与题型/选项范围（questionSchema.ts:23-52）。
- 缺陷：providers PUT 无 body 校验（见②）；`PATCH /api/practice/:id` 的 currentIndex 无上界校验（quiz.ts:164-168）；`GET /api/health` 回显 `DATA_DIR` 绝对路径（index.ts:25，轻微路径泄漏）。

**敏感信息泄漏：正常** — Key 不进 localStorage（client 仅存练习会话 id，QuizPage.tsx:58-103）；无 console 输出 Key；错误回显 `err.message` 不含 Key；fastify logger 仅记 URL（URL 中只有 id）。**风险**：`verify.ts` 是含 Key 环境变量的运维脚本却随 `tsc` 打进 dist（dist/ai/verify.js），不影响运行但建议排除。

**XSS：正常** — 唯一 `dangerouslySetInnerHTML` 经 DOMPurify（Markdown.tsx:12-14），其余组件均文本渲染。但 **dompurify@3.4.12 有已知 moderate XSS advisory（GHSA-55q2-fjhq-7xh7，3.4.13 修复）**，属依赖风险。

## ④ 死代码与未用导出

| 位置 | 状态 |
|---|---|
| `client/src/shared-check.ts`（Phase 1 占位，全仓无引用） | 死代码 |
| `attemptRepo.listWrongQuestions`（attemptRepo.ts:40-50，无调用） | 未用导出 |
| `wrongBookRepo.getState`（wrongBookRepo.ts:30-35，无调用） | 未用导出 |
| `providerRepo.get`（providerRepo.ts:51-53，routes 均用 `list().find`） | 未用导出 |
| `practiceRepo.remove`（practiceRepo.ts:58-61，无调用） | 未用导出 |
| `server/package.json:21` `nanoid` 依赖（全仓无 import） | 死依赖，可删 |

## ⑤ 依赖健康度

`pnpm audit --prod`：**15 漏洞（10 high / 5 moderate）**。

| 包 | 级别 | 状态 |
|---|---|---|
| xlsx@0.18.5（原型污染 + ReDoS） | high ×2 | **npm 无修复版**（<0.19.3/<0.20.2 均 patched `<0.0.0`），SheetJS 停更；唯一解是换库（exceljs 等），风险：解析恶意 xlsx 文件 |
| fastify@5.10.0 传递依赖 fast-uri（host confusion）×4、find-my-way（HTTP2 DDoS）、brace-expansion（ReDoS）×2 | high ×7 | 升级 fastify 至 5.11.3（registry 现有）可消 |
| undici@8.5.0（经 pi-coding-agent@0.80.10 传递，跨用户信息泄露 + cookie 注入） | high ×2 + moderate | 需上游 SDK 升级 |
| dompurify@3.4.12（XSS） | moderate | `pnpm update dompurify`（→3.4.13）可修 |

依赖必要性：`@earendil-works/pi-coding-agent` 是核心 SDK（重但必要）；`nanoid` 未用（见④）；`xlsx` 唯一 Excel 解析方案但有漏洞；其余（fastify/multipart/better-sqlite3/csv-parse/mammoth/zod/marked/dompurify/react/vite）均被使用，无不必要项。

---

## 结论分级汇总

- **正常**：测试全过（32/32）、typecheck 0 错误、Key 加密链路设计、SQL 全参数化、导入 zod 校验、XSS 消毒、Key 不外泄
- **风险**：SSRF（baseUrl 无校验 + /test 带 Key 外发）、无鉴权直连 0.0.0.0、xlsx 高危漏洞无修复版、fastify/undici 传递漏洞、dompurify XSS advisory、APP_SECRET 轮换即崩
- **缺陷**：路由层/导入解析/AiService/client 零测试、6 处死代码与未用导出、nanoid 死依赖、providers PUT 与批量参数边界无校验（500 面）、/api/health 泄漏路径