# E2E 测试方案

Created: 2026-06-23。

## 问题

27 个测试文件全是后端逻辑 / 内存 SQLite / 纯函数，覆盖不到前端 UI 交互。6 个页面 + 4 个组件零覆盖率。核心流程（浏览 Workshop → 下载 → 库管理 → 播放控制）从未被自动验证过。

CI 只有 `bun test + typecheck + build` 三道机器门，前端的渲染正确性和交互逻辑完全依赖肉眼验。

## 约束

- 后端依赖真硬件（mpv、SteamCMD、显示命令），CI 上跑不了全栈。
- 不引入 React Testing Library / happy-dom — 不值当为一个项目新开一条组件测试路线。
- Git pre-commit hook 已有 `bun test`，E2E 跑得慢，不进 pre-commit。进 CI。
- Playwright `^1.61.0` 已在 root devDependencies，但从未配过。

## 方案

Playwright + Vite standalone + API route mocking。Vite dev server 独立启动（无后端），所有 `/api/*` 请求通过 Playwright `page.route()` 拦截并返回 mock 数据。

### 为什么是 route-level mock

Playwright `page.route()` 是内建能力，零额外依赖。每个测试文件在 `beforeEach` 中安装自己的 mock handler，测试间天然隔离。不需要起 fixture server，不需要配反向代理。

### 目录结构

```
playwright.config.ts            # Playwright 配置
packages/frontend/e2e/
  fixtures.ts                   # 所有 mock 数据（静态 JSON）
  helpers.ts                    # 共享辅助函数（setupRoutes 等）
  browse.test.ts                # Browse 页测试
  library.test.ts               # Library 页测试
  downloads.test.ts             # Downloads 页测试
  player-bar.test.ts            # PlayerBar 测试
  settings.test.ts              # Settings 页测试
  shell.test.ts                 # Shell 导航测试
```

### 测试覆盖

| 文件 | 场景 | test 数 |
|------|------|---------|
| `browse.test.ts` | 搜索框渲染 → 输入查询 → 显示结果 → 切换 tag → 翻页 → 空结果 → 网络错误 | ~6 |
| `library.test.ts` | 空库 → 有壁纸网格 → 播放 → 删除 → Display mode 切换 | ~5 |
| `downloads.test.ts` | 空页 → 活跃任务（进度条、消息）→ 已完成 → Clear finished → 取消下载 | ~5 |
| `player-bar.test.ts` | 停止态 → 播放中态 → play/pause/stop/next/prev → display mode → sleep → rotation mode | ~6 |
| `settings.test.ts` | 各 tab 切换 → 存储目录浏览器 → 创建目录 → 目录验证 | ~4 |
| `shell.test.ts` | 侧边栏导航 → active 高亮 → badge 计数 → Pi status 面板 | ~4 |

不覆盖：Auth/Passkey 登录（WebAuthn 无法在 headless 中 mock）、WebSocket 实时更新（测试价值低 mock 成本高）、视觉回归（无 baseline，且本就不该由机器判断）。

### Mock 数据设计

`fixtures.ts` 导出以下 mock：

- `mockSystemSummary()` — 完整的 `SystemSummary`，含 player/display/storage/library/downloads 各子段
- `mockWorkshopItems(n)` — 生成 n 条 `WorkshopItem`，带不同 tag 和 rating
- `mockLibraryItems(n)` — 生成 n 条 `LibraryItem`，带不同的 display_mode
- `mockDownloadTasks(n)` — 生成 n 条 `DownloadTask`，含不同 stage 和 progress
- `mockStorageDirectoryListing()` — 带嵌套目录结构的 listing
- `mockStorageValidation()` — 验证结果的 success/error 两种
- `mockStorageLocations()` — 可用的存储位置列表

所有 mock 数据运行时生成（`Date.now()`、递增 ID），不硬编码。

### 辅助函数

`helpers.ts` 导出：

- `setupApiRoutes(page, routes)` — 为指定页面安装 mock route handlers。接受 routes 数组，每项指定 `{ method, path, handler }`。
- `mockSummary(page, summary)` — 快捷安装 SystemSummary mock
- `mockError(page, path, status)` — 安装一个返回指定 HTTP 错误的 mock

### Playwright 配置要点

```ts
// playwright.config.ts
import { defineConfig } from "playwright/test"

export default defineConfig({
  testDir: "./packages/frontend/e2e",
  retries: 0,
  use: {
    baseURL: "http://localhost:5173",
    headless: true,
  },
  webServer: {
    command: "bun run dev:frontend",
    port: 5173,
    reuseExistingServer: true,
  },
  projects: [
    { name: "chromium", use: { browserName: "chromium" } },
  ],
})
```

只测 Chromium。webkit 和 firefox 在这个项目中无差异化价值（前端无 Safari/Firefox 专有 API）。

### CI 集成

独立 workflow（`e2e.yml`），不和现有 `ci.yml` 挤在一起。E2E 比单元测试慢一个数量级，独立 workflow 可以：

- 各自独立跑，不互相阻塞
- E2E workflow 可以设更长的 timeout
- E2E 失败不影响 `ci.yml` 的快速反馈

```yaml
name: E2E
on:
  push:
    branches: [main]
  pull_request:

jobs:
  e2e:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: oven-sh/setup-bun@v2
        with:
          bun-version: "1.3.14"
      - run: bun install --frozen-lockfile
      - run: npx playwright install chromium
      - run: npx playwright test --project=chromium
```

## 前提崩塌

这个方案假设 Vite 能在 CI headless 环境下启动并 serve 页面。如果 Playwright 的 `webServer` 启动超时，或者 frontend 的编译依赖（Bun workspace resolution）在 CI 上不一致，E2E 会全挂。Vite 本身不需要物理浏览器就能启动，概率低；但如果 CI 上 Bun 版本和本地不一致导致 workspace 解析失败，就会出事。

## 攻击面

| 攻击角 | 问题 | 缓解 |
|--------|------|------|
| 依赖失效 | Playwright 浏览器二进制 CI 上需要额外安装 | `npx playwright install chromium` 在 CI workflow 中 |
| 规模爆炸 | 10x 测试数还是 6 个文件，线性增长 | 无断点 |
| 回滚成本 | 纯增量，删 `e2e/` 目录 + CI 步骤即可 | 零数据影响 |

## 文件变更清单

新增（~12 文件）：
- `playwright.config.ts`
- `packages/frontend/e2e/fixtures.ts`
- `packages/frontend/e2e/helpers.ts`
- `packages/frontend/e2e/browse.test.ts`
- `packages/frontend/e2e/library.test.ts`
- `packages/frontend/e2e/downloads.test.ts`
- `packages/frontend/e2e/player-bar.test.ts`
- `packages/frontend/e2e/settings.test.ts`
- `packages/frontend/e2e/shell.test.ts`
- `.github/workflows/e2e.yml`

无修改、无删除。

## 验证命令

```
bun test                                    # 现有单元门不退化
npx playwright test --project=chromium      # E2E 全量（本地需先 npm exec playwright install chromium）
bun run typecheck                           # 类型门
bun run build                               # 构建门
```

## 回滚

删 `playwright.config.ts`、`packages/frontend/e2e/`、`.github/workflows/e2e.yml`。不碰产品数据，不碰现有测试。可单步 revert。
