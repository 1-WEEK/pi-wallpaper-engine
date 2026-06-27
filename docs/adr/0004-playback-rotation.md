# 播放轮播迭代计划

Updated: 2026-06-07。

把项目从"能放一张壁纸"推进到"能轮播整个库"。主线是播放轮播,配套睡眠定时器、真机验收、文档同步。预计 10 天,单人节奏。

## 押注与最脆弱假设

整个主线押在"播放轮播是当前最该做的方向"。判断依据是:壁纸引擎有一整个 library,却只能手动放一张、放完不自动切,这是核心体验缺口;而且轮播是纯软件,当前 Pi 就能验收。

worker 真机验证没放进关键路径。它依赖一台 NAS,而这台 NAS 是否存在没法事先确认,押上去等于让整个计划赌一个未知前提。所以 worker 降级成条件支线,有 NAS 才插入。

如果方向本身错了(其实想先做 worker 或别的),这份计划的主体作废,需要重排。

## 当前播放能力的边界

`Mpv.ts` 只有 `play(workshopId, path)` 加 `--loop=inf`,单张无限循环。没有 playlist、队列、随机、下一张任何概念。`PlayerState` 只有一个省电恢复用的单例 slot。所以轮播是真缺口,不是重复造轮子。

还有两个底层事实决定了轮播怎么做。一是 mpv 用 `--loop=inf` 启动(`Mpv.ts:98`),当前文件永远循环、永远不发 end-file 事件。二是 IPC 层(`Mpv.ts` 的 `handleData`)只解析带 `request_id` 的命令响应,不处理 mpv 主动推送的 event。所以轮播不靠"播完自动切",靠后端间隔定时器到点 `loadfile` 下一张,复用现有 `play` 的 `loadfile replace`。这样零改动 mpv 启动参数和播放核心。

## 范围

**做**:顺序、随机、单张三种播放模式,上一张下一张,睡眠定时器,轮播的测试,文档同步。

**不做**:不把 10 天押在 worker 真机验证,它是条件支线;不引入前端测试基建,延续上一轮决策;不做播放速度调节,壁纸是循环视频没意义;不碰 storage 目录模型,不回退 SMB,这是 AGENTS.md 的硬规则。

## 数据流

轮播本质是一个由后端定时器驱动的循环。

```
Library (DB 壁纸行)
      │
      ▼
Playlist Engine   后端:模式 single/seq/shuffle + 序列索引 + 间隔定时器,内存态
      │  间隔到点 loadfile(下一张),复用 Mpv.play
      ▼
    Mpv  (--loop=inf 循环当前张,直到下次 loadfile replace)
      │  status
      ▼
PlayerWatch  (1Hz tick + 快照 equality gate,snapshot 加 play_mode 字段)
      │  snapshot
      ▼
WS /api/player/watch  ──►  前端 PlayerBar / MobileMiniPlayer
```

循环是"定时器到点,选下一张,loadfile,当前张 loop 到下个间隔"。终止条件:stop、single 模式、空库、睡眠定时器触发。

## 10 天日程

每一块都是独立可合并的单元,停在任何一天系统都处于可用状态。

