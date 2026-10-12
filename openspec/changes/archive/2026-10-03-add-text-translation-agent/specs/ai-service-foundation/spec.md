## MODIFIED Requirements

### Requirement: 数据库最小权限
Python AI 服务 SHALL 使用独立的数据库角色 `tl_ai` 连接 PostgreSQL。该角色对 `biz` schema MUST 只有被显式授予的表的 SELECT 权限（目前为 `biz.model_config`、`biz.glossary`、`biz.glossary_term`），对 `ai` schema 拥有完整权限。

#### Scenario: 越权写入被拒绝
- **WHEN** 以 `tl_ai` 角色执行 `UPDATE biz.model_config ...` 或 `INSERT INTO biz.glossary_term ...`
- **THEN** 数据库拒绝执行（permission denied）

#### Scenario: 读取术语表
- **WHEN** 以 `tl_ai` 角色执行 `SELECT * FROM biz.glossary_term`
- **THEN** 查询成功

#### Scenario: 未授权的业务表不可读
- **WHEN** 以 `tl_ai` 角色执行 `SELECT * FROM biz.sys_user` 或 `SELECT * FROM biz.translation_record`
- **THEN** 数据库拒绝执行（permission denied）
