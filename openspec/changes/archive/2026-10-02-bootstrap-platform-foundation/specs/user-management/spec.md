## ADDED Requirements

### Requirement: 角色模型
系统 SHALL 预置 `ADMIN` 和 `USER` 两种角色。一个用户 MUST 至少拥有一个角色。`/api/admin/**` 接口 MUST 仅允许 ADMIN 访问。

#### Scenario: 普通用户访问管理接口
- **WHEN** 只有 USER 角色的用户请求任意 `/api/admin/**` 接口
- **THEN** 系统返回 HTTP 403、code `A0301`

#### Scenario: 前端菜单按角色显示
- **WHEN** 只有 USER 角色的用户登录 Web 前端
- **THEN** 导航中不显示"管理后台"菜单；直接访问 `/admin/*` 页面时显示无权限页

### Requirement: 初始管理员引导
系统 SHALL 在启动时检查是否存在 ADMIN 用户。若不存在，MUST 根据环境变量 `ADMIN_USERNAME` 和 `ADMIN_PASSWORD` 创建初始管理员；环境变量缺失时 MUST 记录警告日志，不创建账号。

#### Scenario: 首次启动创建管理员
- **WHEN** 数据库中没有 ADMIN 用户，且配置了上述环境变量，系统启动
- **THEN** 系统创建该管理员账号；之后重复启动不会重复创建

### Requirement: 管理员用户管理
系统 SHALL 允许管理员分页查询用户（按用户名模糊匹配、状态、角色过滤），以及创建用户、启用/禁用用户、分配角色、重置密码、逻辑删除用户。管理员 MUST NOT 禁用、删除自己，或移除自己的 ADMIN 角色。

#### Scenario: 分页查询
- **WHEN** 管理员请求 `GET /api/admin/users?pageNum=1&pageSize=10&username=li`
- **THEN** 系统返回 `PageResult`，其中只包含用户名含 `li` 且未删除的用户，按创建时间倒序

#### Scenario: 禁用用户
- **WHEN** 管理员将某个启用状态的用户设为禁用
- **THEN** 该用户状态变为禁用，并被强制下线（见 user-auth「退出登录与强制下线」），之后无法登录

#### Scenario: 禁止操作自己
- **WHEN** 管理员尝试禁用或删除自己，或移除自己的 ADMIN 角色
- **THEN** 系统返回 HTTP 400、code `A0410`，不做任何修改

#### Scenario: 重置密码
- **WHEN** 管理员为某用户设置新密码
- **THEN** 新密码以 BCrypt 存储，该用户被强制下线

#### Scenario: 逻辑删除后用户名可复用
- **WHEN** 管理员删除用户 `alice` 后，有人用 `alice` 注册
- **THEN** 注册成功，被删除的记录仍保留在数据库中（`deleted = true`）

### Requirement: 个人资料与密码修改
系统 SHALL 允许已登录用户修改自己的昵称和邮箱，并在校验原密码正确后修改密码。密码修改成功后 MUST 强制下线。

#### Scenario: 修改密码成功
- **WHEN** 用户提交正确的原密码和符合强度要求的新密码
- **THEN** 密码更新成功，现有令牌全部失效，前端跳转登录页

#### Scenario: 原密码错误
- **WHEN** 用户提交的原密码不正确
- **THEN** 系统返回 HTTP 400、code `A0240`，密码不变
