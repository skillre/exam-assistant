# 交付与运维审计报告 — 考试助手（exam-assistant）

前置说明：任务要求读取的 `plan.md` 与 `progress.md` **不存在**于仓库根目录（`ls` 无此两文件，`find **/plan.md` / `**/progress.md` 均无结果）。实际计划文档位于 `.rpiv/artifacts/plans/*.md`（git 已跟踪）。另：本环境无 docker 可执行文件（`docker: command not found`），compose 配置只能静态评审，无法实跑验证。

---

## ① 部署架构合理性 — 结论：正常（附 2 项风险）

**正确项（有证据）**
- 双容器职责清晰：`web`（Nginx 静态 + 反代 /api）、`api`（Fastify，`expose: 3000` 不映射宿主端口）— docker-compose.yml:3-4、:16-18。api 不对外直连，强制走 web 反代，与 deploy/README.md:63 的"别直连 api 端口"一致，安全姿态正确。
- 依赖顺序正确：`web depends_on api: condition: service_healthy` — docker-compose.yml:33-35，web 在 api 健康前不启动。
- 双端 healthcheck 均有效：api 用 `node -e fetch(...)`（node:22 内置 fetch）— compose:20-27；web 用 `wget -qO-`（busybox 内置）— compose:39-45。且 `c7186c6` 提交专门修过 web healthcheck 的 `localhost→127.0.0.1`（nginx 仅 IPv4 监听），说明该路径真被踩过。
- SSE 透传配置完整正确 — docker/nginx.conf:14-25：`proxy_buffering off` + `proxy_cache off` + `proxy_set_header Connection ''` + `proxy_read_timeout/send_timeout 3600s`；后端同时下发 `X-Accel-Buffering: no`（packages/server/src/routes/sseWriter.ts:18）双保险。
- 整个链路经远程真实验收：`18a5ba7` "Phase 9 verified on remote: 双容器 healthy + SSE经Nginx352帧 + 重启持久化+Key解密 + 镜像无Key"。

**风险**
- 无日志轮转配置：compose 未设 `logging: {driver: json-file, options: {max-size, max-file}}`，SSE 流式接口长期运行日志会无限增长（docker 默认 json-file 无上限）。
- api healthcheck `start_period: 10s`（compose:26）相对紧张：启动要建库 + `AiService.create()`（SDK 初始化，ai/AiService.ts:87 还含一次真实模型调用测试）——已被远程验证通过，但首启在弱机器上可能超窗。

## ② 数据持久化与备份策略 — 结论：缺陷（最高优先级）

**正常项**
- 数据全落命名卷：`app-data:/app/data`（compose:14、49-50），SQLite / JSONL 会话 / `.app_secret` 均在卷内（packages/server/src/config/paths.ts:14-18，secretBox.ts:15）；`.dockerignore:8-9` 排除 `data`，`.gitignore:5-6` 排除 `data/`——数据不进镜像、不进 Git，DEC-18 落实。
- 重启持久化有验收证据：`18a5ba7` "重启持久化+Key解密"；deploy/README.md:44-48 明确 `down`/`up` 不丢数据、`down -v` 全删并警告不可逆。

**缺陷**
- **零备份方案**。deploy/README.md 全篇（共 6 节）无备份/恢复章节；全库审计未发现任何备份脚本、cron、`sqlite3 .backup` 或卷 tar 指引。所有数据（题库、错题本、学情、会话、已加密的模型 Key 密文）是单卷单点：卷损坏、误删、`docker compose down -v` 手滑 = 全部丢失且**不可恢复**（模型 Key 密文丢失意味着用户需重填所有 provider Key）。SQLite 在线备份（`sqlite3 .backup`）或 `docker run --rm -v app-data:/data ... tar` 均未文档化。对一个存真实 Key 密文 + 全部学习数据的系统，这是交付前必须补的缺口。

## ③ 配置管理 — 结论：正常（附 2 项风险）

**落实良好（有证据）**
- APP_SECRET 语义清晰且实现自洽：加密 provider Key 的主密钥、非模型 Key — compose:12-15 注释、.env.example:6-9。实现为 AES-256-GCM + scrypt 派生（secretBox.ts:16、32-36），env 优先、缺省首启卷内生成 `.app_secret`（0o600）并持久化（secretBox.ts:19-27）。
- 密钥不入镜像/不入 Git 落实到位：`.dockerignore:11-12` 排除 `.env`/`**/.env`，`.gitignore:8` 排除 `.env`；`.env.example` 本身只含非敏感项并显式声明"绝不放模型 Key"（.env.example:1-3）。模型 Key 只在页面填写、加密落 SQLite（deploy/README.md:39-41）。
- 单测覆盖：secretBox.test.ts（6 用例，AES-GCM 往返）——`5d278ec`/`97d7eef` "Phase 2 verified on remote ... secretBox tests (6 pass)"。

**风险**
- **secret 切换失配未警告**：从"自动生成 .app_secret"切换到"显式设 APP_SECRET"（或反之），scrypt 派生出的密钥不同，旧密文全部不可解密（decryptSecret 抛错，secretBox.ts:41-49）。.env.example:7-8 只说了"容器重建仍可解密旧 Key"，没警告"别在自动/显式之间切换"。应文档化：切换前先备份卷内 `.app_secret`。
- 显式 APP_SECRET 时，它能被 `docker inspect` 读到（compose environment 明文注入容器），任何有 docker 权限者即可解密全部 provider Key。文档未提及该主密钥的保管边界（.env 文件本身）。

## ④ 镜像质量 — 结论：正常（附 1 冗余 + 1 风险）

