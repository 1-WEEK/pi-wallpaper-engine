# WE-Pi Player — Project Spec (v3)

> 在 Raspberry Pi 4B 上运行的 Wallpaper Engine Video 壁纸播放器，提供 Web UI 浏览、下载、播放控制。视频转码由 NAS 上的 Docker Worker 完成，Pi 仅负责调度、播放与展示。

---

## 项目目标

- 通过浏览器访问运行在 Pi 上的 Web UI
- 浏览 Steam Workshop 中 Wallpaper Engine 的 Video 类型壁纸
- 一键下载并在 Pi 连接的屏幕上全屏循环播放
- 自动将下载的视频转码为屏幕原生分辨率，适配 Pi 4B 的硬解能力
- 支持切换、暂停、管理本地已下载的壁纸库

---

## 运行环境

| 项 | 状态 |
|----|------|
| 调度/播放设备 | Raspberry Pi 4B（4GB） |
| 系统 | Debian GNU/Linux 13 (Trixie) aarch64 |
| 桌面环境 | 已安装并正常工作（Wayland） |
| 显示器 | **1200×1080 物理像素**（≈ 10:9 略宽于方屏） |
| 转码 Worker | 极空间 NAS（Z4S，Intel N5105/N6005 + 核显，Docker 部署） |
| 共享存储 | NAS 上的壁纸目录，Pi 通过 SMB 挂载（源/转码产物均在 NAS） |
| 网络 | LAN（手机/电脑通过 IP 访问 Web UI） |
| Steam | 持有 Wallpaper Engine（AppID 431960） |

**关键约束**：Pi 4B **不参与任何视频编码**。所有转码操作都委托给 NAS Docker Worker。Pi 4B 只做下载调度、Web UI、SQLite 任务队列和 mpv 播放（解码）。

---

## 系统架构

```
Browser（手机/电脑/任意设备）
        ↓ HTTP / WebSocket
┌──────────────────────────────────────┐
│      Raspberry Pi 4B (Trixie)        │
│      已存在的桌面会话 (Wayland)       │
│                                      │
│  Bun + Elysia + Effect-TS            │
│  ├── Workshop API client             │
│  ├── SteamCMD 下载封装               │
│  ├── 任务队列（SQLite）               │
│  ├── Worker pull 端点                │
│  ├── mpv IPC 控制                    │
│  └── 静态 Web UI 托管                 │
│                                      │
│  mpv (桌面会话内全屏，硬解播放)        │
│        ↓ HDMI                        │
└──────────────────────────────────────┘
   ↓ SMB 挂载 (NAS 共享)
┌──────────────────────────────────────┐
│            极空间 NAS (Z4S)           │
│                                      │
│  /vol/wallpapers/                    │
│    ├─ source/      ← SteamCMD 落盘   │
│    └─ optimized/   ← Worker 转码产物 │
│                                      │
│  Docker 容器: we-pi-transcoder       │
│    ├─ Bun worker 进程                │
│    ├─ ffmpeg + Intel QSV (核显)      │
│    └─ HTTP 长轮询 Pi 拉任务            │
└──────────────────────────────────────┘
       ↑ 拉任务/上报状态 (HTTP)
       └────── Pi ←──────┘
```

**数据流**：

1. 用户在 Web UI 触发下载 → SteamCMD 写入 `NAS:/vol/wallpapers/source/<id>/`
2. 下载完成 → 创建转码 Job 入队
3. NAS Worker 长轮询 Pi，拉取 Job → 直接读 `source/`、写 `optimized/`（同一文件系统，零跨设备传输）
4. Worker 上报进度/完成 → Pi 更新 Job 状态 → WebSocket 广播给前端
5. 播放时 mpv 优先读 `optimized/`，未转码完成则 fallback 读 `source/`

---

## 技术栈

