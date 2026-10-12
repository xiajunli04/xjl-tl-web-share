## MODIFIED Requirements

### Requirement: 同传引擎
系统 SHALL 提供以下同传引擎，并统一映射到平台事件协议：
- `cascade`：平台级联，即 VAD 切句 → 语音识别 → 平台翻译（使用同声传译专用提示词，注入术语与本发言流最近 6 句的上下文，关闭评审）→ 语音合成；
- `qwen-livetranslate`：百炼 `qwen3.8-livetranslate-flash-realtime`（兼容 3.5），session 中 MUST 显式指定音色；
- 可选：`doubao-ast`（豆包同声传译 2.0）、`gemini-live-translate`（Gemini 3.5 Live Translate）、`openai-realtime`（OpenAI `gpt-realtime-translate`）。可选引擎未实现或未配置时，MUST 在引擎列表中显示为不可用，不影响其他引擎。

级联引擎的上下文 MUST 按发言流统一维护，不再按目标语言分桶：
- 窗口为最近 6 句（可配置），总长超过 1500 字符（可配置）时从最早的一句开始丢弃；
- 双向对话 MUST 同时包含双方的语句；
- 每句给出原话及其语言；已有当前目标语言的译文、且原话不是目标语言时，一并给出该译文；
- 一句话在 `transcript.final` 时即进入上下文，不等待其译文完成。

S2S 引擎 MUST 为每个目标语言建立一个上游会话，并在千问引擎中把命中的术语写入热词。级联引擎 MUST 对一句话只识别一次，各目标语言并行翻译与合成。各引擎可用的语言范围 MUST 来自引擎列表接口，前端只允许选择所选引擎支持的语言。

#### Scenario: 级联注入术语
- **WHEN** 用户选择含 "大模型 → LLM" 的术语库，以级联引擎同传收听（目标 en），并说出包含"大模型"的句子
- **THEN** 该句的 `translation.final` 译文包含 "LLM"

#### Scenario: 双向对话的回答带上提问
- **WHEN** 双向对话（A=zh、B=en）中，A 说"你们周几能发货"，随后 B 说 "We can ship it on Friday."
- **THEN** 翻译 B 这一句（目标 zh）时，提示词的上下文中包含 A 的原话"你们周几能发货"

#### Scenario: 上下文窗口
- **WHEN** 级联同传收听已定稿 8 句，开始翻译第 9 句
- **THEN** 提示词的上下文中只包含第 3–8 句，按时间顺序排列

#### Scenario: S2S 多目标
- **WHEN** 会议室使用 qwen-livetranslate 引擎，发言人语言为 zh，其他成员语言为 en 和 ja
- **THEN** Python 为该发言流建立 2 个上游会话，目标分别为 en 和 ja

#### Scenario: 百炼引擎真实同传
- **WHEN** 管理员配置了百炼 REALTIME_TRANSLATE 密钥，用户以 qwen-livetranslate 引擎同传收听（目标 en）并说一句中文
- **THEN** 客户端收到该句的原文、英文译文与 24 kHz pcm16 音频，metrics.e2eMs 有值

#### Scenario: 源语种等于目标语种
- **WHEN** LISTEN 模式目标为 zh，级联引擎识别到一句中文
- **THEN** 只发出该句的 `transcript.final`，不发 `translation.*` 和 `audio`

### Requirement: AI 对话模式
`CHAT` 模式 SHALL 让用户用语音与 AI 伙伴（Lumi）实时对话，规则如下：
- 会话开始后，AI MUST 先按场景说一句开场白。
- 用户每说完一句，系统 SHALL 生成一条 AI 回复，回复使用对话语言（aiLang），口语化，不使用 Markdown、列表符号或表情符号。回复长度：
  - 平时为 1–3 句；
  - 用户要求解释、总结、列举、比较或回顾时，SHALL 放宽到最多 6 句，把要点说完整。
