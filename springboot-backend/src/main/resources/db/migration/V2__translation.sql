-- =====================================================================
-- V2：文本翻译 Agent（见 openspec/changes/add-text-translation-agent design D6）
--   术语库、术语、翻译记录、Agent 轨迹
-- =====================================================================

-- 三元组扩展用于关键词检索的 GIN 索引；docker / 测试初始化脚本已由超级用户预先创建，这里保持幂等
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- ---------------------------------------------------------------------
-- 术语库
-- ---------------------------------------------------------------------
CREATE TABLE biz.glossary (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  owner_id     bigint       NOT NULL REFERENCES biz.sys_user (id),
  name         varchar(64)  NOT NULL,
  description  varchar(255),
  source_lang  varchar(8)   NOT NULL,
  target_lang  varchar(8)   NOT NULL,
  domain       varchar(32),
  scope        varchar(16)  NOT NULL DEFAULT 'PRIVATE' CHECK (scope IN ('PRIVATE','PUBLIC')),
  term_count   int          NOT NULL DEFAULT 0,
  deleted      boolean      NOT NULL DEFAULT false,
  created_at   timestamptz  NOT NULL DEFAULT now(),
  updated_at   timestamptz  NOT NULL DEFAULT now()
);
CREATE INDEX idx_glossary_owner ON biz.glossary (owner_id) WHERE deleted = false;
CREATE INDEX idx_glossary_scope ON biz.glossary (scope) WHERE deleted = false;

COMMENT ON TABLE biz.glossary IS '术语库（Python 只读）';
COMMENT ON COLUMN biz.glossary.scope IS 'PRIVATE 个人 / PUBLIC 公共（仅 ADMIN 可设）';
COMMENT ON COLUMN biz.glossary.term_count IS '术语数，增删术语时由 Spring 维护';
COMMENT ON COLUMN biz.glossary.updated_at IS '术语变更时同步刷新，Python 按 id + updated_at 缓存';

-- ---------------------------------------------------------------------
-- 术语（物理删除）
-- ---------------------------------------------------------------------
CREATE TABLE biz.glossary_term (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  glossary_id     bigint       NOT NULL REFERENCES biz.glossary (id),
  source_term     varchar(200) NOT NULL,
  target_term     varchar(200) NOT NULL,
  note            varchar(255),
  case_sensitive  boolean      NOT NULL DEFAULT false,
  created_at      timestamptz  NOT NULL DEFAULT now(),
  updated_at      timestamptz  NOT NULL DEFAULT now()
);
-- 同一术语库内源术语不区分大小写唯一
CREATE UNIQUE INDEX uk_glossary_term_source ON biz.glossary_term (glossary_id, lower(source_term));

COMMENT ON TABLE biz.glossary_term IS '术语（Python 只读）';

-- ---------------------------------------------------------------------
-- 翻译记录
-- ---------------------------------------------------------------------
CREATE TABLE biz.translation_record (
  id                 bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id            bigint       NOT NULL REFERENCES biz.sys_user (id),
  source_text        text         NOT NULL,
  target_text        text         NOT NULL,
  source_lang        varchar(8)   NOT NULL,
  detected_lang      varchar(8),
  target_lang        varchar(8)   NOT NULL,
  path               varchar(16),
  mode               varchar(16)  NOT NULL,
  style              varchar(16)  NOT NULL,
  domain             varchar(32),
  glossary_ids       bigint[]     NOT NULL DEFAULT '{}',
  model_config_id    bigint,
  review_score       int,
  review_rounds      int          NOT NULL DEFAULT 0,
  compliance         jsonb        NOT NULL DEFAULT '[]'::jsonb,
  term_hits          jsonb        NOT NULL DEFAULT '[]'::jsonb,
  prompt_tokens      int,
  completion_tokens  int,
  latency_ms         int,
  favorite           boolean      NOT NULL DEFAULT false,
  deleted            boolean      NOT NULL DEFAULT false,
  created_at         timestamptz  NOT NULL DEFAULT now()
);
CREATE INDEX idx_translation_record_user_time ON biz.translation_record (user_id, created_at DESC);
-- 关键词检索（ILIKE '%kw%'）使用三元组 GIN 索引；操作符类显式限定 public（Flyway 的 search_path 只有 biz）
CREATE INDEX idx_translation_record_source_trgm ON biz.translation_record USING gin (source_text public.gin_trgm_ops);
CREATE INDEX idx_translation_record_target_trgm ON biz.translation_record USING gin (target_text public.gin_trgm_ops);

COMMENT ON TABLE biz.translation_record IS '翻译记录（仅成功完成的翻译）';
COMMENT ON COLUMN biz.translation_record.source_lang IS '用户选择的源语言，可能为 auto';
COMMENT ON COLUMN biz.translation_record.detected_lang IS '识别出的语种';
COMMENT ON COLUMN biz.translation_record.path IS '实际路径 fast / standard';
COMMENT ON COLUMN biz.translation_record.review_rounds IS '修正轮次';

-- ---------------------------------------------------------------------
-- Agent 轨迹
-- ---------------------------------------------------------------------
CREATE TABLE biz.agent_trace (
  id                 bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  record_id          bigint       NOT NULL REFERENCES biz.translation_record (id),
  seq                int          NOT NULL,
  node               varchar(32)  NOT NULL,
  status             varchar(16)  NOT NULL,
  summary            text,
  detail             jsonb        NOT NULL DEFAULT '{}'::jsonb,
  latency_ms         int,
  prompt_tokens      int,
  completion_tokens  int,
  created_at         timestamptz  NOT NULL DEFAULT now()
);
CREATE INDEX idx_agent_trace_record ON biz.agent_trace (record_id, seq);

COMMENT ON TABLE biz.agent_trace IS 'Agent 节点执行轨迹';
COMMENT ON COLUMN biz.agent_trace.detail IS '该节点相关的事件内容（detect / terms / plan / review / 译文输出）';

-- ---------------------------------------------------------------------
-- 授权：Python 只读术语库与术语，不可读翻译记录
-- ---------------------------------------------------------------------
GRANT SELECT ON biz.glossary, biz.glossary_term TO ${ai_role};
