## ADDED Requirements

### Requirement: 评审模型
系统 SHALL 允许管理员把一个启用的模型配置设为评审模型，并保证任一时刻最多只有一个未删除的评审模型；设置时 MUST 自动取消原评审模型。停用或删除评审模型时 MUST 同时取消其评审标记。管理员 SHALL 可以取消评审标记（幂等）。同一配置可以同时是默认模型和评审模型。

#### Scenario: 切换评审模型
- **WHEN** 管理员把配置 B 设为评审模型，而当前评审模型是配置 A
- **THEN** B 成为评审模型，A 不再是评审模型

#### Scenario: 设置已停用的配置
- **WHEN** 管理员把已停用的配置设为评审模型
- **THEN** 系统返回 HTTP 400、code `C0130`

#### Scenario: 停用评审模型
- **WHEN** 管理员停用当前的评审模型
- **THEN** 该配置失去评审标记，此后的评审使用译者模型

#### Scenario: 取消评审标记
- **WHEN** 管理员对当前评审模型调用取消接口两次
- **THEN** 两次都成功，系统没有评审模型

## MODIFIED Requirements

### Requirement: 可用模型选项
系统 SHALL 允许任意已登录用户查询已启用且未删除的模型配置的选项列表。每项 MUST 只包含 id、名称、提供方、是否默认和是否评审模型，MUST NOT 包含 base_url、模型名之外的连接信息或任何密钥相关字段。默认模型排在第一位。

#### Scenario: 普通用户获取选项
- **WHEN** USER 角色用户请求 `GET /api/model-configs/options`
- **THEN** 返回已启用配置的 `[{id, name, provider, isDefault, isReviewDefault}]`，默认模型排在第一位，响应中不出现 apiKeyMask 和 baseUrl

#### Scenario: 停用的配置不出现
- **WHEN** 管理员停用某个配置后，用户再次请求选项列表
- **THEN** 列表中不再包含该配置
