# Trilium Notes for fnOS（纯原生版）

这是面向飞牛 fnOS 的 Trilium Notes 原生 FPK。安装包直接携带 Trilium 官方 Linux Server 发行包及其配套 Node.js 运行时，由 fnOS 应用生命周期脚本启动本机进程。

本项目没有 Docker Compose、没有 `docker-project` 资源声明，也不会把应用用户加入 `docker` 组。因此安装和运行均不依赖 Docker，应用中心图标也不会出现 Docker 小鲸鱼角标。

## 下载

前往 [GitHub Releases](https://github.com/minlonghuo-lab/trilium-fnos-native/releases/latest) 下载对应 CPU 架构的原生 FPK：

- [Intel / AMD 64 位版](https://github.com/minlonghuo-lab/trilium-fnos-native/releases/download/v0.105.0-r5/trilium-fnos-v0.105.0-r5-x86_64.fpk)
- [ARM64 / aarch64 版](https://github.com/minlonghuo-lab/trilium-fnos-native/releases/download/v0.105.0-r5/trilium-fnos-v0.105.0-r5-arm64.fpk)
- [SHA-256 校验文件](https://github.com/minlonghuo-lab/trilium-fnos-native/releases/download/v0.105.0-r5/SHA256SUMS)

> 本项目是社区移植包，与飞牛官方及 TriliumNext 官方没有隶属关系。重要数据请定期自行备份。

## 功能

- 保留 Trilium Web 版的层级笔记、富文本、关系图、画布、思维导图、脚本、同步、加密、导入导出和 ETAPI 等功能。
- 使用 Trilium 官方界面、图标和主题变量，不另做一套割裂的管理界面。
- 飞牛桌面入口使用内嵌原生窗口，不再跳转到浏览器标签页。
- 登录后在 Trilium 页面右下角显示“一键更新”按钮；未登录用户不能访问更新接口。
- 提供 x86_64 与 ARM64 两个原生 FPK，内置各自架构的官方运行时。

## 安装包选择

- Intel / AMD 64 位设备：`trilium-fnos-v0.105.0-r5-x86_64.fpk`
- ARM64 / aarch64 设备：`trilium-fnos-v0.105.0-r5-arm64.fpk`

两个安装包不能混用。安装阶段还会检查实际 CPU 架构，避免误装。安装过程不需要拉取容器镜像；安装完成后，在没有外网的情况下也能启动当前内置版本。

## 构建

在 macOS 或 Linux 开发机执行：

```bash
./scripts/build.sh
```

构建脚本会完成以下工作：

1. 获取 Trilium 官方指定版本的 x86_64 与 ARM64 Server 发行包。
2. 对照 GitHub Release 提供的 SHA-256 digest 校验下载内容。
3. 将对应原生运行时写入各自 FPK。
4. 运行 JSON、Shell、JavaScript、代理集成测试和无 Docker 元数据检查。
5. 使用飞牛官方 `fnpack 1.2.3` 生成两个安装包。
6. 检查最终 FPK 的网关入口及官方文件一致性，自动生成本次两个安装包的 SHA256SUMS。

上游版本可显式指定，例如：

```bash
UPSTREAM_VERSION=v0.105.0 ./scripts/build.sh
```

## 安装

1. 在 fnOS 应用中心选择“手动安装”。
2. 按设备 CPU 架构选择对应 `.fpk`。
3. 启动应用并从 fnOS 桌面打开 Trilium Notes。
4. 按 Trilium 首次设置向导创建账户密码。

也可以在 fnOS 终端使用：

```bash
appcenter-cli install-fpk trilium-fnos-v0.105.0-r5-x86_64.fpk
```

如果安装旧的 `v0.105.0` 首发包时看到“解压 app.tgz 失败”，请改用最新版。r2 已修复上游构建产物中的悬空绝对软链接，并将内外两层 tar 的属主统一为 `root/root`；r3 进一步改用飞牛 `iframe` 原生窗口，并修复异常退出后再次启动提示端口被占用的问题。

### 从 r4 升级到 r5

先备份数据，在飞牛应用中心停止应用，再手动安装 r5 FPK 升级，启动后刷新飞牛网页、关闭旧 Trilium 窗口并重新打开。保留应用数据，不需要卸载。应用内“一键更新”更新的是 Trilium 官方运行时，**不会升级本项目的 FPK 入口和代理**，所以本次入口修复需要安装 r5 FPK。

r5 入口为当前飞牛访问域名下的 `/app/trilium-fnos/`，使用系统 HTTPS 和 NAS 登录态。国内版要求 fnOS 至少 `1.1.3100`（沿用本包已有最低版本）。NAS 登录后仍需 Trilium 自己的密码；所有 NAS 用户访问的是同一份 Trilium 笔记库。

## 一键更新

登录 Trilium 后，点击页面右下角的更新按钮。更新器只接受已登录、同源且带固定动作头的请求，并执行固定流程：

1. 查询 TriliumNext 官方 GitHub 最新稳定版。
2. 下载当前 CPU 架构对应的官方 Server 发行包。
3. 使用 Release API 返回的 SHA-256 digest 做完整性校验。
4. 在 Trilium 仍可使用时完成下载、校验和解压。
5. 停止后台进程并创建数据冷备份。
6. 原子切换运行时，启动新版本并等待健康检查和数据库迁移。
7. 如果失败，自动恢复旧运行时和更新前数据。

同步协议可能随版本变化。若实例与 TriliumDroid、桌面客户端或其他节点同步，更新前请确认各端版本兼容。

## 数据、备份与日志

- 主数据：`TRIM_PKGVAR/trilium-data`
- 当前运行时指针：`TRIM_PKGVAR/runtime/current`
- 在线更新运行时：`TRIM_PKGVAR/runtime/versions`
- 更新冷备份：fnOS 共享目录 `trilium/backups`
- 更新失败现场：`TRIM_PKGVAR/failed-upgrades`
- Trilium 日志：`TRIM_PKGVAR/trilium.log`
- 代理日志：`TRIM_PKGVAR/proxy.log`
- 更新日志：`TRIM_PKGVAR/update.log`

最多保留 5 份按钮更新备份。卸载时是否保留数据由 fnOS 卸载向导选项决定。

## 实现说明

FPK 前端使用 Trilium 自身 Web UI。一个仅使用 Node.js 内置模块的轻量反向代理负责转发 HTTP、API 与 WebSocket，并向 HTML 注入同风格更新控件。飞牛桌面入口采用 `iframe` 窗口，通过[官方统一网关](https://developer.fnnas.com/docs/core-concepts/gateway-registration)转发到本地 Unix Socket `${TRIM_APPDEST}/app.sock`。

本项目是官方 Linux Server 的原生部署封装，使用内置 Linux ELF Node 运行时与原生模块，不依赖 Docker。飞牛窗口内显示的是 Trilium Web UI，并非重写的操作系统原生控件；Electron 桌面壳的系统托盘、原生窗口等能力不包含在 Server 版中。

r5 保留两个 TCP 监听端口：直接访问入口 `0.0.0.0:8080`，内部后端 `127.0.0.1:18888`。飞牛网页入口走网关，不要求浏览器能直接连接 8080。安装启动、代理转发、一键更新重启与回退均使用同一后端端口。启动时向 Trilium 传入 `TRILIUM_NETWORK_TRUSTEDREVERSEPROXY=127.0.0.1`（0.105.0 将环境变量字符串 `true` 视为非法 IP）；发现其他进程占用端口会报错，不会按端口号强制结束其他应用。客户端同步、ETAPI、分享链接继续使用可达的直接入口或单独 HTTPS 反向代理；它们通常没有 NAS 网关登录 Cookie。

r5 网关与父页面同源，CSP 为 `frame-ancestors 'self'`，不依赖请求 Host 猜测飞牛域名，也不开放通配域名。网关剥离转发路径前缀、转换根路径重定向、限定 Cookie 的路径，并保留 Trilium 自身相对资源/API 路径与 WebSocket 路径。一键更新控件根据自身脚本地址定位 API。HTTP 请求体和附件保持原样，客户端断开时释放后端连接；Socket 启动会拒绝覆盖普通文件或正在使用的 Socket，只清理确认失效的 Socket。

### 网页入口排查

r4 的来源白名单只允许同主机不同端口，不能覆盖“飞牛域名与应用域名不同”的情况；HTTPS 页面还可能阻止 HTTP iframe。只有图标/应用详情访问记录、没有文档请求，不能单独证明 CSP 是唯一原因。

安装 r5 后，先登录飞牛，再在相同浏览器访问 `https://你的飞牛域名/app/trilium-fnos/`。预期得到 Trilium 登录/笔记页面；8080 仍可单独用于对照测试。代理日志新增 `fnOS gateway listening` 和不含笔记、Cookie 或 URL 查询参数的 `gateway document ... status=...` 记录。

- 网关返回 404：检查系统版本、安装后 `ui/config` 的 `gatewayPrefix`，刷新飞牛桌面入口缓存。
- 网关返回 502：检查应用是否运行、`${TRIM_APPDEST}/app.sock` 是否存在及代理启动日志。
- 代理返回 503：检查内部后端 18888 和 Trilium 日志。
- 跳回 NAS 登录：先确认飞牛会话仍有效。Trilium 的登录状态与 NAS 会话是独立的。
- OIDC 登录需将提供方回调地址配置到网关前缀下；未配置过的第三方 SSO 和移动 App WebView 仍需单独验收。

构建时 `scripts/verify-fpk.py` 对最终 FPK 进行检查，并逐文件核对官方 Server 发行包的 SHA-256：除已移除的构建机悬空软链接和新增的 VERSION 文件外，官方程序文件必须全部匹配。当前自动化以模拟后端覆盖 TCP/Unix Socket 路由、Cookie、响应头、请求体、WebSocket、更新路径和启停函数；尚未连接真实 fnOS 设备验收 r5 的网页打开、完整编辑、同步、OCR、导入导出和更新回退流程。

发布前仍建议分别在真实 fnOS x86_64 与 ARM64 设备上完成首次安装、重启、WebSocket、大文件导入、在线更新和自动回退验收。

## 上游与许可证

Trilium Notes 由 TriliumNext 社区维护并使用 GNU Affero General Public License v3.0。本工程使用的 Trilium 程序、图标与许可证来自上游：

- <https://github.com/TriliumNext/Trilium>
- <https://docs.triliumnotes.org/>
