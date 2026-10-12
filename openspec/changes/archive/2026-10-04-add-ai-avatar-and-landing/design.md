## Context

现状：
- **路由**：`web/src/app/(main)/page.tsx` 把 `/` 无条件重定向到 `/translate`。`(main)` 布局对未登录用户跳转 `/login`，所以访客打开站点只能看到登录框。登录成功后，`safeRedirect` 的缺省目标是 `/`。
- **同传**（⑦）：
  - 三种模式，即 LISTEN / CONVERSE / ROOM。
  - 链路是浏览器 ⇄ Spring WS（票据鉴权、扇出、持久化）⇄ Python WS（引擎）。
  - 级联引擎 `CascadeEngine` 的流水线是 VAD → ASR → `_route` → `_translate_all` → `_speak`（TTS）。`sequencer` 保证同句音频有序，`metrics` 计算 e2e。
  - Spring `RoomRegistry.onPythonEvent` 负责改写 utteranceId、补 speaker，并调用 `SegmentWriter` 合并落库。
  - 前端 `lib/audio/player.ts` 有两条播放路径：PCM 用 AudioWorklet 环形缓冲，MP3 用 `decodeAudioData`。浏览器朗读作为兜底。
  - `interpret-store` 维护麦克风电平 `level`、`playing`、`gated` 等状态。
- **前端基线**：Next.js 16.3、React 19.2、Tailwind v4、motion 13、shadcn/ui（base-ui）。项目已经有统一动效令牌 `components/motion/tokens.ts` 和 mock 模式（`NEXT_PUBLIC_MOCK_API=1`），mock 下用脚本化事件模拟同传。

调研结论（2026-10，详见 proposal）：
- 数字人首选 VRM 风格化 3D 角色（`@pixiv/three-vrm`），不走写实路线，以规避恐怖谷。Ready Player Me 已于 2026-01 关停。
- 口型在没有 viseme 时间戳的条件下，用播放输出的 AnalyserNode 能量与频段近似驱动。
- 首页应让访客“立刻体验”：首屏放可触发的演示，交互式场景对比优于对勾表。匿名访客的演示用前端回放，规避成本与滥用。
- 示例模型选用 three-vrm 仓库的 `VRM1_Constraint_Twist_Sample.vrm`（pixiv Inc.，VRM Public License 1.0）。许可条件：avatarPermission=everyone、commercialUsage=corporation、允许修改再分发、creditNotation=unnecessary。模型自带 `aa/ih/ou/ee/oh` 口型、`blink`、`happy/relaxed/sad/surprised` 表情和 lookAt。原始体积 10.8 MB。

## Goals / Non-Goals

**Goals:**
- 访客打开 `/` 就能通过交互演示理解平台价值和与传统方式的差异，全程不需要后端。
- 提供一个可复用的 `<AiAvatar>` 组件：统一的状态机，VRM 与 2D 光球两档渲染，懒加载，可降级，尊重 reduced-motion。
- 双向对话里有“AI 译员”；新增 AI 对话模式，让用户可以直接和数字人用外语对话并随时打断。
- 后端改动最小化：复用级联链路、事件协议和持久化，不新增表，只放宽约束。

**Non-Goals:**
- 见 proposal「非目标」。另外不做：shader 光球（中间档）、数字人换装或多角色选择、首页的真实接口试用。

## Decisions

### D1 数字人渲染：R3F + three-vrm，VRM 与 2D 光球两档

- **决策**：
  - 使用 `three@0.186`、`@react-three/fiber@9.8`、`@pixiv/three-vrm@3.5`，不引入 drei，相机、灯光和加载都自己写，避免体积膨胀。
  - `<AiAvatar>` 是一个轻量外壳，包含状态机、偏好和降级判断，通过 `next/dynamic(..., { ssr:false })` 懒加载 `avatar-canvas`（3D chunk）。chunk 和模型加载期间显示 2D 光球占位，加载完成后交叉淡入。
  - 模型放在 `public/avatars/lumi.vrm`。用 `scripts/optimize-vrm.py` 把贴图缩到不超过 1024 px 并重新编码，目标体积 ≤ 5 MB；如果优化失败，就沿用原文件。
