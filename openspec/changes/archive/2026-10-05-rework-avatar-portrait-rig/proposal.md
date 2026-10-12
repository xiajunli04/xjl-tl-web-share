## Why

⑧ 落地的 VRM 数字人用的是通用示例模型，形象普通，和设计师给出的“高级好看、按语言换形象”的概念相差很远。用户确认了国风二次元方向的概念图（`docs/design/avatar-concepts/11–13`），要求数字人与概念图 **1:1 一致**、去掉耳机，并先做中、英、日、韩四个语言形象；代码可以推翻重写。

实时 3D 建模难以 1:1 还原 2D 概念图：重新捏人会丢失画风，AI 图转 3D 得到的模型缺少表情与口型控制。网关上也没有可用的图生视频模型。可行的做法是直接让概念立绘“动起来”：用同一张立绘的局部变体（嘴型、眨眼、眼神、表情）做实时叠加，再用深度图做视差和微动。这种做法的画面就是概念图本身。

## What Changes

- **BREAKING（前端内部）**：移除 VRM 数字人，即 `@pixiv/three-vrm`、`@react-three/fiber`、`public/avatars/lumi.vrm`、`vrm-rig`、`avatar-canvas` 与 `optimize-vrm.py`。
- **新增立绘绑定（Portrait Rig）渲染**：
  - 用一个 three.js 全屏四边形着色器渲染：底图，加上按权重混合的局部叠加层（嘴型 small/aa/oh/ee、闭眼、抬眼、开心），配合深度图视差（随指针、呼吸、说话时轻点头），以及抠像蒙版让背景透明；
  - 口型由播放音频的频谱驱动，沿用现有 `lipsync`；
  - 保留 `deriveAvatarState` 五状态。
- **新增资源流水线**：
  - `web/scripts/avatar/generate.py` 调用图像编辑接口，生成每个形象的底图与 9 张变体，提示词随仓库保存，可复现；
  - `web/scripts/avatar/build.py` 用差分自动提取局部叠加层，压缩为 WebP，生成 `manifest.json`；
  - 原始图不入库，只提交 `public/avatars/<id>/` 下的成品。
- **首批四个形象**：
  - `zh`：青花瓷旗袍；
  - `en`：金发、藏青西装；
  - `ja`：和服、花簪；
  - `ko`：韩服。

  四人统一品牌名 Lumi，即“一个 AI，多种语言形象”。
- **形象选择**：
  - AI 对话按“对话语言”自动选择形象，没有专属形象的语言使用 `zh`；
  - 双向对话的 AI 译员取对方语言（B）的形象；
  - 首页展示区可切换四位形象。
- **降级**：
  - 不支持 WebGL 或开启“减少动效”时，显示静态立绘（带状态光晕），不再使用光球；
  - 光球只在资源加载期间作为占位。
- 设置中的形态偏好从“3D / 简洁”改为“动态 / 静态”。

## Capabilities

### New Capabilities
- 无

### Modified Capabilities
- `ai-avatar`：渲染方式从 VRM 改为立绘绑定，内容包括：
  - 口型改为离散嘴型帧的交叉混合；
  - 视线跟随改为深度视差；
  - 点击反馈改为“开心”表情与轻跳（取消挥手）；
  - 降级形态改为静态立绘；
  - 新增按语言选择形象。
- `landing-page`：数字人展示区新增形象切换。

## 非目标

- 不做中英日韩以外的形象（资源流水线支持后续扩展）；不做男性形象。
- 不做肢体动作（挥手、手势）。立绘的身体保持静止，只做呼吸与视差。
- 不做逐音素精确口型，仍然是频谱近似、离散嘴型帧。
- 不改后端协议与 AI 名称（仍为 Lumi）。

## 与路线图的依赖关系

本变更是 ⑧ `add-ai-avatar-and-landing` 的后续，编号 ⑧.1。它复用 ⑧ 的数字人状态机、口型频谱分析、同传运行时信号与首页结构，只替换渲染层与资源。不影响其他 change。

## Impact

- **web**：
  - 重写 `components/avatar/`（`portrait-rig`、`ai-avatar`、静态与占位形态）；
  - 新增 `lib/avatar/characters.ts`（形象清单与语言映射）、`lib/avatar/mouth.ts`（嘴型帧选择）；
  - 修改 `chat-view`、`converse-view`、`lumi-showcase`、设置步骤（形象预览）；
  - 依赖方面，删除 `@pixiv/three-vrm`、`@react-three/fiber`，保留 `three`。
- **资源**：新增 `public/avatars/{zh,en,ja,ko}/`，每个约 0.4–0.8 MB；删除 6 MB 的 `lumi.vrm`。
- **docs**：`docs/design/avatar-concepts/` 概念图入库（作为 1:1 复刻依据）；更新总体设计 ⑧.1。
