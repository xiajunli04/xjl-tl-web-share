## ADDED Requirements

### Requirement: 可用模型选项
系统 SHALL 允许任意已登录用户查询已启用且未删除的模型配置的选项列表。每项 MUST 只包含 id、名称、提供方和是否默认，MUST NOT 包含 base_url、模型名之外的连接信息或任何密钥相关字段。默认模型排在第一位。

#### Scenario: 普通用户获取选项
- **WHEN** USER 角色用户请求 `GET /api/model-configs/options`
- **THEN** 返回已启用配置的 `[{id, name, provider, isDefault}]`，默认模型排在第一位，响应中不出现 apiKeyMask 和 baseUrl

#### Scenario: 停用的配置不出现
- **WHEN** 管理员停用某个配置后，用户再次请求选项列表
- **THEN** 列表中不再包含该配置
