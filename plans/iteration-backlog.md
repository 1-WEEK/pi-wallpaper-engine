# 迭代 Backlog

Updated: 2026-06-08。

项目的细粒度任务池。和 `roadmap.md` 分工:roadmap 管产品大阶段(Phase 1 / Phase 2),这里管独立可迭代的技术债、小功能、bug。每一项都独立可合并、互不阻塞,有空取一项做。

## 工作流

每项固定 5 步,第 4 步是这份文档不腐化的关键:

1. 取一项。P0 优先,同级按当时价值。Blocked 区的项不在家或没硬件就别取。
2. 范围大或需要选型,先 `/think` 确认;小项直接做。
3. 实施,`/check`,git-agent 提交(本仓库不加任何 co-author)。
4. **同一个 commit 里把该项状态改成 ✅ 并移入「已完成」区**。维护和代码一起进 git,不能跳过。这条不守,这份文档三个月后就变成下一个过时的 status doc。
5. 过程中发现新债,立即入池,带 P 级、一句话价值、涉及文件。

状态标记:📋 待办,🔨 进行中,✅ 完成,🔒 Blocked(需硬件或真机)。

## P0 正确性(bug,优先于一切优化)

当前无 P0 项。

## P1 工程债 / 功能补全

### BL-2 route 错误处理收敛 📋
全 backend 约 28 个 handler 重复 `runtime.runPromise(Effect.gen(...).pipe(catchTag 映射 status)).catch(500)`。player.ts 因轮播暴增到 18 个 set.status。提取 `httpFromError(err)` 纯函数集中 12 个 TaggedError 的 status 映射,加 `runRoute` helper。分两阶段:先纯函数加单测(零风险),再逐 route 替换,player.ts 先。第一步先 grep 审计现有各 route 的实际 status 作为映射基准,不一致处列出来给人拍板,不擅自统一。
- 文件:新建 `packages/backend/src/routes/httpError.ts`,各 `routes/*.ts`
- 独立:✓(纯重构,行为不变)
- 审计(2026-06-08):error → status 是 kind-driven,各 route 自洽但不能简单按 `_tag` 统一(`StorageError` 在 player=503,storage route 按 kind 细分)。`httpFromError` 须按 `_tag + kind` 精确复刻,Phase 2 逐 route 对照 status 不变。fiddly 大重构,放 P1 最后在干净 context 做。

### BL-3 轮播间隔 UI 📋
`rotation_interval_sec` 后端有(`PlaybackPrefs.setInterval`,默认 600),但没有路由暴露、前端也没调节入口,用户卡在 10 分钟。加 `POST /api/player/interval` 加 Settings 或 PlayerBar 的 preset 调节(1m / 5m / 10m / 30m)。
- 文件:`packages/backend/src/routes/player.ts`、`packages/frontend/src/api.ts`、`packages/frontend/src/pages/Settings.tsx`
- 独立:✓

## P2 体验 / 质量优化

### BL-5 睡眠倒计时实时化 📋
Settings 的「off in ~Xm」基于 5s summary 刷新,不是实时。加前端本地 setInterval 每秒算 `deadline - now`。
- 文件:`packages/frontend/src/pages/Settings.tsx`
- 独立:✓

### BL-6 移动端 MobileMiniPlayer 控件密度 📋
375px 下 DisplayToggle 加 stop / prev / play / next 共 5 控件偏挤。考虑移动端省掉 stop(轮播场景不常用)或缩按钮间距。视觉验证过没溢出,纯打磨。
- 文件:`packages/frontend/src/components/mobile/MobileMiniPlayer.tsx`、`styles.css`
- 独立:✓

### BL-7 PlayerWatch 每秒读 prefs 微优化 📋
`PlayerWatch` 的 1Hz tick 每秒多读一次 `playback_prefs`。play_mode 只在 setMode 时变,可让 `PlaybackPrefs` 持内存态、PlayerWatch 读内存。低 ROI,有空再说。
- 文件:`packages/backend/src/services/PlayerWatch.ts`、`PlaybackPrefs.ts`
- 独立:✓

### BL-8 前端 bundle code splitting 📋
`index-*.js` 约 539KB 单 chunk(build warning)。按路由 dynamic import 拆。Pi LAN 加载,优先级低。
- 文件:`packages/frontend/src/App.tsx`、`vite.config.ts`
- 独立:✓

### BL-9 前端纯逻辑测试 📋
前端 0 自动化测试。不引 React testing infra,只测纯逻辑:`api.ts` 的 error 处理、`workshopTags`、`isAdultContent` 边界,用 bun test。
- 文件:`packages/frontend/src/*.test.ts`(新)
- 独立:✓

## 🔒 Blocked(需硬件或真机,不在家取不了)

### BL-10 storage 真机迁移验证 🔒
自定义目录双向迁移代码完成,需真 Pi 加可移动存储验收一次。

### BL-11 Phase 2 worker NAS 端到端 🔒
worker 代码完成,需 NAS 加 Intel iGPU 部署跑一次真实转码,验证心跳 / 进度 / 重试 / QSV 探测。

### BL-12 轮播 / 睡眠真机冒烟 🔒
回家 5 分钟:随机播放换壁纸、sequential 短间隔看自动切加黑屏、睡眠到点关屏、挂半天看 mpv 句柄 / 内存泄漏。

## 已完成

- ✅ BL-4 清理未引用的 shared `PlaybackPrefs` schema struct,留 `PlayMode`,2026-06-08
- ✅ BL-1 轮播尊重 safe shelf(`Rotation` 序列排除 adult + Library safe 锚点 + 回归测试),2026-06-08
- ✅ 播放轮播(顺序 / 随机 / 单张,上下一张,间隔定时器),2026-06-08,`fddd01a` → `1e5b501`,见 `playback-rotation-iteration.md`
- ✅ 睡眠定时器(N 分钟 stop 加关屏),2026-06-08,`4a2a0c5`
- ✅ 测试欠债清理(display / library / wallpaper service 测试,Rotation 集成测试),`36ffa10`、`c987bdd`
- ✅ 文档失真校正(过时 status 快照、Phase 2 worker placeholder),`39acc19`、`46e42b1`
