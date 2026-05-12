# Plan — Downloads 页结构化进度

补写的回顾性 plan。代码已实施（2026-05-12），此文档记录设计意图与决策，
便于后续维护或回滚时还原推理过程。

## Building

Downloads 页信息密度提升。把原本直接渲染的 SteamCMD raw stdout（如
`Update state (0x61) downloading, progress: 12.34 (1234567 / 10000000)`）替换为
结构化进度：百分比 + 已下 / 总字节 + 进度条 + 已用时（`01:23` 格式，超过 1h 升 `H:MM:SS`）。

## Not Building

- 不做 ETA 估算（SteamCMD 速率波动大，估算只会误导用户）。
- 不做桌面通知 / 重试按钮。
- 不持久化 task 到 DB（重启后 SteamCMD 进程已死，本就无可恢复，内存 Map + TTL 足够）。

## Approach

SteamCmd.ts 的 stdout reader 用 regex `progress:\s*([\d.]+)\s*\(\s*(\d+)\s*\/\s*(\d+)\s*\)` 把
SteamCMD 的下载进度行拆成 `percent / bytes_done / bytes_total` 三个数字字段，
沿 DownloadProgress → DownloadTasks 内存 store → `GET /api/download/tasks` → SWR
1s polling → React row 一路传到 UI。

UI 自绘进度条：determinate 状态用 `<div style={{ width: '${pct}%' }}>`；
拿不到数字时（auth / metadata / validation 阶段 SteamCMD 不输出 progress 行）
用 CSS keyframe slide 动画做 indeterminate 滑动条。

Elapsed clock 用独立 `setInterval(1s)` tick 驱动 React 重渲染，跟 SWR 的
`refreshInterval` 解耦，让计时器丝滑跳秒，不被 fetch 节奏卡顿。

## Key Decisions

1. **数字 vs 工程日志**。原 message 是 SteamCMD raw stdout，stage chip 已经
   表达 "Downloading"，两者冗余；普通用户也读不懂 `Update state (0x61)`。换成
   `"12.3 MB / 100 MB"` 这种用户语言，仅 error stage 才显示真错误文本。
2. **regex miss 的 fallback**。auth / metadata / validation 阶段 SteamCMD 不出
   progress 行，UI 切 indeterminate 滑动动画；message 写
   `"Connecting…"` / `"Validating files…"`。
3. **时间格式 `01:23`**。zero-pad mm:ss；超过 1h 升 `H:MM:SS`。下载几乎触不到
   1h，但保底逻辑写了。
4. **elapsed 独立 tick**。不靠 SWR `refreshInterval` 推动数字渲染，避免每秒"卡一下"。
5. **tabular-nums**。CSS `font-variant-numeric: tabular-nums` 让百分比 / 字节 /
   时间数字等宽，刷新时不抖动。

## Files Changed

后端
- `packages/backend/src/services/SteamCmd.ts` — `PROGRESS_RE`、`parseProgress()`、
  `formatBytes()`；downloading 分支拿到数字才填三字段，否则只发 `"Connecting…"`；
  finalizing 改 `"Validating files…"`。
- `packages/backend/src/services/DownloadTasks.ts` — DownloadTask 加
  `percent / bytes_done / bytes_total: number | null`。
- `packages/backend/src/routes/download.ts` — progress 回调 mirror 新字段到 task。

前端
- `packages/frontend/src/api.ts` — DownloadTask 类型扩字段。
- `packages/frontend/src/pages/Downloads.tsx` — 重写 row：stage chip / percent /
  bytes / elapsed / 进度条；独立 1s tick；error 才显示 message。
- `packages/frontend/src/styles.css` — `.dl-bar` / `.dl-bar-fill` /
  `.dl-bar-indeterminate` 样式 + tabular-nums；删 dead `.dl-time` 重复块。

## Verification

- `bun x tsc --noEmit`（backend + frontend）通过。
- `curl /api/download/tasks` 字段结构通过 TS 校验。
- 端到端：点 Download 后 Active 行显示进度条 + 百分比 + 字节 + `mm:ss` 计时。

## Open Risks

- Pi 上 box86 跑的 SteamCMD stdout 是否完全匹配 `PROGRESS_RE`。Linux Steam
  的该 pattern 多年稳定，box86 仅是 ARM 上跑同一 x86 binary，stdout 应该一致；
  但未在 Pi 实机端到端验过。fallback：拿不到数字就走 indeterminate，UI 不崩。
- 进度条 CSS 动画在 labwc 下的浏览器流畅度未验。

## Rollback

DownloadProgress / DownloadTask 的三个新字段均为 optional/nullable，向后兼容；
单 commit `git revert` 即可，无 schema migration。
