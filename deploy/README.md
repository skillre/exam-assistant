# 部署指南（Docker 双容器）

AI 考试助手用两个容器跑起来：

- **web**：Nginx，托管前端静态页 + 反代 `/api` 到 api 容器（SSE 逐块透传已配好）。
- **api**：Fastify 后端，SQLite / 答疑 JSONL / 运行时 `models.json` / 加密种子都落在 `app-data` 命名卷。

## 一、前置

运行环境需装好 Docker 和 Docker Compose 插件：

```bash
docker --version
docker compose version
```

## 二、拉代码 + 起服务

```bash
# 1) 拉最新代码
git clone <repo-url> exam-assistant   # 首次
cd exam-assistant
git pull                              # 已有则更新

# 2)（可选）准备 .env —— 只放非敏感项，绝不放模型 Key
cp .env.example .env
# 按需编辑：APP_SECRET（不填则首启自动在卷内生成并持久化）、WEB_PORT（默认 8080）

# 3) 构建并后台启动
docker compose up --build -d

# 4) 看状态，等两个容器都 healthy
docker compose ps
```

## 三、访问与配置

浏览器打开 `http://<运行环境IP>:8080`（端口取 `WEB_PORT`）。

首次使用**必须先配模型**（模型 Key 不在代码/镜像里，只能在页面填）：

1. 进「设置」页 → 新增 Provider：填名称、Base URL、API 类型、模型列表、**API Key**。
2. 保存后在「当前使用的模型」下拉里选中一个模型。
3. 之后即可完整走：导入题目 → 刷题判分 → 每题 AI 讲解 → 错题追问 → 错题本重做 → 学情分析。

> 安全说明：填入的模型 Key 会用 `APP_SECRET` 加密后存进卷内 SQLite，**永不回传前端、永不进镜像/Git**。页面只显示某 provider 是否「已配置 Key」。

## 四、数据持久化

所有数据在命名卷 `app-data`（映射到 api 容器 `/app/data`）：

```bash
# 重启不丢数据，已配 provider 的 Key 仍可解密可用
docker compose down
docker compose up -d
```

彻底清空数据（**不可逆**，会连同已配 Key 一起删）：

```bash
docker compose down -v   # -v 删命名卷
```

## 五、常用运维

```bash
docker compose logs -f api      # 看后端日志
docker compose logs -f web      # 看 Nginx 日志
docker compose restart api      # 只重启后端
docker compose up --build -d    # 改代码后重建
```

## 六、故障排查

- **两容器起不来/不 healthy**：`docker compose ps` + `docker compose logs`。api 健康检查打 `/api/health`。
- **页面能开但讲解报错**：多半是没在「设置」页配 provider 或没选模型；或 Key/Base URL 填错。
- **SSE 讲解不流式（整段才出）**：确认经的是 web 容器（8080），Nginx 已配 `proxy_buffering off`；别直连 api 端口。
- **端口冲突**：改 `.env` 的 `WEB_PORT` 再 `docker compose up -d`。

## 七、导入文件模板（JSON / CSV / Excel）

「题库」页可导入结构化文件（JSON/CSV/Excel，走文件导入，不耗 AI）。列约定：

| 列 | 必填 | 说明 |
| ---- | ------ | ------ |
| `type` | 是 | `single`（单选）/ `multiple`（多选）/ `boolean`（判断） |
| `stem` | 是 | 题干文本 |
| `options` | 单选/多选必填 | 选项文本，多个用 `\|` 分隔（判断题为空） |
| `answer` | 是 | 单选=选项下标（从 0 起）；多选=下标逗号分隔（如 `0,2`）；判断=`true`/`false` |
| `explanation` | 否 | 答案解析 |
| `tags` | 否 | 知识点标签，多个用 `\|` 分隔 |

CSV 示例（首行为表头）：

```csv
type,stem,options,answer,explanation,tags
single,1+1=?,1|2,1,等于2,基础
boolean,地球是圆的,,true,常识,常识
```

粘贴文本导入（AI 解析）支持任意自然语言描述的题目（如"单选：1+1=？ A.1 B.2 C.3 答案B"），解析结果先预览确认再入库。
