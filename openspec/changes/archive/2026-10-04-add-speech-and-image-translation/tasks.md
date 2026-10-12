## 1. infra：依赖、迁移与配置

- [x] 1.1 Spring 引入 `spring-boot-starter-websocket`；Python 用 `uv add` 引入 `sherpa-onnx`、`edge-tts`、`websockets`、`pillow`；web 无新依赖。验证：`mvn -q compile`、`uv run python -c "import sherpa_onnx, edge_tts, websockets, PIL"` 均通过
- [x] 1.2 编写 `V6__speech_image.sql`，内容：model_config 新增 `capability`/`supports_vision` 列，provider CHECK 增加 DASHSCOPE，默认唯一索引按 capability 重建；新建 `interpret_session`、`interpret_segment`、`image_translation` 及索引；给 tl_ai 授 SELECT（Python 只需读 model_config）。验证：Testcontainers 迁移测试通过，已有配置迁移后为 CHAT
- [x] 1.3 `.env.example` 新增 `STORAGE_DIR`、`SPEECH_MODEL_DIR`、`SPEECH_MODEL_MIRROR`、`INTERPRET_MAX_STREAMS`；`.gitignore` 加入存储目录；Spring `app.storage.dir`、Python settings 读取新增项。验证：两端启动日志打印生效的配置值
- [x] 1.4 Python 本地模型下载命令 `app/speech/download.py`：下载 SenseVoice int8 与 silero_vad.onnx，支持镜像，已存在时跳过。验证：执行一次后 `.cache/speech/` 中文件齐全；再次执行提示已存在

## 2. springboot-backend：模型配置扩展

- [x] 2.1 ModelConfig 实体、DTO 和校验增加 capability/supportsVision 与新提供方 DASHSCOPE/VOLCENGINE/GOOGLE，并按设计 D12 做能力与提供方组合校验；评审模型只允许 CHAT。验证：单测覆盖合法/非法组合，以及对 TTS 配置设评审时返回 A0410
- [x] 2.2 默认模型改为按 capability 唯一，options 接口支持 `capability`/`vision` 筛选并返回新字段。验证：单测覆盖"不同能力的默认互不影响"和"vision=true 只返回视觉模型"
- [x] 2.3 连通性测试按能力转发给 Python 新的测试分支，并补充 ErrorCode：A0450–A0454、C0170–C0174。验证：MockWebServer 测试各能力的转发参数，错误码枚举测试通过

## 3. python-backend：语音引擎层

- [x] 3.1 `app/repositories/model_config.py` 增加 capability 字段，默认模型查询加 `capability='CHAT'`，新增 `get_default(capability)`。验证：现有测试全绿，新测试确认不会误取 TTS 默认配置
- [x] 3.2 `app/speech/asr.py`：定义 ASR 接口，实现 `LocalSenseVoiceASR`（sherpa-onnx，返回 text+lang）与 `OpenAITranscribeASR`（WAV 上传，未返回 language 时用 lingua 补判）。验证：用 edge-tts 生成的中/日样本 WAV 测试本地识别结果；respx 模拟测试远程转写
- [x] 3.3 `app/speech/vad.py`：封装 Silero VAD 流式切句（min_silence 500 ms、max_speech 10 s），并提供 16k→24k numpy 重采样工具。验证：拼接"语音-静音-语音"的样本被切成 2 段；重采样后长度与采样率正确
- [x] 3.4 `app/speech/tts.py` + `voices.py`：实现 `EdgeTTS`（流式 MP3、默认音色表、男女声切换）、`OpenAISpeechTTS`（PCM16 24k）以及 LRU 缓存。验证：mock edge-tts 与 respx 单测；真实调用一次 edge-tts 合成中文并保存文件
- [x] 3.5 内部接口 `/internal/speech/{engines,transcribe,tts}` 与能力连通性测试分支（ASR 样本音频、TTS、REALTIME 建链、IMAGE 小图）。引擎可用性探测结果缓存 10 分钟。验证：API 测试覆盖模型缺失时 available=false、音频过长返回 A0454、TTS 失败返回 C0172

## 4. python-backend：图片翻译与解读