**正确项（有证据）**
- 双镜像均多阶段（builder + runner）：Dockerfile.api:1-38、Dockerfile.web:1-12。
- 构建缓存分层正确：先拷 `pnpm-workspace.yaml package.json pnpm-lock.yaml tsconfig.base.json` + 各包 package.json，再 `pnpm install --frozen-lockfile`（api:8-14，web:5-9）——依赖层只在清单变化时失效，源码层后拷。lockfile 固定版本保证可复现。
- 体积控制：`pnpm --filter @exam/server prune --prod`（api:18-19，含 `||` 兜底 install --prod）；runner 仅拷 node_modules/package.json/dist（api:29-34）；web runner 只有 nginx + conf + dist（web:9-11）。
- better-sqlite3 原生编译留在 builder，runner 用同系基座 `node:22-bookworm-slim` 保 ABI（api:3、24、注释 30）。`packages/shared` 为纯类型包（shared/package.json main 指向 src/types.ts；server 内全部 `import type`——grep 验证），tsc 擦除后运行期无解析问题，`verbatimModuleSyntax`（tsconfig.base.json:19）兜底。

**冗余（优化项）**
- Dockerfile.web:7 在 builder 里全量 `pnpm install`（含 server 的 better-sqlite3 原生编译）只为编译 client。web 镜像每次构建都白付一次原生编译成本。可用 `pnpm --filter @exam/client --filter @exam/shared install` 或 pnpm deploy 只装 client 依赖链。

**风险**
- slim 镜像无编译工具链：若未来 node 大版本无 better-sqlite3 预编译产物，构建直接失败（当前 node 22 有 prebuilt，Phase 9 已验）。

## ⑤ 文档完备度 — 结论：正常（附缺陷 1 条）

**正常项**
- deploy/README.md 六节覆盖完整流程：前置检查 → clone/.env → `docker compose up --build -d` → `docker compose ps` → 浏览器访问 + 首次配 provider → 数据持久化/清空说明 → 常用运维命令 → 故障排查（含 SSE 不流式的具体排障指向 nginx 缓冲，README:62-64）。新人严格照做可部署成功——这一点有 `18a5ba7` 远程验证背书。
- 关键危险操作（`down -v` 删卷）有显式不可逆警告（README:49-51）。

**缺陷**
- 缺"备份与恢复"章节（与 ② 同根因）：无备份命令、无恢复步骤、无"卷损坏怎么办"。
- 缺 APP_SECRET 失配警告（见 ③）；缺运行环境前置（Docker/compose 最低版本、内存要求）；缺公网暴露下的 TLS 说明（当前 nginx 纯 HTTP，仅适合内网/LAN）。

## ⑥ git 历史与开发流程痕迹 — 结论：风险

**良好项（有证据）**
- 提交粒度合理（phase 级）、信息规范：`613f865` Phase 1-2 脚手架 → 逐 phase 提交 → 每个 phase 配独立验证提交（`97d7eef`、`7a4af20`、`b243cc5`、`18a5ba7` 等 "verified on remote"）+ 独立 fix 提交（`c7186c6`、`182d52a`、`c6aebc4`）。写审分离/验收痕迹以提交形式留存。
- 决策链完整可追溯：提交信息与代码注释中的 DEC-xx 决策号（DEC-12/13/18/19 等）贯通；`.rpiv/artifacts/` 下 frd → research → design → plan 全套文档均被 git 跟踪（`git ls-files` 证实 8 个 rpiv 文档 + plan 含 `kind: plan`、`source_design`/`source_frd` 引用链）。
- 历史干净：当前 HEAD=`1410d48`，`git log --oneline` 共 29 条中 22 条为实质提交，7 条 `pi-rewind:turn-...` 为本会话平台瞬态快照（已 rewind，不在当前历史中），不计入项目历史。

**缺陷/缺口**
- **流程产物落位不合规**：AGENTS.md 规定 REQUIREMENTS.md/CHANGE.md/DESIGN.md/PLAN.md 一律落 `specs/`，实际全部落在 `.rpiv/artifacts/` 且无 `specs/` 目录；存量修改流程按 AGENTS.md 需走 Change Gate 产出 CHANGE.md——审计未见任何 CHANGE.md（v2 五大板块这类大改动应属 L 级，需 requirements-reviewer 独立评审的证据也无）。
- **glla 状态未留存**：`.pi-glla/goals/` 与 `.pi-glla/archive/` 均为空目录，仅 active.jsonl（当前 `goal: null`）+ owner 文件。按 AGENTS.md，`.pi-glla/` 是断点续跑依据，空 goals 意味着已完成 goal 无档案、不可复盘。
- **机器状态未 gitignore**：`.pi-glla/`、`.pi-subagents/` 与 v3 会话的 `.rpiv/artifacts/`（deep-ai-insights，2026-07-18_16:37）未提交也未入 .gitignore——`git status` 持续噪音；且 v3 设计产物（slice3-6、frd）处于悬空未提交状态，属进行中工作。
- 无 `plan.md`/`progress.md`（任务指定文件缺失），计划入口只能从 `.rpiv/artifacts/plans/` 找到。

---

## 关键残余风险清单（按优先级）

1. **零备份方案**（缺陷，②/⑤）：单命名卷保存全部数据 + Key 密文，无备份/恢复手段，误删即不可恢复。
2. **APP_SECRET 切换失配**（风险，③）：自动生成与显式 env 之间切换会使既有密文全部不可解密，文档未警告。
3. **web 镜像构建冗余**（优化，④）：全量安装含原生编译依赖只为出静态页。
4. **无日志轮转**（风险，①）：SSE 流式日志无限增长。
5. **流程合规缺口**（风险，⑥）：specs/ 缺失、无 CHANGE.md、.pi-glla goals 为空、机器状态未 gitignore。

**Blocker**：无（系统本身经 Phase 9 远程验收可部署运行）。**建议交付前必修**：#1。