| 层级 | 技术选型 | 说明 |
|------|---------|------|
| 运行时 | Bun | ARM64 原生（Pi 端）；x86_64（Worker 容器） |
| 后端框架 | Elysia | Bun 原生，端到端类型安全，内置 WebSocket |
| 业务逻辑层 | Effect-TS | 资源/错误/并发管理，包裹所有副作用 |
| Schema 校验 | `effect/Schema` | 配置文件、API 响应、`project.json`、Worker 协议 |
| 平台抽象 | `@effect/platform-bun`（可选） | FS、Command、HTTP client 的 Effect 封装 |
| 前端 | React + Vite | 构建后由 Elysia 托管 |
| 播放器 | mpv + JSON IPC（Unix socket） | 硬解 + 程序控制 |
| 下载 | SteamCMD | ARM64 Linux 官方支持 |
| 数据库 | `bun:sqlite` | 任务队列 + 库元数据 |
| 转码 | NAS Docker + ffmpeg + Intel QSV | `hevc_qsv` / `h264_qsv` 硬件编码 |
| 共享存储 | SMB（CIFS） | Pi 挂载 NAS 共享，Worker 直接访问宿主路径 |
| 系统服务 | systemd user 服务（Pi）+ Docker（NAS） | |

---

## 目录结构

```
we-pi-player/
├── backend/                       # Pi 端调度服务
│   ├── index.ts                   # Elysia + Effect runtime 入口
│   ├── runtime.ts                 # ManagedRuntime，注入所有 Layer
│   ├── routes/
│   │   ├── workshop.ts            # Workshop 浏览
│   │   ├── download.ts            # 下载（含 WS 进度）
│   │   ├── library.ts             # 本地库管理
│   │   ├── player.ts              # mpv 控制
│   │   └── transcode.ts           # 转码 Job 管理 + Worker pull 端点
│   ├── services/
│   │   ├── Config.ts
│   │   ├── SteamWorkshop.ts
│   │   ├── SteamCmd.ts
│   │   ├── Mpv.ts
│   │   ├── Library.ts
│   │   ├── TranscodeQueue.ts      # Job 状态机 + 队列
│   │   ├── Db.ts
│   │   └── Logger.ts
│   ├── schema/
│   │   ├── Config.ts
│   │   ├── ProjectJson.ts
│   │   ├── WorkshopApi.ts
│   │   └── WorkerProtocol.ts      # Worker ↔ Pi 通信 schema
│   └── errors.ts
├── worker/                        # NAS Docker 内运行的 Worker
│   ├── index.ts                   # 长轮询 + ffmpeg 执行
│   ├── ffmpeg.ts                  # QSV 命令构造
│   ├── Dockerfile
│   └── docker-compose.yml         # 部署到 NAS 的 compose 文件
├── frontend/
│   ├── src/
│   │   ├── App.tsx
│   │   ├── pages/
│   │   │   ├── Browse.tsx
│   │   │   ├── Library.tsx
│   │   │   └── Settings.tsx
│   │   └── components/
│   │       ├── WallpaperCard.tsx
│   │       ├── PlayerBar.tsx
│   │       └── TranscodePanel.tsx
│   └── package.json
├── config.json
├── package.json                   # Bun workspaces (backend + worker + frontend)
├── install-pi.sh
└── we-pi-player.service           # systemd user unit
```

---

## 为什么引入 Effect-TS

副作用密集型项目，每个副作用都需要资源生命周期 + 类型化错误 + 取消语义：

1. **资源管理** —— SteamCMD 进程、mpv socket、WebSocket 连接、DB 事务的清理用 `Effect.acquireRelease` / `Scope`
2. **错误类型化** —— `SteamCMDError` / `MpvIpcError` / `WorkshopApiError` / `WorkerTimeoutError` 用 tagged errors 精确传播
3. **取消** —— 用户取消下载/转码、客户端 WS 断开停止推流，由 fiber interruption 自动覆盖
4. **并发控制** —— 同一 workshop ID 串行下载（`Semaphore`）；mpv IPC 命令队列化（`Queue`）；Job 状态机超时回退
5. **依赖注入** —— Service Layer 模式让单测可替换 SteamCMD/mpv/Worker 为 mock

---

## 显示模式与转码策略

### 屏幕规格

物理分辨率 **1200×1080**，比例 ≈ 10:9。Workshop 上的 Video 壁纸大多数是 1920×1080（16:9）或 3840×2160 4K（16:9），少量竖屏和奇怪比例。

### 默认行为：fill（铺满 + 智能裁剪）

WE 视频壁纸内容大多边缘信息少、中心是主体（粒子、景观、抽象动画），裁剪左右两侧的视觉损失通常可接受。`fill` 让屏幕"完全亮"，无黑边。