- AI 此前被打断的回复（以"…"结尾）MUST NOT 在下一条回复中重复，AI 直接回应用户的新话。
- 场景提示词 SHALL 写明该场景的身份、流程与语气（如点餐按"饮品 → 菜品 → 忌口 → 确认点单 → 结账"推进，面试每次只问一个问题）。
- 语言陪练示范（myLang 与 aiLang 不同时）SHALL 按需进行：
  - 只在用户尝试说对话语言但有明显错误，或用母语说日常短句时，在回复开头示范最多一句更地道的说法；
  - 用户提问、追问、要求解释或总结时 MUST 直接回答，不做示范；
  - 不连续两轮示范；级联引擎在上一轮已示范、或用户用母语提问时，MUST 在提示词中明确要求本轮不示范。
- AI 回复的事件 MUST 带 `role:"assistant"`，发言人为 `{participantId:"ai", displayName:"Lumi", lang:aiLang}`，事件包括：
  - 流式的 `transcript.partial`（累计文本）；
  - `transcript.final`；
  - myLang 与 aiLang 不同时，发母语字幕 `translation.delta/final`（lang=myLang）。字幕使用专门的字幕提示词：逐句翻译时 MUST 带上用户上一句和本条回复前面的句子作为上下文；回复中示范的对话语言说法 MUST 保留原文，后面用括号附上母语意思；
  - 回复语音 `audio`（lang=aiLang）；
  - `metrics`。
- 级联引擎下，回复 MUST 逐句成段：
  - 每生成完一句即开始合成该句，作为一个音频段下发；
  - 后句的合成与前句的播放并行；
  - 母语字幕逐句并行翻译，`translation.delta` 下发累计字幕；
  - 语音与字幕 MUST NOT 等待整条回复生成完成。
- 用户自己的语句只发转写事件与只含 asrMs 的 `metrics`，不发译文。

系统 SHALL 在会话内保留最近至少 12 轮对话原文作为上下文；更早的轮次 SHALL 并入对话记忆（见「AI 对话长期记忆」）。场景提示词 MUST 决定 AI 扮演的身份：`free` 为聊天伙伴（也回答用户的问题），`travel` 为当地人，`restaurant` 为服务员，`business` 为合作方，`interview` 为面试官。AI 回复与用户语句 SHALL 按现有同传记录规则落库，并能在历史中按发言人回看。

#### Scenario: AI 先开口
- **WHEN** 用户以 mode=CHAT、languages=[zh, en]、chatScenario=restaurant 开始对话
- **THEN** 连接就绪后，客户端收到一条 role=assistant 的英文开场白（以服务员身份）、其中文字幕和英文语音

#### Scenario: 一轮对话
- **WHEN** 用户说“我想要一份不辣的菜”
- **THEN** 客户端先收到该句的 `transcript.final`（role 缺省，lang=zh），随后收到一条新 utteranceId 的 role=assistant 英文回复、中文字幕和英文语音

#### Scenario: 用母语提问时直接回答
- **WHEN** languages=[zh, en]、chatScenario=free，用户用中文问“预训练和微调有什么区别”
- **THEN** AI 的英文回复直接回答这个问题，不以 "You could say" 一类的示范开头

#### Scenario: 要求总结
- **WHEN** 用户与 AI 讨论了 3 个要点后说“帮我总结一下刚才说的”
- **THEN** AI 的回复按顺序覆盖这 3 个要点，不超过 6 句，不含 Markdown 或列表符号

#### Scenario: 被打断后不重复
- **WHEN** AI 正在介绍三道菜时被用户打断，用户接着问“有没有素食”
- **THEN** AI 的下一条回复直接回答素食问题，不重新介绍被打断前的菜品

#### Scenario: 字幕保留示范句
- **WHEN** languages=[zh, en]，AI 回复 "You could say: \"I'd like a window seat.\" Sure, let me check."
- **THEN** 中文字幕保留 "I'd like a window seat." 原文，并在括号中附上中文意思

