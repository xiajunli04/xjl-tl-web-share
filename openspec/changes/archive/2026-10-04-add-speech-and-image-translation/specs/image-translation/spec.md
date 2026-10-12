## ADDED Requirements

### Requirement: 图片提交
系统 SHALL 允许已登录用户提交图片翻译，入口为 `POST /api/image-translations`，multipart 字段包括：
- `image`：JPG/PNG/WEBP/BMP，不超过 10 MB，宽高 32–8192 px；
- `sourceLang`：默认 auto；
- `targetLang`；
- `engine`：`vision` 默认，或 `qwen-mt-image`；
- `modelConfigId`（可选）；
- `glossaryIds`（可选）。

Spring MUST 把原图保存到 `STORAGE_DIR` 下按日期分目录的文件中，再调用 Python。图片不合法时 MUST 返回 `A0450`。vision 引擎所选模型未标记支持图片输入时 MUST 返回 `C0170`。

#### Scenario: 上传过大的图片
- **WHEN** 用户上传 12 MB 的图片
- **THEN** 系统返回 HTTP 400、code `A0450`

#### Scenario: 模型不支持图片
- **WHEN** 用户指定一个 supports_vision=false 的模型配置进行 vision 引擎翻译
- **THEN** 系统返回 HTTP 400、code `C0170`

### Requirement: 两步法图片翻译流程
vision 引擎 SHALL 依次执行：
1. 预处理：EXIF 旋转校正，长边缩放到不超过 2048 px；
2. `ocr`：视觉模型一次调用，返回文本块与像素 bbox；
3. `terms`：对 OCR 文本做术语匹配；
4. `translate`：一次调用批量翻译全部文本块，以整图文字为上下文，术语作为硬约束；
5. `render`：bbox 还原到原图坐标并归一化到 0–1。

接口 SHALL 以 SSE 返回事件：
- 每个步骤的 `node` 事件（开始/结束、摘要、耗时）；
- OCR 完成后的 `blocks` 事件（原文与 bbox）；
- 翻译完成后的 `translation` 事件（含译文的完整 blocks）；
- 成功时的 `done`（记录 id、tokens、耗时），失败时的 `error`。

OCR 返回非法 JSON 时 MUST 重试一次，仍失败则返回 `error{code:"C0171"}`。图片中没有文字时 SHALL 以 blocks 为空正常完成，并提示"未识别到文字"。

#### Scenario: 菜单照片
- **WHEN** 用户上传一张含 6 行中文菜名的图片，目标语言 en
- **THEN** 依次收到 ocr、terms、translate、render 的 node 事件；blocks 事件含 6 个文本块；done 时每块都有英文译文和位于 [0,1] 的 bbox

#### Scenario: 术语生效
- **WHEN** 术语库含 "宫保鸡丁 → Kung Pao Chicken"，图片中有"宫保鸡丁"
- **THEN** 对应块的译文为 "Kung Pao Chicken"，term_hits 记录该术语已遵循

#### Scenario: 无文字图片
- **WHEN** 用户上传一张纯风景照
- **THEN** 以 done 结束，blocks 为空，页面提示"未识别到文字"

### Requirement: 一体化图片翻译引擎
系统 SHALL 支持 `qwen-mt-image` 引擎：使用 provider=DASHSCOPE、capability=IMAGE_TRANSLATE 的配置，调用百炼 `qwen-mt-image-2.0` 同步接口，下载返回的译图并由 Spring 保存为结果图。该引擎的记录 blocks 为空，页面只提供原图、译图与对比查看。没有可用配置时，引擎列表 MUST 显示该引擎不可用。

#### Scenario: 返回译图
- **WHEN** 用户用 qwen-mt-image 引擎翻译一张英文海报为中文
- **THEN** 记录保存结果图路径，页面「译图」显示返回的图片

### Requirement: 覆盖渲染与查看
图片翻译页 SHALL 在 Canvas 上把译文覆盖渲染到原图对应位置：用 bbox 外扩边框像素的中位色填充背景；文字色取对比度更高者；字号自适应 bbox 并自动换行。页面 SHALL 提供「译图 / 原图 / 对比」三种查看方式，对比为可拖拽分隔滑块。用户 SHALL 可以在文本列表中逐块编辑译文，编辑后 MUST 立即重绘，并通过 `PATCH /api/image-translations/{id}/blocks` 保存。用户可以下载原图分辨率的 PNG 译图，也可以复制全部译文。

#### Scenario: 编辑后重绘
- **WHEN** 用户在「文本」标签页把第 3 块译文改为 "Mapo Tofu"
- **THEN** 画布上该块立即显示新译文，刷新页面后仍为新译文

#### Scenario: 对比查看
- **WHEN** 用户切换到「对比」并拖动滑块到中间
- **THEN** 滑块左侧显示原图，右侧显示译图

### Requirement: 图片输入方式
图片翻译页 SHALL 支持文件选择、拖拽、粘贴剪贴板图片和拍照四种输入。桌面端拍照使用 `getUserMedia` 取景弹窗，可切换摄像头；移动端使用 `capture="environment"` 的文件输入。摄像头不可用或权限被拒时 SHALL 给出提示，并保留其他输入方式。

#### Scenario: 粘贴截图
- **WHEN** 用户在图片翻译页按 Ctrl+V 粘贴一张截图
- **THEN** 该截图进入处理流程，与上传效果一致

### Requirement: 图片翻译记录
系统 SHALL 为每次成功的图片翻译保存记录：引擎、模型、原图与结果图路径、尺寸、语言、blocks、术语命中、步骤轨迹、token 和耗时。用户 MUST 只能访问自己的记录和图片文件（`GET /api/image-translations/{id}/image`、`GET /api/image-translations/{id}/result-image`）；收藏与逻辑删除规则与文本历史一致，删除时 SHALL 异步删除图片文件。

#### Scenario: 访问他人图片
- **WHEN** 用户 A 请求用户 B 的图片文件
- **THEN** 系统返回 HTTP 404、code `A0404`