每个壁纸允许在 UI 中切换为：
- **fill**：等比缩放到铺满，超出部分裁剪（默认）
- **fit**：等比缩放到完全可见，黑边补齐
- **stretch**：拉伸变形（不推荐，仅作为选项）

mpv 通过 `panscan` / `keepaspect` 实时切换，不重启播放。

### 转码目标

下载完成后，自动判断是否需要转码：

| 源情况 | 行为 |
|--------|------|
| 已是 1200×1080 H.264/H.265 | `skipped`，直接播 source |
| 1080p H.264，比例不匹配 | 转码：缩放到 1200×1080 fill 裁剪后的有效区域，重新编码 H.264 |
| 1080p H.265 | 转码到 1200×1080 H.265（保留 H.265 体积优势） |
| 4K（任意编码） | 强制转码到 1200×1080 H.265 |
| 竖屏内容（高 > 宽） | 默认 fit 模式，转码为 letterbox 后的视频或保持原始尺寸由 mpv 运行时缩放 |

转码后体积通常缩到原文件 20-40%，且匹配屏幕原生分辨率，省去运行时缩放开销。

---

## 转码 Worker（NAS Docker）

### 部署形态

NAS 上 Docker 容器，挂载核显设备 `/dev/dri` 给 ffmpeg 使用 Intel QSV 硬件编码。

```yaml
# worker/docker-compose.yml （部署到 NAS）
version: "3"
services:
  we-pi-transcoder:
    build: .
    container_name: we-pi-transcoder
    devices:
      - /dev/dri:/dev/dri          # 暴露 Intel 核显
    group_add:
      - "44"                        # video group
      - "109"                       # render group（具体 GID 视宿主而定）
    volumes:
      - /vol/wallpapers:/data       # NAS 上的共享目录（与 Pi SMB 挂载是同一份）
    environment:
      - PI_HOST=http://<pi-ip>:8080
      - WORKER_NAME=z4s-qsv
      - WORKER_POLL_INTERVAL=5000
      - DATA_ROOT=/data
    restart: unless-stopped
```

### Worker 逻辑（伪代码）

```typescript
// worker/index.ts
while (true) {
  const job = await fetch(`${PI_HOST}/api/transcode/claim`, {
    method: "POST",
    body: JSON.stringify({ worker: WORKER_NAME }),
  }).then(r => r.ok ? r.json() : null)

  if (!job) {
    await sleep(POLL_INTERVAL)
    continue
  }

  // 心跳 fiber
  const heartbeat = setInterval(
    () => fetch(`${PI_HOST}/api/transcode/${job.id}/heartbeat`, { method: "POST" }),
    15000
  )

  try {
    await runFfmpeg(job, (progress) =>
      fetch(`${PI_HOST}/api/transcode/${job.id}/progress`, {
        method: "POST",
        body: JSON.stringify({ progress }),
      })
    )
    await fetch(`${PI_HOST}/api/transcode/${job.id}/complete`, { method: "POST" })
  } catch (err) {
    await fetch(`${PI_HOST}/api/transcode/${job.id}/fail`, {
      method: "POST",
      body: JSON.stringify({ error: String(err) }),
    })
  } finally {
    clearInterval(heartbeat)
  }
}
```

### ffmpeg 命令（QSV）

```bash
ffmpeg -hwaccel qsv -hwaccel_output_format qsv \
  -i /data/source/<id>/<file>.mp4 \
  -vf "scale_qsv=w=1200:h=1080" \
  -c:v hevc_qsv -global_quality 23 -preset medium \
  -tag:v hvc1 \
  -an \
  /data/optimized/<id>.mp4
```

- `hevc_qsv`：Intel 硬件 H.265 编码器
- `scale_qsv`：GPU 上做缩放，避免 CPU↔GPU 来回拷贝
- `-an`：壁纸不需要音频，去掉
- `-tag:v hvc1`：让 mpv/Apple 设备识别 H.265

### Worker 不可用时的行为