- [x] 4.1 `app/image/preprocess.py`：EXIF 旋转、长边缩放到 2048、记录缩放比、bbox 校验裁剪、还原坐标并归一化。验证：单测覆盖旋转图、超大图和越界 bbox
- [x] 4.2 `app/image/pipeline.py`：视觉 OCR（JSON 模式、非法 JSON 重试一次后报 C0171）→ 术语匹配 → 批量编号翻译（整图上下文 + 术语硬约束）→ 渲染数据。SSE 事件为 node、blocks、translation、done、error。验证：mock LLM 测试完整事件序列、空图片和 OCR 失败；中转站 gpt-5.6-luna 真实跑 1 张合成菜单图
- [x] 4.3 `app/image/qwen_mt_image.py`：DashScope 同步调用、下载译图并返回 base64，data URL 不被接受时标记为不可用。验证：respx 模拟成功与失败；按官方文档核对请求体
- [x] 4.4 `app/insights/`：`/internal/insights`（备选译法、关键表达、summary 的 JSON）与 `/internal/insights/ask`（SSE 中文回答，history ≤6）。验证：mock LLM 单测；真实调用一次习语示例，确认结构正确

## 5. python-backend：同传引擎

- [x] 5.1 `app/interpret/engine.py`：定义引擎接口（start/feed/control/close + emit）、统一事件模型、utteranceId 顺序发射器和 metrics 计时器。验证：单测确认乱序完成的句子按顺序发出 audio
- [x] 5.2 `app/interpret/cascade.py` 的识别部分：VAD 切句，进行中每 700 ms 产生 partial，句末产生 final 并识别语种；路由规则覆盖 LISTEN 同语种跳过、CONVERSE 自动/按键、ROOM 多目标。验证：单测按场景回放样本音频，断言事件与路由
- [x] 5.3 `cascade.py` 的翻译与合成部分：复用快速路径提示词 + TranslationContext（术语、最近 3 句、领域、口语风格），各目标并行、流式 delta、TTS 失败时非致命降级，限制 max_tokens。验证：mock LLM/TTS 测试一句双目标的完整事件序列和降级标记
- [x] 5.4 `app/interpret/qwen_livetranslate.py`：每个目标一个会话；按模型名区分 3.8（`output_modalities`）与 3.5（`modalities`/音频格式）两套 session 字段，始终显式传 voice（默认 Tina）；写入热词与源语种转写；事件映射按设计 D6，以 `response.audio_transcript.done` 分句，建连失败时退避重试 2 次。验证：用 `.env` 中的 `TEST_DASHSCOPE_API_KEY` 真实联调一句中文→英文，抓取事件序列保存为夹具；用模拟服务回放夹具，断言事件映射、热词与 e2e 计时
- [x] 5.5 WS 端点 `/internal/interpret/stream`：校验 X-Internal-Token，首帧 config 选择引擎，处理 targets/ptt/flush/mute/end 控制帧，并发上限 `INTERPRET_MAX_STREAMS`，上游断开时重建一次。验证：用 TestClient websocket 跑通级联端到端（mock LLM、真实本地 ASR 与样本音频），并用真实百炼引擎跑通一次

## 6. springboot-backend：同传、图片、语音与解读

- [x] 6.1 `module/speech`：`GET /api/speech/engines`（合并 DB 配置与 Python 探测）、`POST /api/speech/transcribe`（multipart WAV，60 s 上限）、`POST /api/speech/tts`（二进制透传）。验证：MockMvc + MockWebServer 测试三个接口及错误码
- [x] 6.2 `module/insight`：`POST /api/translations/insights`（JSON）与 `/insights/ask`（SSE 转发），限流复用 TranslateRateLimiter。验证：测试 SSE 转发以及原文过长返回 A0410
- [x] 6.3 `module/image` 的提交与转发：multipart 校验、文件存储（按日期分目录、按用户隔离）、SSE 转发，done 时落库，qwen-mt-image 译图落盘，vision 标记校验返回 C0170。验证：集成测试覆盖成功落库、过大图片返回 A0450、非视觉模型返回 C0170
- [x] 6.4 `module/image` 的记录接口：分页（关键词匹配 blocks 文本）、详情、原图/结果图读取（按用户隔离）、PATCH blocks、收藏、删除（异步删除文件）。验证：集成测试覆盖越权返回 A0404、编辑后读取结果一致
- [x] 6.5 `module/interpret` 的会话与票据：创建会话（单用户单活跃，返回 A0214）、加入房间（A0451/A0452）、票据（Redis 存储，60 s，一次性）、WS 握手拦截器（票据与 Origin 校验，失败返回 A0453），SecurityConfig 放行 `/ws/**`。验证：单测覆盖票据重复使用与过期；握手集成测试
- [x] 6.6 `InterpretWebSocketHandler` + `PythonStreamClient`（java.net.http.WebSocket）：发言流建立与转发，事件补充 speaker，audio 按语言路由，Python 断开时向浏览器发非致命错误并重建一次。验证：用模拟 Python WS 服务的集成测试，断言 transcript 广播与 audio 只到匹配语言的接收者
- [x] 6.7 `RoomRegistry`：成员进出与 participants 广播、targets 更新下发、主持人离开时关闭房间、30 s 内重连恢复身份、人数与语言上限。验证：单测覆盖三人三语的 targets 计算、超限、重连
- [x] 6.8 `SegmentWriter` 与会话结束：按句合并译文（到齐或 5 s 超时），每 1 s 或 20 条批量写入；结束时写入时长与统计，全部断开 60 s 后自动结束；历史接口提供同传列表、详情（转写分页 100 条）、收藏、删除。验证：集成测试覆盖合并、超时、自动结束与越权 A0404
- [x] 6.9 Spring 全量测试与 JaCoCo，确认覆盖率不低于现有水平。验证：`mvn verify` 通过，并记录覆盖率

