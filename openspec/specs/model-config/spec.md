# model-config Specification

## Purpose
TBD - created by archiving change bootstrap-platform-foundation. Update Purpose after archive.
## Requirements
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

### Requirement: 密钥加密存储
系统 SHALL 用 AES-256-GCM 加密 API Key 后再存储，加密密钥来自环境变量 `MODEL_KEY_SECRET`。任何接口响应、日志和操作日志中 MUST NOT 出现 API Key 的明文或密文。Python 服务 MUST 能用同一密钥解密 Spring 写入的密文。

#### Scenario: 数据库中只有密文
- **WHEN** 直接查询 `biz.model_config` 表
- **THEN** `api_key_cipher` 字段为 `v1:` 开头的密文，不包含明文

#### Scenario: 跨语言解密
- **WHEN** Python 服务读取 Spring 保存的配置并解密
- **THEN** 得到的明文与管理员录入的 API Key 一致

### Requirement: 默认模型
系统 SHALL 保证每种能力类型在任一时刻最多只有一个未删除且启用的默认模型。将某个配置设为默认时，MUST 自动取消同一能力的原默认配置，不影响其他能力的默认配置。停用或删除当前默认配置时，MUST 同时取消其默认标记。所有"使用默认模型"的翻译、解读和图片翻译调用 MUST 只取 CHAT 能力的默认配置。

#### Scenario: 切换默认模型
- **WHEN** 管理员将 CHAT 配置 B 设为默认，而当前 CHAT 默认是配置 A
- **THEN** B 成为默认，A 不再是默认

#### Scenario: 不同能力互不影响
- **WHEN** 管理员把一个 TTS 配置设为默认，而 CHAT 已有默认配置 A
- **THEN** 该 TTS 配置成为 TTS 默认，A 仍是 CHAT 默认

#### Scenario: 停用默认模型
- **WHEN** 管理员停用当前的默认配置
- **THEN** 该配置被停用并失去默认标记，系统暂时没有该能力的默认模型，管理页面给出提示

### Requirement: 模型连通性测试
系统 SHALL 允许管理员对已保存的配置发起连通性测试。测试 MUST 经由 Python AI 服务真实调用一次对应能力，返回是否成功、耗时、结果摘要和用量；失败时返回归类后的错误码和提示。连通失败 MUST 作为正常的测试结果返回，不作为接口异常。各能力的测试方式：

| 能力 | 测试方式 | 结果摘要 |
|---|---|---|
| CHAT | 一次对话 | 模型回复片段 |
| ASR | 转写内置的中文样本音频 | 识别文本 |
| TTS | 合成"你好" | 音频字节数 |
| REALTIME_TRANSLATE | 建立 WebSocket 会话并完成一次会话配置 | 会话已建立 |
| IMAGE_TRANSLATE | 翻译内置的小文字图 | 结果图尺寸 |

#### Scenario: 测试成功
- **WHEN** 管理员测试一个密钥正确的 CHAT 配置
- **THEN** 页面显示"连通成功"、耗时（毫秒）和模型回复片段

#### Scenario: 测试语音识别配置
- **WHEN** 管理员测试一个密钥正确的 ASR 配置
- **THEN** 页面显示"连通成功"、耗时和样本音频的识别文本

#### Scenario: 密钥错误
- **WHEN** 管理员测试一个 API Key 无效的配置
- **THEN** 接口返回 code `00000`，data 中 `ok=false`、`errorCode=C0121`，页面显示"API Key 无效"

#### Scenario: AI 服务未启动
- **WHEN** Python AI 服务不可达时管理员发起测试
- **THEN** 接口返回 HTTP 503、code `C0110`，页面提示"AI 服务不可用"

### Requirement: 可用模型选项
系统 SHALL 允许任意已登录用户查询已启用且未删除的模型配置的选项列表，可按能力类型（`capability`，缺省为 `CHAT`）和是否支持图片输入（`vision=true`）筛选。每项 MUST 只包含 id、名称、能力、提供方、是否默认、是否评审模型和是否支持图片输入，MUST NOT 包含 base_url、模型名之外的连接信息或任何密钥相关字段。默认模型排在第一位。

#### Scenario: 普通用户获取选项
- **WHEN** USER 角色用户请求 `GET /api/model-configs/options`
- **THEN** 返回已启用 CHAT 配置的 `[{id, name, capability, provider, isDefault, isReviewDefault, supportsVision}]`，默认模型排在第一位，响应中不出现 apiKeyMask 和 baseUrl

#### Scenario: 只看视觉模型
- **WHEN** 用户请求 `GET /api/model-configs/options?vision=true`
- **THEN** 只返回 supportsVision=true 的 CHAT 配置

#### Scenario: 停用的配置不出现
- **WHEN** 管理员停用某个配置后，用户再次请求选项列表
- **THEN** 列表中不再包含该配置

### Requirement: 评审模型
系统 SHALL 允许管理员把一个启用的 CHAT 能力模型配置设为评审模型，并保证任一时刻最多只有一个未删除的评审模型；设置时 MUST 自动取消原评审模型。停用或删除评审模型时 MUST 同时取消其评审标记。管理员 SHALL 可以取消评审标记（幂等）。同一配置可以同时是默认模型和评审模型。

#### Scenario: 切换评审模型
- **WHEN** 管理员把配置 B 设为评审模型，而当前评审模型是配置 A
- **THEN** B 成为评审模型，A 不再是评审模型

#### Scenario: 设置已停用的配置
- **WHEN** 管理员把已停用的配置设为评审模型
- **THEN** 系统返回 HTTP 400、code `C0130`

#### Scenario: 设置非对话能力的配置
- **WHEN** 管理员把一个 TTS 配置设为评审模型
- **THEN** 系统返回 HTTP 400、code `A0410`

#### Scenario: 停用评审模型
- **WHEN** 管理员停用当前的评审模型
- **THEN** 该配置失去评审标记，此后的评审使用译者模型

#### Scenario: 取消评审标记
- **WHEN** 管理员对当前评审模型调用取消接口两次
- **THEN** 两次都成功，系统没有评审模型