转码 Worker 离线时（NAS 关机、Docker 容器没起来）：
- Job 持续在 `pending` 队列等待
- Web UI 显示警告："转码服务离线，新下载的壁纸将以原始分辨率播放"
- mpv 用源文件播放（Pi 4B 硬解 1080p H.264 流畅，4K H.265 也能解但 CPU 占用偏高）
- Worker 重新上线后自动消化积压 Job

### Worker 协议

所有端点均在 Pi 端实现：

```
POST /api/transcode/claim                    # Worker 拉取一个 pending Job
   body: { worker: string }
   resp: Job | null

POST /api/transcode/:jobId/heartbeat          # Worker 心跳（防 stuck）
   resp: { ok: true } | { ok: false, reason: "cancelled" }

POST /api/transcode/:jobId/progress           # 上报进度
   body: { progress: number }                  // 0-100

POST /api/transcode/:jobId/complete           # 上报完成
   body: { output_path: string, output_size: number, duration_ms: number }

POST /api/transcode/:jobId/fail               # 上报失败
   body: { error: string }
```

**Job 状态机**（Effect-TS 建模）：

```
pending → claimed → running → completed
                  ↘         ↘
                   failed   timeout (心跳超时回退到 pending)
```

`claimed` / `running` 状态有 60 秒心跳超时，超时由 Pi 端的 `Effect.Schedule` 周期任务扫描并回退到 `pending`。

---

## 数据模型

### `library` 表

```typescript
{
  workshop_id: string                         // PK
  title: string
  author: string
  preview_url: string
  source_path: string                          // NAS 上的源文件路径
  source_resolution: string                    // "3840x2160"
  source_codec: string                         // "h264" | "hevc" | ...
  source_size: number                          // bytes
  downloaded_at: number                        // unix ms

  transcode_status: "skipped" | "pending" | "claimed" | "running" | "completed" | "failed"
  transcode_progress: number                   // 0-100
  transcode_error: string | null
  transcoded_path: string | null
  transcoded_resolution: string | null
  transcoded_codec: string | null
  transcoded_size: number | null

  display_mode: "fill" | "fit" | "stretch"     // 默认 "fill"
  last_played_at: number | null
}
```

`playable_path` 是派生字段：`transcoded_path ?? source_path`。

### `transcode_jobs` 表

```typescript
{
  id: string                                   // ULID
  workshop_id: string                          // FK → library
  status: "pending" | "claimed" | "running" | "completed" | "failed"
  worker: string | null                        // 拉取此 Job 的 Worker 名
  claimed_at: number | null
  last_heartbeat: number | null
  progress: number                             // 0-100
  error: string | null
  created_at: number
  completed_at: number | null
}
```

---

## API 端点

### Workshop 浏览
```
GET /api/workshop/search?q=keyword&page=1
GET /api/workshop/item/:workshopId
```

### 下载
```
POST /api/download/:workshopId                # 触发下载
WS   /api/download/progress/:workshopId       # 下载进度
DELETE /api/download/:workshopId              # 取消下载
```

### 本地库
```
GET    /api/library
DELETE /api/library/:workshopId               # 删除（含源文件 + 转码产物）
PATCH  /api/library/:workshopId               # 更新 display_mode 等
```

### 播放控制
```
POST /api/player/play/:workshopId
POST /api/player/pause
POST /api/player/stop
POST /api/player/display-mode                 # body: { mode: "fill" | "fit" | "stretch" }
GET  /api/player/status
WS   /api/player/watch
```

### 转码（用户侧）
```
POST   /api/transcode/:workshopId             # 手动触发或重试
GET    /api/transcode/:workshopId             # 查询状态
DELETE /api/transcode/:workshopId             # 取消任务
GET    /api/transcode/queue                   # 队列概览
WS     /api/transcode/watch                   # 所有 Job 状态变化
```

### 转码（Worker 侧，见上文）
```
POST /api/transcode/claim
POST /api/transcode/:jobId/heartbeat
POST /api/transcode/:jobId/progress
POST /api/transcode/:jobId/complete
POST /api/transcode/:jobId/fail
```

---

## Effect 集成关键模式

### 1. ManagedRuntime + Layer

```typescript
// backend/runtime.ts
import { Layer, ManagedRuntime } from "effect"

const MainLayer = Layer.mergeAll(
  ConfigLive,
  DbLive,
  SteamCmdLive,
  MpvLive,
  TranscodeQueueLive,
  LoggerLive,
)

export const runtime = ManagedRuntime.make(MainLayer)
```

