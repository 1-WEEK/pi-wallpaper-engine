# Progress — 2026-05-27 项目现状收口

本文基于当前 `main`、计划文档、实际 package/API/schema 状态整理。
结论：项目已经收缩并落地为 **Phase 1 直播放产品**，Phase 2 NAS 转码 Worker 保留接口占位但不是当前可用能力。之前计划的 SMB 功能已由更通用和安全的自定义目录模式（Directory Picker）替代。

## 当前结论

- Phase 1 主链路可用：Workshop 浏览、异步 SteamCMD 下载、非 Video fail-fast、SQLite library、mpv 全屏播放、display mode、下载进度、移动端 UI 都已具备。
- 自定义目录存储（Directory Picker model）已经落地：支持配置单个绝对路径作为媒体根目录、支持前端直接浏览服务端可用目录树，并提供双向迁移能力，轮询迁移进度。原 SMB/NAS 直连挂载代码均已被移除。
- SQLite state 固定在 `~/.local/state/pi-wallpaper-engine/`，不随媒体存储迁移。
- Phase 2 转码 Worker 未实现：没有 `/api/transcode/*` 路由，没有 Worker 代码、Dockerfile、compose、心跳/进度/完成上报闭环。
- Passkey auth 未实现：`plans/auth-passkey-betterauth.md` 是方案文档，不是代码事实。
- 播放与显示器联动已实现：stop 后 30 秒自动关屏，Display Off 先 stop mpv，Display On 可从 `player_state` 恢复壁纸；已在 Pi 上通过手动验收。

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

- `storage` config 收敛为 `{ root?: string | null }`，`null` 回退到 `paths.data_root`
- 提供 `/api/storage/locations` 与 `/api/storage/directories` 前端目录树浏览接口
- `@pwe/migrate` 封装 rsync copy/verify/remove
- `MigrateLive` 后台双向迁移，复制全部目录后统一校验，先写目标 mode 再删旧源
- 迁移中挡下载，播放源 root 内文件时拒绝迁移
- Settings 提供基于 Dialog 的目录选择器（Directory Picker）、统一英文文案，展现迁移进度条与取消按钮
- 完全剥离了此前引入的 SMB / cifs 挂载及守护进程代码逻辑。

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
- `/api/storage/locations`
- `/api/storage/directories`
- `/api/storage/validate-target`
- `/api/storage/root`
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
| Storage redesign | 自定义路径双向迁移已实现并替代原 SMB 设计 |
| Phase 2 Worker | 仅 schema/table/service draft，占位 |
| Phase 3 UX | 大量提前完成，但播放队列/随机/恢复还缺 |
| Auth | 方案收敛，未实现 |
| Player-display linkage | 已完成验证 |
| Phase 4/5 | 未开始 |

## 下一步建议

优先级应避免再按旧 v3 spec 发散。当前最务实的路线：

1. 先把 Phase 1 产品化补齐：Pi 实机安装/卸载文档验证、播放稳定性、存储迁移验收。
2. 决定是否真的要做 Phase 2 Worker；如果要做，再补 `/api/transcode/*` 路由和 Worker。
3. 如果要公网暴露，先实现 passkey auth 或在 Cloudflare Access 下保护 origin。
4. 再考虑播放队列、随机播放、开机恢复等播放体验增强。

## 一句话总结

当前项目是一个已经可运行的 Pi 本机 Wallpaper Engine Video 直播放系统；自定义媒体目录和双向迁移能力已经落地，NAS 转码和 passkey 是未来路线，不是当前能力。
