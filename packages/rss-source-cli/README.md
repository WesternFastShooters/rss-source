# rss-source-cli

面向人类、自动化脚本和 AI Agent 的 RSS Source 命令行客户端。所有执行命令默认
输出稳定 JSON：

```json
{ "ok": true, "data": {}, "error": null }
```

## 直接使用

```bash
export RSS_SOURCE_URL=https://rss.example.com
export RSS_SOURCE_API_KEY='<你的 API Key>'
# 若域名启用了 Cloudflare Access Service Token：
export CF_ACCESS_CLIENT_ID='<Client ID>'
export CF_ACCESS_CLIENT_SECRET='<Client Secret>'

npx --yes rss-source-cli@latest health
npx --yes rss-source-cli@latest feeds list --limit 20
npx --yes rss-source-cli@latest entries list --unread-only --limit 20
```

安装后可使用 `rss-source` 或 `rss-source-cli` 两个命令。

## 常用命令

```bash
rss-source feeds add https://example.com/feed.xml --category AI
rss-source feeds update <feed-id> --status paused
rss-source feeds refresh <feed-id>
rss-source feeds remove <feed-id> --yes

rss-source entries get <entry-id>
rss-source entries update <entry-id> --read --star
rss-source unread count

rss-source opml import subscriptions.opml
rss-source opml export --output backup.opml
```

## 从 Folo 同步

先按 Folo CLI 的方式登录一次：

```bash
npx --yes folocli@latest login
```

预览和执行同步：

```bash
rss-source folo sync --dry-run
rss-source folo sync
```

同步通过 `folocli@latest subscription list` 读取普通订阅，通过 `list get` 展开列表
中的订阅，按 URL 去重后写入 RSS Source。已有订阅不会重复创建，新增订阅默认不
立即抓取，由服务端调度器限并发处理。
