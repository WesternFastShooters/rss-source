# RSS Source

可自托管、CLI 优先的 RSS 信源后端。它用 PostgreSQL 保存大量 RSS、Atom、JSON
Feed 订阅与文章，通过轻量调度器持续刷新；人类、自动化程序和 AI Agent 使用
[`rss-source-cli`](https://www.npmjs.com/package/rss-source-cli) 操作服务。

项目不包含 Web 阅读器，也不再暴露 MCP 接口。CLI 比 MCP 更容易在 Agent shell、
CI 和普通终端中复用，并保持稳定的 JSON 输入输出。

## 核心能力

- RSS 2.0、RDF、Atom 和 JSON Feed
- `rsshub://` 地址及内置 RSSHub 服务
- 容量由 PostgreSQL、磁盘和抓取频率决定，没有产品订阅额度
- ETag、Last-Modified、失败指数退避和并发抓取
- PostgreSQL `FOR UPDATE SKIP LOCKED` 调度抢占
- OPML 批量导入和导出
- 时间线、未读、收藏、分类和文本搜索
- Bearer API Key、Host/Origin 白名单和订阅 URL SSRF 防护
- 幂等、事务化数据库迁移
- 非 root、只读文件系统友好的生产镜像
- Folo 普通订阅与列表成员一键同步

## 架构

```text
标准 RSS / Atom / JSON Feed ─┐
                             ├─> RSS Source ─> PostgreSQL
无 RSS 网站 ─> RSSHub ───────┘       ↑
                                     └─ rss-source-cli / Agent
```

生产 Compose 包含 `app`、`postgres`、`rsshub` 和 `redis` 四个服务。应用容器
内部端口为 `3000`。

## 工具链

- Node.js `24.18.0`
- pnpm `11.5.2`
- TypeScript `7.0.2`
- 服务端构建：`pnpm build:server`
- 全仓构建：`pnpm build`
- 服务端启动：`node dist/index.js`
- 迁移：`node dist/db/migrate.js`

## 本地开发

```bash
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test
pnpm build
```

服务端至少需要 `DATABASE_URL` 和 `APP_API_KEY`。完整变量见 `.env.example`。

## CLI

无需全局安装即可使用：

```bash
export RSS_SOURCE_URL=https://rss.example.com
export RSS_SOURCE_API_KEY='<APP_API_KEY>'
# 若域名启用了 Cloudflare Access Service Token：
export CF_ACCESS_CLIENT_ID='<Client ID>'
export CF_ACCESS_CLIENT_SECRET='<Client Secret>'

npx --yes rss-source-cli@latest health
npx --yes rss-source-cli@latest feeds list --limit 20
npx --yes rss-source-cli@latest entries list --unread-only --limit 20
```

安装后同时提供 `rss-source` 和 `rss-source-cli` 两个命令。所有操作默认返回：

```json
{
  "ok": true,
  "data": {},
  "error": null
}
```

主要命令：

```bash
rss-source feeds add <feed-url> --category AI
rss-source feeds get <feed-id>
rss-source feeds update <feed-id> --status paused
rss-source feeds refresh <feed-id>
rss-source feeds remove <feed-id> --yes

rss-source entries list --unread-only --limit 20
rss-source entries get <entry-id>
rss-source entries update <entry-id> --read --star
rss-source unread count

rss-source opml import subscriptions.opml
rss-source opml export --output backup.opml
```

### 同步 Folo

先登录官方 Folo CLI：

```bash
npx --yes folocli@latest login
```

然后预览并执行：

```bash
rss-source folo sync --dry-run
rss-source folo sync
```

CLI 会调用 `folocli@latest subscription list`，并用 `list get` 展开所订阅列表内的
全部 feed。同步按 URL 幂等去重，新订阅默认交给服务端调度器逐批抓取。

## REST API

CLI 使用以下 REST API。除 `/`、`/health` 和 `/ready` 外均要求：

```http
Authorization: Bearer <APP_API_KEY>
```

| 方法 | 地址 | 用途 |
|---|---|---|
| `GET` | `/health` | 进程存活检查 |
| `GET` | `/ready` | PostgreSQL 就绪检查 |
| `GET/POST` | `/api/feeds` | 查询或新增订阅 |
| `GET/PATCH/DELETE` | `/api/feeds/:id` | 查询、修改或删除订阅 |
| `POST` | `/api/feeds/:id/refresh` | 立即刷新订阅 |
| `GET` | `/api/entries` | 查询文章时间线 |
| `GET/PATCH` | `/api/entries/:id` | 全文和已读/收藏状态 |
| `GET` | `/api/unread/count` | 未读数量 |
| `POST/GET` | `/api/opml/import`、`/api/opml/export` | OPML 导入导出 |

## 生产部署

腾讯云部署见 `docs/production-deployment.md`。关键约束：

- 仅绑定 `127.0.0.1:3000:3000`
- PostgreSQL、Redis、RSSHub 不发布宿主机端口
- 应用使用 UID/GID `10001`、只读根文件系统并移除 capabilities
- 所有服务 `restart: unless-stopped`
- 自动部署使用不可变的 `sha-<完整提交哈希>` 镜像
- 新镜像为 `ghcr.io/westernfastshooters/rss-source`
- PostgreSQL 和 Redis 持久化到 `/srv/data/rss-source`

## 发布

- GitHub：`https://github.com/WesternFastShooters/rss-source`
- npm：`https://www.npmjs.com/package/rss-source-cli`
- GHCR：`ghcr.io/westernfastshooters/rss-source`

推送 `main` 后，GitHub Actions 会运行类型检查、测试和生产构建，构建
`linux/amd64` 镜像并自动部署腾讯云。