| Day | 交付 |
|---|---|
| 1 | 收口开胃。删掉过时 10 天的 `project-status-2026-05-27.md`,它还写着 worker、auth、WS、cancel 未实现,全错了,换成 2026-06-07 真实快照,顺手对齐 roadmap。 |
| 2 | 轮播数据模型。新建 `playback_prefs` 单例表(`play_mode` 默认 `single`,`rotation_interval_sec` 默认 600),走 `Db.ts` 既有的 `CREATE TABLE IF NOT EXISTS` 模式。不动 `Mpv.ts` 启动参数,轮播复用现有 `play`。 |
| 3 | 轮播引擎。后端维护播放序列(顺序按 library 排,随机用 Fisher-Yates 洗一轮、放完整库再重洗),间隔定时器到点选下一张并 `loadfile`,切换时跳过磁盘上已不存在的项;新路由 `POST /api/player/mode`、`/api/player/next`、`/api/player/prev`;`PlayerWatch` 的 snapshot 加 `play_mode`。 |
| 4 | 轮播后端测试。把"选下一张"和随机不重复算法做成纯函数单测;边界覆盖空库、当前项被删、单张库、切换中。Day 2 到 4 合并就是轮播后端完整可用,curl 能驱动。 |
| 5 | 轮播前端。`PlayerBar` 加模式切换图标和上下一张按钮,接 WS 上报的当前壁纸;纯 CSS token,不引新 CSS 系统。 |
| 6 | 移动端加入口。`MobileMiniPlayer` 适配;`Library` 页加"播放全部""随机播放"入口。Day 5 到 6 合并就是 UI 可用。 |
| 7 | 睡眠定时器。N 分钟后自动 `stop` 加 `display off`,复用现有 player 和 display 联动;后端定时加 Settings 入口。独立可合并。 |
| 8 | 真机验收加修 bug。当前 Pi 上跑轮播长稳,盯 mpv 句柄和内存泄漏、连切黑屏;有可移动存储就顺带验 storage 双向迁移;修真机暴露的 bug。 |
| 9 | 测试欠债。补轮播遗留的测试缺口,补 1 到 2 个关键路由集成测试,前端纯逻辑(`workshopTags`、`api` 错误处理)补少量测试,不引 React infra。 |
| 10 | 文档同步加 buffer。README 和 AGENTS 记录轮播能力、新 API、新不变量;打磨。条件支线:有 NAS 就部署 worker 镜像、配 `PWE_WORKER_API_KEY`、跑一次真实壁纸端到端转码、验证心跳进度重试和 QSV 探测,用碎片时间,不占主线。 |

## 关键决策

轮播走后端间隔定时器加逐个 `loadfile`,不用 end-file,也不用 mpv 原生 playlist。原因有两层。一是 mpv `--loop=inf` 让当前文件永不结束,end-file 根本不会触发,走 end-file 得改播放核心并新建 event 解析,代价高。二是壁纸轮播的自然语义是"每张显示一段时间再换",按间隔切比按视频播完切更贴合。shuffle 不重复、库动态变化、模式切换都在后端定时器逻辑里控,复用现有 `Mpv.play` 的 `loadfile replace`,零改 mpv 启动参数。

`play_mode` 默认 `single`,新代码不改现有行为,轮播是 opt-in,回滚也安全。

重启后只恢复 `play_mode` 偏好,不自动开播。轮播定时器在用户 `play` 或"播放全部"时启动,睡眠定时器(Day 7)到点会取消它。

播放偏好放新建的 `playback_prefs` 表,不塞进 `player_state`。后者语义是省电恢复,混进来不干净。

主线先后端后前端,各自能单独合并。Day 4 停下系统仍可用,API 完整;Day 6 停下 UI 完整。

## 提交约定

实施时按增量提交,一个可合并单元配一个提交,不攒大提交。用 git-agent 自动拆分:

```
git-agent commit --intent "<这一增量做了什么>"
```

它会把暂存区按逻辑边界拆成多个原子提交,最多 5 组。

本仓库不加任何 co-author trailer。这是用户的全局偏好,已写进 `~/.claude/CLAUDE.md`。git-agent 默认就不加 co-author,正好符合,提交后不需要补 trailer,也不要手动加。

## 验证

每个增量:`bun test` 绿,`bun run typecheck` 干净。

轮播手动验收:三模式切换、上下一张、播完自动切、空库不崩、删当前项继续轮播。

Day 8 真机:轮播跑数小时不泄漏(盯 mpv 句柄、内存),间隔切换平滑(`loadfile replace` 不重启进程,短暂解码黑屏可接受)。

## 回滚

纯软件,加一张新表加前端增量。`play_mode` 默认 `single` 就等价旧行为,可以直接 `git revert`,没有数据迁移风险。

## 待定项

轮播引擎归属,并进 `PlayerWatch` 还是新建 `Playlist` service,Day 2 实现时定。

worker 真机验证能否进行,取决于有没有 NAS。
