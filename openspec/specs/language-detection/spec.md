# language-detection Specification

## Purpose
TBD - created by archiving change add-text-translation-agent. Update Purpose after archive.
## Requirements
### Requirement: 支持语种清单
系统 SHALL 支持 15 种语种：zh、en、ja、ko、fr、de、es、ru、pt、it、ar、th、vi、id、tr，并提供接口返回每种语种的代码、中文名和本族语名称。翻译请求中的源语言（`auto` 除外）和目标语言 MUST 属于该清单，否则返回 HTTP 400、code `A0420`。

#### Scenario: 获取语种清单
- **WHEN** 已登录用户请求 `GET /api/translate/languages`
- **THEN** 返回 15 项 `{code, name, nativeName}`，例如 `{code:"ja", name:"日语", nativeName:"日本語"}`

#### Scenario: 不支持的目标语种
- **WHEN** 翻译请求的 targetLang 为 `xx`
- **THEN** 系统返回 HTTP 400、code `A0420`

### Requirement: 文本语种识别
系统 SHALL 识别文本所属语种，返回最可能的语种、置信度（0–1）、识别方法和最多 3 个候选。识别 MUST 限定在支持语种范围内。当统计模型的最高置信度低于 0.5 或文本少于 4 个字符时，系统 SHALL 调用 LLM 兜底，并把方法标记为 `llm`。

#### Scenario: 识别中文
- **WHEN** 用户提交"今天天气很好，我们去公园散步吧。"
- **THEN** 返回 `lang=zh`，`confidence ≥ 0.9`，`method=lingua`

#### Scenario: 区分日语和中文
- **WHEN** 用户提交"今日はいい天気ですね。"
- **THEN** 返回 `lang=ja`

#### Scenario: 短文本兜底
- **WHEN** 用户提交"Hi"
- **THEN** 系统调用 LLM 兜底，返回 `method=llm` 和识别出的语种

#### Scenario: 空文本
- **WHEN** 用户提交空白文本
- **THEN** 系统返回 HTTP 400、code `A0410`

### Requirement: 工作台自动识别
翻译工作台 SHALL 在源语言为"自动识别"时，于用户停止输入 600ms 后自动识别语种，并在源语言选择器中显示识别结果和置信度。识别接口 SHALL 按用户限流（每分钟 120 次）。

#### Scenario: 输入后自动识别
- **WHEN** 源语言为自动识别，用户输入一段法语后停止输入
- **THEN** 约 600ms 后选择器显示"自动识别：法语 (xx%)"

