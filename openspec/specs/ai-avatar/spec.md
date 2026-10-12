# ai-avatar Specification

## Purpose
TBD - created by archiving change add-ai-avatar-and-landing. Update Purpose after archive.
## Requirements
### Requirement: 数字人组件与状态机
Web 前端 SHALL 提供可复用的 AI 数字人组件。组件状态 MUST 是以下五种之一，并按优先级判定：
1. `error`：致命错误或连接断开；
2. `speaking`：正在播放 AI 语音；
3. `thinking`：用户语句已定稿，但回复或译文的首包尚未到达；
4. `listening`：麦克风电平高于阈值，且未静音、未被门控；
5. `idle`：其他情况。

状态切换 SHALL 在约 250 ms 内平滑过渡。组件 SHALL 为当前状态提供可读的文字说明（供读屏），例如“正在倾听”。

#### Scenario: 说话优先于倾听
- **WHEN** AI 语音正在播放，同时麦克风电平高于阈值
- **THEN** 数字人状态为 `speaking`

#### Scenario: 思考状态
- **WHEN** 用户的一句话已定稿，AI 回复尚未开始播放
- **THEN** 数字人状态为 `thinking`，并显示“正在思考”

### Requirement: 口型与倾听反馈
数字人在 `speaking` 状态下 SHALL 用实际播放音频的实时频谱计算语音能量，并以此驱动吉祥物嘴巴的开合（开口程度随能量变化，能量低于噪声门限时合上）。使用浏览器朗读兜底、无法取得音频数据时，SHALL 用近似节律驱动嘴巴开合。

在 `listening` 状态下，吉祥物 SHALL 随麦克风电平前倾，外壳表面随之起伏。在 `idle` 状态下，SHALL 有漂浮、呼吸和随机眨眼（间隔 2.5–6 秒）。

#### Scenario: 静音段闭嘴
- **WHEN** 播报音频中出现 300 ms 的静音段
- **THEN** 该时间段内吉祥物的嘴巴回到闭合的微笑

#### Scenario: 浏览器朗读兜底
- **WHEN** 某句 TTS 降级为浏览器朗读
- **THEN** 朗读期间吉祥物的嘴巴仍有开合，朗读结束后闭合

### Requirement: 指针交互
数字人 SHALL 让眼睛与身体平滑跟随鼠标或触控指针；指针离开窗口或 3 秒无移动后，回到正前方。在允许交互的场景（首页、AI 对话）中，SHALL 支持拖拽旋转、指针拨开字形与点击问候（开心表情、粒子炸开再聚拢、星星）。在同传双向对话中，点击与拖拽 MUST NOT 触发任何动作。

#### Scenario: 视线跟随
- **WHEN** 用户把鼠标移动到吉祥物左上方
- **THEN** 吉祥物的眼睛与身体朝左上方转动

#### Scenario: 点击问候
- **WHEN** 用户在 AI 对话中点击吉祥物
- **THEN** 吉祥物露出 ^ ^ 表情，身体粒子炸开再聚拢并迸发星星，约 1 秒后回到当前状态

### Requirement: 懒加载与降级
数字人默认渲染吉祥物（不依赖 three.js，无需懒加载 3D 代码），挂载后立即由代码绘制。出现以下任一情况时，组件 SHALL 按 mascot「渲染与降级始终由代码生成」处理，MUST NOT 换成图片：
- 用户偏好为“静态”或系统开启“减少动效”：绘制静止帧；
- 浏览器不支持 WebGL 或上下文丢失：改用 Canvas2D；
- 帧率过低：降低粒子密度与分辨率。

隐藏的真人立绘渲染器（开关打开时）仍按需懒加载。

#### Scenario: 不支持 WebGL
- **WHEN** 浏览器无法创建 WebGL 上下文
- **THEN** 数字人以 Canvas2D 绘制同一个吉祥物，颜色与表情随状态变化，不报错

