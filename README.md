# Trilium Notes for fnOS（纯原生版）

这是面向飞牛 fnOS 的 Trilium Notes 原生 FPK。安装包直接携带 Trilium 官方 Linux Server 发行包及其配套 Node.js 运行时，由 fnOS 应用生命周期脚本启动本机进程。

本项目没有 Docker Compose、没有 `docker-project` 资源声明，也不会把应用用户加入 `docker` 组。因此安装和运行均不依赖 Docker，应用中心图标也不会出现 Docker 小鲸鱼角标。

## 下载

前往 [GitHub Releases](https://github.com/minlonghuo-lab/trilium-fnos-native/releases/latest) 下载对应 CPU 架构的原生 FPK：

- [Intel / AMD 64 位版](https://github.com/minlonghuo-lab/trilium-fnos-native/releases/download/v0.105.0-r2/trilium-fnos-v0.105.0-r2-x86_64.fpk)
- [ARM64 / aarch64 版](https://github.com/minlonghuo-lab/trilium-fnos-native/releases/download/v0.105.0-r2/trilium-fnos-v0.105.0-r2-arm64.fpk)
- [SHA-256 校验文件](https://github.com/minlonghuo-lab/trilium-fnos-native/releases/download/v0.105.0-r2/SHA256SUMS)

> 本项目是社区移植包，与飞牛官方及 TriliumNext 官方没有隶属关系。重要数据请定期自行备份。

## 功能

- 保留 Trilium Web 版的层级笔记、富文本、关系图、画布、思维导图、脚本、同步、加密、导入导出和 ETAPI 等功能。
- 使用 Trilium 官方界面、图标和主题变量，不另做一套割裂的管理界面。
- 飞牛桌面入口默认使用 `8080` 端口。
- 登录后在 Trilium 页面右下角显示“一键更新”按钮；未登录用户不能访问更新接口。
- 提供 x86_64 与 ARM64 两个原生 FPK，内置各自架构的官方运行时。

## 安装包选择

- Intel / AMD 64 位设备：`trilium-fnos-v0.105.0-r2-x86_64.fpk`
- ARM64 / aarch64 设备：`trilium-fnos-v0.105.0-r2-arm64.fpk`

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
appcenter-cli install-fpk trilium-fnos-v0.105.0-r2-x86_64.fpk
```

如果安装旧的 `v0.105.0` 首发包时看到“解压 app.tgz 失败”，请改用 `v0.105.0-r2`。首发包继承了上游构建产物中的悬空绝对软链接；r2 已移除该非运行时链接，并将内外两层 tar 的属主统一为 `root/root`，同时严格限制 FPK 根目录为 fnOS 标准条目。

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

FPK 前端使用 Trilium 自身 Web UI。一个仅使用 Node.js 内置模块的轻量反向代理负责透明转发 HTTP、API 与 WebSocket，并向 HTML 注入同风格更新控件。飞牛桌面入口采用 URL 模式，以兼容 Trilium 的同源安全头、下载、打印和新窗口功能。

这里移植的是 Trilium 官方 Server 的全部浏览器功能；仅限 Electron 桌面壳的操作系统托盘、原生窗口等能力不属于 Server 版功能。

发布前仍建议分别在真实 fnOS x86_64 与 ARM64 设备上完成首次安装、重启、WebSocket、大文件导入、在线更新和自动回退验收。

## 上游与许可证

Trilium Notes 由 TriliumNext 社区维护并使用 GNU Affero General Public License v3.0。本工程使用的 Trilium 程序、图标与许可证来自上游：

- <https://github.com/TriliumNext/Trilium>
- <https://docs.triliumnotes.org/>
