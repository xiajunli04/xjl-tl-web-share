## 1. infra：依赖、迁移与资源

- [x] 1.1 web 用 pnpm 引入 `three@0.186`、`@react-three/fiber@9.8`、`@pixiv/three-vrm@3.5` 和 `@types/three`。验证：`pnpm typecheck` 与 `pnpm build` 通过；在构建产物中确认 three 只出现在懒加载 chunk 里
- [x] 1.2 把 three-vrm 官方样例 `VRM1_Constraint_Twist_Sample.vrm` 放入 `web/public/avatars/lumi.vrm`。编写 `web/scripts/optimize-vrm.py`（Pillow 把贴图缩到不超过 1024 px、缩略图缩到 256 px，并重建 GLB 缓冲），在 `web/public/avatars/LICENSE.md` 记录许可（VRM Public License 1.0）。验证：原始 10.8 MB 压缩到 6.0 MB，gzip 后传输约 2.6 MB。剩余体积主要是几何体与口型 morph（4.3 MB），无法再靠贴图压缩缩小，因此 ≤5 MB 的原目标改为以 gzip 传输体积衡量。重新解析后 VRMC_vrm meta 与 18 个表情预设完整
- [x] 1.3 编写 Flyway `V7__interpret_chat.sql`：放宽 `interpret_session.mode` 的 CHECK，使其包含 CHAT；更新 options 注释。验证：Testcontainers 迁移测试通过，可插入 mode=CHAT 的记录

## 2. springboot-backend：CHAT 模式

- [x] 2.1 `InterpretDtos` 的 MODE_REGEX 增加 CHAT，新增 `chatScenario` 字段。`InterpretService.create` 增加 CHAT 校验：languages 恰为 2 个且受支持；engine 必须为 cascade；场景合法，缺省为 free。chatScenario 写入 options 与 RoomSpec。验证：`InterpretSessionApiTest` 新增 CHAT 创建成功、S2S 引擎返回 A0410、非法场景返回 A0410 三个用例
- [x] 2.2 `RoomRegistry.configFrame` 增加 CHAT 分支（sourceLangs=languages、targetLangs=[]、`chat:{scenario,myLang,aiLang,persona}`）；`onControl` 转发 `interrupt`，非 CHAT 模式忽略。验证：`InterpretStreamTest` 断言 config 帧字段，并断言 interrupt 只在 CHAT 模式下被转发
- [x] 2.3 `onPythonEvent` 与 `rewriteUtterance` 在 `role=assistant` 时把 speaker 写成 Lumi/ai/aiLang；AI 句的 expectedTargets 为 [myLang]（与 aiLang 相同时为空）。`reply.interrupted` 只做转发。验证：单测断言 AI 句以发言人 ai 落库并带字幕译文；`mvn -q test` 全绿

## 3. python-backend：AI 对话引擎

- [x] 3.1 在 `StreamConfig` 中增加 CHAT 模式与 `chat` 配置（scenario、my_lang、ai_lang、persona）并完善校验，`CONTROL_TYPES` 增加 `interrupt`。验证：`test_interpret_engine.py` 新增 CHAT 配置合法/非法用例
- [x] 3.2 新增 `app/interpret/chat_prompts.py`，提供 5 个场景的系统提示词、开场白指令，以及对话历史拼装（12 轮）。验证：单测断言提示词包含对话语言名称与场景身份，历史被截断为 12 轮
- [x] 3.3 级联引擎 CHAT 分支，覆盖开场白、用户句只转写、AI 回复（流式 partial → final → 母语字幕 → 按句流水线 TTS → metrics）。所有事件带 role=assistant，并共享 sequencer。验证：`test_interpret_cascade.py` 用 fake ASR/LLM/TTS 断言开场白与一轮对话的事件序列和 role
- [x] 3.4 打断：`interrupt` 取消当前回复任务（LLM 流、字幕、TTS），发出 `reply.interrupted`，把已生成部分写入历史；会话结束时取消所有回复任务。验证：单测在 TTS 进行中发送 interrupt，断言之后不再有该 uid 的 audio，且历史中包含被截断的文本；`uv run pytest` 全绿
- [x] 3.5 真实联调：用中转站模型配置与 edge-tts，通过脚本向内部 WS 发送一段合成中文 WAV（restaurant 场景）。验证：先收到开场白，再收到英文回复、中文字幕与 MP3 音频，并记录 e2e 延迟。结果（`evaluation/eval/multimodal/chat_smoke.py`，gpt 中转模型 + 本地 SenseVoice + edge-tts）：开场白 3.7 s 定稿，中文字幕约 1.5 s 后到达；用户句末到 AI 首段语音 e2e 2.6 s；WAV 被 VAD 切成两句，第二句触发了插话打断（reply.interrupted），随后的回复以 "You could say: …" 示范了地道说法

## 4. web：数字人基础

