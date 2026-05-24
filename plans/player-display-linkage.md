# Plan — MPV 播放与显示器开关联动优化

> 状态（2026-05-24）：未实现。当前代码已有手动显示器电源 API/UI
> (`/api/display/on|off|status` + `DisplayPowerToggle`)，但 mpv 播放/暂停/停止
> 与显示器开关仍未自动联动，`DisplayConfig` 也还没有
> `auto_off_after_idle_seconds` 字段。

## 当前状态

MPV 播放器与显示器电源控制是**完全独立**的两个系统：

- **MPV**：`play()` / `pause()` / `resume()` / `stop()` / `setDisplayMode()`
- **Display**：`on()` / `off()` / `status()`，通过外部命令控制显示器电源
- **联动关系**：**零**。播放时不自动开显示器，停止后不自动关显示器。

## 交互痛点

### 痛点 1：播放时显示器可能是关的（最大痛点）

用户流程：
1. 用户之前关掉了显示器
2. 用户在 Library/Browse 点击播放某壁纸
3. MPV 开始播放，但显示器是黑的
4. 用户看不到任何画面，以为没播放成功
5. 用户需要手动去点 PlayerBar 上的 DisplayPowerToggle 才能看到画面

**期望**：点击播放 → 画面直接出现，不需要额外操作。

### 痛点 2：停止播放后显示器一直亮着

用户流程：
1. 用户停止播放（或播放列表结束）
2. MPV 进入 idle（黑屏）
3. 显示器继续亮着， wasting power
4. 没有自动节能机制

**期望**：停止播放一段时间后，显示器自动关闭。

### 痛点 3：前端状态没有语义关联

PlayerBar 上有两个独立的状态指示器：
- 播放器状态：playing / paused / idle
- 显示器状态：on / off / unknown

它们之间没有任何关联提示，用户可能困惑：
- "我开了显示器，为什么没画面？" → 播放器 idle
- "我在播放，为什么黑屏？" → 显示器关了

## 目标设计

核心原则：**显示器状态跟随播放器状态，但保留用户手动控制的兜底能力。**

### 联动规则

| 触发事件 | 联动行为 | 理由 |
|---------|---------|------|
| 开始播放 | 自动开显示器 | 用户点了播放就是想看画面 |
| 暂停播放 | 启动自动关显示器定时器（可配置延时，默认 5 分钟） | 暂停 = 暂时不看，节能 |
| 恢复播放 | 取消定时器，自动开显示器 | 用户恢复观看 |
| 停止播放 | 启动自动关显示器定时器（可配置延时，默认 5 分钟） | 停止 = 不看了，节能 |
| 用户手动关显示器 | **自动暂停播放** | 避免后台持续解码浪费资源；OLED 防烧屏同时省 CPU/GPU |
| 用户手动开显示器 | **自动恢复播放** | 用户开屏就是想继续看，直接续上 |

### 配置扩展

`config.json` 中 `display` 段新增可选字段：

```json
{
  "display": {
    "on_command": ["..."],
    "off_command": ["..."],
    "status_command": ["..."],
    "auto_off_after_idle_seconds": 300
  }
}
```

- `auto_off_after_idle_seconds`: 暂停/停止后自动关显示器的延时，单位秒。
  - `0` 或省略 = 不自动关闭
  - 默认值建议 `300`（5 分钟）

## 实现方案

### 方案选择：路由层组合（最小侵入）

不在 Mpv 或 Display service 内部引入循环依赖，而是在**路由层**组合调用。这是当前项目 HTTP 路由保持普通 handler、Effect-TS 只做业务逻辑层的一贯风格。

#### 1. 播放时自动开显示器

`packages/backend/src/routes/player.ts` 的 `/play/:workshopId`：

```ts
// 在 mpv.play() 之前自动开显示器
yield* display.on().pipe(
  Effect.catchAll((e) => logger.warn(`Auto display on failed: ${e.message}`))
)
yield* mpv.play(item.workshop_id, path)
```

- `display.on()` 失败不阻断播放（catchAll + warn）
- 因为 display 配置是可选的，未配置时 `display.on()` 会返回 `DisplayError({ kind: "NotConfigured" })`，静默忽略即可

#### 2. 暂停/停止后自动关显示器

在 `Mpv` service 内部增加定时器机制：

```ts
// Mpv.ts 内部
const autoOffDelayMs = (config.display?.auto_off_after_idle_seconds ?? 0) * 1000
const autoOffTimerRef = yield* Ref.make<ReturnType<typeof setTimeout> | null>(null)

const cancelAutoOff = () =>
  Effect.sync(() => {
    const timer = Effect.runSync(Ref.get(autoOffTimerRef))
    if (timer) clearTimeout(timer)
    Effect.runSync(Ref.set(autoOffTimerRef, null))
  })

const scheduleAutoOff = () =>
  Effect.gen(function* () {
    yield* cancelAutoOff()
    if (autoOffDelayMs <= 0) return
    const timer = setTimeout(() => {
      Effect.runPromise(
        display.off().pipe(Effect.catchAll(() => Effect.void))
      )
    }, autoOffDelayMs)
    yield* Ref.set(autoOffTimerRef, timer)
  })
```

在 `pause()` 和 `stop()` 中调用 `scheduleAutoOff()`，在 `play()` 和 `resume()` 中调用 `cancelAutoOff()`。

