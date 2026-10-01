# Pencil 手写批注 / Pencil Annotation

在思源笔记文档上手写批注的插件：像 GoodNotes 一样用 **Apple Pencil / 触控笔**在整篇文档上方自由书写，支持压感钢笔、荧光笔、橡皮擦和笔迹选择移动。**笔迹按文档存放于插件私有数据目录，随思源云同步**——iPad 上写的字，电脑上自动出现，换机、重装都不丢。

> 灵感来自 [Cherise233/siyuan-document_drawing-plugins](https://github.com/Cherise233/siyuan-document_drawing-plugins)（该项目未上架插件市场、未附带源码与开源协议）。本项目为全新 TypeScript 实现，未复用其代码，并在数据可靠性（云同步存储）与笔迹质量（真实压感）上做了重点改进。

## 功能

- **压感钢笔**：基于 Pointer Events 的真实压感（Apple Pencil），粗细随手写力度自然变化；鼠标/触控板输入自动退化为基于速度的模拟压感。
- **荧光笔**：半透明、`multiply` 混合，标记文字时文字依然清晰可见，重叠处自然加深（单笔内部不会出现交叠深点）。
- **橡皮擦**：整笔擦除（笔画级），拖动即擦，可选大小，带光标圈。
- **选择**：点选笔迹后可整体拖动、复制、删除。
- **撤销 / 重做**：工具栏按钮（桌面端另有 `Ctrl+Z` / `Ctrl+Shift+Z`），最多 100 步。
- **手掌防误触**：手写模式下手指触摸用于滚动页面，仅触控笔可落笔（可在设置中关闭，改为手指也可绘制）。
- **Apple Pencil 双击**：用笔在页面上快速双击，切换钢笔 ↔ 橡皮擦（可在设置中关闭）。
- **浮动工具栏**：可拖动的工具球 + 展开面板，位置记忆；桌面端另有顶栏按钮入口。
- **导出**：把手写内容合成 PNG（白底/透明底可选），保存到 assets，并可一键插入文档末尾。
- **中英双语界面**。

## 数据存储与多设备同步

每篇文档的笔迹保存为一个 JSON 文件：

```
{工作空间}/data/storage/petal/pencil-annotation/{文档ID}.json
```

该目录属于思源插件私有数据区，**参与思源的加密云同步**：

- 在 iPad 写下笔迹 → 防抖 1.2 秒后自动保存；
- 其他设备同步到新笔迹时，当前打开的编辑器会**按笔迹 ID 增量合并**并提示"已合并来自其他设备的笔迹"；
- 双端同时修改同一篇文档时，按笔迹 ID 取并集（同 ID 本地优先）。

> 注意：清空笔迹走撤销可恢复；若在两台设备上各自删除了同一笔迹，合并后会以最后保存的一方为准。

## 安装（开发版）

1. 本仓库构建：`npm install && npm run build`，产物在 `build/`；
2. 把 `build/` 里的所有文件复制到 `{思源工作空间}/data/plugins/pencil-annotation/`，或：
   ```bash
   node scripts/copy-assets.mjs "C:\path\to\你的工作空间\data\plugins"
   ```
3. 重启思源（或「设置 → 集市 → 重载」），在「设置 → 集市 → 已下载」中启用 **Pencil 手写批注**。

### 在 iPad 上使用

**方式一：插件市场安装（推荐）**。本插件已提交至思源官方集市收录（[PR](https://github.com/siyuan-note/bazaar/pulls?q=is%3Apr+ BUGdefender404%2Fpencil-annotation)）：PR 合并后，在 iPad 端思源「设置 → 集市 → 插件」中搜索 **Pencil 手写批注** 或 **pencil-annotation** 直接安装即可，之后版本更新也会出现在集市中。

**方式二：浏览器访问（临时/测试）**。iPad Safari 打开桌面端思源的局域网地址（如 `http://192.168.x.x:6806`），插件在移动浏览器前端同样可用。

> iOS 端工作空间在应用沙箱内，无法像桌面端那样直接把文件拷进 `data/plugins`；除市场安装外，移动浏览器访问是最轻量的验证方式。

## 发布流程（维护者）

1. 更新 `plugin.json` 的 `version` 与 `CHANGELOG.md`；
2. `npm run pack` 生成 `package.zip`；
3. 在 GitHub 创建同名 tag 的 Release（如 `v0.1.0`）并附上 `package.zip`：`gh release create v0.1.0 package.zip`；
4. 首次上架：向 [siyuan-note/bazaar](https://github.com/siyuan-note/bazaar) 的 `plugins.txt` 添加一行 `BUGdefender404/pencil-annotation` 并提 PR；后续新版本只需发 Release，集市会自动拉取。

## 使用

- 点击顶栏按钮（桌面）或屏幕上的**笔形工具球**（全平台）进入/退出手写模式；
- 手写模式下：文档区域被透明画布接管，直接书写；手指仍然滚动页面（默认开启防误触时）；
- 工具栏从左到右：钢笔 / 荧光笔 / 橡皮擦 / 选择 · 颜色与粗细 · 撤销 / 重做 / 导出 / 清空 · 设置 / 收起；
- 选中笔迹后工具栏会出现 复制 / 删除 / 完成 三个操作按钮；
- 「清空」有确认弹窗，且清空本身可撤销。

## 开发

```bash
npm install
npm run typecheck   # 类型检查
npm run build       # 构建 → build/（自动拷贝 plugin.json / i18n / 图标 / 样式）
npm run deploy -- "工作空间/data/plugins 的路径"   # 构建并部署
npm run harness     # 打开浏览器测试台 http://localhost:5199/test/harness.html
npm run pack        # 构建 + 生成 package.zip（上架用）
```

测试台（`test/harness.html`）模拟思源编辑器 DOM，用合成 PointerEvent（含压感）驱动真实输入路径，可离线验证绘制、荧光笔混合、擦除、选择、手势与导出，无需启动思源。

## 目录结构

```
src/
  engine/       # 纯 TS 绘图核心：types / geometry / renderer(perfect-freehand) / store(撤销·序列化)
  overlay/      # 每编辑器覆盖层：overlay.ts(输入·手势·渲染) / toolbar.ts(浮动工具栏) / icons.ts
  plugin/       # 思源集成：api.ts(内核读写·上传·插块) / settings.ts / exportImage.ts / exportDialog.ts
  index.ts      # 插件入口：生命周期 / 事件总线 / 保存调度 / 设置面板
```

## 已知限制（v1 路线图）

- 笔迹按**文档坐标**锚定：调整窗口宽度、改字号导致正文重排后，笔迹不会跟随文字移动（与在 PDF 上批注同理）；
- 无图层、无套索多选、无像素级橡皮（计划后续版本）；
- 撤销历史仅保存在当前会话内存中，关闭文档后清零（笔迹本身已持久化）；
- 长文档采用视口画布 + 可视区裁剪渲染，笔迹数以千计时滚动重绘可能需要进一步的瓦片缓存优化。

## 协议

MIT