- [x] 4.1 新增 `lib/avatar/state.ts`（deriveAvatarState，按优先级判定五种状态）和 `lib/avatar/lipsync.ts`（visemesFromSpectrum、平滑器、pseudoVisemes）。验证：vitest 覆盖状态优先级、静音时闭嘴、低/中/高频分别偏向 ou/aa/ee、平滑的 attack/release
- [x] 4.2 `lib/audio/player.ts` 的输出总线增加 GainNode 与 AnalyserNode，暴露 `getOutputAnalyser()`；PCM worklet 与 MP3 播放都经过该总线。验证：现有 queue/player 测试保持全绿；手动播放时 analyser 有数据
- [x] 4.3 `stores/ui.ts` 增加 `avatarEnabled`、`avatarStyle: "3d" | "simple"` 并持久化；新增 `lib/avatar/support.ts`，探测 WebGL 与 reduced-motion。验证：vitest 覆盖偏好持久化与降级判定
- [x] 4.4 `components/avatar/avatar-orb.tsx`：2D 光球形态，五种状态各有颜色与动效，reduced-motion 下只做透明度变化，带 aria-live 状态说明。验证：组件在五种状态下截图核对；reduced-motion 下无缩放
- [x] 4.5 `components/avatar/avatar-canvas.tsx`（懒加载 chunk）：R3F Canvas 加载 VRM，设置相机构图（portrait/bust）、主题灯光、可见性暂停（IntersectionObserver + visibilitychange）、帧率探测降级，卸载时 deepDispose。验证：Playwright 打开测试页，确认模型加载、切后台后 rAF 停止、卸载后 WebGL 上下文释放。实际验证：用独立 Playwright 脚本（GPU 渲染）在 AI 对话与双向对话中截图，确认模型加载、构图与状态表现正常；在 SwiftShader 软件渲染下自动降级为光球并提示一次（帧率监测因此增加 3 秒预热期，避免着色器编译期误判）。切后台暂停与卸载释放依赖 R3F frameloop="never" 与 VRMUtils.deepDispose，已做代码走查，未做自动化度量
- [x] 4.6 VRM 行为层：idle 呼吸、眨眼与微动；listening 前倾与点头；thinking 歪头与视线上移；speaking 口型（analyser 或伪口型）加微笑；error 显示悲伤表情；视线跟随指针；点击挥手（带冷却）；状态权重 250 ms 插值。验证：在 `/interpret` 的 mock 模式下逐一触发五种状态并截图核对表情与口型
- [x] 4.7 `components/avatar/ai-avatar.tsx` 外壳：用 dynamic(ssr:false) 加载 3D 层，加载期间显示光球与进度，交叉淡入，加载失败或不支持时回退光球；接收 `input` 与 `framing`/`interactive` 参数。验证：断网加载模型时回退光球且无报错；`pnpm typecheck` 通过

## 5. web：同传接入数字人与 AI 对话模式

- [x] 5.1 扩展协议与 reducer：`role` 字段、`reply.interrupted` 事件、Utterance 增加 `role`/`interrupted`；新增 `ClientControl` `interrupt`；store 增加 `awaitingReply` 派生值。验证：`reducer.test.ts` 覆盖 AI 句与打断
- [x] 5.2 `InterpretMode` 增加 CHAT；`setup.ts` 新增 chatMyLang/chatAiLang/chatScenario 字段，CHAT 只允许级联引擎并生成对应创建请求；meta 增加第 4 张卡片与场景元数据；mock 同传支持 CHAT 脚本（开场白、回复、打断）。验证：`setup.test.ts` 与 `mock-interpret.test.ts` 新增用例
- [x] 5.3 `use-interpret-socket`：增加 `interrupt()`（发送控制帧、停止本地播放、标记气泡）；耳机模式下 AI 播报时收到新的用户 partial 会自动打断。新增 `useInterpretAvatarInput()`。验证：单测覆盖自动打断条件；在 mock 模式下手动点击打断
- [x] 5.4 模式卡片改为 4 张（AI 对话插画）；settings-step 为 CHAT 提供我的语言、对话语言、场景卡（5 张单选），引擎区只显示级联并附说明。验证：截图核对 4 张卡片的错峰进场，以及场景卡选中动效
- [x] 5.5 `chat-view.tsx` 实现 AI 对话进行中布局：桌面为主从两栏，移动端为上下布局；包括数字人舞台、状态说明、打断按钮的进出场、对话流（AI 气泡含原文与母语字幕，已打断标记）和底部控制条。验证：在 mock 模式下截图核对桌面与 390 px 宽两种布局，不是整页平铺
- [x] 5.6 CONVERSE 中间控制条接入徽章式数字人（portrait，骑在分隔线上，带电平外环），提供 Bot 开关，关闭后恢复 LevelOrb。验证：在 mock 模式下截图核对开与关两种状态，上半区旋转时数字人不受影响
- [x] 5.7 历史记录：同传历史列表与详情识别 CHAT 模式（标签“AI 对话”），AI 句显示 Lumi 头像与字幕。验证：mock 历史中一条 CHAT 记录的截图

## 6. web：首页

