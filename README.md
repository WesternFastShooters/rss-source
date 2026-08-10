# AI LLM Agent RSS

一个可自托管、API 优先的 RSS 后端。它用 PostgreSQL 保存大量 RSS/Atom/JSON Feed 订阅与文章，通过轻量调度器持续刷新，并在同一端口暴露 REST API 和 MCP Streamable HTTP 接口。

项目只实现后端，不包含 Web 阅读器。任何支持 HTTP/MCP 的前端、Agent 或自动化服务都可以使用它。

## 核心能力

- RSS 2.0、RDF、Atom 和 JSON Feed
- `rsshub://` 地址及内置 RSSHub 服务
- 无人为订阅数上限，容量由 PostgreSQL、磁盘和抓取频率决定
- ETag、Last-Modified、失败指数退避和并发抓取
- PostgreSQL `FOR UPDATE SKIP LOCKED` 抢占，允许安全扩展多个实例
- OPML 批量导入和导出
- 时间线、未读、收藏、分类和文本搜索 API
- 基于 MCP TypeScript SDK v2 的 Streamable HTTP 接口
- Bearer API Key、Host/Origin 白名单和订阅 URL SSRF 防护
- 幂等、事务化数据库迁移
- 非 root、只读文件系统友好的生产镜像

## 架构

```text
标准 RSS / Atom / JSON Feed ─┐
                             ├─> 应用调度器 ─> PostgreSQL ─> REST API / MCP
无 RSS 网站 ─> RSSHub ───────┘
```

生产 Compose 包含四个服务：

- `app`：本项目，容器内部端口 `3000`
- `postgres`：订阅、文章、状态和迁移记录
- `rsshub`：把无标准 RSS 的网站转换成 RSS
- `redis`：RSSHub 缓存

## 已确认的工具链

该目录最初为空，没有可以继承的锁文件或构建约定。项目明确固定为：

- Node.js `24.18.0` LTS
- pnpm `11.5.2`
- TypeScript `7.0.2`
- 构建：`pnpm build`
- 启动：`node dist/index.js`
- 迁移：`node dist/db/migrate.js`

## 本地开发

```bash
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test
pnpm build
```

本地运行需要 PostgreSQL，并至少设置：

```text
DATABASE_URL
APP_API_KEY
ALLOWED_HOSTS
ALLOWED_ORIGINS
```

复制 `.env.example` 为 `.env` 后填写配置。应用不会自动读取 `.env`；开发时可以由 shell、进程管理器或 Docker Compose 注入。

## REST API

除 `/`、`/health` 和 `/ready` 外，所有端点都要求：

```http
Authorization: Bearer <APP_API_KEY>
```

主要端点：

| 方法 | 地址 | 用途 |
|---|---|---|
| `GET` | `/health` | 进程存活检查 |
| `GET` | `/ready` | PostgreSQL 就绪检查 |
| `GET/POST` | `/api/feeds` | 查询或新增订阅 |
| `GET/PATCH/DELETE` | `/api/feeds/:id` | 查询、修改或删除订阅 |
| `POST` | `/api/feeds/:id/refresh` | 立即刷新订阅 |
| `GET` | `/api/entries` | 查询文章时间线 |
| `GET/PATCH` | `/api/entries/:id` | 读取全文或修改已读/收藏状态 |
| `GET` | `/api/unread/count` | 未读数量 |
| `POST` | `/api/opml/import` | 导入 OPML；可使用 `?refresh=true` 立即抓取 |
| `GET` | `/api/opml/export` | 导出 OPML |

导入仓库内置的 232 个 AI 信源：

```bash
curl -X POST \
  -H "Authorization: Bearer $APP_API_KEY" \
  -H "Content-Type: application/xml" \
  --data-binary @seed/ai-llm-agent-sources.opml \
  http://127.0.0.1:3000/api/opml/import
```

默认导入只建立订阅，让调度器逐步抓取，避免同时请求 232 个网站。

## MCP

MCP 地址：`https://<你的域名>/mcp`，传输协议为 Streamable HTTP，认证使用同一个 Bearer API Key。

提供的工具：

- `list_feeds`
- `add_feed`
- `remove_feed`
- `refresh_feed`
- `list_entries`
- `get_entry`
- `update_entry`
- `unread_count`
- `import_opml`

如果 Cloudflare Access 保护该域名，非浏览器 MCP 客户端通常还需要 Cloudflare Access Service Token，并发送 `CF-Access-Client-Id` 与 `CF-Access-Client-Secret`。

## 生产部署

腾讯云 Ubuntu 24.04 的完整部署准备和首次操作见 [docs/production-deployment.md](docs/production-deployment.md)。

关键约束已经固化在 `compose.production.yaml`：

- 只有应用端口映射到宿主机
- 映射形式为 `127.0.0.1:3000:3000`
- PostgreSQL、Redis 和 RSSHub 不发布宿主机端口
- 应用容器使用 UID/GID `10001`
- 应用文件系统只读，并移除 Linux capabilities
- 所有服务使用 `restart: unless-stopped`
- 数据只写入 `/srv/data/ai-llm-agent-rss`

## CI 与镜像

推送到 `main` 后，GitHub Actions 会：

1. 使用真实 PostgreSQL 运行类型检查和全部测试；
2. 编译生产代码；
3. 构建 `linux/amd64` 镜像；
4. 使用仓库自带的 `GITHUB_TOKEN` 推送到：

```text
ghcr.io/westernfastshooters/ai-llm-agent-rss:latest
ghcr.io/westernfastshooters/ai-llm-agent-rss:sha-<完整提交哈希>
```

工作流文件：`.github/workflows/ci.yaml`。
