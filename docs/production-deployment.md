# 腾讯云生产部署

目标环境：Ubuntu 24.04 LTS、linux/amd64、2 核 CPU、4GB 内存、Docker 29、Docker Compose 2。

本文件只描述部署准备和命令。本项目不会自动连接或修改服务器。

## 1. 服务器目录

服务器只保存 Compose、环境变量和持久化数据，不需要保存源码、`node_modules` 或构建缓存。

```bash
sudo install -d -m 0755 /srv/apps/ai-llm-agent-rss
sudo install -d -m 0755 /srv/data/ai-llm-agent-rss/postgres
sudo install -d -m 0755 /srv/data/ai-llm-agent-rss/redis
```

将以下两个文件放入 `/srv/apps/ai-llm-agent-rss`：

- `compose.production.yaml`
- 由 `.env.example` 创建的 `.env`

```bash
cd /srv/apps/ai-llm-agent-rss
chmod 600 .env
```

## 2. 必填环境变量

| 变量 | 说明 |
|---|---|
| `POSTGRES_DB` | 数据库名 |
| `POSTGRES_USER` | 数据库用户 |
| `POSTGRES_PASSWORD` | PostgreSQL 强随机密码 |
| `REDIS_PASSWORD` | RSSHub Redis 强随机密码 |
| `APP_API_KEY` | REST/MCP Bearer Key，至少 32 字符 |
| `ALLOWED_HOSTS` | Cloudflare 公网域名、`127.0.0.1`、`localhost` |
| `ALLOWED_ORIGINS` | 允许的浏览器 Origin 主机名 |
| `RSSHUB_BASE_URL` | Compose 内部 RSSHub 地址，应指向 `rsshub` 服务 |
| `FETCH_ALLOW_PRIVATE_HOSTS` | SSRF 白名单，应包含 `rsshub` |

推荐显式设置：

- `IMAGE_NAME=ghcr.io/westernfastshooters/ai-llm-agent-rss`
- `IMAGE_TAG=sha-<准备部署的完整提交哈希>`
- `ALLOWED_HOSTS=<你的 Cloudflare 域名>,localhost,127.0.0.1`
- `ALLOWED_ORIGINS=<你的 Cloudflare 域名>,localhost,127.0.0.1`（只写主机名，不带 `https://`）
- `RSSHUB_BASE_URL=http://rsshub:1200`
- `FETCH_ALLOW_PRIVATE_HOSTS=rsshub`
- `DB_POOL_MAX=10`
- `FETCH_CONCURRENCY=6`
- `DEFAULT_FETCH_INTERVAL_MINUTES=30`
- `SCHEDULER_TICK_SECONDS=30`
- `LOG_LEVEL=info`
- `TZ=Asia/Shanghai`

使用以下命令分别生成数据库密码、Redis 密码和 API Key；不要复用：

```bash
openssl rand -hex 32
```

## 3. GHCR 访问

如果镜像包为公开，无需登录。若为私有，需要一个仅有 `read:packages` 权限的 GitHub Token：

```bash
echo '<只读 Token>' | docker login ghcr.io -u '<GitHub 用户名>' --password-stdin
```

GitHub Actions 推送镜像使用自动生成的 `GITHUB_TOKEN`，不需要新增发布 Secret。

## 4. 首次启动和迁移

先验证 Compose，再启动依赖：

```bash
cd /srv/apps/ai-llm-agent-rss
docker compose --env-file .env -f compose.production.yaml config --quiet
docker compose --env-file .env -f compose.production.yaml pull
docker compose --env-file .env -f compose.production.yaml up -d postgres redis rsshub
```

显式执行数据库迁移。迁移使用 advisory lock、迁移记录表和单迁移事务，可重复安全执行：

```bash
docker compose --env-file .env -f compose.production.yaml run --rm --no-deps \
  app node dist/db/migrate.js
```

然后启动应用：

```bash
docker compose --env-file .env -f compose.production.yaml up -d
docker compose --env-file .env -f compose.production.yaml ps
curl --fail http://127.0.0.1:3000/health
curl --fail http://127.0.0.1:3000/ready
```

应用启动时也会幂等执行迁移，因此容器重启不会重复应用 SQL。

## 5. Cloudflare Tunnel 与 Access

现有 Tunnel origin 保持：

```text
http://localhost:3000
```

无需开放腾讯云安全组入站端口。Compose 只绑定：

```text
127.0.0.1:3000:3000
```

确保 `ALLOWED_HOSTS` 包含 Cloudflare 上配置的真实域名，否则应用会以 `403` 拒绝请求。

Cloudflare Access 负责边界认证，应用仍要求 `Authorization: Bearer <APP_API_KEY>`。自动化或 MCP 客户端需要同时满足两层认证。

## 6. 导入 232 个信源

`seed/ai-llm-agent-sources.opml` 不需要长期保留在服务器。可以在本地通过 Cloudflare 地址上传，或临时复制到服务器导入后删除：

```bash
curl -X POST \
  -H "Authorization: Bearer <APP_API_KEY>" \
  -H "Content-Type: application/xml" \
  --data-binary @ai-llm-agent-sources.opml \
  https://<你的域名>/api/opml/import
```

不要在首次导入时添加 `?refresh=true`。调度器会按照并发限制逐批抓取，减少服务器峰值和远端限流。

## 7. 更新与回滚

`compose.production.yaml` 已按多架构清单 digest 固定 PostgreSQL、Redis 和
RSSHub 镜像。升级这些服务时应先核对发布说明和备份，再有意更新对应 digest，
避免服务器在普通重启时意外拉到不兼容版本。

推荐部署不可变的 `sha-<提交哈希>` 标签：

```bash
docker compose --env-file .env -f compose.production.yaml pull app
docker compose --env-file .env -f compose.production.yaml up -d app
curl --fail http://127.0.0.1:3000/ready
```

回滚时把 `.env` 中的 `IMAGE_TAG` 改回前一个 SHA 标签并重复以上命令。数据库迁移只允许向前；新增迁移必须保持向后兼容，至少跨一个应用版本。

## 8. 持久化与备份

需要备份的目录：

- `/srv/data/ai-llm-agent-rss/postgres`：必须备份，包含全部订阅和文章状态
- `/srv/data/ai-llm-agent-rss/redis`：RSSHub 缓存，可丢弃后重建

推荐使用逻辑备份，而非直接复制运行中的 PostgreSQL 目录：

```bash
docker compose --env-file .env -f compose.production.yaml exec -T postgres \
  sh -c 'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" --format=custom' > rss-backup.dump
```

备份文件应离开服务器保存，并定期验证恢复过程。

## 9. 资源预算

Compose 针对 2 核 4GB 主机设置了上限：

- 应用：768MB
- PostgreSQL：1GB
- RSSHub：1GB
- Redis：192MB

RSSHub 使用不带 Chromium 的轻量镜像。需要无头浏览器的特殊路由应单独评估；直接启用 Chromium 可能使 4GB 主机出现内存压力。
