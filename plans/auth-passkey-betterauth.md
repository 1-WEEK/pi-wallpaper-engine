# Pi Wallpaper Engine Passkey Auth Plan

> 状态（2026-05-24）：方案已收敛，但尚未实现。当前 `config.example.json`、
> `packages/shared/src/schema/Config.ts`、`packages/backend/src/index.ts` 都还没有
> `auth` 段、Better Auth 依赖或 route guard。现有业务 API 仍依赖外部网络边界保护。

## 背景

当前项目没有用户鉴权。只要能访问后端端口，就可以调用播放器、下载、存储、显示器电源等控制接口。项目已经通过 Cloudflare Tunnel 绑定到 HTTPS 域名，但 Tunnel connector 部署在家庭局域网另一台设备上，因此 Pi 的 origin 端口仍需要允许该 connector 设备访问，不能简单把 LAN 全部封死。

目标是把后端 API 从“可连端口即可信”升级为“公网 HTTPS 域名 + 应用内 passkey session + 最小公开接口”的单管理员模型。

## 最终决策

- 使用 Better Auth + Passkey，不使用 Auth.js。
- 只支持一个管理员用户，不做多用户、角色和邀请机制。
- 登录方式只用 passkey，不提供密码登录。
- 管理员最多绑定 3 个 passkey。
- 不允许删除最后一个 passkey，避免管理员把自己锁死。
- 丢失所有 passkey 后，通过 SSH 到 Pi 执行本地重置命令恢复。
- 首次初始化必须提供一次性 setup token，来源为环境变量 `PWE_AUTH_SETUP_TOKEN`。
- Auth secret 来源为环境变量 `PWE_AUTH_SECRET`，不写入 `config.json`。
- 初始化完成后关闭创建用户入口；之后只允许已登录管理员管理自己的 passkey。
- Auth 数据放独立 `auth.db`，位于本地 state 目录，不跟媒体存储或 SMB/NAS 走。
- Better Auth schema 生成 SQL 文件提交到 repo，由应用启动迁移执行。
- Session 默认 30 天。
- Cookie 使用 host-only，不设置父域 `Domain`，dev/prod 不共享 cookie。
- dev 和 prod 使用独立 Cloudflare Tunnel HTTPS 域名、独立 RP ID、独立 passkey。
- 不启用 Cloudflare Access；公网入口直接到应用登录页。
- 不依赖 `CF-Connecting-IP` 等 Cloudflare header 做鉴权。
- 后端严格校验 Host/Origin 白名单。
- 非白名单 Host/Origin、LAN 直连、错误入口返回 403。
- `/api/health` 和 `/api/auth/*` 公开；其他 API 和下载进度 WebSocket 都需要有效 session。
- setup/auth 入口增加简单内存限速。
- 防火墙配置只写文档示例，不由 `install-pi.sh` 自动修改。

## 配置设计

在 `packages/shared/src/schema/Config.ts` 和 `config.example.json` 增加 `auth` 段：

```json
{
  "auth": {
    "enabled": true,
    "base_url": "https://pwe.example.com",
    "trusted_origins": ["https://pwe.example.com"],
    "rp_id": "pwe.example.com",
    "admin_email": "admin@example.com",
    "secret_env": "PWE_AUTH_SECRET",
    "setup_token_env": "PWE_AUTH_SETUP_TOKEN",
    "session_days": 30,
    "max_passkeys": 3
  }
}
```

开发环境使用独立 dev 域名，例如：

```json
{
  "auth": {
    "enabled": true,
    "base_url": "https://pwe-dev.example.com",
    "trusted_origins": ["https://pwe-dev.example.com"],
    "rp_id": "pwe-dev.example.com",
    "admin_email": "admin@example.com",
    "secret_env": "PWE_AUTH_SECRET",
    "setup_token_env": "PWE_AUTH_SETUP_TOKEN",
    "session_days": 30,
    "max_passkeys": 3
  }
}
```

配置校验规则：

- `auth.enabled = true` 时，`base_url` 必须是 HTTPS URL。
- `rp_id` 必须匹配 `base_url` 的 hostname。
- `trusted_origins` 必须包含 `base_url`。
- `session_days` 默认 30。
- `max_passkeys` 默认 3，最小值 1。
- `secret_env` 指向的环境变量缺失时启动 fail-fast。
- 首次 setup 未完成时，`setup_token_env` 指向的环境变量缺失则 setup 接口不可用，并返回明确错误。