- **备选方案**：
  - TalkingHead 不能直接用 VRM，且中文口型模块缺失；
  - 写实 GLB 有恐怖谷，来源也已关停；
  - Rive/Live2D 需要美术资源，且有专有许可；
  - 纯 shader 光球“人味”不够。
- **理由**：VRM 自带口型、表情、视线和弹簧骨骼，单人开发即可做出生动的角色。两档渲染共用一个状态机，降级路径清晰。

### D2 状态机与驱动数据

`lib/avatar/state.ts` 是纯函数 `deriveAvatarState(input)`，输入 `{phase, connection, micLevel, muted, gated, playing, awaitingReply, error}`，输出以下五种状态之一：

| 状态 | 判定（按优先级） | VRM 表现 | 光球表现 |
|---|---|---|---|
| `error` | 致命错误 / 连接断开 | `sad` 0.6，视线下垂 | 灰色、低亮度 |
| `speaking` | 播放器 `playing` | 口型由输出能量驱动，叠加 `happy` 0.25，头部随音量轻点 | 随输出电平缩放的品牌色光晕 |
| `thinking` | `awaitingReply`：已有用户定稿句，但 AI 回复或译文首包未到 | 视线上移、歪头、`relaxed` 0.4 | 缓慢旋转的渐变环 |
| `listening` | 麦克风电平高于阈值且未静音、未被门控 | 身体前倾，幅度随电平变化；视线看向用户，偶尔点头 | 随麦克风电平缩放 |
| `idle` | 其他 | 呼吸、随机眨眼（2–6 s）、头部微动 | 慢速呼吸 |

- 状态切换做 250 ms 的权重插值，不出现跳变。
- 状态由调用方组装输入。同传通过 `useInterpretAvatarInput()` 从 `interpret-store` 取数；首页演示由脚本直接给出。
- 电平和口型权重以 ref/motion value 的形式逐帧读取，不触发 React 重渲染。

### D3 口型：播放输出的频段分析

- **决策**：
  - `lib/audio/player.ts` 在输出总线上并联一个 `AnalyserNode`（fftSize 1024），对外暴露 `getOutputAnalyser()`。PCM worklet 节点和 MP3 的 `AudioBufferSourceNode` 都经过同一个 `GainNode` 输出。
  - `lib/avatar/lipsync.ts` 提供纯函数 `visemesFromSpectrum(bins, sampleRate)`，按 RMS 和三个频段（约 200–800 Hz 低频、800–2500 Hz 中频、2500–5000 Hz 高频）计算 `{aa, oh, ou, ee, ih}` 权重。规则如下：
    - 低频占优时偏 `oh/ou`；
    - 中频占优时偏 `aa`；
    - 高频占优时偏 `ee/ih`；
    - 总能量低于噪声门限时全部为 0。
  - 结果经过 attack 60 ms / release 120 ms 的平滑后写入 VRM `expressionManager`。
  - 浏览器朗读（speechSynthesis）拿不到音频数据，此时用 `pseudoVisemes(t)`：在 `speaking` 状态下按 4–6 Hz 叠加的正弦生成近似口型。
- **备选方案**：HeadAudio 的 MFCC 模型推理（体积与集成成本更高，列为后续增强）；edge-tts WordBoundary 时间戳（只到词级，中文效果差）。
- **理由**：分析的是“实际播放出来的声音”，天然与音频同步、与语言无关，而且纯函数可以单测。

### D4 渲染循环、性能与降级

- 满足以下任一条件时，`<AiAvatar>` 直接使用光球，不加载 3D chunk：
  - 用户偏好为“简洁”（`ui` store，持久化）；
  - `prefers-reduced-motion`；
  - WebGL 不可用（启动时探测 `canvas.getContext('webgl2')`）；
  - 模型加载失败；
  - 连续 2 s 平均帧率低于 24，此时降级并提示一次。
- `Canvas` 设置：`dpr={[1, 1.5]}`、`gl={{ alpha:true, antialias:true, powerPreference:'low-power' }}`。容器离开视口（IntersectionObserver）或页面隐藏（visibilitychange）时，`frameloop` 切换为 `never`，其他时间为 `always`。
- 灯光颜色和轮廓光从 CSS 变量 `--color-brand` 读取，跟随主题变化，暗色模式下提高轮廓光强度。
- 卸载时调用 `VRMUtils.deepDispose`，并释放 renderer。

