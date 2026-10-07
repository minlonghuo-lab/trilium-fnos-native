# Trilium Notes for fnOS · 原生版

直接运行 Trilium 官方 Linux Server 与配套 Node.js，不依赖 Docker，不包含 Electron 桌面壳。编辑器、主题、同步、ETAPI、导入导出等使用官方 Server 实现。

当前本体：**Trilium 0.106.0**。当前封装：**v0.106.0-r1**。

- 开发者：[TriliumNext](https://github.com/TriliumNext/Trilium)
- 发布者：[Epochwl](https://github.com/minlonghuo-lab/trilium-fnos-native)

本项目是社区封装，与 TriliumNext、飞牛官方没有隶属关系；开发者字段标明上游作者，不代表官方发布或背书。

## 安装包

从 [GitHub Releases](https://github.com/minlonghuo-lab/trilium-fnos-native/releases/tag/v0.106.0-r1) 下载对应架构的 FPK 与 SHA-256 校验文件。本地构建产物位于 dist/。

- Intel/AMD：trilium-fnos-v0.106.0-r1-x86_64.fpk
- ARM64：trilium-fnos-v0.106.0-r1-arm64.fpk
- 校验文件：dist/SHA256SUMS

fnOS 国内版要求至少 1.1.3100。在应用中心按 NAS 架构手动安装。首次打开按 Trilium 向导设置密码。飞牛桌面通过 /app/trilium-fnos/ 同源网关打开新页面，手机呈现方式由飞牛 App WebView 决定。

## 此版本改动

- 官方运行时升级到 0.106.0；后续封装命名遵循 v<Trilium版本>-r<封装修订号>。
- 删除封装在线更新按钮、检查/下载/切换/回退接口及进度轮询。旧更新接口返回 404/405，后续通过手动安装新 FPK 升级。
- 菜单只提供“电脑端同步”：地址、复制、连接说明。继承当前 Trilium 主题；独立访问或存储不可用时使用系统明暗主题。
- 原生菜单中的下载提示在 fnOS 界面隐藏；不修改官方程序和数据库设置。上游自身的发布检查设置不属于封装更新器。
- 同步辅助脚本在编辑器启动时不查询 API 或 GitHub，按需读取同步地址；没有 CDN 或额外运行依赖。
- 使用短间隔、有上限的就绪检查，核对进程身份、端口和网关 Socket；快速查找候选进程，发信号前再次核对身份。
- 保留静态资源压缩传输，不向附件和分享 HTML 注入辅助代码。HTTP 流、WebSocket 与同步认证继续透传。

## 手动升级

1. 先备份重要笔记，确认客户端版本兼容；旧版在线更新若正在执行，等待完成。
2. 在飞牛应用中心停止应用，再手动安装新 FPK。不需要卸载，不要删除应用数据。
3. 升级前脚本调用同目录生命周期脚本停服务，然后创建并校验数据归档；失败中止升级。升级过程中请勿断电。
4. 启动后关闭旧页面并重新打开。首次数据库迁移可能比后续启动慢，不要反复点击启动。

备份位于 trilium/backups 共享目录；无共享路径时回退到应用数据目录的 update-backups。旧版在线更新留下的备份、运行时和失败现场不会自动删除。

移除在线更新器后不再提供在线自动回退。升级失败时保留日志与备份，不要让旧版程序直接打开已迁移数据库；必要时停服恢复升级前数据。不要向已安装更高本体版本的实例安装较低版本。

## 电脑端同步

登录 Trilium，全局菜单 → **电脑端同步**。页面显示检测到的局域网候选地址。

| 用途 | 地址 |
| --- | --- |
| 飞牛网页入口 | https://飞牛域名/app/trilium-fnos/，依赖飞牛登录 |
| 可信局域网同步 | http://NAS固定IP:8080/，使用 Trilium 同步认证 |
| 外网同步 | 独立 HTTPS 域名反向代理至 NAS 8080，或私有 VPN |
| 内部后端 | 127.0.0.1:18888，不对电脑开放 |

新电脑可在初始化时选择从同步服务器同步，填写独立地址与 Trilium 密码；已有客户端在设置 → 同步中配置并测试。两端使用兼容版本、校准时间并先备份；不同笔记库不能假定可无损合并。

不要把飞牛网关、/__fnos/ 或 18888 当作同步地址。多网卡地址只是候选，需从电脑验证可达性；建议固定 NAS IP。默认入口端口为 8080，fnOS 若配置其他服务端口，页面使用实际端口。

关闭网页不会停止后台服务。应用停止、NAS 断网、重启或升级期间暂时不可同步；正常重启不会随机换端口或数据目录。开机自启动需在 fnOS 中启用并实机验证。

## 数据与日志

- 笔记数据：TRIM_PKGVAR/trilium-data
- 运行时链接：TRIM_PKGVAR/runtime/current
- 后端日志：TRIM_PKGVAR/trilium.log
- 代理日志：TRIM_PKGVAR/proxy.log
- 升级备份：共享目录 trilium/backups，不自动轮换删除

网关会话使用独立 Cookie 名称并限制路径，HTTPS 网关保留 HttpOnly、Secure 和 SameSite=None。直连与网关会话互不覆盖。iPhone WebView Cookie 限制仍取决于系统与飞牛 App；登录循环时可用 Safari 直连对照测试，不应关闭鉴权绕过。

## 构建与验证

在 macOS/Linux 开发机执行：

    ./scripts/build.sh
    UPSTREAM_VERSION=v0.106.0 PACKAGE_VERSION=0.106.0-r1 ./scripts/build.sh

指定其他本体版本时默认使用该版本加 -r1。构建校验官方 Release SHA-256，使用官方 fnpack 1.2.3 打包。内外归档统一 root/root，移除已知构建机悬空软链接；最终逐文件核对官方载荷，不修改官方程序文件。

    ./scripts/validate.sh
    node --test tests/*.test.js
    node tests/fixtures/sync-ui-server.js

浏览器 fixture 使用模拟地址，不打入 FPK。自动化覆盖权限、Cookie、HTTP/WebSocket、同步透传、在线更新接口移除、生命周期和同步菜单。Mac 构建机不能原生执行 Linux Server；尚无真实 NAS 启动速度前后计时，不将模拟测试视为 NAS 或 iPhone 实机验收。

## 排查

- 网关 404：检查 fnOS 版本、入口配置并刷新飞牛桌面。
- 网关 502：检查服务状态及 app.sock。
- 代理 503：查看后端日志；数据库迁移期间稍候重试。
- 端口占用：检查实际监听者，不会按端口号结束其他应用。
- 同步失败：检查独立地址可达性、版本兼容和系统时间。NAS 网关登录与 Trilium 同步认证是两回事。

## 许可证

Trilium Notes、图标及官方程序来自 [TriliumNext/Trilium](https://github.com/TriliumNext/Trilium)，遵循 GNU AGPL v3.0，许可证与第三方声明随 FPK 载荷提供。

参考：[官方同步指南](https://docs.triliumnotes.org/user-guide/setup/synchronization)、[飞牛开发指南](https://developer.fnnas.com/)。
