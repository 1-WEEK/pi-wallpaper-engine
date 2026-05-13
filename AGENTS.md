# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 项目定位

跑在 Raspberry Pi 4B（Debian 13 Trixie aarch64）上的 Wallpaper Engine **Video** 类型壁纸播放器。Web UI 浏览 Steam Workshop、下载、用 mpv 全屏循环播放。Phase 1 不做转码，源文件直播；Phase 2（未实现）才有 NAS Docker 转码 Worker。

## 常用命令

```
bash install-pi.sh              # 装依赖 + 配置 + preflight，止于此（dev 模式）
bash install-pi.sh --service    # 加装并启用 systemd user 服务（部署模式）

bun run dev                     # 前后端一起跑（前端 5173 HMR + 后端 8080）
bun run dev:backend             # 只跑后端
bun run dev:frontend            # 只跑前端

bun test                        # 跑测试（目前只有 transcode/decide.test.ts）
bun run check                   # preflight 13 项诊断
bun x tsc --noEmit              # 类型检查（在 packages/backend/ 下跑最干净）
bun run --filter @pwe/frontend build   # 构建前端到 packages/frontend/dist
```

`bun test` 单测过滤：`bun test packages/backend/src/transcode/decide.test.ts`

## 架构

**Bun workspaces monorepo**：
- `@pwe/shared` — Effect Schema、Data.TaggedError、跨包共享类型
- `@pwe/backend` — Bun + Elysia + Effect-TS，端口 8080
- `@pwe/frontend` — Vite + React，端口 5173 dev（HMR + 代理 `/api` 到后端）
- `@pwe/worker` — Phase 2 占位，只有 README

**Effect Layer 装配（`packages/backend/src/runtime.ts`）**：用 `.pipe(Layer.provideMerge(...))` 链式注入，**顺序敏感** — 叶子依赖（Config、Logger）放链末。`Layer.mergeAll` 不做交叉解析，别用。Runtime 是 `ManagedRuntime.make(buildLayer(configPath))`，Elysia 路由通过 `runtime.runPromise(Effect.gen(...))` 桥接业务逻辑。

**Service Tag 约定**：每个 service 文件 export `class XxxLive` 的 Layer + `class Xxx extends Context.Tag(...)` 标签。`Db.ts` 用 `acquireRelease` 管 SQLite 连接；`Mpv.ts` 用 acquireRelease 管 mpv 子进程 + Unix socket；`SteamCmd.ts` 同样 acquireUseRelease 管 box86 子进程。

**Effect-TS 仅做业务逻辑层**（资源/错误/取消语义），HTTP 路由保持普通 Elysia handler。

## 关键设计约束

- **下载必须异步**：`POST /api/download/:id` 立即返回 202，后台 fork workflow。SteamCMD 一次跑 30-60+ 秒，同步 handler 会被浏览器/proxy 当超时报 500。进度走 WS `/api/download/progress/:id`。
- **路径在 DB 里存相对值**（如 `source/<id>/.../foo.mp4`），运行时拼 `config.paths.data_root`。Phase 2 Worker 用同样的相对路径，各自前缀自己的 root。
- **非 Video 类型 fail-fast**：`WallpaperFile.resolveWallpaperFiles` 读 `project.json.type`，非 `video` 立刻抛 `NotVideoWallpaperError`，路由 catch 自动清理 `source/<id>/` 半成品。Workshop 搜索 `requiredtags=Video` 不可靠，靠这层兜底。
- **Phase 1 = `TranscodeQueueNoop`**：所有下载行 `transcode_status="skipped"`。`TranscodeQueueLive` 写好待用，Phase 2 改 `runtime.ts` 一行换 Layer 即可。`transcode_jobs` 表存在但 Phase 1 永远空。
- **错误用 `Data.TaggedError`**（在 `@pwe/shared/errors.ts`）：`SteamCmdError`（带 `kind: AuthRequired | NotSubscribed | Timeout | BinaryNotFound | UnknownFailure`）、`WorkshopApiError`、`MpvIpcError`、`NotVideoWallpaperError` 等。路由 catch 用 `err._tag` 判定状态码。

