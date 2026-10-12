## ADDED Requirements

### Requirement: 模型配置管理
系统 SHALL 允许管理员新增、编辑、查询、启停和逻辑删除 LLM 模型配置。配置项包括：显示名、提供方类型（`OPENAI_COMPATIBLE` 或 `ANTHROPIC`）、base_url、模型名、API Key、可选参数（temperature、max_tokens、timeout_seconds）和备注。

#### Scenario: 新增 DeepSeek 配置
- **WHEN** 管理员提交提供方 `OPENAI_COMPATIBLE`、base_url `https://api.deepseek.com/v1`、模型名 `deepseek-chat` 及 API Key
- **THEN** 系统保存配置并返回配置详情，其中 API Key 只以掩码形式出现（如 `sk-****abcd`）

#### Scenario: 编辑时不修改密钥
- **WHEN** 管理员编辑配置时 apiKey 字段留空
- **THEN** 系统保留原有密钥，只更新其他字段

### Requirement: 密钥加密存储
系统 SHALL 用 AES-256-GCM 加密 API Key 后再存储，加密密钥来自环境变量 `MODEL_KEY_SECRET`。任何接口响应、日志和操作日志中 MUST NOT 出现 API Key 的明文或密文。Python 服务 MUST 能用同一密钥解密 Spring 写入的密文。

#### Scenario: 数据库中只有密文
- **WHEN** 直接查询 `biz.model_config` 表
- **THEN** `api_key_cipher` 字段为 `v1:` 开头的密文，不包含明文

#### Scenario: 跨语言解密
- **WHEN** Python 服务读取 Spring 保存的配置并解密
- **THEN** 得到的明文与管理员录入的 API Key 一致

### Requirement: 默认模型
系统 SHALL 保证任一时刻最多只有一个未删除且启用的默认模型。将某个配置设为默认时，MUST 自动取消原默认配置。停用或删除当前默认配置时，MUST 同时取消其默认标记。

#### Scenario: 切换默认模型
- **WHEN** 管理员将配置 B 设为默认，而当前默认是配置 A
- **THEN** B 成为默认，A 不再是默认

#### Scenario: 停用默认模型
- **WHEN** 管理员停用当前的默认配置
- **THEN** 该配置被停用并失去默认标记，系统暂时没有默认模型，管理页面给出提示

### Requirement: 模型连通性测试
系统 SHALL 允许管理员对已保存的配置发起连通性测试。测试 MUST 经由 Python AI 服务真实调用一次 LLM，返回是否成功、耗时、模型回复片段和 token 用量；失败时返回归类后的错误码和提示。连通失败 MUST 作为正常的测试结果返回，不作为接口异常。

#### Scenario: 测试成功
- **WHEN** 管理员测试一个密钥正确的配置
- **THEN** 页面显示"连通成功"、耗时（毫秒）和模型回复片段

#### Scenario: 密钥错误
- **WHEN** 管理员测试一个 API Key 无效的配置
- **THEN** 接口返回 code `00000`，data 中 `ok=false`、`errorCode=C0121`，页面显示"API Key 无效"

#### Scenario: AI 服务未启动
- **WHEN** Python AI 服务不可达时管理员发起测试
- **THEN** 接口返回 HTTP 503、code `C0110`，页面提示"AI 服务不可用"