### D5 指针交互与“亲近感”细节

- 视线（`vrm.lookAt.target`）跟随指针，按 3 m 外的虚拟平面换算，带阻尼。指针离开窗口 3 s 后视线回到镜头。
- 点击数字人会触发一次“打招呼”：抬手（右上臂骨骼插值，0.8 s）加 `happy`，随后回到当前状态，有 3 s 冷却。首页和 AI 对话中启用，同传对话中禁用，避免误触。
- 相机是固定的半身构图。窄容器用头肩近景（`framing="portrait"`），大舞台用半身构图（`framing="bust"`）。
- reduced-motion 下不加载 VRM，所以上面这些都不会出现；光球只做透明度呼吸。

### D6 AI 对话模式（CHAT）的协议

**创建**：`POST /api/interpret/sessions`，规则如下：
- `mode="CHAT"`、`engine` 必须是 `cascade`，否则返回 400 `A0410`，提示“AI 对话仅支持平台级联引擎”。
- `languages=[myLang, aiLang]`，两种语言可以相同。
- 新增可选字段 `chatScenario`，取值 `free | travel | restaurant | business | interview`，缺省 `free`，非法值返回 `A0410`。
- `converseRouting` 忽略。`tts` 缺省 true。
- 选项写入 `options.chatScenario`。同一用户同一时刻仍只能有一个进行中的会话。

**Spring → Python config**：
- `mode="CHAT"`、`sourceLangs=[myLang, aiLang]`（作为 ASR 语种候选）、`targetLangs=[]`；
- 新增 `chat:{scenario, myLang, aiLang, persona:"Lumi"}`。

**Python 下行事件**（在现有事件上扩展，前向兼容）：

| 场景 | 事件 |
|---|---|
| 会话开始 | AI 先开口：按场景生成开场白，按下方“AI 回复”流程发出 |
| 用户一句话 | 照常发 `transcript.partial/final`，`role` 缺省视为 `user`，不发译文；随后发只含 `asrMs` 的 `metrics`（转写段以 metrics 到达作为合并完成条件，否则要等 15 s 超时才落库，顺序也会排在 AI 回复之后） |
| AI 回复 | 新 utteranceId，所有事件带 `role:"assistant"`：<br>① `transcript.partial`，text 为累计回复文本，随 LLM 流式增长；<br>② `transcript.final`（lang=aiLang）；<br>③ myLang ≠ aiLang 时，发 `translation.delta/final`（lang=myLang，母语字幕）；<br>④ `audio`（lang=aiLang，按句流水线合成，last=true 收尾）；<br>⑤ `metrics`，e2eMs 从用户句末算到 AI 首段音频 |
| 打断 | 收到控制帧 `interrupt` 后，取消当前回复的 LLM 流、TTS 与字幕任务，发 `reply.interrupted{utteranceId, text}`，text 是已生成的文本；如果此前尚未定稿，同时补发一个 `transcript.final` |

**上行控制帧**：新增 `{type:"interrupt"}`。Spring `onControl` 把它转发给本人发言流，Python `CONTROL_TYPES` 增加 `interrupt`。

**发言人身份**：Spring `rewriteUtterance` 看到 `role=="assistant"` 时，speaker 写成 `{participantId:"ai", displayName:"Lumi", lang:aiLang}`；utteranceId 仍按本人发言流改写，保证唯一。`SegmentWriter` 用 `Speaker("ai","Lumi",null)` 落库。AI 句的 `expectedTargets` 为 `[myLang]`（与 aiLang 相同时为空）。

**对话记忆**：Python 在发言流内存中保留最近 12 轮对话。被打断的回复以“已说出的部分 + `…`”写入历史。

**LLM 提示词**（`app/interpret/chat_prompts.py`）：
- 角色：Lumi，一个友好的多语言对话伙伴；
- 始终用 aiLang 回复，口语化，1–3 句、不超过 60 词，不用 Markdown 和表情符号；
- 场景设定决定 Lumi 扮演的身份，例如旅行中扮演当地人、餐厅中扮演服务员、面试中扮演面试官；
- 用户用 myLang 或语句不完整时，Lumi 先自然复述一遍更地道的 aiLang 说法再继续。