- [x] 6.1 调整路由：删除 `(main)/page.tsx`，新增 `(marketing)/layout.tsx`（粘性顶栏带滚动态、锚点、主题切换、登录态 CTA、页脚）；`safeRedirect` 缺省改为 `/translate`；侧边栏 Logo 指向 `/translate`，用户菜单加入「访问首页」；登录/注册页 Logo 链接 `/`。验证：未登录访问 `/` 不跳转；登录后访问 `/` 显示「进入工作台」；`nav.test.ts` 更新并通过。结果：未登录访问 / 地址不变、顶栏显示“登录 / 免费开始”；写入会话后显示“进入工作台”（Playwright 验证）；safeRedirect 抽到 lib/redirect.ts 并补单测，缺省为 /translate
- [x] 6.2 新增 `lib/landing/script.ts` 时间线纯函数与 `hooks/use-script-player.ts`（rAF、视口暂停、reduced-motion 下直达终态、重播）；`lib/landing/fixtures.ts` 收录真实样例与实验数字。验证：vitest 覆盖 stateAt 在各时间点的输出与分支选择
- [x] 6.3 Hero 区：服务端直出标题与 CTA，右侧为迷你 Agent 轨迹卡（阶段芯片点亮、流式译文、重播）。验证：截图；Lighthouse 中 LCP 元素为 h1 且不从 opacity 0 开始。结果：生产构建（next start）下 PerformanceObserver 测得 LCP 元素为 H1、本机 1.28 s；首屏 25 个 JS 共约 443 KB
- [x] 6.4 交互试玩区：3 个样例分段控件，回放模拟工作台卡；歧义样例弹出追问卡，选择后走对应分支。验证：Playwright 点选不同释义后译文不同。结果：选“名词”得到“我看见了她的鸭子。”，选“动词”得到“我看见她猛地低头躲了一下。”
- [x] 6.5 对比区：场景分段，四列同步回放，问题高亮与说明，指标徽章；可折叠的成本估算器（字数/时长滑块，区间与来源脚注）；精简对比表。验证：截图核对三个场景；估算器数值与公式单测
- [x] 6.6 数字人展示区：接近视口时才挂载 AiAvatar（bust、interactive）；「听 Lumi 打招呼」使用浏览器朗读加伪口型与挥手；场景卡切换开场白；三张模式小卡。验证：首屏的网络请求中没有 three chunk 和 .vrm；滚动到该区后加载；reduced-motion 下为光球。结果：生产模式下首屏不请求 3D chunk 与 .vrm；滚动到该分区后才加载 3D chunk（约 291 KB）与 lumi.vrm（6.0 MB；next start 不压缩 .vrm，部署时需由反向代理开启 gzip，约 2.6 MB）。开发模式下 Turbopack 会预取 dynamic chunk，属于开发环境现象
- [x] 6.7 能力 bento（6 格悬停微动画、指针光斑）与长文档旅程（sticky 示意卡按滚动进度切换）。验证：截图核对；键盘聚焦卡片也能触发动画
- [x] 6.8 评测数据计数器（数值与报告一致、带出处）与收尾 CTA + FAQ 折叠面板。验证：对照 `docs/experiments/实验报告.md` 逐项核对数值

## 7. 验收与文档

- [x] 7.1 全量检查：web 运行 `pnpm lint && pnpm typecheck && pnpm test && pnpm build`，Spring 运行 `mvn -q test`，Python 运行 `uv run pytest`。验证：全部通过。结果：web vitest 26 个文件 278 个用例通过、eslint 0 错误（新增 .next-* 输出目录忽略）、tsc 通过、next build 成功（独立输出目录 .next-build）；Spring mvn test 295 个用例 0 失败；Python pytest 537 个用例通过
- [x] 7.2 UI/UX 截图验收：首页 8 个分区（亮/暗）、AI 对话（桌面/移动）、双向对话数字人、reduced-motion 下的首页与 AI 对话。验证：截图存入 `docs/test/screenshots/`，核对没有整页平铺、动效生效、reduced-motion 生效。结果：截图 17 张存于 docs/test/ai-avatar-landing-ui/（首页亮/暗、对比与估算器、试玩追问、bento 悬停、数据、reduced-motion；同传四张模式卡、AI 对话设置、AI 对话桌面/暗色/390 px 移动端/reduced-motion 光球、双向对话 AI 译员开与关、AI 对话历史）。验收中发现并修复两处问题：reduced-motion 下脚本播放器首帧直达终态导致 hydration 不匹配；进场初始位移依赖 useReducedMotion 导致属性不匹配（改为常量，交给全局 MotionConfig reducedMotion="user"）
- [x] 7.3 文档：`docs/总体设计.md` 路线图加入 ⑧ 并更新范围分层；`docs/contracts/speech-image-api.md` 补充 CHAT、`role`、`interrupt` 与 `reply.interrupted`。验证：文档评审通读。结果：总体设计新增 §2.2 调研摘要、路线图 ⑧ 与范围分层；契约 speech-image-api.md 补充 CHAT 配置、interrupt、reply.interrupted、role 与 AI 发言人；interpret-ws.md 新增 §4 AI 对话真实事件样例
