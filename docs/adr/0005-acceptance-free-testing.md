# 验收无关迭代(Acceptance-Free Iteration)

Created: 2026-06-12。

## 问题

`iteration-backlog.md` 的 P0/P1/P2 已清空,只剩 `🔒 Blocked` 三项(BL-10 storage 真机、
BL-11 NAS 转码、BL-12 轮播冒烟)——全部要人在家、对着硬件才能验。也就是说:**当前能继续推进的
工作,全卡在"需要我验收"上。** 本文定义一类不卡这个瓶颈的工作,并把它落成可执行的分阶段计划。

## 判据

这个项目的"验收"实际上有三种,要躲开的是后两种:

1. **机器门(machine gate)** — `bun test` 绿 / `bun x tsc --noEmit` 干净 / `bun run build` 成功。
2. **硬件在场** — 需要真 Pi / 真 NAS(BL-10/11/12)。
3. **人的判断** — 产品/审美决策(如移动端要不要删 stop 按钮,BL-6 的方案 A vs B)。

> **一项工作"不依赖验收",当且仅当它的完成判据是机器门,而不是一次硬件观察或一次人的决策。**

2026-06-12 实测三门全绿:`bun test` 149 pass / 0 fail / 4.2s,typecheck 5 个 workspace 干净,
build 成功(app 75KB + vendor 465KB)。证明判据成立,且这三条命令不需要 Pi 硬件即可跑。

## 承重前提(premise collapse)

这个计划假设"机器门变绿 = 验收通过"。**它只在『规格已定的正确性类工作』上成立。** 一旦某项任务夹带
契约变更或 UX 决策,绿只证明"新行为自洽",不证明"这是你想要的"。所以承重纪律是 IN/OUT 边界(见下)。

更要命的一点:**仓库当前没有 CI**(`.github/workflows` 不存在)。"测试绿"现在只靠本地 pre-commit
hook 保证。在你不在家时由 agent 做完一项、说"绿了",这个绿只值 agent 一句话——你最后还是得自己
拉下来重跑才敢信,"不依赖验收"就是假的。**因此 Phase 0(CI)是承重第一步,不是可选项。** CI 在
GitHub x86 runner 上能验的,恰好是机器门那一坨;硬件相关的 BL-10/11/12 它本来就跑不了——
**CI 能验的边界,和"不需要你验收"的边界天然重合。**

## IN / OUT 边界

**IN(验收无关,本计划范围):**
- 测试回填:为现有行为补测试,完成即绿。
- 行为保持的重构 + 测试证明不变量(不碰下面 OUT 的契约路由)。
- 构建/类型卫生:死代码清理、陈旧分支清理,`tsc` + `build` 验证。
- CI:把机器门自动化。

**OUT(仍需你,本计划明确不做):**
- BL-2 故意缓转的 5 个路由的 **status/body 契约变更**(workshop / storage / download / transcode /
  system)——`iteration-backlog.md` 已写明需你签字。
- **BL-10 / BL-11 / BL-12** — 硬件在场。
- 任何视觉变更 / 新 UX 流 / 产品取舍。Playwright-mock(见 memory `pwe-visual-review-workflow`)
  能截图查"无视觉变更的重构有没有回归",但**不能替你判断"好不好看"**——它是次级门,不是验收。

## 分阶段实施

每个阶段独立可合并:某阶段 ship 后系统处于可用状态,即使后续阶段永不落地也不破坏任何东西。
每阶段固定:实施 → 跑机器门 + `/check` 多轮检修 → 原子提交(代码 + `iteration-backlog.md` 状态翻转,
遵循仓库 step-4 反腐化纪律)→ 文档同步。

### Phase 0 — CI 立门(keystone)
- 新增 `.github/workflows/ci.yml`:`on: [push, pull_request]` → `oven-sh/setup-bun` →
  `bun install --frozen-lockfile` → `bun test` → `bun run typecheck` → `bun run build`。
- runner `ubuntu-latest`(x86)。typecheck 各 workspace 约 8–44s,总体在 Actions 免费额度内。
- **报告先行,不设 required check**:跑绿两次前不阻塞合并,避免给单人仓库添堵。设为 required 的
  时机交给用户。
- 验证:三门本地已绿(见上);CI 第一次跑 = 远端复现这三条命令,自证 hermetic。

### Phase 1 — 前端纯逻辑测试回填
- `packages/frontend/src/api.test.ts`:mock `globalThis.fetch`,驱动 `api.workshopSearch`,断言
  拼出的 query string —— cursor 缺省为 `*`、`pageSize` 缺省时不带、`tags` CSV 拼接、`sort` 透传。
  照 `format.test.ts` 模式(bun test)。
- 范围小但真实:`format.ts` 已覆盖,`auth.ts`(fetch 包装)/`workshopTags.ts`(常量数组)非好目标,
  不强测。

### Phase 2 — 后端逻辑测试回填
- `packages/backend/src/services/SteamWorkshop.test.ts`:mock `fetch` + 内存 `Config` Layer,
  驱动 `search()`,断言:(a) `requiredtags` 永远含 `Video` 且去重;(b) 用户 tag 与 Video AND;
  (c) `search_text` 仅在 query 非空(trim 后)时设置;(d) `nextCursor` 等于入参 cursor 时被抑制为
  `undefined`;(e) 同参第二次调用命中缓存、不再 `fetch`。全程 hermetic(fetch mock)。
- 模板见 `routes/transcode.test.ts`(内存 SQLite + 假 Layer + `ManagedRuntime` + `app.handle`)。
- **回填即锁契约**:为 BL-2 故意没收敛的路由补 route 测试,顺手把现有 status/body 钉死,防回归。
- **不 enshrine bug**:写测试前对照 AGENTS.md 不变量;若代码与规格冲突(如 BL-2 发现的 `/resume`
  200→500 latent bug),**报出来停手**,不把错误行为写成绿测试。

### 后续候选(seed 进 backlog,本批不做)
- 更多后端路由/服务测试:`library` `player` `display` `storage` `system` 路由;`SleepTimer`
  `DownloadTasks` `PlayerWatch` `Migrate` 服务。
- 删 4 个已完全合并的陈旧本地分支(`feat/display-power-ui-fidelity` `feat/upgrade-vite-8`
  `feature/auth-passkey` `phase2-transcode-worker`,均 ahead:0)。
- **可选(依赖新增):** 前端组件测试骨架(happy-dom + @testing-library/react)。引入新 devDep,
  较重,单列为可选项,不进本批承重序列。

## 验证命令

```
bun test                 # 机器门 1
bun run typecheck        # 机器门 2(各 workspace tsc --noEmit)
bun run build            # 机器门 3
```

## 回滚

CI yaml、测试文件全是纯增量、可删、不碰产品码、不碰数据。任一阶段可独立 revert。

## 攻击面

- **依赖失效**:GitHub Actions 挂了 → 本地 pre-commit `bun test` 仍在,正确性不丢,只丢异步可信层。
- **规模**:测试回填和 CI 不随数据量增长,无 10x 断点。
