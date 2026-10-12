# 语音、同传、图片翻译与解读接口契约

> 来源：openspec/changes/add-speech-and-image-translation（design D1–D15、specs/*）。
> 本文是 Python ↔ Spring ↔ Web 三方实现的唯一字段依据；修改字段必须先改本文。
> 约定沿用现有接口：Spring 对外 `Result<T>{code,message,data,traceId}`；Python 内部同样的信封，`X-Internal-Token` 鉴权；
> SSE 每个事件为 `event:` 行 + 单行 JSON `data:` 行；JSON 字段一律 camelCase；语言代码为平台 15 语种的 ISO 639-1（`zh en ja ko fr de es ru pt it ar th vi id tr`），另允许 `yue` 作为识别结果（路由时视为 `zh`）。

---

## 0. 公共定义

### 0.1 引擎 ID

| 类型 | id | 说明 | 依赖 |
|---|---|---|---|
| asr | `local-sensevoice` | 本地 SenseVoice + Silero VAD | 本地模型文件 |
| asr | `openai-transcribe` | OpenAI 兼容 `/audio/transcriptions` | capability=ASR 的模型配置 |
| tts | `edge-tts` | 微软 Edge 在线语音（MP3） | 网络 |
| tts | `openai-speech` | OpenAI 兼容 `/audio/speech`（PCM16 24 kHz） | capability=TTS 的模型配置 |
| tts | `browser` | 浏览器 speechSynthesis（服务端不出音频） | 无 |
| interpret | `cascade` | 平台级联：VAD → ASR → 翻译 → TTS | asr/tts 引擎 + CHAT 默认模型 |
| interpret | `qwen-livetranslate` | 百炼 qwen3.8/3.5-livetranslate-flash-realtime | REALTIME_TRANSLATE + DASHSCOPE 配置 |
| interpret | `doubao-ast` | 豆包同声传译 2.0（可选） | REALTIME_TRANSLATE + VOLCENGINE 配置 |
| interpret | `gemini-live-translate` | Gemini 3.5 Live Translate（可选） | REALTIME_TRANSLATE + GOOGLE 配置 |
| interpret | `openai-realtime` | OpenAI gpt-realtime-translate（可选） | REALTIME_TRANSLATE + OPENAI_COMPATIBLE 配置 |
| image | `vision` | 视觉模型 OCR → 术语 → 平台翻译 | supportsVision=true 的 CHAT 配置 |
| image | `qwen-mt-image` | 百炼 qwen-mt-image-2.0 一体化译图 | IMAGE_TRANSLATE + DASHSCOPE 配置 |

### 0.2 EngineInfo

```json
{
  "id": "qwen-livetranslate",
  "type": "interpret",
  "name": "千问同传",
  "vendor": "阿里百炼",
  "kind": "config",            // builtin | config
  "available": true,
  "reason": null,              // 不可用原因（中文），available=true 时为 null
  "languages": ["zh","en","ja","ko","fr","de","es","ru","pt","it","ar","th","vi","id","tr"],
  "modelConfigId": 12,         // kind=config 时为所用配置 id（默认配置优先），否则 null
  "s2s": true,                 // interpret 引擎：是否厂商语音到语音
  "maxTargets": 3,             // interpret 引擎：单条发言流最多目标语言数（cascade 为 5）
  "autoConverse": false,       // interpret 引擎：双向对话是否支持自动方向（仅 cascade 为 true）
  "constraint": null           // 额外语种约束说明，如豆包 "源或目标须为中文/英文"
}
```

### 0.3 错误码（新增）

| 码 | HTTP | 含义 |
|---|---|---|
| A0450 | 400 | 图片为空、过大或格式不支持 |
| A0451 | 409 | 会议室已满或语言数超限 |
| A0452 | 404 | 房间不存在或已关闭 |
| A0453 | 401 | WS 票据无效或已使用 |
| A0454 | 400 | 音频为空、过长（听写上限 60 s）或格式不支持 |
| C0170 | 400 | 所选模型不支持图片输入 |
| C0171 | 502 | OCR 结果解析失败 |
| C0172 | 502 | 语音合成失败（同传中为非致命） |
| C0173 | 503 | 语音引擎不可用 |
| C0174 | 502 | 实时同传上游连接失败或中断 |

Python `ErrorCode` 枚举需要同步增加 A0450、A0454、C0170–C0174（A0451–A0453 只在 Spring 产生）。

---

## 1. Python 内部接口（Spring 调用）

全部需要 `X-Internal-Token`。非 SSE 接口返回信封 `{code,message,data,traceId}`，错误时 HTTP 状态码与错误码表一致。

### 1.1 `GET /internal/speech/engines`

响应 `data`：`{"asr":[EngineInfo], "tts":[EngineInfo], "interpret":[EngineInfo], "image":[EngineInfo]}`。
Python 读取 `biz.model_config` 组装 config 型引擎；内置引擎探测结果缓存 10 分钟（`?refresh=true` 强制刷新）。
未实现的可选引擎（如缺少 proto 的 doubao-ast）不出现在列表中。

### 1.2 `POST /internal/speech/transcribe`

请求：
```json
{"audioBase64":"<WAV 16kHz mono PCM16>", "lang":"auto", "engine":"local-sensevoice", "modelConfigId":null}
```
`engine` 缺省：有启用的 ASR 配置时取 `openai-transcribe`，否则 `local-sensevoice`。
响应 `data`：`{"text":"大家好","lang":"zh","durationMs":3120,"engine":"local-sensevoice"}`。
错误：空/超 60 s/非 WAV → A0454；引擎不可用 → C0173。

### 1.3 `POST /internal/speech/tts`

请求：`{"text":"Hello","lang":"en","voice":null,"gender":"female","engine":"edge-tts","modelConfigId":null}`
成功：HTTP 200，**二进制**响应体；`Content-Type: audio/mpeg`（edge-tts）或 `audio/L16;rate=24000`（openai-speech）；响应头 `X-Tts-Engine`、`X-Tts-Voice`。
失败：信封 JSON，C0172 / C0173 / A0410（超过 2000 字符）。`engine=browser` 返回 A0410（浏览器朗读不经过服务端）。

### 1.4 `POST /internal/llm/test`（扩展）

请求不变 `{"modelConfigId":1}`。Python 按配置的 capability 分支：

| capability | 测试 | `data.reply` |
|---|---|---|
| CHAT | 原有 | 回复片段 |
| ASR | 转写内置样本 `app/speech/assets/sample_zh.wav` | 识别文本 |
| TTS | 合成"你好" | `"音频 12345 字节"` |
| REALTIME_TRANSLATE | 建立上游会话并完成会话配置后关闭 | `"会话已建立"` |
| IMAGE_TRANSLATE | 翻译内置 64×32 文字图 | `"结果图 64×32"` |

响应结构沿用 `{ok, latencyMs, reply, usage, errorCode, errorMessage}`。

### 1.5 `POST /internal/image/translate`（SSE）

请求：
```json
{
  "requestId":"img-7f3a", "userId":5,
  "imageBase64":"...", "mime":"image/jpeg",
  "sourceLang":"auto", "targetLang":"en",
  "engine":"vision", "modelConfigId":null, "glossaryIds":[3]
}
```
事件（顺序）：

```
event: start
data: {"requestId":"img-7f3a"}

event: node
data: {"seq":1,"node":"ocr","status":"started"}

event: node
data: {"seq":2,"node":"ocr","status":"completed","summary":"识别到 6 个文本块（中文）","latencyMs":3210}

event: blocks
data: {"width":1200,"height":900,"detectedLang":"zh","blocks":[{"id":1,"text":"宫保鸡丁","bbox":[0.12,0.20,0.38,0.26]}]}

event: node
data: {"seq":3,"node":"terms","status":"completed","summary":"命中 1 条术语","latencyMs":4}

event: node
data: {"seq":4,"node":"translate","status":"started"}

event: node
data: {"seq":5,"node":"translate","status":"completed","summary":"已翻译 6 块","latencyMs":2100}

event: translation
data: {"blocks":[{"id":1,"text":"宫保鸡丁","translation":"Kung Pao Chicken","bbox":[0.12,0.20,0.38,0.26]}]}

event: node
data: {"seq":6,"node":"render","status":"completed","summary":"坐标已归一化","latencyMs":1}

event: done
data: {"detectedLang":"zh","blocks":[...],"termHits":[{"source":"宫保鸡丁","target":"Kung Pao Chicken","followed":true,"blockIds":[1]}],
       "trace":[{"node":"ocr","status":"completed","summary":"...","latencyMs":3210}],
       "usage":{"promptTokens":1500,"completionTokens":420},"latencyMs":5400,
       "modelConfigId":2,"resultImageBase64":null}
```
- `bbox` 一律为原图归一化坐标 `[x0,y0,x1,y1]`，0–1，x0<x1、y0<y1。
- 无文字：`blocks` 为空，正常 `done`，`node(ocr).summary="未识别到文字"`。
- `engine=qwen-mt-image`：节点为 `translate`（一次调用）与 `render`，`blocks` 与 `translation` 事件省略，`done.blocks=[]`，`done.resultImageBase64` 为 JPG。
- 失败：`event: error` `data: {"code":"C0171","message":"OCR 结果解析失败"}`，随后结束。
- Spring 落库后在 `done` 中补 `id`（记录 id）再转发给浏览器。

### 1.6 `POST /internal/insights`

请求：`{"source":"It's raining cats and dogs.","translation":"下着倾盆大雨。","sourceLang":"en","targetLang":"zh","modelConfigId":null}`
响应 `data`：
```json
{
  "alternatives":[{"text":"雨下得很大。","register":"中性","note":"日常叙述最常用"}],
  "expressions":[{"source":"raining cats and dogs","target":"倾盆大雨","meaning":"形容雨下得非常大","note":"英语习语，不能直译"}],
  "summary":"原文是英语习语，译文采用中文四字成语对应。",
  "usage":{"promptTokens":210,"completionTokens":180}
}
```
`register` 取值：`正式` `中性` `口语` `书面` `文学`。原文超过 2000 字符 → A0410。

### 1.7 `POST /internal/insights/ask`（SSE）

请求：`{source, translation, sourceLang, targetLang, modelConfigId, question, history:[{"q":"...","a":"..."}]}`（history ≤ 6）。
事件：`delta {"text":"因为"}` … `done {"usage":{...}}` 或 `error {"code","message"}`。

### 1.8 `WS /internal/interpret/stream`

握手头：`X-Internal-Token`。一个连接 = 一条发言流。

**首帧（文本）config**：
```json
{
  "type":"config",
  "streamId":"s-42-p1", "sessionId":42, "userId":5,
  "mode":"LISTEN",                         // LISTEN | CONVERSE | ROOM | CHAT
  "engine":"cascade",
  "sourceLangs":["auto"],                  // LISTEN: ["auto"] 或提示集合；CONVERSE: [A,B]；ROOM: [发言人语言]；CHAT: [我的语言, 对话语言]
  "targetLangs":["zh"],                    // LISTEN: [目标]；CONVERSE: [A,B]（按路由取另一侧）；ROOM: 其他成员语言；CHAT: []
  "converseRouting":"auto",                // CONVERSE: auto | ptt
  "glossaryIds":[3], "domainHint":"技术发布会",
  "modelConfigId":null,                    // cascade 翻译所用 CHAT 模型；S2S 引擎所用 REALTIME_TRANSLATE 配置
  "asrEngine":"local-sensevoice", "ttsEngine":"edge-tts",
  "tts":true, "voices":{"en":null}, "gender":"female",
  "chat":null                              // 仅 CHAT：{"scenario":"restaurant","myLang":"zh","aiLang":"en","persona":"Lumi","greet":true}
}
```
CHAT（AI 对话，add-ai-avatar-and-landing）只允许 `engine=cascade`，否则 4400；`scenario` ∈ `free` `travel` `restaurant` `business` `interview`；
`greet=true` 时 AI 在就绪后先说开场白（发言流断线重建时 Spring 传 false，避免重复）。
**之后**：二进制帧 = PCM16LE 16 kHz 单声道；文本控制帧：
- `{"type":"targets","targetLangs":["en","ja"]}` 会议室成员变化
- `{"type":"ptt","side":"A"}` / `{"type":"ptt","side":null}` 双向对话按键（A=sourceLangs[0]）
- `{"type":"flush"}` 强制断句；`{"type":"mute","muted":true}`；`{"type":"end"}`
- `{"type":"interrupt"}` 仅 CHAT：取消进行中的 AI 回复（LLM 流、字幕翻译、TTS），未发出的音频丢弃
- `{"type":"interrupt","yield":true}` 仅 CHAT（improve-speech-endpointing-and-live-ux D6）：让位——撤回最近一条
  客户端尚未开始播放的 AI 回复：发 `transcript.discard{role:"assistant"}`，不写入对话记忆；用户随后定稿的新句与上一句合并为一轮；
  续说被丢弃或 3 s 内没有新句定稿时为上一句重新回复

**Python → Spring 事件**（Spring 补 `speaker` 后转发，见 §2.6）：

| type | 字段 |
|---|---|
| `ready` | engine, sourceLangs, targetLangs |
| `transcript.partial` | utteranceId, text, hold?（级联：true 表示判为未说完、正在等待续说） |
| `transcript.discard` | utteranceId（撤回尚未定稿的语句：语气词 / 噪声，或让位撤回的 AI 回复；此后该 utteranceId 不再有事件） |
| `transcript.final` | utteranceId, text, lang, startedMs, endedMs |
| `translation.delta` | utteranceId, lang, delta |
| `translation.final` | utteranceId, lang, text, ttsFallback |
| `audio` | utteranceId, lang, format(`pcm16`\|`mp3`), sampleRate, seq, last, data(base64) |
| `metrics` | utteranceId, asrMs, mtFirstMs, mtMs, ttsFirstMs, e2eMs（不适用的为 null）；级联另有 holdMs（续说等待累计，e2eMs 包含它） |
| `reply.interrupted` | utteranceId, text（仅 CHAT：被打断的 AI 回复已生成的文本；没有进行中的回复时针对最近一条，text 为空） |
| `error` | code, message, fatal |
| `ended` | reason |

- `utteranceId` 在一条流内从 1 单调递增；`startedMs/endedMs` 相对流开始（续说合并的句子取首段开始与末段结束）。
- 一句话的事件：若干 `transcript.partial`（可能带 `hold`）后二选一——`transcript.final` 及其后续事件，或 `transcript.discard`。
- 级联两段式断句（improve-speech-endpointing-and-live-ux D1–D4）：VAD 静音只是候选句末，判为未说完时等待续说
  （同传 700 ms / 极速 400 ms / 对话 1500 ms，可配置），续说并入同一句并对合并音频重新识别；识别为空或只有语气词的句子丢弃。
- 同一句的 `audio` 按 seq 递增，最后一包 `last=true`；不同句的 audio 按 utteranceId 顺序发出。
- 源语种等于唯一目标语种的句子只发 `transcript.final`（及 metrics），不发 translation/audio。
- 并发流超过 `INTERPRET_MAX_STREAMS`：发 `error{code:"A0212",fatal:true}` 后关闭。
- 关闭码：正常结束 1000；鉴权失败 4401；配置非法 4400；致命错误 1011。

**CHAT 事件约定**：
- 用户句：`transcript.partial/final`（不带 role）+ 只含 `asrMs` 的 `metrics`，不发译文。
- AI 回复：新 utteranceId，所有事件（含 sequencer 发出的 `audio`）带 `"role":"assistant"`：
  `transcript.partial`（text 为累计文本，随 LLM 流式增长）→ `transcript.final{lang: aiLang, ttsFallback}` →
  myLang≠aiLang 时 `translation.delta/final{lang: myLang}`（母语字幕）→ `audio{lang: aiLang}`（按句流水线合成）→ `metrics`（e2eMs = 用户句末 → AI 首段音频）。
- 新的用户句定稿时，若上一条回复仍在进行，视为插话打断：先发 `reply.interrupted`，再回应新句。
- 对话上下文保留最近 12 轮；被打断的回复以“已生成部分 + …”写入上下文。

---

## 2. Spring 对外接口（浏览器调用）

均需 `Authorization: Bearer <JWT>`（WS 除外，见 §2.6）。

### 2.1 语音

| 方法 | 路径 | 请求 | 响应 |
|---|---|---|---|
| GET | `/api/speech/engines` | `?refresh=false` | `Result<{asr,tts,interpret,image}>`（同 §1.1） |
| POST | `/api/speech/transcribe` | multipart：`file`（audio/wav，≤60 s）、`lang?`、`engine?` | `Result<{text,lang,durationMs,engine}>` |
| POST | `/api/speech/tts` | JSON `{text,lang,voice?,gender?,engine?}` | 二进制音频（透传 Content-Type 与 X-Tts-* 头）；失败为 Result JSON |

### 2.2 解读

| 方法 | 路径 | 请求 | 响应 |
|---|---|---|---|
| POST | `/api/translations/insights` | `{source,translation,sourceLang,targetLang,recordId?}` | `Result<{alternatives,expressions,summary}>` |
| POST | `/api/translations/insights/ask` | `{source,translation,sourceLang,targetLang,question,history}` | SSE：`delta` / `done` / `error` |

限流复用翻译限流（每用户每分钟 20 次，A0212）。

### 2.3 图片翻译

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/api/image-translations` | multipart：`image`、`sourceLang`(默认 auto)、`targetLang`、`engine`(默认 vision)、`modelConfigId?`、`glossaryIds?`（可重复字段）→ SSE，事件同 §1.5，`done` 带 `id` |
| GET | `/api/image-translations` | `keyword? targetLang? favorite? from? to? page pageSize` → `Result<PageResult<ImageTranslationItem>>` |
| GET | `/api/image-translations/{id}` | `Result<ImageTranslationDetail>` |
| GET | `/api/image-translations/{id}/image` | 原图字节（Content-Type 为原 mime） |
| GET | `/api/image-translations/{id}/result-image` | 结果图字节（仅 qwen-mt-image；无则 404） |
| PATCH | `/api/image-translations/{id}/blocks` | `{"blocks":[{"id":3,"translation":"Mapo Tofu"}]}` → `Result<ImageTranslationDetail>` |
| PUT | `/api/image-translations/{id}/favorite` | `{"favorite":true}` |
| DELETE | `/api/image-translations/{id}` | 逻辑删除，异步删文件 |

```json
// ImageTranslationItem
{"id":7,"engine":"vision","sourceLang":"auto","detectedLang":"zh","targetLang":"en","width":1200,"height":900,
 "blockCount":6,"preview":"宫保鸡丁 → Kung Pao Chicken","hasResultImage":false,"favorite":false,"createdAt":"..."}
// ImageTranslationDetail = Item + 
{"modelConfigId":2,"mime":"image/jpeg","sizeBytes":183000,"blocks":[{"id":1,"text":"...","translation":"...","bbox":[...]}],
 "glossaryIds":[3],"termHits":[...],"trace":[...],"promptTokens":1500,"completionTokens":420,"latencyMs":5400}
```
浏览器加载原图使用带 JWT 的 fetch → blob URL（`<img>` 不能带 Authorization 头）。

### 2.4 同传会话

| 方法 | 路径 | 请求 | 响应 |
|---|---|---|---|
| POST | `/api/interpret/sessions` | `InterpretCreateRequest` | `Result<InterpretJoinVO>` |
| POST | `/api/interpret/rooms/{code}/join` | `{displayName, lang, participantId?}`（participantId 用于 30 s 内重连恢复身份） | `Result<InterpretJoinVO>` |
| POST | `/api/interpret/sessions/{id}/ticket` | 无（创建者重连取新票据） | `Result<InterpretJoinVO>` |
| POST | `/api/interpret/sessions/{id}/end` | 无 | `Result<InterpretSessionVO>` |
| GET | `/api/interpret/sessions/active` | — | `Result<InterpretSessionVO \| null>`：进行中的会话（刷新页面后恢复用）；残留会话就地结束并返回 null |
| GET | `/api/interpret/sessions` | `keyword? mode? favorite? from? to? page pageSize` | `Result<PageResult<InterpretSessionVO>>` |
| GET | `/api/interpret/sessions/{id}` | — | `Result<InterpretSessionVO>` |
| GET | `/api/interpret/sessions/{id}/segments` | `page pageSize(≤100)` | `Result<PageResult<InterpretSegmentVO>>` |
| PUT | `/api/interpret/sessions/{id}/favorite` | `{"favorite":true}` | `Result<Void>` |
| DELETE | `/api/interpret/sessions/{id}` | — | `Result<Void>` |

```json
// InterpretCreateRequest
{"mode":"CONVERSE","engine":"cascade","languages":["zh","en"],      // LISTEN: [目标]；CONVERSE: [A,B]；ROOM: [我的语言]；CHAT: [我的语言, 对话语言]
 "sourceHints":[],"converseRouting":"auto","glossaryIds":[],"domainHint":null,
 "tts":true,"headphone":false,"gender":"female","voices":{},
 "asrEngine":null,"ttsEngine":null,"modelConfigId":null,"displayName":"主持人","title":null,
 "chatScenario":null}                                               // 仅 CHAT：free | travel | restaurant | business | interview，缺省 free
// InterpretJoinVO
{"sessionId":42,"participantId":"p1","wsTicket":"Qm9…","roomCode":"K7M2QX","mode":"ROOM","engine":"cascade",
 "languages":["zh"],"isHost":true,"wsUrl":"/ws/interpret"}
// InterpretSessionVO
{"id":42,"mode":"ROOM","engine":"cascade","languages":["zh"],"roomCode":"K7M2QX","status":"ENDED","title":"…",
 "startedAt":"…","endedAt":"…","durationMs":360000,"stats":{"utterances":24,"avgE2eMs":2350,"p50E2eMs":2200,
 "participants":3,"languages":["zh","en","ja"]},"favorite":false,"options":{…}}
// InterpretSegmentVO
{"seq":1,"speakerParticipant":"p1","speakerName":"主持人","sourceLang":"zh","sourceText":"大家好",
 "translations":{"en":"Hello everyone","ja":"皆さんこんにちは"},"metrics":{"e2eMs":2200},"startedMs":1200,"endedMs":2400}
```
校验：CONVERSE 两种语言必须不同（A0410）；CHAT 语言恰为 2 个（可相同）、引擎必须为 cascade、场景合法，否则 A0410；已有 ACTIVE 会话（A0214，`data` 为该会话的 InterpretSessionVO）；引擎不可用（C0173）；S2S 引擎 + `converseRouting=auto` → A0410。
标题缺省：`同传收听 · 中文` / `双向对话 · 中文 ⇄ 英语` / `AI 对话 · 英语` / `会议室 K7M2QX`。CHAT 的 `options.chatScenario` 记录场景。

### 2.5 历史分类

文本历史接口不变（`/api/translations`）；图片用 §2.3 列表，同传用 §2.4 列表。

### 2.6 `WS /ws/interpret?ticket=<wsTicket>`

- 握手：票据有效（60 s、一次性，Redis `ws:ticket:{t}` → `{userId, sessionId, participantId}`），Origin 在 `WEB_ORIGIN` 内；否则 HTTP 401（A0453）或 403。
- 浏览器 → Spring：二进制 PCM16LE 16 kHz 单声道帧（建议 40 ms / 1280 字节，单帧 ≤ 32 KB）；文本帧 `ptt` `flush` `mute` `interrupt`（可带 `yield`） `end` `ping`（Spring 回 `{"type":"pong"}`；`interrupt` 只在 CHAT 中原样转发，其他模式静默忽略）。
- Spring → 浏览器：§1.8 的全部事件，另加：
  - 每个携带 utteranceId 的事件增加 `speaker`：`{"participantId":"p1","displayName":"主持人","lang":"zh"}`，且 `utteranceId` 改写为全局唯一字符串 `"<participantId>:<n>"`；
    CHAT 中 `role=assistant` 的事件 speaker 为 `{"participantId":"ai","displayName":"Lumi","lang":<对话语言>}`，转写段以发言人 `ai` 落库（期待一条母语字幕）；
  - `ready`：`{type, sessionId, participantId, mode, engine, languages, roomCode, isHost}`；
  - `participants`：`{type, list:[{participantId, displayName, lang, speaking, isHost, online}]}`（全量，进出或说话状态变化时下发，speaking 由该成员最近 1.5 s 内有 partial/final 推断）；
  - `ended`：`{type, reason, stats}`，reason ∈ `user_end` `host_left` `idle` `error`。
- `transcript.discard`：照常广播；Spring 从发言流重建用的最近语句中移除该句，并撤销待写或已写的转写段（不落库）。
- 路由：`transcript.*`、`translation.*`、`metrics` 广播给房间全体；`audio` 只发给 `lang` 与该成员语言相同、且该成员开启了播报的连接（LISTEN/CONVERSE 只有一个连接，全部下发）。

---

## 3. Web 端约定

- 采集：`public/worklets/pcm-capture.js`，输出 Int16 16 kHz、每 40 ms 一帧，并通过 `port` 同时报告 RMS（0–1）。
- 播放：`pcm16`（24 kHz）用 AudioWorklet 环形缓冲连续播放；`mp3` 按句（同 utteranceId 的全部 audio 拼接）`decodeAudioData` 后排队；`ttsFallback=true` 或 ttsEngine=browser 时用 `speechSynthesis` 朗读 `translation.final.text`。
- 半双工：LISTEN/CONVERSE 未开耳机模式时，播放期间不上行音频帧，播放结束 300 ms 后恢复。
- mock 模式：`NEXT_PUBLIC_MOCK_API=1` 时同传与图片翻译使用脚本化事件序列（不连 WS）。