**注意**：这需要在 `Mpv` service 中注入 `Display` 依赖。当前 `runtime.ts` 中 `DisplayLive` 在 `MpvLive` 之前装配，满足依赖顺序。

#### 3. 关显示器时自动暂停播放

`packages/backend/src/routes/display.ts` 的 `/off`：

```ts
.post("/off", ({ set }) =>
  runtime.runPromise(
    Effect.gen(function* () {
      const display = yield* Display
      const mpv = yield* Mpv
      yield* mpv.pause()
      yield* display.off()
      return { ok: true, state: "off" }
    })
  )
)
```

**理由**：显示器关闭后，后台继续解码播放浪费 CPU/GPU/IO 资源，且对 OLED 烧屏防护没有额外帮助（像素已经断电）。暂停保留当前文件和位置，开屏后直接续上。

#### 4. 开显示器时自动恢复播放

`packages/backend/src/routes/display.ts` 的 `/on`：

```ts
.post("/on", ({ set }) =>
  runtime.runPromise(
    Effect.gen(function* () {
      const display = yield* Display
      const mpv = yield* Mpv
      const status = yield* mpv.status()
      yield* display.on()
      if (!status.playing && status.current_workshop_id) {
        yield* mpv.resume()
      }
      return { ok: true, state: "on" }
    })
  )
)
```

**理由**：用户手动开显示器就是想继续看画面。如果之前是因为关显示器而 pause 的，自动 resume；如果本来就是 playing，则无影响。

### 前端状态展示优化

PlayerBar 中根据播放状态和显示器状态给出联动提示：

| 播放器状态 | 显示器状态 | 提示 |
|-----------|-----------|------|
| playing | off | ⚠️ 显示器已关闭，画面不可见 |
| idle | on | ℹ️ 无内容播放，选择壁纸开始 |
| paused | on | （正常，无需提示） |

这些提示可以放在 PlayerBar 的一个小型状态条中，只在异常组合时显示。

## 改动清单

### Backend

1. **`packages/shared/src/schema/Config.ts`**
   - `DisplayConfig` 新增可选字段 `auto_off_after_idle_seconds: Schema.optional(Schema.Number)`

2. **`packages/backend/src/services/Mpv.ts`**
   - 注入 `Display` 依赖
   - 新增 `autoOffTimerRef` 和 `cancelAutoOff` / `scheduleAutoOff` 函数
   - `play()` 中：先 `display.on()`，再 `cancelAutoOff()`
   - `pause()` 中：调用 `scheduleAutoOff()`
   - `resume()` 中：调用 `cancelAutoOff()`，再 `display.on()`
   - `stop()` 中：调用 `scheduleAutoOff()`

3. **`packages/backend/src/routes/player.ts`**
   - `/play/:workshopId` 中注入 `Display`，播放前自动 `display.on()`

4. **`packages/backend/src/routes/display.ts`**
   - `/on` 中注入 `Mpv`，如果播放器 paused 且有当前文件，自动 `resume()`
   - `/off` 中注入 `Mpv`，先 `mpv.pause()` 再 `display.off()`

5. **`packages/backend/src/runtime.ts`**
   - 确认 `DisplayLive` 在 `MpvLive` 之前装配（当前已满足）

### Frontend

6. **`packages/frontend/src/components/PlayerBar.tsx`**
   - 增加播放器-显示器状态联动提示（只在异常组合时显示）

7. **`config.example.json`**
   - `display` 段增加 `auto_off_after_idle_seconds: 300`

## 非目标（不改）

- 不改 Display service 的核心逻辑（on/off/status）
- 不改 DisplayPowerToggle 组件的独立控制能力
- 不引入复杂的 Orchestrator service
- 定时器不持久化（后端重启后定时器丢失，可接受）

## OLED 烧屏防护的长期建议

用户手动关显示器防烧屏是有效的 workaround，但长期应该考虑自动化方案：

| 方案 | 实现难度 | 效果 |
|------|---------|------|
| **定时切换壁纸** | 低 | 已具备 `last_played_at` 和 Library 列表，可定时随机切换 |
| **播放 N 分钟后自动息屏 M 分钟** | 中 | 在 Mpv 定时器基础上扩展：播放 30min → auto off 5min → auto on → resume |
| **像素偏移（pixel shift）** | 高 | 需 Wayland 合成器支持或 mpv 插件，Pi 上可能不稳定 |

最务实的路径是"定时切换壁纸"，利用已有的 `mpv.play()` 和 Library 列表，避免任何单张壁纸长时间停留。

## 风险与回滚

**风险**：
- `Mpv` 注入 `Display` 后，如果 `Display` 未配置（返回 NotConfigured），所有自动联动静默跳过，不影响播放
- 定时器用 `setTimeout`，在 Effect 里不够地道，但 pragmatic

**回滚**：
- 删除 Mpv.ts 中的 Display 依赖和定时器逻辑
- 恢复 player.ts 路由为独立调用
- 无数据迁移

## 验证方式

1. `bun test` — 全部通过
2. `bun x tsc --noEmit`（backend + frontend）— 无错误
3. 手动验收：
   - 播放壁纸时显示器自动开启
   - 停止播放 5 分钟后显示器自动关闭
   - 手动关显示器时播放自动暂停
   - 手动开显示器时播放自动恢复
   - Display 未配置时，播放不受影响