使用会话的 `modelConfigId`（缺省为默认 CHAT 模型）、非推理快速路径、temperature 0.7。

**半双工**：沿用 ⑦ 的规则，未开耳机模式时 AI 播报期间暂停收音，此时用户只能点「打断」按钮。开启耳机模式（全双工）时，AI 播报期间如果收到新的用户 `transcript.partial`，前端自动发送 `interrupt`，实现“插话即打断”。

- **备选方案**：
  - 新建独立的 `/ws/chat` 通道和 `ChatEngine`：需要重复实现鉴权、扇出和持久化；
  - 让 AI 回复复用 `translation.*` 事件：语义混乱，历史回看也无法区分发言人。
- **理由**：复用发言流与 `SegmentWriter`，历史记录天然可回看；`role` 字段对已有模式完全兼容。

### D7 双向对话中的“AI 译员”

- CONVERSE 中间控制条改为“徽章式”布局：数字人头像（`framing="portrait"`，桌面 88 px，移动端 64 px，圆形遮罩加电平外环）居中骑在上下两半区的分隔线上，左右分别是状态、延迟和开关。
- 数字人状态：听到任意一侧说话时为 `listening`；有定稿原文、译文未到时为 `thinking`；播报译文时为 `speaking`。
- 数字人开关放在控制条上（Bot 图标切换），偏好 `avatarEnabled` 持久化。关闭后恢复原有的 LevelOrb 布局。上半区旋转不影响数字人。

### D8 首页：路由、外壳与脚本化演示

**路由**：
- 删除 `(main)/page.tsx`，新增 `(marketing)/layout.tsx` 与 `(marketing)/page.tsx`，承载 `/`。
- `safeRedirect` 的缺省目标改为 `/translate`。
- 侧边栏 Logo 点击跳到 `/translate`，用户菜单新增「访问首页」。
- 登录/注册页的 Logo 链接回 `/`。

**营销外壳**：
- 粘性顶栏：Logo、锚点导航（演示 / 对比 / 能力 / 数据）、主题切换、CTA。滚动后顶栏出现毛玻璃和描边。
- 页脚。
- CTA 根据 `useAuthStore` 在 hydration 完成后切换：未登录显示「免费开始」（指向 `/register`）和「登录」，已登录显示「进入工作台」。hydration 之前统一渲染未登录版本，避免 hydration 不匹配。

**脚本播放器**：
- `lib/landing/script.ts` 定义 `Step = {at:ms, apply:(state)=>state}` 的纯函数时间线，以及 `stateAt(script, t)`，可单测。
- `hooks/use-script-player.ts` 用 rAF 推进时间，提供 play/pause/restart/seek，离开视口时暂停。reduced-motion 下直接 `seek(end)` 展示终态。

**演示数据**：放在 `lib/landing/fixtures.ts`，内容取自实验报告与实测中的真实样例：
- K8s 术语锁定：`Deployment→部署`；
- 会话指代：“They stopped charging”；
- 告示：“Caution: Wet Floor”。

数据引用的指标全部标注出处（实验报告章节）。

**性能**：
- Hero 标题服务端直出，不从 opacity 0 开始动画，保证 LCP。
- 数字人展示区在接近视口（rootMargin 300px）时才挂载 `<AiAvatar>`。
- 其他演示都是 DOM + motion，不依赖 WebGL。

- **备选方案**：
  - 首页放在 `(main)` 内按登录态分支：会和 `(main)` 布局的登录守卫冲突；
  - 开放匿名真实接口：需要验证码、限流和预算，超出范围。
- **理由**：路由组隔离外壳，访客路径零后端依赖，答辩现场断网也能演示。

### D9 数据模型与迁移

- 新增 `V7__interpret_chat.sql`：放宽 `biz.interpret_session.mode` 的 CHECK，使其包含 `CHAT`；更新 options 列注释，加入 `chatScenario`。
- 不新增表。AI 的发言人身份保存在转写段已有的 speaker 字段中。
- 新增错误码：无。参数非法统一用 `A0410`，引擎不可用沿用 `C0173`。

## UI/UX

### 信息架构