### 2. Job 生命周期 + 心跳超时

```typescript
// services/TranscodeQueue.ts (摘录)
const claim = (worker: string) =>
  Effect.gen(function* () {
    const db = yield* Db
    const job = yield* db.atomic((tx) =>
      tx.findOne({ status: "pending" })
        .pipe(Effect.tap((j) =>
          tx.update(j.id, { status: "claimed", worker, claimed_at: now() })
        ))
    )
    return job
  })

// 周期任务：扫描 stuck Job 回退到 pending
const reaper = Effect.gen(function* () {
  const db = yield* Db
  yield* db.expireStuckJobs(60_000)  // 60s 无心跳
}).pipe(
  Effect.repeat(Schedule.fixed("30 seconds")),
  Effect.forkScoped,
)
```

### 3. 下载 → 自动入队转码

```typescript
const downloadAndQueueTranscode = (workshopId: string) =>
  Effect.gen(function* () {
    const meta = yield* steamCmd.download(workshopId)
    const probe = yield* ffprobe(meta.videoPath)  // 在 Pi 上跑 ffprobe（不编码，只读元数据，CPU 极低）
    yield* library.insert({ ...meta, ...probe })

    const needsTranscode = decideTranscode(probe, screen)
    if (needsTranscode) {
      yield* transcodeQueue.enqueue(workshopId)
    } else {
      yield* library.update(workshopId, { transcode_status: "skipped" })
    }
  })
```

### 4. mpv IPC 命令队列化

```typescript
// services/Mpv.ts
// Queue + worker fiber 顺序消费 IPC 命令，避免 JSON 行响应粘包错位
const send = (cmd: unknown[]) =>
  Effect.gen(function* () {
    const q = yield* MpvCommandQueue
    return yield* q.offer(cmd)
  })

const setDisplayMode = (mode: "fill" | "fit" | "stretch") =>
  Effect.gen(function* () {
    switch (mode) {
      case "fill":
        yield* send(["set_property", "keepaspect", true])
        yield* send(["set_property", "panscan", 1.0])
        break
      case "fit":
        yield* send(["set_property", "keepaspect", true])
        yield* send(["set_property", "panscan", 0.0])
        break
      case "stretch":
        yield* send(["set_property", "keepaspect", false])
        break
    }
  })
```

### 5. WebSocket 广播 Job 状态

```typescript
// 所有 Job 状态变化推送到一个 PubSub，多个 WS 客户端订阅
const transcodeEvents = yield* PubSub.unbounded<JobEvent>()

// Job 状态更新时
yield* transcodeEvents.publish({ type: "progress", jobId, progress })

// WS 端点订阅
const subscribe = (ws: WebSocket) =>
  Effect.gen(function* () {
    const sub = yield* transcodeEvents.subscribe
    yield* sub.take.pipe(
      Effect.flatMap((evt) => Effect.sync(() => ws.send(JSON.stringify(evt)))),
      Effect.forever,
    )
  })
```

---

## mpv 启动参数

```bash
mpv \
  --input-ipc-server=/tmp/mpv.sock \
  --idle=yes \
  --loop=inf \
  --fs \
  --no-osc \
  --no-input-default-bindings \
  --no-audio \
  --hwdec=auto-safe \
  --vo=gpu \
  --gpu-context=auto \
  --keepaspect=yes \
  --panscan=1.0          # fill 默认
```

- `--idle=yes`：启动时不立即播放，等 IPC 命令推文件
- `--hwdec=auto-safe`：让 mpv 自动选最稳的硬解后端（v4l2m2m / drmprime / 软解 fallback）
- `--panscan=1.0`：默认 fill，运行时通过 IPC 修改

---

## 配置文件（config.json）

```json
{
  "steam": {
    "username": "",
    "steamcmd_path": "/usr/games/steamcmd"
  },
  "paths": {
    "nas_mount": "/mnt/nas/wallpapers",
    "source_dir": "source",
    "optimized_dir": "optimized"
  },
  "screen": {
    "width": 1200,
    "height": 1080,
    "default_display_mode": "fill"
  },
  "mpv": {
    "ipc_socket": "/tmp/mpv.sock",
    "hwdec": "auto-safe"
  },
  "transcode": {
    "target_codec": "hevc",
    "target_quality": 23,
    "heartbeat_timeout_ms": 60000
  },
  "server": {
    "host": "0.0.0.0",
    "port": 8080
  }
}
```