#### Scenario: 减少动效
- **WHEN** 系统开启“减少动效”
- **THEN** 数字人显示静止的吉祥物画面，不播放入场与循环动画

#### Scenario: 低帧率
- **WHEN** 运行中连续 2 秒平均帧率低于 24
- **THEN** 吉祥物粒子变少、分辨率降低，形象与交互保持不变

### Requirement: 渲染资源管理
数字人容器离开视口或页面被隐藏时，渲染循环 MUST 暂停；恢复可见后，渲染循环继续。组件卸载或切换形象时，MUST 释放 WebGL 渲染器、几何体、材质与纹理。画布像素比上限为 1.5，背景透明（立绘的 alpha 来自抠像蒙版）；半身构图时，立绘底边 SHALL 渐隐融入舞台。

#### Scenario: 切到后台标签页
- **WHEN** 用户把同传页面切到后台标签页
- **THEN** 数字人停止逐帧渲染，回到前台后恢复

#### Scenario: 切换形象
- **WHEN** 用户在首页从中文形象切换到日语形象
- **THEN** 旧渲染器被释放，日语形象的静态立绘先出现，随后交叉淡入为动态立绘

### Requirement: 数字人偏好
用户 SHALL 能在使用数字人的界面中开关数字人，并选择“动态 / 静态”形态。偏好 MUST 持久化在本地，刷新后保持不变；旧版本保存的 `3d` 与 `simple` MUST 分别映射为“动态”和“静态”。

#### Scenario: 关闭数字人
- **WHEN** 用户在双向对话中关闭数字人，然后刷新页面并重新开始对话
- **THEN** 数字人保持关闭，控制条恢复为麦克风电平光球布局

#### Scenario: 旧偏好迁移
- **WHEN** 本地存储中的偏好是旧版的 `simple`
- **THEN** 升级后数字人显示为静态立绘

### Requirement: 语言形象
真人语言形象（`zh` 青花瓷旗袍、`en` 藏青西装、`ja` 樱花和服、`ko` 韩服）的代码与资源 SHALL 保留，但在开关 `HUMAN_AVATAR_ENABLED` 关闭时（默认关闭）MUST NOT 展示，也 MUST NOT 请求其资源文件。

开关关闭时，以下界面 SHALL 统一使用平台吉祥物 Lumi：
- AI 对话；
- 双向对话；
- 首页；
- 设置预览；
- 气泡头像；
- 模式卡片。

开关打开时，恢复按语言选择形象的行为：
- AI 对话按对话语言选择；
- 双向对话取 B 侧语言；
- 没有专属形象的语言使用 `zh`。

#### Scenario: 默认隐藏真人形象
- **WHEN** 用户以对话语言 en 开始 AI 对话（开关为默认关闭）
- **THEN** 舞台显示吉祥物，网络中不出现 `/avatars/` 下的任何请求

#### Scenario: 开关打开时恢复
- **WHEN** 开发者把 `HUMAN_AVATAR_ENABLED` 改为 true，用户以对话语言 en 开始 AI 对话
- **THEN** 舞台显示 English 形象

### Requirement: 立绘资源流水线
每个形象的资源 SHALL 由仓库内的脚本生成与构建：
- `web/scripts/avatar/generate.py` 生成底图与局部变体（嘴型 small/aa/oh/ee、闭眼、抬眼、开心）、抠像蒙版和深度图；提示词随仓库保存；
- `web/scripts/avatar/build.py` 用差分提取局部图层、做颜色校正与羽化，产出 `public/avatars/<id>/` 下的 `base.webp`、`depth.webp`、`atlas.webp` 和 `manifest.json`。

原始生成图 MUST NOT 入库。单个形象的产物 SHALL 不超过 1 MB。

#### Scenario: 构建产物
- **WHEN** 对一个已生成原始图的形象执行 build.py
- **THEN** 得到四个产物文件，manifest 中包含 7 个局部图层的目标矩形与图集矩形，以及脸部窗口