- **`/` 首页**（营销外壳，无侧边栏）由 8 个分区构成，每屏只讲一件事：
  1. **Hero**
     - 左侧：主张标题“会思考、会追问、会自查的翻译 Agent”，副标题，以及主/次 CTA（「免费开始」/「看它如何工作」，后者平滑滚动到第 2 屏）。
     - 右侧：迷你轨迹卡，五个阶段芯片（分析 → 规划 → 翻译 → 评审 → 修正）依次点亮，译文流式输出。进入视口自动播放一次，之后可以点「重播」。
  2. **交互试玩**
     - 三个分段样例：歧义句、术语句、长段落。
     - 选中后在一张模拟工作台卡里回放 Agent 轨迹。
     - 歧义样例中途弹出追问卡，访客点选不同答案，会得到不同译文。
  3. **与传统方式对比**
     - 场景分段：技术文档 / 歧义对话 / 三人跨语言会议。
     - 四列同步回放：人工翻译、传统机器翻译、直接问通用大模型、本平台。每列底部是耗时、成本、术语一致率徽章，问题处用波浪下划线标出，并附说明气泡。
     - 下方是可折叠的「成本估算器」：字数或会议时长滑块，显示区间和来源脚注。
     - 末尾是精简对比表（6 行），供读屏和截图引用。
  4. **和 AI 面对面**
     - 左侧是数字人舞台（懒加载）；右侧是对话脚本，可点「听 Lumi 打招呼」（浏览器朗读 + 伪口型），或点击场景卡切换开场白。
     - 下方是三张模式小卡：同传收听 / 双向对话 / 会议室。
  5. **能力 bento**（6 格，悬停或聚焦时播放微动画）：
     - 术语库：术语高亮锁定；
     - 翻译记忆：命中匹配度计数；
     - 长文档断点续译：进度环暂停后继续；
     - 同传会议室：头像脉冲与逐句延迟；
     - 图片原位翻译：原图/译图擦除切换；
     - 听写朗读：声波。
  6. **一份长文档的旅程**：左侧 sticky 示意卡，右侧四个步骤文案（切分 → 摘要与专名表 → 分段翻译 → 对照编辑）。滚动进度驱动左侧卡片切换状态，不劫持滚动。
  7. **评测数据**：4–6 个数字计数器，例如：
     - 前块上下文使严重错误 −82%；
     - 会话上下文使指代准确率达到 95.9%；
     - 混合策略使耗时 −46%；
     - 级联同传术语准确率 100%；
     - 两步法图片翻译 chrF +10。

     每个数字配一句结论和出处。
  8. **收尾**：CTA 横幅，以及 FAQ 折叠面板（隐私、语言、离线、模型）。

- **`/interpret` 准备页**：
  - 模式卡片从 3 张变为 4 张，新增「AI 对话」，插画为数字人头像剪影。
  - 选择 AI 对话后，第二步设置包括：
    - 我的语言、对话语言；
    - 场景卡（5 张单选，图标加一句说明）；
    - 音色性别；
    - 引擎区只展示「平台级联」，并说明原因；
    - 高级分区：模型、耳机模式、语音播报。
- **AI 对话进行中**：
  - 桌面为主从两栏：
    - 左侧 5/12 是数字人舞台，包括 `framing="bust"` 的数字人、状态字幕（“Lumi 在听… / 在想… / 正在说”）、电平外环、「打断」按钮（仅 speaking 时出现，带进出场动画）、场景徽章。
    - 右侧 7/12 是对话流：AI 气泡显示 aiLang 原文，下方小字是母语字幕；用户气泡显示识别原文。被打断的回复带「已打断」标记。
  - 底部控制条：静音、语音播报、耳机模式提示、结束。
  - 移动端为上下布局：上方数字人约 38vh，下方对话流。
- **双向对话进行中**：见 D7。

### 关键交互流程

1. **访客首页演示**：打开 `/` → Hero 轨迹自动播放 → 点「看它如何工作」→ 在试玩区选择歧义样例，回放到追问时暂停 → 点选答案后译文按选择生成 → 对比区切换场景 → 在数字人区点「听 Lumi 打招呼」，数字人挥手、朗读并开口 → 点「免费开始」注册。
2. **AI 对话**：同传页 → 选「AI 对话」→ 选语言与场景 → 开始，数字人加载完成后先打招呼 → 用户说话（数字人倾听，身体前倾）→ 句末进入思考状态 → 回复流式出现并开口朗读 → 用户点「打断」，播报立即停止，气泡标记已打断，数字人回到倾听。
3. **双向对话**：开始后中间出现 AI 译员徽章，一方说话时数字人倾听，译文播报时开口。点 Bot 开关可隐藏数字人。