### Schema 校验

```typescript
// backend/schema/Config.ts
import { Schema } from "effect"

export const Config = Schema.Struct({
  steam: Schema.Struct({
    username: Schema.String,
    steamcmd_path: Schema.String,
  }),
  paths: Schema.Struct({
    nas_mount: Schema.String,
    source_dir: Schema.String,
    optimized_dir: Schema.String,
  }),
  screen: Schema.Struct({
    width: Schema.Number,
    height: Schema.Number,
    default_display_mode: Schema.Literal("fill", "fit", "stretch"),
  }),
  mpv: Schema.Struct({
    ipc_socket: Schema.String,
    hwdec: Schema.Literal("auto-safe", "v4l2m2m", "drm", "auto", "no"),
  }),
  transcode: Schema.Struct({
    target_codec: Schema.Literal("hevc", "h264"),
    target_quality: Schema.Number.pipe(Schema.between(0, 51)),
    heartbeat_timeout_ms: Schema.Number,
  }),
  server: Schema.Struct({
    host: Schema.String,
    port: Schema.Number.pipe(Schema.between(1, 65535)),
  }),
})
```

---

## Web UI

### 主界面布局

```
┌─────────────────────────────────────────┐
│  WE-Pi Player  [现在播放: ...] [⚙ 队列] │
├──────────┬──────────────────────────────┤
│          │                              │
│  导航栏  │   壁纸网格                    │
│          │                              │
│ > 浏览   │   [封面] [封面] [封面]        │
│   本地库 │   [封面] [封面] [封面]        │
│   设置   │                              │
│          │   搜索框 / 分页              │
└──────────┴──────────────────────────────┘
```

### 库卡片状态

每个壁纸卡片显示转码状态徽章：

```
✓ 已优化 1200×1080         ← 转码完成
⚙ 优化中 45%               ← 转码进行中（带进度条）
⏳ 排队中                   ← pending
⚠ 转码失败 [重试]          ← failed
○ 源已符合，未转码          ← skipped
○ 转码服务离线             ← Worker 心跳超时 + 队列堆积
```

### 全局任务面板（顶部抽屉）

```
┌─────────────────────────────────────┐
│ 转码队列  3 个任务                    │
│  ⚙ Cyberpunk City      45%  [取消]  │
│  ⏳ Mountain Rain     排队中 [取消]  │
│  ⏳ Sunset Beach     排队中 [取消]  │
│ Worker: z4s-qsv ✓ 在线 (10s ago)    │
└─────────────────────────────────────┘
```

WebSocket `/api/transcode/watch` 推送所有状态变化，前端用全局 store 保持。

### 卡片操作

- 悬停：**播放** / **下载** 按钮
- 已下载标记
- 点击查看详情（描述、预览图、display_mode 切换）
- 下载中显示实时进度（WebSocket）
- 转码中实时进度

---

## 安装流程

### 1. Pi 端

```bash
# Clone
git clone https://github.com/yourname/we-pi-player
cd we-pi-player

# 安装 Bun + 依赖
bash install-pi.sh

# 配置 NAS 挂载（fstab 示例）
sudo mkdir -p /mnt/nas/wallpapers
echo "//<nas-ip>/wallpapers /mnt/nas/wallpapers cifs credentials=/etc/cifs-creds,uid=$(id -u),gid=$(id -g),iocharset=utf8 0 0" | sudo tee -a /etc/fstab
sudo mount -a

# SteamCMD 首次登录（处理 Steam Guard 2FA）
steamcmd +login <username>

# 配置
cp config.example.json config.json
nano config.json

# 启动 user 服务
systemctl --user enable --now we-pi-player

# Web UI
# http://<pi-ip>:8080
```

### 2. NAS Worker 部署

通过极空间 Docker UI 或 SSH：

```bash
# SSH 进 NAS
cd /vol/.../we-pi-transcoder
docker compose up -d
```

