# Library 视频预览功能需求与技术文档

## 背景与目标

在 Library 页面为已下载并转码完成的壁纸视频提供浏览器内预览。该功能只播放 `optimized/` 目录下的转码后文件，不播放源文件，也不支持未转码或转码中的项。

用户明确约束：

- 只考虑 HEVC 编码的转码后文件，不生成 H.264 fallback。
- 前端播放器统一使用 [Plyr](https://github.com/sampotts/plyr)。

---

## 功能需求

1. **后端串流接口**
   - 新增 `GET /api/library/:workshopId/stream`。
   - 仅当 `transcode_status === "completed"` 且 `transcoded_path` 存在时才返回视频流。
   - 支持 HTTP `Range: bytes=...` 请求，返回 `206 Partial Content`，允许拖动进度。

2. **前端预览入口**
   - Library 网格视图和列表视图的每张卡片增加 **Preview** 按钮。
   - 已转码项才显示 Preview 按钮；未转码、转码中、转码失败/跳过的项不显示。

3. **预览弹层**
   - 桌面端：居中 overlay。
   - 移动端：复用现有 `MobileSheet`。
   - 弹层内使用 Plyr 播放 `/api/library/:workshopId/stream`。
   - 默认静音播放，使用 Steam `preview_url` 作为 poster。
   - 关闭弹层时销毁 Plyr 实例，停止网络加载。

4. **鉴权**
   - stream 路由位于 `/api/library/*`，自动继承现有 `sessionGuard`。
   - `config.auth.enabled=false` 时可直接访问。

5. **错误处理**
   - 文件不存在或未转码：404。
   - 存储目录断开：503。
   - 浏览器无法解码 HEVC：Plyr 触发 error 事件，前端显示提示文案。

---

## 非功能需求

- **不暴露整个 `optimized/` 目录**：所有路径通过 `Library.playablePath(row)` + `Storage.mediaRoot()` 解析。
- **不引入第二套 CSS 系统**：使用 Plyr 自带样式，并通过 CSS 变量覆盖为项目现有 token（`--ink`、`--paper`、`--accent` 等）。
- **最小依赖**：仅新增 `plyr` 一个前端依赖。
- **可回滚**：不修改数据库 schema；回滚时删除新增组件、路由和依赖即可。

---

## 技术方案

### 后端

修改文件：`packages/backend/src/routes/library.ts`

新增路由：

```
GET /api/library/:workshopId/stream
```

实现要点：

1. 用 `Library.get(workshopId)` 查询记录。
2. 检查 `row.transcode_status === "completed"` 且 `row.transcoded_path` 非空，否则返回 404。
3. 通过 `Library.playablePath(row)` 获得相对路径，再用 `Storage.mediaRoot()` 解析为绝对路径。
4. 使用 `isPathInsideRoot(abs, mediaRoot)` 校验路径不越界。
5. 读取文件 `stat` 信息。
6. 根据请求头处理 Range：
   - 无 `Range`：返回 `200`，响应头带 `Accept-Ranges: bytes`、`Content-Type: video/mp4`、`Content-Length`，body 为 `Bun.file(path)`。
   - 有 `Range`：解析 `start-end`，返回 `206`，响应头带 `Content-Range: bytes start-end/size`、`Accept-Ranges: bytes`、`Content-Length: chunkSize`，body 为 `Bun.file(path).slice(start, end+1)`。
7. 错误走 `httpFromError` 统一映射。

### 前端

新增依赖：`packages/frontend/package.json`

```json
{
  "dependencies": {
    "plyr": "^3.8.4"
  }
}
```

新增组件：`packages/frontend/src/components/VideoPreview.tsx`

实现要点：

1. 接收 props：`workshopId`、`title`、`posterUrl`、`onClose`。
2. 内部维护一个 `<video>` 元素 ref。
3. 在 `useEffect` 中：
   - `import('plyr')` 动态加载（避免首屏打包过大）。
   - 初始化 `new Plyr(videoRef.current, { ... })`。
   - 调用 `player.source = { type: 'video', sources: [{ src: api.libraryStream(workshopId), type: 'video/mp4' }] }`。
   - 监听 `error` 事件，若播放失败则展示提示。
4. 卸载时调用 `player.destroy()` 并清空 src。

修改文件：`packages/frontend/src/api.ts`

新增方法：

```ts
libraryStream: (id: string) => `/api/library/${id}/stream`
```

修改文件：`packages/frontend/src/pages/Library.tsx`

- 在 grid/list 卡片上增加 Preview 按钮。
- 点击后设置当前 preview 状态，渲染 `VideoPreview`。

修改文件：`packages/frontend/src/styles.css`

- 在文件顶部或组件内导入 Plyr CSS：

```css
@import "plyr/dist/plyr.css";
```

- 覆盖 Plyr CSS 变量以匹配项目主题：

```css
.plyr {
  --plyr-color-main: var(--accent);
  --plyr-video-background: var(--ink-1);
  --plyr-font-family: inherit;
  --plyr-control-radius: 6px;
}
```

---

## API 接口详情

### `GET /api/library/:workshopId/stream`

**功能**：串流转码后的 MP4 文件。

**请求头**：

```http
Range: bytes=0-1048575  # 可选
```

**成功响应**：

- 无 Range：`200 OK`
- 有 Range：`206 Partial Content`

响应头示例：

```http
Content-Type: video/mp4
Accept-Ranges: bytes
Content-Length: 123456789
Content-Range: bytes 0-1048575/123456789  # 206 时
```

**失败响应**：

| 状态码 | 场景 |
|--------|------|
| 401 | 鉴权开启且未登录 |
| 404 | 壁纸不存在、未转码、转码未完成、转码后文件不存在 |
| 503 | 存储目录不可用 |
| 500 | 其他内部错误 |

---

## 关键决策

1. **HEVC only，无 H.264 fallback**
   - 理由：用户明确只考虑 HEVC，且项目默认 `transcode.target_codec` 为 `hevc`。
   - 代价：Firefox/Linux/部分 Windows 设备无法预览。

2. **使用 Plyr**
   - 理由：用户指定；Plyr 提供统一、可访问、可主题的播放器 UI。
   - 代价：增加约 40KB gzip 依赖；仍受浏览器 HEVC 解码能力限制。

3. **HTTP byte-range MP4 串流**
   - 理由：单文件、无需打包成 HLS/DASH、Pi 本地网络带宽通常充足。
   - 实现：手动解析 Range，保证 seek 可靠。

4. **路径解析走 `Library.playablePath` + `Storage.mediaRoot`**
   - 理由：遵守 AGENTS.md 关于路径解析的硬规则，自动支持用户切换 media root。

5. **单阶段实现**
   - 理由：功能独立，可直接合并；无需等待后续阶段。

---

## 风险与备案

| 风险 | 影响 | 应对 |
|------|------|------|
| 浏览器无法解码 HEVC | 部分用户无法预览 | Plyr `error` 事件捕获，显示提示“HEVC not supported in this browser” |
| Plyr 主题与现有 UI 不协调 | 视觉不一致 | 通过 CSS 变量覆盖主色、背景色、圆角 |
| 大文件 seek 时 Range 实现有误 | 播放异常/无法拖动 | 实现后用 Chrome DevTools Network 面板验证 206 响应 |
| 关闭弹层后视频仍在后台缓冲 | 浪费带宽 | 卸载时 `player.destroy()` 并清空 video src |

---

## 验证清单

- [ ] `bun test` 通过。
- [ ] `bun x tsc --noEmit` 通过。
- [ ] 已转码项点击 Preview，Plyr 正常播放。
- [ ] 拖动进度条触发 206 Partial Content。
- [ ] 关闭弹层后网络请求停止。
- [ ] 未转码/转码中项无 Preview 按钮。
- [ ] 删除 optimized 文件后访问 stream URL 返回 404。
- [ ] auth 开启时未登录访问 stream URL 返回 401。
- [ ] 在不支持 HEVC 的浏览器上点击 Preview 显示错误提示。

---

## 回滚方案

1. 删除 `packages/frontend/src/components/VideoPreview.tsx`。
2. 在 `packages/backend/src/routes/library.ts` 中移除 stream 路由。
3. 在 `packages/frontend/src/api.ts` 中移除 `libraryStream`。
4. 在 `packages/frontend/src/pages/Library.tsx` 中移除 Preview 按钮相关代码。
5. 在 `packages/frontend/src/styles.css` 中移除 Plyr CSS 导入和变量覆盖。
6. 从 `packages/frontend/package.json` 中移除 `plyr` 并重新安装依赖。

---

## 涉及文件

- `packages/backend/src/routes/library.ts`
- `packages/frontend/package.json`
- `packages/frontend/src/api.ts`
- `packages/frontend/src/components/VideoPreview.tsx`
- `packages/frontend/src/pages/Library.tsx`
- `packages/frontend/src/styles.css`
