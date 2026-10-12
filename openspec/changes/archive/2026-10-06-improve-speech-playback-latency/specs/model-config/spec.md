## MODIFIED Requirements

### Requirement: 模型配置管理
系统 SHALL 允许管理员新增、编辑、查询、启停和逻辑删除模型配置。配置项包括：显示名、能力类型、提供方类型、base_url、模型名、API Key、是否支持图片输入、可选参数（temperature、max_tokens、timeout_seconds 及引擎相关的额外参数，如音色）和备注。

- 能力类型（capability）取值：`CHAT`（对话）、`ASR`（语音识别）、`TTS`（语音合成）、`REALTIME_TRANSLATE`（实时同传）、`REALTIME_CHAT`（实时语音对话）、`IMAGE_TRANSLATE`（图片翻译）。
- 提供方类型取值：`OPENAI_COMPATIBLE`、`ANTHROPIC`、`DASHSCOPE`、`VOLCENGINE` 或 `GOOGLE`。
- 能力与提供方 MUST 满足以下组合：

| 能力 | 允许的提供方 |
|---|---|
| CHAT | OPENAI_COMPATIBLE、ANTHROPIC |
| ASR、TTS | OPENAI_COMPATIBLE |
| REALTIME_TRANSLATE | DASHSCOPE、VOLCENGINE、GOOGLE、OPENAI_COMPATIBLE |
| REALTIME_CHAT | DASHSCOPE、OPENAI_COMPATIBLE |
| IMAGE_TRANSLATE | DASHSCOPE |

  不合法的组合返回 `A0410`。
- 已有配置在迁移后 capability 为 `CHAT`。

#### Scenario: 新增 DeepSeek 配置
- **WHEN** 管理员提交能力 `CHAT`、提供方 `OPENAI_COMPATIBLE`、base_url `https://api.deepseek.com/v1`、模型名 `deepseek-chat` 及 API Key
- **THEN** 系统保存配置并返回配置详情，其中 API Key 只以掩码形式出现（如 `sk-****abcd`）

#### Scenario: 编辑时不修改密钥
- **WHEN** 管理员编辑配置时 apiKey 字段留空
- **THEN** 系统保留原有密钥，只更新其他字段

#### Scenario: 新增千问同传配置
- **WHEN** 管理员提交能力 `REALTIME_TRANSLATE`、提供方 `DASHSCOPE`、模型名 `qwen3.8-livetranslate-flash-realtime` 及 API Key
- **THEN** 系统保存配置，引擎列表中 qwen-livetranslate 变为可用

#### Scenario: 新增实时语音对话配置
- **WHEN** 管理员提交能力 `REALTIME_CHAT`、提供方 `DASHSCOPE`、模型名 `qwen3-omni-flash-realtime` 及 API Key
- **THEN** 系统保存配置，引擎列表 chat 类别中 realtime-chat 变为可用

#### Scenario: 不合法的组合
- **WHEN** 管理员提交能力 `TTS`、提供方 `ANTHROPIC`
- **THEN** 系统返回 HTTP 400、code `A0410`

#### Scenario: 实时语音对话不合法的提供方
- **WHEN** 管理员提交能力 `REALTIME_CHAT`、提供方 `VOLCENGINE`
- **THEN** 系统返回 HTTP 400、code `A0410`
