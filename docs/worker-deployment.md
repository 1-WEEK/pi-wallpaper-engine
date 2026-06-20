# NAS 转码 Worker 部署指南

Pi Wallpaper Engine 的转码 Worker 跑在 NAS 上，专门负责把下载好的视频壁纸重新编码成适合 Pi 4B 硬解的 HEVC 文件。Pi 只负责下发任务、传输源文件和接收成品；真正的 ffmpeg 运算发生在 NAS 容器里。

Worker 默认不启用。只有给 Pi 后端配置好 `PWE_WORKER_API_KEY` 之后，转码队列才会真正工作。

## 前置条件

- 一台能跑 Docker 的 NAS，建议 x86_64 + Intel 核显，这样可以走 QSV 硬件加速。大多数搭载低功耗 Intel CPU 的家用 NAS 都符合这个条件。
- NAS 和 Pi 在同一个局域网，NAS 能访问 Pi 的后端地址，例如 `http://pi.local:8080` 或 `http://<pi-ip>:8080`。
- 你的开发机器上已经装好 Docker、buildx、GitHub CLI（gh），并且能访问容器仓库（推荐 ghcr.io）。
- Pi 端已经运行 Wallpaper Engine 后端，版本支持 Phase 2 转码队列。

> 不要在 Pi 4B 上构建 Worker 镜像。Pi 的内存和 SD 卡扛不住 `bun install` 加固件依赖的 Docker 构建，交叉构建 amd64 更是不现实。镜像应该在 x86_64 开发机、Apple Silicon Mac 或 CI 上构建，然后分发到 NAS。

## 生成共享密钥

Worker 和后端靠同一个 API key 互相认证。在任意机器上执行：

```bash
openssl rand -hex 32
```

这个值需要同时放到两边：

- **Pi 端**：写入 `~/.config/pi-wallpaper-engine/auth.env`，然后重启后端。
  ```bash
  echo "PWE_WORKER_API_KEY=<你的密钥>" >> ~/.config/pi-wallpaper-engine/auth.env
  systemctl --user restart pi-wallpaper-engine
  ```
- **NAS 端**：稍后写入 `.env` 文件里的 `PWE_WORKER_API_KEY`。

密钥长度至少 8 位，建议直接用上面生成的 32 字节 hex。

## 分发 Worker 镜像

Worker 镜像在你的开发机器上构建，然后分发到 NAS。推荐用容器仓库；如果没有仓库，也可以用 docker save / load 的 tar 包。

### 方式一：推送到容器仓库（推荐）

#### 1. 确保 gh 已登录

推送 ghcr.io 时，`release.sh` 会依赖 `gh` 自动完成 `docker login`。先确认：

```bash
gh auth login
gh auth status
```

如果你还没装 `gh`，去 https://cli.github.com 安装。

#### 2. 构建并推送

从 monorepo 根目录执行：

```bash
PWE_WORKER_REGISTRY=ghcr.io/<你的用户名>/pwe-worker \
PWE_WORKER_TAG=0.1.0 \
packages/worker/scripts/release.sh --push
```

脚本默认构建 `linux/amd64`，会自动打上 `0.1.0` 和 `latest` 两个标签。推送 ghcr.io 之前，脚本会自动用 `gh auth token` 完成 Docker 登录，不需要手动 `docker login`。

如果你用的是 Apple Silicon Mac，也可以交叉构建 x86 镜像给 NAS：

```bash
PWE_WORKER_REGISTRY=ghcr.io/<你的用户名>/pwe-worker \
PWE_WORKER_TAG=0.1.0 \
packages/worker/scripts/release.sh --push
```

Docker Desktop 的 buildx + QEMU 会自动处理交叉编译，只是比本机构建慢一些，内存建议 16GB 以上。

如果需要同时构建 `linux/amd64` 和 `linux/arm64`，加 `--multi`：

```bash
PWE_WORKER_REGISTRY=ghcr.io/<你的用户名>/pwe-worker \
PWE_WORKER_TAG=0.1.0 \
packages/worker/scripts/release.sh --push --multi
```

#### 3. 在 NAS 上拉取并启动

把 `packages/worker/docker-compose.yml` 和 `packages/worker/.env.example` 复制到 NAS 上的某个目录，例如 `~/pwe-worker/`。

```bash
mkdir -p ~/pwe-worker
cd ~/pwe-worker
cp .env.example .env
$EDITOR .env
```

编辑 `.env` 后执行：

```bash
docker login ghcr.io   # 如果镜像是私有的
docker compose pull
docker compose up -d
```

### 方式二：tarball 分发（无仓库）

#### 1. 在开发机器上构建并导出

```bash
PWE_WORKER_TAG=0.1.0 packages/worker/scripts/release.sh
```

然后打包成 tar：

```bash
docker save ghcr.io/<你的用户名>/pwe-worker:0.1.0 | gzip > pwe-worker-0.1.0.tar.gz
scp pwe-worker-0.1.0.tar.gz nas:/tmp/
```

#### 2. 在 NAS 上导入并启动

```bash
ssh nas
docker load < /tmp/pwe-worker-0.1.0.tar.gz
```