## Pi/SteamCMD 特殊性

- **steamcmd 走 box86 + Valve 官方 tarball**，**不是** Debian apt 包。Trixie aarch64 上 `steamcmd:i386` 因 libc 版本冲突装不上。`install-pi.sh` 加 `dpkg --add-architecture armhf` + `libc6:armhf` + 从 `Itai-Nelken/weekly-box86-debs` 装 box86，下 tarball 到 `~/.local/share/steamcmd/`，在 `/usr/local/bin/steamcmd` 写 wrapper 调 box86。
- **SteamCMD 配置在 `~/Steam/config/config.vdf`**（不是 `~/.steam/steam/config/loginusers.vdf`，那是 Steam 客户端的）。preflight 和 install-pi.sh 检查 `Accounts.<username>` 是否存在判断登录状态。
- **mpv 参数实测可用**：`--hwdec=auto --gpu-api=opengl`（Pi 4B V3D 驱动），不是 spec 里的 `auto-safe` + `vo=gpu`。Config 字段 `mpv.hwdec` 和 `mpv.gpu_api` 可调。
- **mpv 由 backend 拉起**（不是兄弟 systemd unit），acquireRelease 管生命周期。backend 重启 = 短暂黑屏。

## 前端设计系统

**Logo**：`packages/frontend/public/favicon.svg`（256×256 SVG）和 `packages/frontend/public/favicon.ico`（16/32/48px 多尺寸）。

**色彩 token**（定义在 `packages/frontend/src/styles.css` `:root`）：
- `--ink: #0E1116` — 正文背景（与 logo 的 ink 色一致）
- `--ink-1: #131820` — 卡片/面板表面
- `--ink-2: #1a2030` — 输入框/按钮
- `--paper: #F4EFE6` — 主文字（暖奶油色）
- `--accent: #7C5CFF` — 主强调色（紫色）
- `--accent-2: #B7A7FF` — 次强调色（浅紫）
- `--accent-border: rgba(124,92,255,0.22)` — 强调色边框

**CSS 策略**：纯 CSS（无 Tailwind / CSS Modules）。不要在前端引入第二套 CSS 方案。调色系统全部走 CSS 自定义属性，不要在组件里硬写十六进制颜色值。

**Favicon 生成**：如需重新生成 `.ico`，在临时目录装 `@resvg/resvg-js`（arm64-linux-gnu 有预编译包），用 Bun 脚本渲染 SVG → PNG → ICO。`librsvg2-bin` 未安装，不走 `rsvg-convert`。

## Vite 与局域网

`packages/frontend/vite.config.ts` 设 `server.host: true` 绑 0.0.0.0，否则手机/电脑访问 `http://<pi-ip>:5173` 会 connection refused。生产模式（`--service`）走 backend 8080 静态托管 `packages/frontend/dist/`。

## 配置文件

`config.json` 是用户实际配置（gitignored，含 API key）；`config.example.json` 是模板。schema 在 `packages/shared/src/schema/Config.ts`，启动时 Effect Schema 校验，缺字段 fail-fast。`paths.data_root` 默认 `~/pi-wallpaper-engine-data`，可指向 SMB 挂载启用 NAS 共享存储（见 `docs/optional-nas.md`）。

## 不要做的事

- 不要把 SteamCmd 改成同步等待 HTTP 返回 — 必然超时
- 不要在 `Layer.mergeAll` 里塞需要交叉解析依赖的 service — 必须 `provideMerge` 链
- 不要把 `transcode_jobs` 表 / `WorkerProtocol` schema 删掉 — Phase 2 要用
- 不要假设 SteamCMD 在 `/usr/games/steamcmd`（apt 包路径）— 实际在 `/usr/local/bin/steamcmd`（box86 wrapper）
- 不要给路由加 `RequiresMountsFor=` 之类 SMB 挂载依赖 — 默认本地存储，NAS 是可选
