# Codex / Claude Code 作图，前端精调

Agent 和前端操作同一份可编辑项目。Agent 可以准备素材、新建画布、排版、添加文字与形状；你可以随时在页面中拖动、缩放、改色、改字号。每次 agent 批量操作对应一个 Undo 步骤。

## 1. 启动与连接

在仓库运行 `python3 server.py`，打开 `http://127.0.0.1:8766/`，等待 **AI connected**。Agent 控制需要该页面保持打开。

将以下路径替换为仓库和绘图输出目录的绝对路径。按所用客户端注册一次，然后重新加载客户端的 MCP 工具：

```sh
codex mcp add figure-editor -- python3 /absolute/path/web_figure_editor/figure_mcp.py --asset-root /absolute/path/plot-output
claude mcp add --transport stdio figure-editor -- python3 /absolute/path/web_figure_editor/figure_mcp.py --asset-root /absolute/path/plot-output
```

`--asset-root` 是 agent 导入 SVG、PNG、JPEG 的目录；传给 `import_assets.paths` 的路径必须相对此目录。服务端口不是 8766 时，在适配器参数中追加 `--port`。无需额外 Python 依赖。更新代码后重启 MCP 进程并刷新编辑器，让两端加载新操作。

仓库的 `AGENTS.md` / `CLAUDE.md` 提供操作约定。可以直接告诉 agent：

> 读取当前 Figure Editor 页面，将我的四张 SVG 排成 2×2 组图，新建 800×600 px 的页面，添加独立的 a–d 标签，保持图片比例。先检查预览，再应用；所有文字和标注都要能在前端继续修改。

## 2. 从空白画布建立可编辑图稿

1. `figure_sessions` 找到目标页面，再用 `figure_get_state` 获取 `sessionId`、`revision` 和已有 ID。多个页面时按项目确定目标。
2. 将 [examples/agent-composition.json](../examples/agent-composition.json) 复制为工作文件，填入实际 session 和 revision。示例完全由原生文字、矩形和箭头组成，不需要导入素材。若 `editable-workflow` 已存在，换一个新的 slide ID，并同步后续操作。
3. 用相同参数调用 `figure_preview_batch`，查看图像。预览默认显示批次结束时的活动页，因此能直接预览尚未创建的新页。
4. 用相同操作和 revision 调用 `figure_batch_edit`。新页自动选中，结果返回 `createdSlideIds`、`createdItemIds` 和新的 revision。整个批次只占一个 Undo 步骤。
5. 在前端继续调节；下一次 agent 修改前重新读取状态。

| 操作 | 用法 |
| --- | --- |
| `add_slide` | 指定一个新的 `slideId`，可选 `name`、`canvas: {width, height, background}`。插入到当前页之后并选中；未指定的画布属性继承当前页。ID 为 1–100 个字母、数字、`_` 或 `-`，首字符为字母或数字。 |
| `set_slide` | 修改已有页的名称或部分画布属性，已有对象的位置和尺寸保留。缩小画布后用 `check_export` 检查越界。 |
| `add_shape` | `shapeType` 为 `rect`、`roundRect`、`ellipse`、`line`、`arrow` 或 `doubleArrow`；`properties` 设置名称、位置、尺寸、旋转和样式。 |
| `add_text` | 创建独立文字框，设置 `text`、`fontSize`、`fontFamily`、`fontWeight`、`color`、`align` 等。 |
| `set` | 用 `itemIds` 修改现有对象。形状支持 `fill`、`fillOpacity`、`stroke`、`strokeWidth`、`strokeOpacity`、`strokeDash`；图片支持描边属性。设置 `fill` / `stroke` 会清除该通道的渐变，使用指定纯色。 |

画布几何统一为 CSS px，96 px = 1 inch；毫米乘以 `96 / 25.4` 可换算为 px。设置画布宽高时允许 64–8000 px，与前端画布控件一致。横线/水平箭头使用 `height: 0`，竖线使用 `width: 0`，斜线可用正宽高和旋转。透明度为 0–1，`strokeDash` 为 `solid` / `dash` / `dot`，圆角矩形的 `cornerRadius` 为短边的 0–0.5 倍。`fill` 不适用于线条，`cornerRadius` 只适用于 `roundRect`。

## 3. 科学绘图与修改源图

Agent 用你的数据和绘图脚本输出 SVG/PNG/JPEG，再通过 `figure_import_assets` 导入，通过 `place_asset` 放置。只指定 `width` 或 `height` 会保持图片比例。建议把面板标号、说明文字、箭头等做成独立对象。

SVG 可以在前端 **Edit SVG elements** 中修改文本和属性，也可以通过 `inspect_svg` / `edit_svg` 操作。生成 SVG 时保留文本有助于后续改字；已转为路径的文字不能直接当文本修改。PNG/JPEG 只能整体裁剪、缩放和调整效果，不会自动恢复内部曲线或坐标轴数据。

源图重算后，使用 `check_sources` 找到变化 → `import_assets` 导入新版本 → 预览 `replace_asset` → 应用到明确选中的面板。它保留前端调好的位置、图框、裁剪和样式；`swap_asset` 则清除裁剪并把完整新图按比例放入原图框。源图比例改变后应检查裁剪内容。

## 4. 不配置 MCP 也能使用 CLI

CLI 与 MCP 共享工具定义、校验和版本检查，不需要另起服务：

```sh
python3 figure_cli.py tools
python3 figure_cli.py tools batch_edit
python3 figure_cli.py sessions
python3 figure_cli.py call get_state --args state.json
python3 figure_cli.py call preview_batch --args composition.json
python3 figure_cli.py call batch_edit --args composition.json
```

`state.json` 内容为 `{"sessionId":"实际页面ID"}`；`composition.json` 使用上述示例的完整结构。`--args -` 从标准输入读取 JSON。全局参数放在子命令之前，例如：

```sh
python3 figure_cli.py --asset-root /absolute/path/plot-output --output-dir /absolute/path/previews call import_assets --args imports.json
```

成功输出 JSON：`{"ok":true,"result":{...}}`。预览图写入新的 PNG 文件，路径在 `images[].path`；不会把图片 base64 塞进终端上下文。`tools` 可离线查看完整 JSON Schema。失败返回非零退出码和标准错误中的 JSON，不自动重试。CLI 不会自动挑选 session 或覆盖 revision。

## 5. 前端交接与保存

在图层列表选择对象，直接拖动或调整属性。形状使用 **Fill & Line** / **Size & Properties**；文字可以改内容、字号和字体；图片可以裁剪或编辑 SVG 元素。前端修改后旧 revision 会失效，防止 agent 覆盖刚才的手工调整。

首次保存 `.figure.json` 时在页面点击 **Save** 选择文件；之后 `figure_save(destination="file")` 可以保存到该已授权文件。`destination="draft"` 只保存浏览器恢复草稿。导出的 PNG/PDF 等不是可继续编辑的项目文件。

最后运行 `figure_check_export` 检查目标格式、越界对象和有效位图 DPI，再调用 `figure_export`。若命令超时，先读状态确认是否已执行，再决定下一步。