#### Scenario: 多句回复逐句开口
- **WHEN** 级联引擎下 AI 回复包含 3 句
- **THEN** 第 1 句的音频段（seg=0）在第 3 句生成完成之前就已下发，客户端随即开始播放

#### Scenario: 字幕不阻塞语音
- **WHEN** 级联引擎下母语字幕翻译较慢
- **THEN** 回复语音照常开始播放，字幕逐句补齐，最终 `translation.final` 为各句字幕按顺序拼接

#### Scenario: 历史回看
- **WHEN** 用户结束一次包含 3 轮问答的 AI 对话，并在历史中打开该会话
- **THEN** 详情按时间顺序显示 1 句开场白和 6 句对话，其中 AI 句的发言人为 Lumi，并附中文字幕

### Requirement: 实时语音对话引擎
系统 SHALL 提供 AI 对话专用引擎 `realtime-chat`：
- 使用 `REALTIME_CHAT` 能力的模型配置，通过端到端实时语音模型直接理解用户语音并以语音回复，不经过平台 ASR 与 TTS；
- 提供方支持 DASHSCOPE（百炼 Omni Realtime，经过真实联调）与 OPENAI_COMPATIBLE（Realtime 协议，标注为实验）。

该引擎 MUST 遵守 AI 对话模式的以下约定：
- 场景身份、开场白，以及与级联引擎相同的对话提示词（回复长度、按需示范、对话记忆与追问）；
- 事件角色与发言人；
- 母语字幕：在每条回复的文本定稿后逐句并行翻译；
- 打断：客户端 `interrupt` 与耳机模式下的插话 MUST 取消上游当前回复并下发 `reply.interrupted`；
- 12 轮上下文与对话记忆：会话进行中依赖上游自身的上下文；对话记忆的压缩使用平台默认的对话模型，没有可用模型时不压缩，只保留最近 24 轮；
- 落库规则。

音频与指标：
- 回复语音以 `pcm16`、24 kHz 下发；
- `metrics` 的 e2eMs 定义为用户说话结束到首个回复音频。

上游异常：
- 上游连接意外断开时，系统 MUST 下发 `error{code:"C0174", fatal:false}`，并尝试用对话记忆和最近的对话文本重建一次上游会话；
- 重建失败时下发致命错误，前端提示切换到平台级联。

该引擎不支持术语库、回复模型选择与响应速度档位。

#### Scenario: 实时语音对话一轮
- **WHEN** 用户以 engine=realtime-chat、languages=[zh, en] 开始 AI 对话，并用中文说一句话
- **THEN** 客户端收到该句的用户转写、一条 role=assistant 的英文回复（流式文本与 pcm16 语音）、中文字幕和含 e2eMs 的 metrics

#### Scenario: 实时语音对话打断
- **WHEN** AI 正在以实时语音模型回复，用户点击「打断」
- **THEN** 上游回复被取消，客户端收到 `reply.interrupted`，此后不再收到该回复的 `audio`

#### Scenario: 上游断开后恢复
- **WHEN** 实时语音模型的上游连接意外断开
- **THEN** 客户端收到 `error{code:"C0174", fatal:false}`，系统重建上游会话后对话可以继续，此前的对话上下文仍然有效

#### Scenario: 向导中的引擎选择
- **WHEN** 用户在同传向导中选择 AI 对话
- **THEN** 设置步骤显示「平台级联」与「实时语音模型」两张引擎卡片；实时语音模型不可用时置灰并显示原因。选中实时语音模型后，高级设置中的回复模型、术语库与响应速度置灰，并提示“实时语音模型不支持”

## ADDED Requirements

