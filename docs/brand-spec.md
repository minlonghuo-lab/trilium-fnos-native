# Trilium 同步页适配

- 参考：TriliumNext/Trilium v0.106.0，`apps/client/src/widgets/type_widgets/options/sync.tsx`、`stylesheets/theme-next/forms.css`。
- 标志：沿用已有官方 `trilium-fnos/ICON.PNG`，不重绘品牌图形。
- 页面角色：桌面/手机上的简洁同步设置说明，不是营销页面。
- 主题：继承当前 Trilium main/card/input/button/text CSS 变量；独立访问时使用明暗中性色回退。
- 字体：当前 Trilium 字体栈；无网络字体或 CDN。
- 间距：8px 基础，16/24px 内容间距。按钮/输入框约 6px 圆角，区块 8px。
- 交互：只保留地址复制、读取重试和返回；键盘可操作，手机触摸区域不小于 44px。
- 不增加更新选项、广告、统计、装饰性图表或悬浮按钮。
- 初稿：`docs/sync-preview.html`；其中地址为明确标记的占位信息。
