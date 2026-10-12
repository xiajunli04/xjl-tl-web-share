-- =====================================================================
-- V1：平台基础表结构（以 tl_app 身份执行）
--   biz：业务数据（Spring 读写）；ai：AI 服务数据（Python 读写）
--   ${ai_role}：Python 使用的数据库角色（Flyway placeholder，默认 tl_ai）
-- =====================================================================

CREATE SCHEMA IF NOT EXISTS biz;
CREATE SCHEMA IF NOT EXISTS ai;

-- 向量扩展需要超级用户创建，docker 初始化脚本已预先创建，这里保持幂等
CREATE EXTENSION IF NOT EXISTS vector;

-- ---------------------------------------------------------------------
-- 用户
-- ---------------------------------------------------------------------
CREATE TABLE biz.sys_user (
  id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  username       varchar(32)  NOT NULL,
  password_hash  varchar(100) NOT NULL,
  nickname       varchar(64),
  email          varchar(128),
  status         varchar(16)  NOT NULL DEFAULT 'ENABLED' CHECK (status IN ('ENABLED','DISABLED')),
  last_login_at  timestamptz,
  deleted        boolean      NOT NULL DEFAULT false,
  created_at     timestamptz  NOT NULL DEFAULT now(),
  updated_at     timestamptz  NOT NULL DEFAULT now()
);
-- 仅在未删除用户中保证用户名唯一，逻辑删除后用户名可复用
CREATE UNIQUE INDEX uk_sys_user_username ON biz.sys_user (username) WHERE deleted = false;
CREATE INDEX idx_sys_user_created_at ON biz.sys_user (created_at DESC);

COMMENT ON TABLE biz.sys_user IS '系统用户';
COMMENT ON COLUMN biz.sys_user.password_hash IS 'BCrypt 哈希';
COMMENT ON COLUMN biz.sys_user.status IS 'ENABLED / DISABLED';

-- ---------------------------------------------------------------------
-- 角色
-- ---------------------------------------------------------------------
CREATE TABLE biz.sys_role (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  code        varchar(32)  NOT NULL UNIQUE,
  name        varchar(64)  NOT NULL,
  created_at  timestamptz  NOT NULL DEFAULT now()
);
COMMENT ON TABLE biz.sys_role IS '角色';

CREATE TABLE biz.sys_user_role (
  user_id  bigint NOT NULL REFERENCES biz.sys_user (id),
  role_id  bigint NOT NULL REFERENCES biz.sys_role (id),
  PRIMARY KEY (user_id, role_id)
);
CREATE INDEX idx_sys_user_role_role ON biz.sys_user_role (role_id);
COMMENT ON TABLE biz.sys_user_role IS '用户-角色关联';

INSERT INTO biz.sys_role (code, name) VALUES ('ADMIN', '管理员'), ('USER', '普通用户');

-- ---------------------------------------------------------------------
-- 模型配置（字段契约见 design D13，Python 只读）
-- ---------------------------------------------------------------------
CREATE TABLE biz.model_config (
  id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name           varchar(64)  NOT NULL,
  provider       varchar(32)  NOT NULL CHECK (provider IN ('OPENAI_COMPATIBLE','ANTHROPIC')),
  base_url       varchar(255) NOT NULL,
  model_name     varchar(128) NOT NULL,
  api_key_cipher text         NOT NULL,
  api_key_mask   varchar(32)  NOT NULL,
  params         jsonb        NOT NULL DEFAULT '{}'::jsonb,  -- {"temperature":0.3,"maxTokens":1024,"timeoutSeconds":30}
  is_default     boolean      NOT NULL DEFAULT false,
  enabled        boolean      NOT NULL DEFAULT true,
  remark         varchar(255),
  deleted        boolean      NOT NULL DEFAULT false,
  created_at     timestamptz  NOT NULL DEFAULT now(),
  updated_at     timestamptz  NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX uk_model_config_default ON biz.model_config (is_default) WHERE is_default AND NOT deleted;

COMMENT ON TABLE biz.model_config IS 'LLM 模型配置';
COMMENT ON COLUMN biz.model_config.api_key_cipher IS 'AES-256-GCM 密文：v1:base64(iv||ct||tag)';
COMMENT ON COLUMN biz.model_config.api_key_mask IS '密钥掩码，仅用于展示';

-- ---------------------------------------------------------------------
-- 登录日志
-- ---------------------------------------------------------------------
CREATE TABLE biz.login_log (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id      bigint,
  username     varchar(64)  NOT NULL,
  ip           varchar(64),
  user_agent   varchar(512),
  success      boolean      NOT NULL,
  fail_reason  varchar(128),
  created_at   timestamptz  NOT NULL DEFAULT now()
);
CREATE INDEX idx_login_log_created_at ON biz.login_log (created_at DESC);
CREATE INDEX idx_login_log_username ON biz.login_log (username);
COMMENT ON TABLE biz.login_log IS '登录日志';

-- ---------------------------------------------------------------------
-- 操作日志
-- ---------------------------------------------------------------------
CREATE TABLE biz.operation_log (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id      bigint,
  username     varchar(64),
  module       varchar(64)  NOT NULL,
  action       varchar(64)  NOT NULL,
  method       varchar(16),
  path         varchar(255),
  params       text,
  result_code  varchar(8),
  duration_ms  bigint,
  ip           varchar(64),
  trace_id     varchar(64),
  created_at   timestamptz  NOT NULL DEFAULT now()
);
CREATE INDEX idx_operation_log_created_at ON biz.operation_log (created_at DESC);
CREATE INDEX idx_operation_log_username ON biz.operation_log (username);
COMMENT ON TABLE biz.operation_log IS '管理员操作日志（参数已脱敏）';

-- ---------------------------------------------------------------------
-- 授权：Python 角色对 biz 仅可读被显式授权的表，对 ai schema 拥有全部权限
-- ---------------------------------------------------------------------
GRANT USAGE ON SCHEMA biz TO ${ai_role};
GRANT SELECT ON biz.model_config TO ${ai_role};

GRANT ALL ON SCHEMA ai TO ${ai_role};
GRANT ALL ON ALL TABLES IN SCHEMA ai TO ${ai_role};
GRANT ALL ON ALL SEQUENCES IN SCHEMA ai TO ${ai_role};
ALTER DEFAULT PRIVILEGES IN SCHEMA ai GRANT ALL ON TABLES TO ${ai_role};
ALTER DEFAULT PRIVILEGES IN SCHEMA ai GRANT ALL ON SEQUENCES TO ${ai_role};
ALTER DEFAULT PRIVILEGES IN SCHEMA ai GRANT ALL ON FUNCTIONS TO ${ai_role};
