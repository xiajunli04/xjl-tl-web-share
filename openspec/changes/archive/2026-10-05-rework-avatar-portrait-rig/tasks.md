## 1. infra：资源流水线

- [x] 1.1 技术验证：在中文底图上用“只改嘴部”的编辑提示生成张嘴变体，做像素差分。验证：背景平均差 3.5，衣服 15，眼睛 7.7，嘴部 35 以上，热力图只有嘴部是亮的，说明可以局部替换
- [x] 1.2 编写 `web/scripts/avatar/generate.py`：
  - 中文底图来自概念图 11，英、日、韩底图来自头像表 12，并以中文底图作为构图与画风参照；
  - 每个形象生成 9 张变体（4 种嘴型、闭眼、抬眼、开心、蒙版、深度）；
  - 失败重试 3 次，原图存入 `web/.avatar-src/`，该目录不入库。

  验证：四个形象共 40 张图全部生成；网络抖动导致的个别失败已自动重试成功
- [x] 1.3 编写 `web/scripts/avatar/build.py`：
  - 用大半径模糊差分的峰值定位嘴和眼；
  - 在窗口内取差分掩膜，膨胀并羽化，窗口边缘渐隐，外环做颜色校正；
  - 产出图集、带 alpha 的底图、深度图、`face.webp` 小头像、`manifest`，并输出预览拼图。

  验证：四个形象的预览中，7 个图层的合成都没有错位或色差。修正过两处：发丝噪声干扰定位，改为大半径模糊后取峰值；闭眼图层只覆盖了一只眼，放宽了邻域。每个形象约 0.5 MB
- [x] 1.4 删除 VRM 相关内容：`@pixiv/three-vrm`、`@react-three/fiber`、`lumi.vrm`、`optimize-vrm.py`、`avatar-canvas`、`vrm-rig`、`avatar-orb`。验证：`pnpm build` 成功；生产模式下渲染器 chunk 从 291 KB 降到 136 KB
- [x] 1.5 概念图转为 WebP 入库到 `docs/design/avatar-concepts/`（附 README，说明哪些采用、哪些备选），原 PNG 与验证图删除。验证：7 张图共约 0.9 MB

## 2. web：数字人渲染

- [x] 2.1 新增纯函数模块：`lib/avatar/characters.ts`（形象清单、语言映射）、`rig-weights.ts`（嘴型帧选择、眨眼、思考、开心、运动）、`view.ts`（bust/portrait/face 三种构图与 CSS 背景换算）。验证：vitest 覆盖语言回退、嘴型帧选择、静音闭嘴、idle 眨眼、思考不眨眼、开心回落、倾听放大、出错降饱和、指针视差，以及构图的头顶保留与特写比例
- [x] 2.2 编写 `components/avatar/portrait-rig.tsx`：three.js 单四边形着色器，实现构图、缩放、深度视差、7 个图层的权重混合、饱和度、底边渐隐和预乘 alpha；支持可见性暂停、指针、点击问候、帧率降级，以及卸载时释放资源。验证：在首页点击 English 后，画布存在，状态为 speaking，6 帧截图的嘴型依次为微张、张开、露齿、闭合，页面无错误
- [x] 2.3 `components/avatar/ai-avatar.tsx` 外壳：
  - 静态立绘按构图裁切，作为占位与降级形态，带状态光晕；
  - 渲染器懒加载，就绪后交叉淡入；
  - 切换形象时交叉淡入；
  - 偏好改为 live/static，旧值做兼容映射。

  验证：reduced-motion 下截图为静态立绘；vitest 覆盖 `normalizeStyle`
- [x] 2.4 `components/avatar/character-face.tsx`：圆形小头像，使用 `face.webp`。验证：生产模式下首屏 4 个小头像共约 95 KB。修复前每个小头像都加载完整立绘，首屏多出约 1.6 MB

## 3. web：接入

- [x] 3.1 AI 对话：
  - 舞台按对话语言选择形象，背景为渐变加光环；
  - 气泡头像改为形象头像；
  - 就绪时做一次开心问候。

  验证：桌面亮色、暗色与 390 px 移动端截图（暗色下抠像边缘干净）
- [x] 3.2 双向对话 AI 译员徽章取 B 侧语言形象（头肩构图）。验证：zh/en 对话中显示 English 形象
- [x] 3.3 模式卡片：AI 对话插画改为四个形象的头像堆叠。设置步骤：对话语言旁加形象预览，并提示该语言是否有专属形象。验证：截图
- [x] 3.4 首页「和 AI 面对面」：
  - 加入四个形象芯片；
  - 开场白改为“形象 × 场景”，用该形象的语言朗读，并显示对应字幕；
  - FAQ 文案同步更新。

  验证：四个形象的说话截图；修复一处芯片 className 依赖 `useReducedMotion` 导致的 hydration 不匹配（改用 `motion-safe:`）

## 4. 验收与文档

- [x] 4.1 全量检查：
  - vitest：26 个文件、288 个用例通过；
  - eslint：0 错误（唯一一条警告来自早已存在的 coverage 产物）；
  - tsc 通过；
  - next build 成功；
  - 生产模式下，首屏 LCP 元素为 H1（本机 1.22 s），首屏不加载任何立绘；滚动到 Lumi 分区后才加载渲染器 chunk（136 KB）、图集（91 KB）与深度图（4 KB），底图按构图懒加载
- [x] 4.2 截图验收，存于 `docs/test/avatar-portrait-rig-ui/`：
  - 首页：四个形象、暗色、reduced-motion；
  - 同传：模式卡片、AI 对话设置、AI 对话（桌面、暗色、移动端、reduced-motion）、双向对话徽章
- [x] 4.3 文档：总体设计路线图新增 ⑧.1；`docs/design/avatar-concepts/README.md` 说明概念图的采用情况与资源流水线
