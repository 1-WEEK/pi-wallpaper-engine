# Progress 2026-06-07 项目现状

本文基于当前 `main`、代码、API、schema 的实际状态整理,取代 2026-05-27 快照。

结论:项目已经是一个功能完整、产品化的 Pi 本机壁纸引擎。Phase 1 直播放可用,自定义目录和双向迁移落地,passkey auth 已实机验证,播放与显示器联动已验证。Phase 2 转码 worker 的代码已经写完,但还没在真 NAS 上跑过端到端转码。当前正在做播放轮播。

## 当前结论

- Phase 1 主链路可用且产品化:Workshop 浏览、异步 SteamCMD 下载(可取消)、非 Video fail-fast、SQLite library、mpv 全屏播放、display mode、下载进度、live player WebSocket、移动端 UI 都已具备。
- 自定义目录存储(Directory Picker)已落地:单个绝对路径作为媒体根、前端目录树浏览、双向迁移、迁移进度轮询。原 SMB/NAS 直连挂载代码已移除。代码完成,待真机(可移动存储)验收。
- SQLite state 固定在 `~/.local/state/pi-wallpaper-engine/`,不随媒体存储迁移。
- Passkey auth 已实现并在 Pi 实机验证:Better Auth + Passkey 后端(sessionGuard、originGuard、WS 鉴权、限流)和前端(Setup 向导、Login、Settings 管理)都已完成。`docs/auth.md` 为操作文档。默认关闭,公网暴露时开启。
- 播放与显示器联动已实现并验证:stop 后 30 秒自动关屏,Display Off 先 stop mpv,Display On 从 `player_state` 恢复壁纸。
- Phase 2 转码 worker 代码已完成,未真机验证:`@pwe/worker`(`client`、`ffmpeg`、`index`)、Dockerfile、docker-compose、`WorkerProtocol`、心跳/进度/完成/失败/重试都已写好。runtime 按 `PWE_WORKER_API_KEY` 在 `TranscodeQueueLive` 和 `TranscodeQueueNoop` 之间切换,`/api/transcode/*` 同条件挂载。还没在真 NAS 跑过端到端转码。

## 已完成

### Phase 1 Direct Play

- Bun workspaces monorepo:`shared` / `backend` / `frontend` / `migrate` / `worker`
- Effect service layer + Elysia routes
- Steam Web API search/detail
- SteamCMD async download workflow,`POST /api/download/:id` 立即返回 202,支持取消正在运行的下载
- 下载任务 SQLite 持久化、结构化进度、启动 reconcile、1h TTL 清理
- `project.json.type` 校验,非 Video 自动清理半成品
- ffprobe 元数据、adult metadata 归一化、suspect library row heal
- Library 列表、删除、display_mode 更新
- mpv backend-owned process、Unix socket IPC、命令队列
- live player WebSocket(`/api/player/watch`),1Hz 快照推送
- Display API:可选 `on/off/status` argv 命令,未配置返回 503
- Player/display linkage:`player_state` 持久化恢复,stop/off/on 省电语义
- system summary、SPA fallback、systemd user service scripts

### Storage Productization

- `storage` config 收敛为 `{ root?: string | null }`,`null` 回退到 `paths.data_root`
- `/api/storage/locations` 与 `/api/storage/directories` 前端目录树浏览
- `@pwe/migrate` 封装 rsync copy/verify/remove
- `MigrateLive` 后台双向迁移,复制后统一校验,先写目标再删旧源
- 迁移中挡下载,播放源 root 内文件时拒绝迁移
- Settings 的 Directory Picker、迁移进度条与取消按钮
- 旧 SMB / cifs 挂载及守护进程代码已完全剥离

### Auth

- Better Auth + Passkey 后端,独立 `auth.db`
- sessionGuard 给 `/api/*` 加 401 墙,`/api/health` 与 `/api/auth/*` 放行
- originGuard 校验 `trusted_origins`,WebSocket 走 session
- authRateLimit 限流,`auth:reset` CLI,preflight 检查
- 前端 Setup 向导、Login、Settings passkey 管理

### Frontend Experience

- Browse:分页、URL 状态、tags/sort、移动端 filter sheet
- Library:grid/list、safe/adult session filter、转码 saved% 指示、移动端卡片
- Downloads:active/finished 分组、percent/bytes/elapsed
- Settings:Steam/display/mpv/storage 状态
- Desktop shell + mobile top bar/tab bar/mini player
- 纯 CSS design tokens,无 Tailwind/CSS Modules

### Phase 2 Worker(代码完成,未真机验证)

- `@pwe/worker`:claim/heartbeat/progress/complete 的 `WorkerProtocol` 客户端
- ffmpeg 硬件 HEVC(Intel QSV)+ libx265 软件回退
- Dockerfile + docker-compose,预构建镜像分发模型
- Pi 侧 `/api/transcode/*` 与 `TranscodeQueueLive` 由 `PWE_WORKER_API_KEY` 门控
- `TranscodeMonitor` 处理 stale claim reset

## 当前 API 事实

已实现:

- `/api/health`
- `/api/workshop/search`、`/api/workshop/item/:workshopId`
- `/api/download/:workshopId`、`/tasks`、`/tasks/:workshopId`、`/:workshopId/cancel`、`WS /progress/:workshopId`
- `/api/library`、`/api/library/:workshopId`
- `/api/player/play/:workshopId`、`/pause`、`/resume`、`/stop`、`/display-mode`、`/status`、`WS /watch`
- `/api/display/on`、`/off`、`/status`
- `/api/storage`、`/cancel`、`/locations`、`/directories`、`/validate-target`、`/root`
- `/api/transcode/*`(`PWE_WORKER_API_KEY` 设置时挂载)
- `/api/auth/*`(passkey setup/login,session guard)
- `/api/system/summary`

尚未实现:

- 播放轮播(队列、随机、顺序、上下一张),见 `playback-rotation-iteration.md`
- 睡眠定时器

## 阶段判断

| 阶段 | 状态 |
|---|---|
| Phase 1 MVP | 已完成并产品化 |
| Storage redesign | 自定义路径双向迁移已实现,待真机验收 |
| Phase 2 Worker | 代码完成,未真 NAS 部署验证 |
| Auth | 已实现并实机验证 |
| Player-display linkage | 已完成验证 |
| 播放轮播 | 进行中 |

## 下一步

1. 播放轮播,进行中,见 `playback-rotation-iteration.md`。
2. 真机验收:storage 双向迁移、轮播长时间稳定性。
3. Phase 2 worker 真 NAS 部署加端到端验证,需要 NAS 与 Intel iGPU。

## 一句话总结

当前是一个功能完整、已产品化的 Pi 本机壁纸引擎,自定义目录、双向迁移、passkey、播放联动都已落地,转码 worker 代码就绪等真机验证,播放轮播正在做。
