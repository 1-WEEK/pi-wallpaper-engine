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

当前无 P1 项。

## P2 体验 / 质量优化

### BL-15 SteamWorkshop search 测试回填(验收无关迭代 Phase 2)📋
`packages/backend/src/services/SteamWorkshop.test.ts`:mock `fetch` + 内存 Config,驱动 `search()`,
断言 requiredtags 含 Video 且去重、search_text trim、nextCursor 自指抑制、缓存命中不重复 fetch。
对照 AGENTS.md 不变量,不 enshrine bug。

### BL-16 后续测试回填 + 卫生(验收无关迭代 后续候选)📋
更多后端路由/服务测试(library/player/display/storage/system 路由,SleepTimer/DownloadTasks/
PlayerWatch/Migrate 服务);删 4 个已完全合并的陈旧本地分支。可选:前端组件测试骨架(引入新
devDep,较重)。见 `acceptance-free-iteration.md`。

## 🔒 Blocked(需硬件或真机,不在家取不了)

### BL-10 storage 真机迁移验证 🔒
自定义目录双向迁移代码完成,需真 Pi 加可移动存储验收一次。

### BL-11 Phase 2 worker NAS 端到端 🔒
worker 代码完成,需 NAS 加 Intel iGPU 部署跑一次真实转码,验证心跳 / 进度 / 重试 / QSV 探测。

### BL-12 轮播 / 睡眠真机冒烟 🔒
回家 5 分钟:随机播放换壁纸、sequential 短间隔看自动切加黑屏、睡眠到点关屏、挂半天看 mpv 句柄 / 内存泄漏。

## 已完成

- ✅ BL-14 前端纯逻辑测试回填(验收无关迭代 Phase 1),2026-06-12
  - `packages/frontend/src/api.test.ts`:stub `globalThis.fetch`,断言 `api.workshopSearch` 拼的
    query string —— cursor 缺省 `*`、pageSize/tags/sort 缺省时不带、tags CSV 拼接、非 ok 响应以
    `body.error` 抛错。4 cases,全 hermetic(不碰 window)。full suite 149→153 pass。
- ✅ BL-13 CI 立门(验收无关迭代 Phase 0),2026-06-12
  - `.github/workflows/ci.yml`:`push→main` + `pull_request` 上跑 `bun install --frozen-lockfile`
    → `bun test` → `bun run typecheck` → `bun run build`。把机器门变成可信异步信号。
  - 报告先行,未设 required check(跑绿两次前不阻塞合并)。
  - 本地预验:四条命令全绿,frozen-lockfile no changes,test 149 pass,build OK。
  - 激活需 push 分支 / 开 PR 后 Actions 才触发;runner 为 x86 ubuntu,硬件项(BL-10/11/12)本就跑不了。
- ✅ BL-6 移动端 MobileMiniPlayer 控件密度(方案 B:缩间距),2026-06-10
  - `styles.css`:`.mobile-mini-player` gap 10→6px、padding 12→10px(横向),`.mobile-mini-player-btn` 38→34px。保留全部 5 控件(含 stop)。
  - 选方案 B 而非方案 A(删 stop):删功能是产品决策,handoff 明确「不要替用户删 stop」,未获用户授权前不删。方案 B 纯 CSS、无功能损失、可逆。
  - 375px Playwright mock 验证(见 memory `pwe-visual-review-workflow`):overflowX=0,5 控件无溢出,末控件右缘 365px(= 375 − 10 padding),间距宽松。
  - 用户若仍想要方案 A(移动端去 stop)是一行 follow-up。
- ✅ BL-2 route 错误处理收敛(`httpFromError` + `runRoute` helper),2026-06-10
  - Phase 1(`c20e72e`):`httpError.ts` 纯函数 + 8 单测,kind-aware 映射。
  - Phase 2(`37a9341` player / `c08ed03` library / `6f5a7c3` display):`runRoute` closure 逐 route 把 catchTag/catchAll→set.status 样板替换成 httpFromError。各 route 独立 commit,逐一 typecheck + 全量 test 绿,status 逐条对照审计表不变。
  - 决策落地:`/resume` 由 error 返 200(latent bug)修成 500;error body message 统一(mpv 加 `mpv:` 前缀、LibraryNotFound→`Wallpaper <id> not found`),status 不变,前端以 status 为主。
  - 基础设施:`runtime.ts` 加 `AppContext`(从 ManagedRuntime 推断),供 runRoute pin effect 的 R 通道(handoff 原版 `<R>` 自由泛型过不了 typecheck)。
  - **有意不转的 route(转了会改 status 契约或破坏 client,违背「status 不变」)**:
    - `workshop.ts`:现有 `e.status>0 ? e.status : 502` 透传上游 HTTP 码,httpFromError 拍平成 502 会丢透传 → 上游 404/403 会变 502。
    - `storage.ts`:bespoke `mapError`/`mapDirectoryError`(Mount→502、Validation→502/400、Space→400、default→400)与 httpFromError(Mount→503、Validation→400、Space→507、default→500)不一致,且 body 带 `ok`/`kind`,前端 StoragePanel 用到。
    - `download.ts`:主 POST 是 202 + forked workflow + inline 503/409/404,无标准样板;WorkshopApi 在 workflow 内吞成 fallback,不走 HTTP。
    - `transcode.ts`:error 通道含裸 `Error`(mapError),破 `E extends {_tag}` 约束;body `{ok:false}` 给 worker client。
    - `system.ts`:`storage.status()` 残留 StorageError 经 httpFromError 会把现有 500 变 503。
  - 若日后想收敛上述 route,需先和人确认接受对应 status/body 契约变化(`httpFromError` 改回、或 runRoute 放宽约束)。
- ✅ BL-8 bundle vendor 拆分(vite manualChunks,app chunk 539KB→75KB + vendor 465KB,无 Suspense flash),2026-06-08
- ✅ BL-9 前端首批纯逻辑测试(提取 `format.ts` + 5 个 bun test,frontend tsconfig 加 bun types),2026-06-08
- ✅ BL-7 PlaybackPrefs 内存缓存(PlayerWatch 1Hz tick 读 Ref 不读 DB),2026-06-08
- ✅ BL-5 睡眠倒计时实时化(Settings 本地 1s 刷新,mm:ss 格式),2026-06-08
- ✅ BL-3 轮播间隔 UI(`Rotation.setInterval` + `POST /api/player/interval` + Settings preset,summary/WS 暴露 `rotation_interval_sec`),2026-06-08
- ✅ BL-4 清理未引用的 shared `PlaybackPrefs` schema struct,留 `PlayMode`,2026-06-08
- ✅ BL-1 轮播尊重 safe shelf(`Rotation` 序列排除 adult + Library safe 锚点 + 回归测试),2026-06-08
- ✅ 播放轮播(顺序 / 随机 / 单张,上下一张,间隔定时器),2026-06-08,`fddd01a` → `1e5b501`,见 `playback-rotation-iteration.md`
- ✅ 睡眠定时器(N 分钟 stop 加关屏),2026-06-08,`4a2a0c5`
- ✅ 测试欠债清理(display / library / wallpaper service 测试,Rotation 集成测试),`36ffa10`、`c987bdd`
- ✅ 文档失真校正(过时 status 快照、Phase 2 worker placeholder),`39acc19`、`46e42b1`