然后同样复制 `docker-compose.yml` 和 `.env.example`，填好 `.env`，执行：

```bash
docker compose up -d
```

## 配置 .env

NAS 上只需要两个文件：`docker-compose.yml` 和 `.env`。`.env` 从 `.env.example` 复制，必填项如下：

```bash
# 完整镜像引用，包含标签
PWE_WORKER_IMAGE=ghcr.io/<你的用户名>/pwe-worker:0.1.0

# 和 Pi 端 auth.env 里完全一致的密钥
PWE_WORKER_API_KEY=<你的密钥>

# Pi 后端的局域网地址，不要用公开 Tunnel 域名
PWE_BACKEND_URL=http://pi.local:8080

# Worker 在领取任务时上报自己的名字，方便日志辨认
PWE_WORKER_NAME=nas-01

# 容器内的临时工作目录，默认即可
PWE_WORK_DIR=/tmp/pwe-worker
```

如果你的镜像在本地 tar 里，那 `PWE_WORKER_IMAGE` 就写 `release.sh` 打印出来的那个完整标签。

## 启动验证

容器起来后先看日志：

```bash
docker logs pwe-worker | head -20
```

正常启动会看到类似输出：

```
▶ pwe-worker "nas-01" → http://pi.local:8080
  work dir: /tmp/pwe-worker
  encoder: qsv - hevc_qsv device probe succeeded
```

这说明 Worker 已经连上 Pi，并且成功探测到 QSV 硬件编码。

如果日志停在 `encoder: x265 - hevc_qsv device probe failed (...)`，说明 QSV 没透传进容器，但 Worker 会退回到 libx265 软件编码，仍然能工作，只是慢一点。需要硬件加速的话，继续看下一节。

## 检查 QSV 硬件加速

QSV 依赖 `docker-compose.yml` 里的设备映射：

```yaml
devices:
  - /dev/dri:/dev/dri
```

确保 NAS 主机上有 `/dev/dri/renderD128`：

```bash
ls -l /dev/dri
```

如果主机根本没有这个设备，说明 NAS 没有 Intel 核显或者驱动没装好，Worker 只能用软件编码。

如果主机有设备但容器里探测失败，检查：

1. `docker-compose.yml` 是否正确挂载了 `/dev/dri`。
2. NAS 上是否安装了 `intel-media-va-driver-non-free` 或 `i965-va-driver`。Dockerfile 已经打包了 `intel-media-va-driver-non-free`，理论上不需要在宿主机额外安装，但某些老 CPU 可能需要 `i965-va-driver`。
3. 容器内执行 `vainfo` 看看 VA-API 是否识别到设备。

只要 NAS 是 x86 架构且 Docker 能正常访问 `/dev/dri`，`hevc_qsv` 通常可以直接启用。

## 常见问题

**Q: Worker 日志显示 401/403，然后退出。**  
A: `PWE_WORKER_API_KEY` 和 Pi 端不一致。检查 `~/.config/pi-wallpaper-engine/auth.env` 里的值，并确认后端已经重启。

**Q: Worker 连不上 Pi，日志报 network failure。**  
A: 确认 NAS 能访问 `PWE_BACKEND_URL`。用 `curl http://<pi-ip>:8080/api/health` 从 NAS 上测试。如果 Pi 开了防火墙，放行 8080 端口。

**Q: 为什么建议用局域网地址，而不是 Cloudflare Tunnel 域名？**  
A: Worker 要上传大体积视频文件，走 Tunnel 既慢又可能触发超时。局域网内直接传输更稳定。

**Q: 我可以在 Pi 4B 上构建镜像吗？**  
A: 可以，但不建议。Pi 内存和 SD 卡都有限，构建过程会很慢；如果要交叉构建给 x86 NAS 用，基本不现实。请在普通电脑、Apple Silicon Mac 或 CI 上构建。

**Q: 任务失败后会不会一直卡死？**  
A: 不会。Worker 每次心跳间隔 15 秒，Pi 端 60 秒没收到心跳就会把任务重置为 pending，交给下一个 Worker 或重试。

**Q: 一个 Worker 能同时跑多个任务吗？**  
A: 当前设计是一个 Worker 一次只处理一个任务，避免把 NAS 压得太满。想提高并发可以起多个 Worker 实例，但通常没必要。

**Q: 转码过程中切换 Pi 的媒体目录会怎样？**  
A: 切换媒体目录会阻塞新的任务领取，正在进行的转码会阻止切换完成。等当前任务结束或超时才继续。

## 回滚和停机

如果只是临时停止 Worker：

```bash
docker compose down
```

Pi 端的任务队列不会受影响。`TranscodeMonitor` 会在大约 60 秒内把被该 Worker 领取的任务重新置为 pending。

如果想彻底移除 Worker：

```bash
docker compose down
rm -rf ~/pwe-worker
```

然后清空 Pi 端 `auth.env` 里的 `PWE_WORKER_API_KEY` 并重启后端，转码队列就会回到 Noop 模式，所有下载项的 `transcode_status` 标记为 `skipped`。

## NAS 上实际只需要这些文件

- `docker-compose.yml`
- `.env`

镜像、源码、锁文件都不需要上传到 NAS。这就是推荐的分发方式。