### 动效清单

| 场景 | 动效 | reduced-motion |
|---|---|---|
| 首页分区进场 | 标题以外的内容淡入并上移 12 px（220 ms，`EASE_OUT`），在视口内触发一次 | 仅透明度 |
| Hero 轨迹 | 阶段芯片依次点亮（弹簧缩放），译文逐字流式输出，光标闪烁 | 直接显示终态 |
| 试玩追问卡 | 自底部弹出（`SPRING_SHEET`），选项悬停时上浮 | 仅透明度 |
| 对比四列 | 同步打字回放；问题处的波浪线从左到右描出 | 直接显示终态与标注 |
| bento 卡 | 悬停或聚焦时播放各自的微动画，卡片轻微上浮，光斑跟随指针 | 静态，无光斑 |
| 长文档旅程 | 滚动进度驱动示意卡在各状态间交叉淡入 | 同（仅透明度） |
| 数字计数器 | `NumberTicker` 进入视口时滚动到目标值 | 直接显示数值 |
| 顶栏 | 滚动后出现背景模糊和描边（150 ms） | 同 |
| 数字人 | 呼吸、眨眼、视线跟随、倾听前倾、思考歪头、口型、挥手；状态权重 250 ms 插值 | 改用光球，仅做透明度呼吸 |
| 光球占位 → VRM | 交叉淡入 300 ms | 不加载 VRM |
| 打断按钮 | speaking 时缩放加淡入出现，点击后有波纹 | 仅透明度 |
| 模式卡片（4 张） | 沿用错峰进场与悬停上浮 | 沿用 |

## Risks / Trade-offs

- [VRM 模型体积大（10.8 MB），弱网下加载慢] → 先显示光球占位并给出加载进度，脚本压缩贴图，开启长缓存，首页只在接近视口时加载。
- [音频频段近似的口型不精确] → 只追求“节奏对上、形状大致合理”，配合平滑和 `happy` 微表情掩盖误差；HeadAudio 列为后续增强。
- [WebGL 在低端设备卡顿，影响同传实时性] → 帧率探测后自动降级为光球；同传 CONVERSE 中默认使用 portrait 小尺寸；所有逐帧数据走 ref，不触发 React 渲染。
- [AI 对话的首包延迟（ASR + LLM 首句 + TTS 首包）可能在 3–4 s] → 按句流水线合成，首句就绪即播；thinking 状态的可视反馈降低等待感；提示词限制回复长度。
- [半双工下无法“插话打断”] → 提供显式「打断」按钮；耳机模式下支持自动打断，并在设置中说明。
- [首页对比数据（人工翻译价格、同传译员日费）来自行业来源，口径不一] → 统一以区间表示并标注“估算”和来源；本平台的数字只引用自有实验。
- [首页演示与真实系统行为不一致，容易被质疑“造假”] → 演示数据取自真实实验样例，并在演示卡角标注“回放演示”，CTA 引导注册体验真实功能。
- [新增依赖与 React 19.2 的兼容性] → 锁定已验证的版本（R3F 9.8.1 的 peer 为 react >=19 <19.4），升级前先跑 typecheck 和 build。

## Migration Plan

1. 部署 Spring 时执行 Flyway V7（只放宽 CHECK，可回滚：回滚脚本只需把约束改回原值，且需先确认没有 CHAT 记录）。
2. Python 与 Spring 同时发布。旧版前端不会发送 CHAT 或 `interrupt`，不受影响；新版前端连旧后端时，CHAT 创建会被 400 拒绝，界面给出错误提示。
3. 前端路由调整后，书签 `/` 从“跳转工作台”变为首页。已登录用户在首页点「进入工作台」即可，侧边栏 Logo 也指向工作台。

## Open Questions

- 是否要为数字人准备第二个角色（男性形象）来匹配音色性别？本 change 先只用一个角色；音色性别只影响 TTS。
- HeadAudio（MFCC viseme）是否值得在答辩前作为增强接入，视实现阶段的效果再定。