## 数据库与迁移

新增本地 auth DB：

```text
~/.local/state/pi-wallpaper-engine/auth.db
```

不要把 auth 表放入媒体根，也不要随 `storage.mode = mounted_share` 迁到 SMB/NAS。

迁移策略：

- 使用 Better Auth CLI 生成 SQLite SQL。
- SQL 文件提交到 repo，例如 `packages/backend/src/db/auth-migrations/001_better_auth.sql`。
- 后端启动时打开 `auth.db`，执行 auth migration。
- 现有业务 DB 仍由 `DbLive` 管理；auth DB 用独立 service 或 auth module 管理。
- 回滚时可以停服务、移除 auth 接入、保留或删除 `auth.db`，不影响 library/download/transcode 数据。

额外需要一张轻量本地状态表，记录 setup 是否完成：

```sql
CREATE TABLE IF NOT EXISTS auth_setup_state (
  id TEXT PRIMARY KEY CHECK (id = 'singleton'),
  completed_at INTEGER NOT NULL
);
```

初始化完成后写入该表。之后即使 `PWE_AUTH_SETUP_TOKEN` 仍存在，也不允许创建第二个用户。

## 后端接入

新增 auth 模块，职责：

- 初始化 Better Auth。
- 挂载 `/api/auth/*` handler。
- 提供 `getSession(headers)`。
- 提供 Elysia guard/macro，保护非公开路由。
- 提供 setup 流程：校验 setup token、创建唯一 admin、绑定第一个 passkey、写入 setup completed。
- 限制同一 admin 最多 3 个 passkey。
- 阻止删除最后一个 passkey。

Elysia 接入边界：

- 在 `packages/backend/src/index.ts` 中先注册 Host/Origin 校验。
- 再注册 `/api/auth/*`。
- 再注册业务 API routes。
- 业务 API route 统一套 auth guard，避免每个 handler 自己重复检查。

公开路径：

- `GET /api/health`
- `/api/auth/*`
- 前端静态资源

保护路径：

- `/api/workshop/*`
- `/api/download/*`
- `/api/library/*`
- `/api/player/*`
- `/api/display/*`
- `/api/storage/*`
- `/api/system/*`

WebSocket：

- `/api/download/progress/:workshopId` open 时读取 request headers/cookie。
- 没有有效 session 时立刻关闭连接。
- 通过 session 后再订阅 PubSub。

错误行为：

- 未登录：`401 { "error": "Authentication required" }`
- 无权限或错误 Host/Origin：`403 { "error": "Forbidden" }`
- setup token 缺失或错误：`403`
- setup 已完成后再次 setup：`403`

## Host 与 Origin 白名单

后端必须严格校验请求入口：

- `Host` 必须匹配 `auth.trusted_origins` 的 hostname。
- 有 `Origin` 的请求，`Origin` 必须在 `auth.trusted_origins` 中。
- 写请求必须有合法 Origin。
- WebSocket upgrade 同样校验 Host/Origin。
- 非白名单请求返回 403，不重定向。

Tunnel connector 在另一台 LAN 设备上时，Pi origin 仍会收到来自 LAN 的 HTTP 请求。安全边界不是“禁止 LAN 上所有 origin 请求”，而是：

- 防火墙只允许 Tunnel connector 的 LAN IP 访问 Pi origin 端口。
- 应用仍要求 Host/Origin 是 Cloudflare HTTPS 域名。
- 如果 Cloudflare Tunnel 没有保留原始 Host，需要在 tunnel 配置里显式设置 origin request header。

## 前端接入

前端新增登录门：

- App 启动时请求 session。
- 未登录时只显示简洁登录页。
- 登录页提供 passkey 登录按钮。
- 首次 setup 模式下，显示 admin 身份和 setup token 输入框。
- 登录后进入现有 Browse/Library/Downloads/Settings 导航。

Settings 新增 passkey 管理：

- 显示当前 passkey 列表。
- 添加 passkey。
- 删除 passkey。
- 最多 3 个。
- 最后一个 passkey 不允许删除。