## 7. web：基础设施

- [x] 7.1 音频基础：`public/worklets/pcm-capture.js`（抽取到 16k PCM16，40 ms 一帧，输出 RMS）、`lib/audio/player.ts`（PCM 环形缓冲 + MP3 按句解码排队、播放状态事件）、`lib/audio/wav.ts`。验证：vitest 测试 WAV 头与重采样函数；手动录 3 秒回放
- [x] 7.2 API 客户端与类型：speech、image（SSE）、insights（含 ask SSE）、interpret（会话、加入、票据）、history 分类；补齐对应 mock 数据与脚本化事件序列（同传逐句、图片步骤）。验证：`pnpm typecheck`、mock 模式下各接口返回示例数据
- [x] 7.3 `hooks/use-interpret-socket.ts` + `stores/interpret-store.ts`：连接、事件分发、半双工门控、指数退避重连（最多 3 次）、ptt/flush/mute 控制。验证：vitest 用模拟 WebSocket 测试事件归并与重连
- [x] 7.4 导航新增「同声传译」「图片翻译」，面包屑同步更新。验证：截图核对 USER 导航顺序与指示条动画

## 8. web：同声传译页面

- [x] 8.1 准备阶段：模式卡片向导（错开进场、悬停上浮）、语言与引擎设置（徽章、不可用原因提示、按引擎限制语言）、可折叠的「高级」分区、加入房间入口，以及麦克风权限引导卡片。验证：截图核对分步布局没有整页平铺，reduced-motion 下只做淡入
- [x] 8.2 收听模式：舞台大字幕、partial 过渡、历史字幕可折叠、控制条（电平光球、状态胶囊、延迟、播报开关、耳机模式、结束）。验证：mock 事件序列驱动截图；光球随电平缩放，reduced-motion 下为静态电平条
- [x] 8.3 对话模式：面对面两半区（上半区 180° 旋转）、按键说话按钮、自动开关（S2S 引擎禁用并提示）、气泡进场动效、"播报中，暂停收音"提示。验证：截图核对旋转动画与禁用态
- [x] 8.4 会议室模式：成员条（弹入、说话脉冲环）、房间码复制与链接、统一消息流（我的语言优先，可展开原文）、上限与错误提示，以及结束摘要对话框。验证：两个浏览器窗口（mock 或真实）加入同一房间并截图
- [x] 8.5 真实链路联调：启动 Spring + Python，后台录入百炼 REALTIME_TRANSLATE 配置；用级联引擎完成收听、自动对话、两窗口会议室各一次，用百炼引擎完成收听与按键对话各一次，确认记录写入历史。验证：截图与日志存入 `docs/test/interpret-smoke/`

## 9. web：图片翻译页面

- [x] 9.1 `lib/image-render.ts`：背景中位色采样、对比色、字号二分与换行、原图分辨率导出。验证：vitest 用 node-canvas 替身或纯函数测试字号与换行算法
- [x] 9.2 空状态与输入：拖拽区（拖入流光）、上传、粘贴、拍照弹窗（getUserMedia、快门白闪、切换摄像头）、示例图片、顶部语言与引擎工具条。验证：截图；在拒绝摄像头的情况下提示正确
- [x] 9.3 处理中与结果：扫描线、OCR 框依次淡入、译文交叉淡入、步骤胶囊；主从布局（画布查看器的译图/原图/对比滑块与缩放；右侧文本/术语/详情三个标签页）、行内编辑并重绘保存、下载 PNG、复制、换语言重译、收藏。验证：mock 与真实中转站各跑一张菜单图并截图；reduced-motion 下扫描线改为进度条

## 10. web：工作台增强、历史与管理

