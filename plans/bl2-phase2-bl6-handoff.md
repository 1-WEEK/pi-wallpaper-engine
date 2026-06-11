# Handoff: BL-2 Phase 2 与 BL-6

留给新 session 在干净 context 实现。所有分析已在前一个 session 做完,照此执行即可,不必重新摸索。配合 `iteration-backlog.md` 的工作流(每项 check + git-agent 提交 + 标 ✅)。

提交统一用 `git-agent commit --free --no-attribution`(`--free` 绕 gemini planner 的 429,`--no-attribution` 去掉 Git Agent co-author)。不加任何 co-author。

---

## BL-2 Phase 2:用 httpFromError 逐 route 替换错误处理样板

### 现状
Phase 1 已落地(commit `c20e72e`):`packages/backend/src/routes/httpError.ts` 的 `httpFromError(err)` 纯函数,按 kind-aware 映射把 tagged 业务错误转成 `{ status, body }`,有 8 个单测(`httpError.test.ts`)全覆盖。Phase 2 是把约 28 个 handler 的样板换成它。

### runRoute helper
放每个 route factory 函数内,closure 捕获 `runtime`,这样不用给 runtime 的 AppContext 命名(Effect 的 R 通道靠推断,已验证 player 的 effect 能过)。完整实现:

```ts
import { httpFromError } from "./httpError.js"

// route factory 从 `=> new Elysia(...)` 改成 block:
// export const xxxRoutes = (runtime: AppRuntime, ...) => {
//   const runRoute = ...
//   return new Elysia(...) ...
// }   ← 结尾补一个 }

const runRoute = <A, E extends { readonly _tag: string }, R>(
  set: { status?: number },
  effect: Effect.Effect<A, E, R>,
) =>
  runtime
    .runPromise(
      effect.pipe(
        Effect.catchAll((err) =>
          Effect.sync(() => {
            const { status, body } = httpFromError(err)
            set.status = status
            return body
          }),
        ),
      ),
    )
    .catch((e: unknown) => {
      set.status = 500
      return { error: e instanceof Error ? e.message : String(e) }
    })
```

handler 替换模式:

```ts
// before
.post("/x", ({ set }) =>
  runtime.runPromise(
    Effect.gen(function* () { ... }).pipe(
      Effect.catchTag("LibraryNotFoundError", () => Effect.sync(() => { set.status = 404; return { error: "..." } })),
      Effect.catchTag("MpvIpcError", (e) => ...),
    ),
  ).catch((e) => { set.status = 500; return { error: ... } }))

// after
.post("/x", ({ set }) => runRoute(set, Effect.gen(function* () { ... })))
```

成功路径里的 `set.status`(如 download 的 202、transcode 的 204)是非 error 状态码,**不归 runRoute**,保留在 effect 内或 handler 里。runRoute 只接管 error 处理。

### 审计基准(替换后 status 必须不变,逐 route 对照)

前一个 session 已 grep 审计现有映射。`httpFromError` 的映射按此推导,大多一致:

| Error | httpFromError | 现有 route 行为 | 一致? |
|---|---|---|---|
| LibraryNotFoundError | 404 | player/library/download 均 404 | ✓ |
| MpvIpcError / MpvSpawnError | 500 (`mpv: ...`) | player 各 handler 500 | ✓ |
| StorageError(Disconnected/Mount) | 503 | player/library StorageError→503 | ✓(player 实际只收 Disconnected/Mount) |
| StorageError(Busy/Validation/Space) | 409/400/507 | storage route 按 kind | ✓ |
| DisplayError(NotConfigured) | 503 | display route NotConfigured→503 | ✓ |
| DbError / ConfigError / FfprobeError | 500 | 各处 500 | ✓ |
| SteamCmdError(by kind) | 401/403/504/500 | 下载流程 | 逐个 grep 确认 |

### 三个决策点(替换前定,在 commit 注明)
1. **resume 的 latent bug**:`player.ts` 的 `/resume` 现在 error 返 **200**(`catchAll(() => Effect.succeed({ error: String(e) }))`,不设 status)。runRoute 会给 500。建议修成 500(error 本不该 200),commit 注明是顺带修的 bug。
2. **WorkshopApiError canonical 不一致**:`httpFromError` 给 **502**(上游网关错误,语义更准),但 `workshop.ts` 现有 **500**。替换 workshop route 时决策:接受 502(改契约)或把 httpFromError 的 WorkshopApi 改回 500。建议 502 + 注明。
3. **error message 统一**:httpFromError 统一 message(如 LibraryNotFound 从 `"Not found"` → `"Wallpaper <id> not found"`)。status 不变,body message 会变。前端以 status 为主,影响 minor,但注明。

### 逐 route 顺序(各自独立 commit,各自验证)
1. `player.ts`: 11 个 handler,样板最多,含 resume 决策。最先做,最值。
2. `library.ts`: LibraryNotFound→404, StorageError→503。
3. `download.ts`: 含 WorkshopApi 决策;小心 202 异步成功返回不要被 runRoute 吞。
4. `storage.ts`: StorageError kind 细分,httpFromError 已覆盖,逐 kind 对照。
5. `workshop.ts`: WorkshopApi 502/500 决策。
6. `display.ts`: DisplayError kind。
7. `transcode.ts`: **有现成 `transcode.test.ts`,替换后必须 test 绿**,是最好的回归保护。
8. `system.ts`: 单 handler。

每个 route:替换 → `bun run --filter @pwe/backend typecheck` → `bun test` → 对照审计表确认 status 不变(除 resume/WorkshopApi 有意决策)。**不可批量改不验证。**

### 验证
- `bun test`(含 `httpError.test.ts` + `transcode.test.ts`)。
- `bun run --filter @pwe/backend typecheck`。
- 手动:对每个改过的 route,确认 error 路径的 status 码对照审计表未变。

---

## BL-6:移动端 MobileMiniPlayer 控件密度(需产品决策)

375px 下 5 控件(DisplayToggle + stop / prev / play / next)偏挤,Playwright 视觉验证过没溢出。两个方案,**先问用户偏好再动**:

- **方案 A(去 stop)**:删 `MobileMiniPlayer.tsx` 的 stop 按钮,剩 4 控件更宽松。理由:DisplayToggle(关屏省电)+ pause(暂停)已覆盖 stop 的场景。代价:移动端不能单纯 stop(不关屏)。
- **方案 B(缩间距)**:CSS 缩 `.mobile-mini-player-btn` 的 gap/尺寸(`styles.css`),保留 5 控件。无功能损失,改善有限。

改完在真机 375px 或 Playwright mock(见 memory `pwe-visual-review-workflow`,mock `/api/**` + 375px 截图)确认。

---

## 风险边界
- **BL-2**:改 API status 契约。必须逐 route 对照审计表验证 status 不变;resume/WorkshopApi 的契约变化要在 commit message 明确。一次只改一个 route,改完即验。
- **BL-6**:产品决策(删功能 vs 纯视觉),需用户选,不要替用户删 stop。

## 回滚
- BL-2:纯重构,每个 route 一个 commit,`git revert` 单个即回退。httpFromError + test 已在 main,不受影响。
- BL-6:单文件,直接 revert。
