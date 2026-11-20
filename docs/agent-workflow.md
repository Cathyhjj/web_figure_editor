# Codex / Claude Code 作图，前端精调

Agent 和前端操作同一份可编辑项目。Agent 可以准备素材、新建画布、排版、添加文字与形状；你可以随时在页面中拖动、缩放、改色、改字号。每次 agent 批量操作对应一个 Undo 步骤。

## 1. 启动与连接

首次使用，在仓库运行以下命令。把素材目录换成存放绘图输出的现有目录。若图片已经在编辑器的素材库里，可直接运行 `python3 figure_cli.py setup`。

```sh
python3 figure_cli.py --asset-root "/你的素材目录" setup
```

运行输出中的 `register.codex` 或 `register.claude` 命令，重新加载对应客户端的 MCP 工具。已有本地服务时直接打开输出中的 `editorUrl`（默认 `http://127.0.0.1:8766/`）。首次启动服务用 `startServer` 中的命令。保持编辑器页面打开，等到 **AI connected** 后即可作图。更新代码后，先保存手上的图，再刷新页面并重新加载 MCP 工具。

`import_assets.paths` 使用相对于 `--asset-root` 的路径，可导入 SVG、PNG、JPEG。若服务使用其他端口，在 `setup` 前加上 `--port` 和端口号。

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

Agent 用你的数据和绘图脚本输出 SVG/PNG/JPEG，再通过 `figure_import_assets` 导入，通过 `place_asset` 放置。只指定 `width` 或 `height` 会保持图框比例。面板标号、说明文字、箭头可分别建成独立对象。

要把长宽比不同的谱图放进同样大的图框，在 `place_asset` 的 `properties` 中指定 `width`、`height` 和 `"imageFit": "contain"`。编辑器会等比居中显示谱图。`set` 也支持相同的图片属性。例如，保留原图右半幅并保持现有图框，可用以下操作，两个 ID 均从实际页面读取。

```json
{
  "op": "set",
  "slideId": "实际页面ID",
  "itemIds": ["实际图片对象ID"],
  "properties": {
    "imageFit": "contain",
    "crop": { "x": 0.5, "y": 0, "width": 0.5, "height": 1 }
  }
}
```

`crop` 的坐标和宽高是相对于完整原图的比例。用 `"crop": null` 恢复原图。在 `contain` 模式下裁剪会保留外框。在默认的 `stretch` 模式下裁剪会保持源图缩放并调整外框。一次同时指定多项属性时，依次处理适配方式、裁剪、显式位置和尺寸。

图片支持单边羽化。例如在 `set` 或 `place_asset` 的 `properties` 中使用 `{"softEdgeMode":"single","softEdge":15,"softEdgeAngle":90,"softEdgeStrength":50}`，即可让图片从上边向内渐显。宽度单位为 pt，范围为 0–100。强度 `softEdgeStrength` 可设为 0–300，省略时为 100。0 关闭单边羽化，50 使最外缘保留一半原有不透明度，100 使最外缘完全透明。超过 100 后，渐变区域内部会进一步变淡，宽度保持不变。例如 200 时，渐变中点保留四分之一的原有不透明度。0°、90°、180°、270° 分别对应左、上、右、下，中间角度对应斜向渐变。将 `softEdge` 设为 0 可关闭羽化，将 `softEdgeMode` 设为 `all` 可切回四边羽化。

使用 `{"softEdgeMode":"radial","softEdgeAngle":315,"softEdgeRadius":50}` 可从图片左下角向内做圆形羽化。角度沿图片周边定位圆心，半径按当前显示图像短边的百分比计算，范围为 0–200，默认 50。径向羽化使用同一强度设置，半径或强度设为 0 即可关闭。

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

`state.json` 内容为 `{"sessionId":"实际页面ID"}`，`composition.json` 使用上述示例的完整结构。`--args -` 从标准输入读取 JSON。

如果 agent 刚生成了一张谱图，而已注册的 MCP 没有配置素材目录，可用 CLI 为这次导入指定输出目录。然后直接用返回的 `assetId` 在原 MCP 会话中排版。例如，目录里有 `spectrum.svg` 时，准备以下 `imports.json`，填入实时读取的 session 和 revision。

```json
{"sessionId":"实际页面ID","expectedRevision":"当前版本","paths":["spectrum.svg"]}
```

```sh
python3 figure_cli.py --asset-root /absolute/path/plot-output call import_assets --args imports.json
```

成功输出 JSON：`{"ok":true,"result":{...}}`。预览图写入新的 PNG 文件，路径在 `images[].path`；不会把图片 base64 塞进终端上下文。`tools` 可离线查看完整 JSON Schema。失败返回非零退出码和标准错误中的 JSON，不自动重试。CLI 不会自动挑选 session 或覆盖 revision。

## 5. 前端交接与保存

在图层列表选择图片，进入 **Format Picture → Picture → Fit, Crop & Source**。用 **Picture fit** 选择等比居中（**Fit proportionally**）或拉伸填满（**Stretch to frame**）。在同一区域可裁剪、恢复原图或编辑 SVG 元素。面板标号等独立文字可直接在画布上点选修改。

需要让 agent 接着改时，选中图层，多选可用 Shift 加点。点击 **Layers → Copy AI reference**，将引用和修改要求一起粘贴给 Codex 或 Claude Code。例如：“只把这两张图等宽、顶部对齐，保留我刚调好的裁剪。” 没有选中图层时，复制的是当前页引用。

Agent 用引用里的 `sessionId`、`slideId` 调用 `figure_get_state`，核对 `project.id` 和所选对象 ID，按当前 revision 预览和应用。引用记录点击复制时的对象。换选图层后可重新复制。标签页重连会生成新 session，需从目标页复制新引用。

首次保存 `.figure.json` 时在页面点击 **Save** 选择文件；之后 `figure_save(destination="file")` 可以保存到该已授权文件。`destination="draft"` 只保存浏览器恢复草稿。导出的 PNG/PDF 等不是可继续编辑的项目文件。

最后运行 `figure_check_export` 检查目标格式、越界对象和有效位图 DPI，再调用 `figure_export`。若命令超时，先读状态确认是否已执行，再决定下一步。