前端 `api.ts` 需要统一处理：

- `401`：清理本地 session 状态并回到登录页。
- `403`：显示简短错误，Host/Origin 错误时提示使用配置的 HTTPS 域名。
- WebSocket 连接失败：如果是鉴权失败，提示重新登录。

开发环境：

- Cloudflare dev 域名指向 Vite 5173。
- Vite 继续代理 `/api` 和 WebSocket 到后端 8080。
- 浏览器只看到 `https://pwe-dev.example.com` 一个 origin。

生产环境：

- Cloudflare prod 域名指向后端 8080。
- 后端静态托管 `packages/frontend/dist`。

## 网络与 Tunnel 文档

新增部署文档说明：

- dev tunnel origin：`http://<pi-lan-ip>:5173`
- prod tunnel origin：`http://<pi-lan-ip>:8080`
- Tunnel connector 设备必须能访问 Pi origin。
- Pi 服务不要绑定 `127.0.0.1`，除非 cloudflared 也运行在 Pi 本机。
- 如果加防火墙，只 allowlist Tunnel connector 的 LAN IP。
- 不要把 `http://<pi-lan-ip>:8080` 或 `http://<pi-lan-ip>:5173` 当作用户入口。

示意：

```text
Browser
  -> https://pwe.example.com
  -> Cloudflare Tunnel
  -> connector device on LAN
  -> http://pi-lan-ip:8080
  -> Pi backend
```

## 工作区策略

不要在脏工作区上直接做 auth 实现。开始前先确认当前文档/功能改动已经提交或明确搁置。

开始实现前：

1. 完成当前任务。
2. 确认 `main` 已提交到最新 HEAD。
3. 创建独立 worktree：

```bash
git worktree add ../pi-wallpaper-engine-auth -b feature/auth-passkey main
```

之后所有 auth 代码改动都在 `../pi-wallpaper-engine-auth` 中进行。

## 测试计划

自动检查：

```bash
bun install
bun run typecheck
bun test
bun run --filter @pwe/frontend build
```

后端验收：

- 未登录访问 `/api/library` 返回 401。
- 未登录访问 `/api/health` 返回正常。
- 非白名单 Host 返回 403。
- 非白名单 Origin 写请求返回 403。
- 初始化完成后，再次 setup 返回 403。
- 不能创建第二个用户。
- 管理员最多 3 个 passkey。
- 不能删除最后一个 passkey。
- `/api/download/progress/:workshopId` 未登录无法建立有效订阅。

前端验收：

- 未登录访问 dev/prod HTTPS 域名显示登录页。
- 首次 setup 需要 setup token。
- setup 成功后进入应用。
- 后续访问可以 passkey 登录。
- Settings 可添加、查看、删除 passkey。
- 删除 passkey 后列表刷新正确。
- 第 4 个 passkey 添加失败并显示清晰错误。

网络验收：

- Tunnel connector 设备可以访问 Pi origin。
- 非 allowlist LAN 设备不能访问 Pi origin，或被应用 Host/Origin 校验返回 403。
- dev HTTPS 域名可使用 Vite HMR。
- prod HTTPS 域名可使用静态前端和 API。

## 回滚

回滚应用代码：

- 移除 Better Auth 依赖和 auth routes。
- 移除业务 route guard。
- 移除前端登录门。
- 保留 `auth.db` 不影响业务。

回滚部署：

- 移除 `auth` 配置段。
- 移除 `PWE_AUTH_SECRET` 和 `PWE_AUTH_SETUP_TOKEN`。
- 保留 Cloudflare Tunnel。
- 防火墙规则如已手动配置，需要手动恢复。

## 风险

- Better Auth adapter 与 Bun/Elysia 版本兼容性需要实现时验证。
- Passkey 对 RP ID、origin、HTTPS 要求严格，dev/prod 域名不能混用。
- Cloudflare Tunnel 如果没有保留 Host，后端 Host 白名单会拒绝请求，需要 tunnel 配置配合。
- 只用 Better Auth、不启用 Cloudflare Access，意味着公网请求会直接到达应用登录面，因此 setup/auth 限速和注册关闭必须实现。
- SSH 本地重置是恢复路径，因此 Pi 的 SSH 安全和本机账号安全仍然重要。