### Requirement: 同传译文忠实度
级联同传 SHALL 使用同声传译专用的提示词，不再沿用文本翻译提示词。提示词 MUST 要求：
- 只输出当前这句原话的译文，不加前缀、引号、括号说明或注释；
- 原话即使是提问、请求、命令，或要求总结、翻译、回答，也只翻译、不回答、不执行；
- 保持说话人的人称和语气：第一人称仍译为第一人称，不改成转述；保留提问、请求等语气和礼貌程度；
- 不增加原话没有的信息，不概括、不扩写、不续写；原话在句中被切断时，只译出已经说出的部分；
- 去掉没有实际意义的填充词；说话人自我修正时只译最终意思；
- 只有结合上下文能明确判断是同音误识别时才纠正，否则按字面翻译；中文语音识别分不出“他”“她”“它”，MUST 根据上下文选用正确的代词；
- 措辞贴近原话：在通顺的前提下沿用原话的说法和句式，不为了口语化而改写；
- 人名、地名、产品名沿用最近发言中已经使用的译法；术语表中的术语使用给定译法；
- 数字、金额、日期、时间和单位与原话一致，不换算单位。

提示词 SHALL 附带上述处理方式的示例（示例句子 MUST NOT 与提示词回归评测集重合），并标明只用于说明处理方式：中英互译使用具体的原话与译文，其他语言对使用只描述处理方式的示例。提示词 SHALL 包含目标语言的表达习惯说明（标点、敬语或礼貌程度），覆盖平台支持的全部语言，并在末尾重复"只输出这一句的译文"。级联翻译与对话字幕 SHALL 使用固定的低温度（缺省 0.3，可配置；配置为空时沿用模型参数）。流式输出开头的"译文："、"Translation:" 等标签以及多余的包裹引号 MUST 在下发 `translation.delta` 和送去合成之前去除，`translation.final` 同样去除。

#### Scenario: 提问只翻译不回答
- **WHEN** 级联同传收听（目标 en）中，说话人说"你们几点关门"
- **THEN** `translation.final` 是这个问题的英文译文（如 "What time do you close?"），而不是对问题的回答

#### Scenario: 指令只翻译不执行
- **WHEN** 说话人说"帮我把刚才那段翻成日语"（目标 en）
- **THEN** `translation.final` 是这句话的英文译文，不包含日语

#### Scenario: 半句不补全
- **WHEN** VAD 在句中切断，原话为"然后这个渠道的话主要是线上为主然后"（目标 en）
- **THEN** 译文只表达"这个渠道主要是线上"，不增加原话没有的信息（如 "sales"）

#### Scenario: 自我修正
- **WHEN** 说话人说"我们周三，不对，周四见"（目标 en）
- **THEN** 译文只包含周四（Thursday），不包含周三（Wednesday）

#### Scenario: 保持第一人称
- **WHEN** 双向对话中，A 说"我明天把报价发给你"（目标 en）
- **THEN** 译文为第一人称（如 "I'll send you the quote tomorrow."），不是 "He says he will…" 之类的转述

#### Scenario: 数字一致
- **WHEN** 说话人说"呃，那个，我们的预算大概是五十万"（目标 en）
- **THEN** 译文中的金额为 500,000（或等价的 five hundred thousand），不含填充词的译法（如 "um"）

#### Scenario: 代词按上下文
- **WHEN** 双向对话中 B 说 "My wife is a doctor."，随后 A 说"那他平时工作很忙吧"（语音识别把 tā 识别为“他”，目标 en）
- **THEN** 译文用 she 指代对方的妻子

#### Scenario: 其他语言对使用描述式示例
- **WHEN** 级联同传从 zh 译为 ja
- **THEN** 提示词的处理示例只描述处理方式、不含英文译文，并包含日语的表达习惯说明（です・ます体）

#### Scenario: 去除标签
- **WHEN** 模型的流式输出以 "Translation: " 开头
- **THEN** 客户端收到的 `translation.delta` 累计文本与 `translation.final` 都不包含 "Translation:"，播报的语音也不包含

