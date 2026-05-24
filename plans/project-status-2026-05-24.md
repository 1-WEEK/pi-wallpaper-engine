# Progress — 2026-05-24 项目现状收口

本文基于当前 `main`、计划文档、实际 package/API/schema 状态整理。
结论：项目已经收缩并落地为 **Phase 1 直播放产品**，Phase 2 NAS 转码 Worker
保留接口占位但不是当前可用能力。

## 当前结论

- Phase 1 主链路可用：Workshop 浏览、异步 SteamCMD 下载、非 Video fail-fast、
  SQLite library、mpv 全屏播放、display mode、下载进度、移动端 UI 都已具备。
- 声明式 SMB 存储已经落地：单 SMB 配置、`smb.path`、helper 挂载、sentinel 校验、
  30s reconcile、local↔SMB 双向迁移、迁移进度轮询。
- SQLite state 固定在 `~/.local/state/pi-wallpaper-engine/`，不随媒体存储迁移。
- Phase 2 转码 Worker 未实现：没有 `/api/transcode/*` 路由，没有 Worker 代码、
  Dockerfile、compose、心跳/进度/完成上报闭环。
- Passkey auth 未实现：`plans/auth-passkey-betterauth.md` 是方案文档，不是代码事实。
- 播放与显示器联动已实现：stop 后 30 秒自动关屏，Display Off 先 stop mpv，
  Display On 可从 `player_state` 恢复壁纸；仍需 Pi 手动验收。

## 已完成

### Phase 1 Direct Play

- Bun workspaces monorepo：`shared` / `backend` / `frontend` / `migrate` / `worker`
- Effect service layer + Elysia routes
- Steam Web API search/detail
- SteamCMD async download workflow，`POST /api/download/:id` 立即返回 202
- 下载任务 SQLite 持久化、结构化进度、启动 reconcile、1h TTL 清理
- `project.json.type` 校验，非 Video 自动清理半成品
- ffprobe 元数据、adult metadata 归一化、suspect library row heal
- Library 列表、删除、display_mode 更新
- mpv backend-owned process、Unix socket IPC、命令队列
- Display API：可选 `on/off/status` argv 命令，未配置返回 503
- Player/display linkage：`player_state` 持久化恢复，stop/off/on 省电语义
- system summary、SPA fallback、systemd user service scripts

### Storage Productization

- `storage` config 收敛为 `{ mode, smb }`
- `smb.path` 作为 share 内相对媒体目录，空 path 兼容共享根
- `scripts/pwe-storage-helper` + sudoers NOPASSWD，backend 不直接 mount
- 常量化 mount root：`/run/pwe/mounts/smb`
- sentinel：SMB share 根必须有 `.pwe-mounted-root`
- SMB password 存 `Bun.secrets`
- `@pwe/migrate` 封装 rsync copy/verify/remove
- `MigrateLive` 后台双向迁移，复制全部目录后统一校验，先写目标 mode 再删旧源
- 迁移中挡下载，播放源 root 内文件时拒绝迁移
- Settings 存储卡片、迁移进度条、取消按钮

### Frontend Experience

- Browse：分页、URL 状态、tags/sort、移动端 filter sheet
- Library：grid/list、safe/adult session filter、移动端卡片
- Downloads：active/finished 分组、percent/bytes/elapsed、safe queue
- Settings：Steam/display/mpv/storage 状态
- Desktop shell + mobile top bar/tab bar/mini player
- 纯 CSS design tokens，无 Tailwind/CSS Modules

## 当前 API 事实

已实现：

- `/api/health`
- `/api/workshop/search`
- `/api/workshop/item/:workshopId`
- `/api/download/:workshopId`
- `/api/download/tasks`
- `/api/download/tasks/:workshopId`
- `WS /api/download/progress/:workshopId`
- `/api/library`
- `/api/library/:workshopId`
- `/api/player/play/:workshopId`
- `/api/player/pause`
- `/api/player/resume`
- `/api/player/stop`
- `/api/player/display-mode`
- `/api/player/status`
- `/api/display/on`
- `/api/display/off`
- `/api/display/status`
- `/api/storage`
- `/api/storage/cancel`
- `/api/system/summary`

未实现：

- `/api/transcode/*`
- `WS /api/player/watch`
- 真正取消正在运行的 SteamCMD 进程
- `/api/auth/*`、session guard、passkey setup/login

## 阶段判断

| 阶段 | 状态 |
|---|---|
| Phase 1 MVP | 已完成并进入产品化 |
| Storage redesign | 已实现并提交 |
| Phase 2 Worker | 仅 schema/table/service draft，占位 |
| Phase 3 UX | 大量提前完成，但播放队列/随机/恢复还缺 |
| Auth | 方案收敛，未实现 |
| Player-display linkage | 已实现，待 Pi 手动验收 |
| Phase 4/5 | 未开始 |

## 下一步建议

优先级应避免再按旧 v3 spec 发散。当前最务实的路线：

1. 先把 Phase 1 产品化补齐：Pi 实机 SMB 验收、安装/卸载文档验证、播放稳定性。
2. 决定是否真的要做 Phase 2 Worker；如果要做，再补 `/api/transcode/*` 路由和 Worker。
3. 如果要公网暴露，先实现 passkey auth 或在 Cloudflare Access 下保护 origin。
4. 再考虑播放队列、随机播放、开机恢复等播放体验增强。

## 一句话总结

当前项目不是“等待 Worker 才能用”的半成品，而是一个已经可运行的 Pi 本机
Wallpaper Engine Video 直播放系统；NAS 转码和 passkey 是未来路线，不是当前能力。
