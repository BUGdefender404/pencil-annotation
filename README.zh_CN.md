# Pencil 手写批注 / Pencil Annotation

在思源笔记文档上手写批注的插件：像 GoodNotes 一样用 **Apple Pencil / 触控笔**在整篇文档上方自由书写，支持压感钢笔、荧光笔、橡皮擦和笔迹选择移动。**笔迹按文档存放于插件私有数据目录，随思源云同步**——iPad 上写的字，电脑上自动出现，换机、重装都不丢。

> 灵感来自 [Cherise233/siyuan-document_drawing-plugins](https://github.com/Cherise233/siyuan-document_drawing-plugins)（该项目未上架插件市场、未附带源码与开源协议）。本项目为全新 TypeScript 实现，未复用其代码，并在数据可靠性（云同步存储）与笔迹质量（真实压感）上做了重点改进。

## 功能

- **压感钢笔**：基于 Pointer Events 读取触控笔压感，支持 Android 手写笔和 Apple Pencil（取决于设备/浏览器上报能力）；鼠标绘制默认关闭，开启后使用固定粗细。
- **荧光笔**：半透明、`multiply` 混合，标记文字时文字依然清晰可见，重叠处自然加深（单笔内部不会出现交叠深点）。
- **橡皮擦**：整笔擦除（笔画级），拖动即擦，可选大小，带光标圈。
- **选择**：点选笔迹后可整体拖动、复制、删除。
- **撤销 / 重做**：工具栏按钮（桌面端另有 `Ctrl+Z` / `Ctrl+Shift+Z`），最多 100 步。
- **输入分离（手写优先）**：手写模式下笔负责绘制、手指只翻页（含表格横向滚动），鼠标绘制默认关闭，真鼠标仍可编辑正文。笔正在书写时屏蔽掌触；触摸勾选任务、拖表格或编辑文字前先退出手写模式。退出后恢复普通笔/触摸操作。
- **笔尖双击**：在页面上快速点两下，切换钢笔 ↔ 橡皮擦。默认关闭，避免点号/短笔画被误识别；已有用户的明确设置保留，可自行关闭。不是笔身双击手势。
- **浮动工具栏**：可拖动的工具球 + 展开面板，位置记忆；设置可隐藏工具球，桌面顶栏/命令仍可切换手写。手机、平板可从插件设置重新显示工具球；小屏工具栏自动分行。
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

> 笔迹首次读取完成前不接受绘制；读取失败不会作为空文档覆盖旧数据，联网恢复或重新开启手写模式后重试。同一页面的分屏共享文档状态，保存请求按文档串行执行。保存失败会提示并最多自动重试三次，未保存数据仍在当前会话中，**请勿关闭页面**；关闭/隐藏时的补存不能保证抵抗浏览器强杀或断电。
>
> 多设备同步仍采用笔迹 ID 并集合并，不是实时协同或删除冲突解决协议；请避免多端同时修改同一文档。

## 安装（开发版）

1. 本仓库构建：`npm install && npm run build`，产物在 `build/`；
2. 把 `build/` 里的所有文件复制到 `{思源工作空间}/data/plugins/pencil-annotation/`，或：
   ```bash
   node scripts/copy-assets.mjs "C:\path\to\你的工作空间\data\plugins"
   ```
3. 重启思源（或「设置 → 集市 → 重载」），在「设置 → 集市 → 已下载」中启用 **Pencil 手写批注**。

### Docker、Android 平板/手机与浏览器 PWA

插件声明支持 `docker` 后端以及桌面/移动浏览器前端。Docker 下将构建产物放到**容器实际工作空间**的 `data/plugins/pencil-annotation/`，并持久化挂载整个工作空间、确保可写。绘图在浏览器端进行，容器无需接入手写笔或安装 Node.js。

Android 平板、支持手写笔的手机及浏览器 PWA 使用同一套输入处理；笔须被浏览器识别为 `pointerType="pen"` 才有真实压感。若数位板驱动只上报 `mouse`，浏览器无法把它与真鼠标区分：优先启用驱动的笔/压感模式（Windows 下检查 Windows Ink），或开启「鼠标绘制」作为兼容方案。报告问题时请注明系统、浏览器版本、笔型号和是否使用 PWA。

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
- 手写模式下：透明画布仅显示笔迹；在浏览器/思源的触摸转鼠标逻辑之前接管绘图与触摸事件。手指移动按动画帧翻页并提供有限惯性，不触发正文编辑；鼠标仍可正常编辑（除非开启鼠标绘制）；
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
npx playwright install chromium webkit
npm test            # Chromium / WebKit 回归，可用 BROWSER=chromium 只跑一个引擎
# 可选：启动隔离的临时工作空间，验证真实思源内核与浏览器前端
SIYUAN_KERNEL=/path/to/SiYuan-Kernel npm run test:host
npm run pack        # 构建 + 生成 package.zip（上架用）
```

测试台（`test/harness.html`）模拟思源编辑器 DOM。`npm test` 覆盖独立 Pointer/Touch/Mouse 流隔离、八方向快速短笔画、丢失捕获后继续采样、笔尖终点、掌触与分屏、工具栏指针归属、按帧翻页、保存竞争及小屏布局。Chromium 还通过浏览器协议注入笔和触摸事件；`test:host` 在真实思源移动前端交叠注入笔与掌触并验证端点、正文状态和持久化。它使用临时工作空间，不读取或修改已有笔记。

自动化浏览器及移动视口模拟**不等同于 Android/iPad 真机或已安装 PWA 验证**。真实压感、系统防误触和系统打断仍需对应设备复验；WebKit 自动化的笔事件为合成事件。

## 目录结构

```
src/
  engine/       # 纯 TS 绘图核心：types / geometry / renderer(perfect-freehand) / store(撤销·序列化)
  overlay/      # 每编辑器覆盖层：overlay.ts(输入·手势·渲染) / toolbar.ts(浮动工具栏) / icons.ts
  plugin/       # 思源集成：api.ts(内核读写·上传·插块) / settings.ts / exportImage.ts / exportDialog.ts
  index.ts      # 插件入口：生命周期 / 事件总线 / 保存调度 / 设置面板
```

## 已知限制（v1 路线图）

- 笔迹使用 CSS 像素坐标，可随锚定的文字块平移，但并非字符级绑定：屏幕像素密度本身不是问题；电脑/平板/手机排版宽度、字号或换行不同后，圈线不保证仍精确贴合文字。精确标记文字请使用思源原生文字高亮；
- 无图层、无套索多选、无像素级橡皮（计划后续版本）；
- 撤销历史仅保存在当前会话内存中，关闭文档后清零（笔迹本身已持久化）；
- 长文档采用视口画布 + 可视区裁剪渲染，笔迹数以千计时滚动重绘可能需要进一步的瓦片缓存优化。

## 协议

MIT
