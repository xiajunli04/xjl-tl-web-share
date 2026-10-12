## MODIFIED Requirements

### Requirement: 前端会话管理与路由守卫
Web 前端 SHALL 在访问令牌过期时自动用刷新令牌续期一次，并发请求只触发一次刷新；刷新失败 MUST 清空本地会话并跳转登录页。

路由守卫规则：
- 未登录用户访问受保护页面时，MUST 被重定向到登录页，登录后返回原页面；
- 根路径 `/` 是公开的产品首页，MUST NOT 要求登录；
- 登录时没有 redirect 参数（或参数不安全）时，默认进入 `/translate`。

#### Scenario: 静默续期
- **WHEN** 前端请求收到 code `A0230`，且本地持有有效的刷新令牌
- **THEN** 前端完成一次刷新后自动重试原请求，用户无感知

#### Scenario: 未登录访问受保护页面
- **WHEN** 未登录用户直接访问 `/profile`
- **THEN** 前端跳转到 `/login?redirect=/profile`，登录成功后回到 `/profile`

#### Scenario: 访问首页不需要登录
- **WHEN** 未登录用户访问 `/`
- **THEN** 页面展示产品首页，不跳转登录页

#### Scenario: 默认登录去向
- **WHEN** 用户直接打开 `/login` 并登录成功
- **THEN** 前端进入 `/translate`