- [x] 10.1 工作台语音输入（录音电平、识别中态、回填并设置源语言、权限提示）与原文/译文朗读（声波动画、停止、浏览器兜底）。验证：真实录音识别一句中文；断开 edge-tts（mock 502）时自动改用浏览器朗读
- [x] 10.2 Agent 面板「解读」标签页：空状态、骨架屏、备选译法卡片及「采用」替换动效、关键表达、「问一问」流式气泡与快捷问题。验证：mock 截图；真实调用一次习语示例
- [x] 10.3 历史页分类标签（文本/图片/同传，指示条与交叉淡入）、图片记录卡片与详情（只读查看器）、同传记录卡片与详情（双语转写、语言切换、搜索、统计）。验证：截图核对三类详情
- [x] 10.4 管理后台模型配置：能力类型分段控件联动表单与 provider、列表按能力分组、「支持图片」徽章、各能力的测试结果展示。验证：新增一个 TTS 配置的截图；非法组合提示
- [x] 10.5 web 质量门：`pnpm lint`、`pnpm typecheck`、`pnpm test`、`pnpm build` 全部通过，新增逻辑有单测。验证：命令输出记录

## 11. evaluation：E4 / E5 实验

- [x] 11.1 同传数据集 `data/speech/`：zh/en/ja/ko 各 10 句加参考译文，合成脚本（edge-tts，与播报不同音色，输出 16 kHz WAV），README 写明局限。验证：校验脚本确认 40 条齐全
- [x] 11.2 `eval/multimodal/e4_interpret.py`：按实时速度推流到 Python WS，统计 CER/WER、chrF（含文本上界）、分段延迟 p50/p90，设置"带/不带术语与上下文"对照组和百炼 S2S 对照组，无密钥的可选引擎跳过。验证：小样本试跑后全量运行，输出 e4_summary.csv 与延迟图
- [x] 11.3 图片数据集 `data/image/`：渲染脚本（3 类场景 × 中/英/日源语言，至少 30 张，含字体/颜色/倾斜变化）与真值 blocks、参考译文。验证：抽查 5 张图与真值框对齐
- [x] 11.4 `eval/multimodal/e5_image.py`：两步法与单次视觉翻译对比，统计 OCR 字符准确率、IoU≥0.5 召回、chrF、术语准确率、耗时与 token。验证：全量运行，输出 e5_summary.csv 与对比图
- [x] 11.5 `tests/test_multimodal.py`：覆盖 CER、IoU 匹配、汇总逻辑的单测。验证：`uv run pytest tests/test_multimodal.py` 通过

## 12. python-backend：可选 S2S 引擎（排期紧张时可整组裁剪）

- [x] 12.1 `app/interpret/openai_realtime.py`：每个目标一个 WS 会话，16k→24k 上行，事件映射，按静默 1.2 s 或标点分句。验证：pytest 内启动 `websockets.serve` 模拟服务，按官方事件序列回放
- [x] 12.2 `app/interpret/gemini_live_translate.py`：setup 设置 targetLanguageCode、echoTargetLanguage=false、输入/输出转写；16k 上行、24k 下行。验证：模拟服务按官方文档的消息序列回放
- [x] 12.3 `app/interpret/doubao_ast.py`：用官方 proto 生成 `vendor/doubao_pb/`，实现 StartSession/TaskRequest/FinishSession 编解码与事件映射，Header 鉴权，标注"一侧须为 zh/en"的语种约束。验证：protobuf 往返单测 + 模拟服务；proto 无法取得时把该引擎标为未实现并隐藏
- [x] 12.4 引擎列表、模型配置表单与连通性测试接入三个可选引擎（provider 对应 OPENAI_COMPATIBLE/GOOGLE/VOLCENGINE；豆包的 appId 放在额外参数中）。验证：未配置时显示"需配置"，配置假密钥时连通性测试返回归类后的错误

## 13. docs：文档与收尾

- [x] 13.1 实验报告第 11 节（E4/E5 设置、结果表与图、结论与局限，数字逐一与 CSV 对齐）。验证：抽查 5 个数字与 CSV 一致
- [x] 13.2 更新总体设计：竞品对标表、同传厂商调研与实测记录、范围分层（语音与图片移入范围）、架构图增加 WS 通道、路线图 ⑦；`docs/contracts/interpret-ws.md` 写明实时音频通道协议，附真实抓取的事件样例。验证：文档中的事件字段与代码中的事件模型一致
- [x] 13.3 重新生成测试报告（三端用例数与覆盖率、新能力证据表）；Python 质量门 `ruff check`、`pytest --cov` 通过。验证：报告中列出 live-interpretation、speech-services、image-translation、translation-insights、multimodal-evaluation