需要在 docker-compose.yml 里把 `PI_HOST` 指向 Pi 的 IP，把 `/dev/dri` 挂载到容器内并加上正确的 `group_add` GID（通过 `ls -ln /dev/dri` 查得）。

### 3. systemd user 服务

```ini
# ~/.config/systemd/user/we-pi-player.service
[Unit]
Description=WE-Pi Player
After=graphical-session.target
PartOf=graphical-session.target
RequiresMountsFor=/mnt/nas/wallpapers

[Service]
Type=simple
WorkingDirectory=%h/we-pi-player
ExecStart=%h/.bun/bin/bun run backend/index.ts
Restart=on-failure
RestartSec=3

[Install]
WantedBy=graphical-session.target
```

`RequiresMountsFor` 保证 NAS 挂载就绪后再启动，避免冷启动时找不到文件。

---

## 开发阶段划分

### Phase 1 — Effect 骨架 + 核心可用（MVP）
- [ ] Bun + Elysia + Effect runtime 基础搭建
- [ ] Config Service + Schema 校验
- [ ] Db Service（bun:sqlite + library/jobs 表）
- [ ] SteamWorkshop Service（API + Schema 校验）
- [ ] SteamCmd Service（acquireRelease + stdout 解析，落盘到 NAS）
- [ ] Mpv Service（Unix socket + 命令队列 + display_mode 切换）
- [ ] 最简 Web UI（列表 + 播放）
- [ ] **不带转码**：直接播 source 文件，验证 1080p / 4K 在 Pi 上的实际表现

### Phase 2 — 转码 Worker
- [ ] TranscodeQueue Service（Job 状态机 + 心跳超时回退）
- [ ] Worker pull 协议端点
- [ ] NAS Worker 镜像（Bun + ffmpeg + QSV）
- [ ] Docker compose 部署文档
- [ ] Pi 端 ffprobe 集成（决定是否需要转码）
- [ ] Web UI 转码状态展示
- [ ] WebSocket 状态广播

### Phase 3 — 完整体验
- [ ] 封面图、搜索分页
- [ ] 下载进度 WebSocket（Effect Stream + Stream.share）
- [ ] 本地库管理（删除、排序、筛选）
- [ ] 播放队列 / 随机播放
- [ ] Web UI 美化 + 移动端响应式

### Phase 4 — 增强
- [ ] 定时切换壁纸（`Effect.Schedule`）
- [ ] 开机恢复上次播放
- [ ] 转码失败重试策略 + 异常告警
- [ ] 多 Worker 支持（同协议下扩展第二个节点）

### Phase 5 — 本机 TUI（Ink）
- [ ] Ink 控制面板，复用 Service 层
- [ ] 封面图通过 Kitty graphics protocol 显示
- [ ] mpv 全屏播放，TUI 仅做控制

---

## 前提条件 & 已知限制

| 条件 | 状态 |
|------|------|
| Steam 账号需持有 WE | 必须 |
| 仅支持 Video 类型壁纸 | Scene 类无法在 Pi 渲染 |
| Pi 64 位系统 | ✅ Trixie aarch64 |
| 桌面环境 | ✅ 已就绪 |
| 屏幕 1200×1080 | ✅ 已正常工作 |
| NAS SMB 挂载 | 必须（源/转码产物的统一存储） |
| NAS 核显 + Docker | 必须（QSV 转码） |
| Pi 4B H.264/H.265 硬解 | mpv 自动选 v4l2m2m / drmprime |

**Worker 离线降级**：NAS Docker 容器停止或 NAS 关机时，转码队列堆积但不影响下载和播放（mpv 用 source 文件）。

---

## 参考资源

- Bun: https://bun.sh
- Elysia: https://elysiajs.com
- Effect-TS: https://effect.website
- Effect Schema: https://effect.website/docs/schema/introduction/
- Steam Web API: https://partner.steamgames.com/doc/webapi
- Workshop QueryFiles: `IPublishedFileService/QueryFiles/v1`
- SteamCMD: https://developer.valvesoftware.com/wiki/SteamCMD
- mpv JSON IPC: https://mpv.io/manual/master/#json-ipc
- Intel QSV in ffmpeg: https://trac.ffmpeg.org/wiki/Hardware/QuickSync
- WE AppID: `431960`
