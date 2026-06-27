# BL-17: 视频预览功能 (Transcoded Video Preview)

## 目标
在 Library 页面，为已完成转码（`transcode_status === 'completed'`）的视频提供浏览器内预览。

## 约束
- **只播放 HEVC**：不生成 H.264 fallback。如果浏览器不支持，直接报错提示，不强求兼容。
- **只播放优化后文件**：仅对 `optimized/` 下的文件进行串流，不播放原始下载文件。
- **依赖最小化**：前端只引入 `plyr`，并复用项目现有 CSS token。

## 后端设计
- **路由**: 新增 `GET /api/library/:workshopId/stream`
- **逻辑**:
  1. 查询数据库，若不是 `completed` 状态，返回 404。
  2. 使用 `Library.playablePath(row)` 结合 `Storage.mediaRoot()` 定位绝对路径。防目录穿越。
  3. 支持 HTTP `Range: bytes=...` 头，返回 `206 Partial Content`，以支持拖动进度条。

## 前端设计
- **依赖**: 引入 `plyr` (`^3.8.4`)。
- **组件**: 新增 `VideoPreview.tsx`。
  - 使用 `plyr` 包装 `<video>`。
  - 动态导入（`import('plyr')`）避免首屏过大。
  - 监听 `error` 事件（捕获 HEVC 不兼容问题）。
  - 组件卸载时调用 `player.destroy()` 并清空 `src`。
- **UI 接入**:
  - `Library.tsx` 卡片增加 Preview 按钮（仅在 `completed` 时出现）。
  - 弹层复用现有的 Overlay / MobileSheet。

## 测试与验证
- 拖动进度条时，必须触发 206 请求。
- 支持 Auth：未登录时请求 stream 应被拦截（401）。
- 关闭预览弹层后，网络请求必须停止。