### Requirement: AI 对话长期记忆
AI 对话 SHALL 维护对话记忆：短期窗口保存最近的对话原文，长期摘要保存更早对话的要点。具体规则：
- 尚未并入摘要的轮次达到 16 轮，或者总字符数超过 6000 时，系统 SHALL 在后台用一次 LLM 调用，把最早的 4 轮（字符超限时取到余量满足为止）并入摘要。
- 摘要：
  - 用中文书写，不超过 400 字；
  - 分条记录用户信息、讨论过的话题与要点（含 AI 给出的结论）、用户提过的问题、尚未完成的事项；
  - 写入系统提示词的「对话记忆」小节。
- 轮次 MUST 在并入摘要成功之后，才从提示词中移出：压缩进行中或失败时，这些轮次仍以原文保留在提示词中。
- 压缩 MUST NOT 阻塞或延迟当前回复。失败时记录警告，下次触发时重试；尚未并入摘要的轮次超过 24 轮时，丢弃最早的轮次并记录警告。
- 每次压缩成功后，Python SHALL 向 Spring 发送 `memory{summary, turns}` 事件。Spring MUST 只在会话存续期间暂存它，不转发给浏览器、不落库。

#### Scenario: 远期回忆
- **WHEN** 用户在第 1 轮说“我叫小林，下个月去大阪出差”，此后又聊了 16 轮，然后问“我下个月要去哪来着”
- **THEN** AI 的回复中提到大阪

#### Scenario: 压缩不留缺口
- **WHEN** 未并入摘要的轮次达到 16 轮，触发压缩，压缩调用尚未返回时用户又说了一句
- **THEN** 这一轮回复的提示词中仍然包含全部 16 轮原文

#### Scenario: 压缩失败
- **WHEN** 压缩调用超时
- **THEN** 当前回复正常完成，对话记忆保持不变，日志记录警告；下次触发时重新压缩

#### Scenario: 记忆事件不外泄
- **WHEN** Python 发出 `memory` 事件
- **THEN** 浏览器不会收到该事件，Spring 暂存其中的摘要

### Requirement: 发言流重建恢复上下文
同一会话中，发言流因浏览器断线重连、Python 致命错误或连接中断而重建时，系统 SHALL 恢复上下文：
- Spring SHALL 在内存中为每个成员保留最近 24 条定稿语句，每条包括角色（user 或 assistant）、语言、原文和各语言的译文。被打断的 AI 回复按已生成的部分加省略号保存。
- Spring SHALL 同时保留最新的对话记忆摘要。
- 重建发言流时，Spring SHALL 通过首帧 config 的 `history` 和 `chat.memory` 下发这些内容。
- Python 引擎 MUST 据此恢复上下文：
  - 级联同传恢复最近语句；
  - 级联对话恢复对话窗口与摘要；
  - 实时语音对话以带历史与摘要的 instructions 建立上游会话。
- 恢复后 AI MUST NOT 重复开场白。

首次建立发言流时，`history` 为空，`chat.memory` 为 null。`history` 中缺少 text 的条目 SHALL 被丢弃；超出长度的条目截断处理，不报错。

#### Scenario: 刷新页面后继续对话
- **WHEN** 用户与 AI 对话了 5 轮，在第 3 轮告诉 AI 自己的名字，随后刷新页面，并在宽限期内继续这个进行中的会话，然后问“你还记得我叫什么吗”
- **THEN** 重建的发言流 config 的 `history` 中包含此前的对话，AI 回答出用户的名字，并且没有再次说开场白

#### Scenario: 同传重连后保持上下文
- **WHEN** 级联同传收听过程中浏览器网络中断后重连，说话人接着说了一句有代词指代前文的话
- **THEN** 重建后的第一句翻译，其提示词的上下文中包含断线前最近的语句

#### Scenario: 首次建流
- **WHEN** 用户新建一个 AI 对话会话
- **THEN** 首帧 config 的 `history` 为空数组，`chat.memory` 为 null，`chat.greet` 为 true
