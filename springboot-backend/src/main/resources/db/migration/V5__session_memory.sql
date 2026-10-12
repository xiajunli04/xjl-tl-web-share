-- =====================================================================
-- V5：会话上下文与翻译记忆（见 openspec/changes/add-session-context-and-memory design D1 / D3 / D4 / D5）
--   biz：翻译会话；翻译记录新增会话、修订与追问相关列；文档段落新增翻译记忆命中
--   ai ：翻译记忆（Python 读写，embedding 在 Python 中计算；tl_app 只建表、不写入）
--   均为兼容性改动（加表、加列），存量记录的新列为 NULL 或默认值，行为不变。
-- =====================================================================

-- ---------------------------------------------------------------------
-- 翻译会话（Spring 持有会话与会话记忆，Python 无状态计算）
-- ---------------------------------------------------------------------
CREATE TABLE biz.translation_session (
  id               bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id          bigint       NOT NULL REFERENCES biz.sys_user (id),
  title            varchar(100),
  source_lang      varchar(8)   NOT NULL,
  target_lang      varchar(8)   NOT NULL,
  style            varchar(16)  NOT NULL DEFAULT 'faithful',
  domain           varchar(32),
  glossary_ids     bigint[]     NOT NULL DEFAULT '{}',
  model_config_id  bigint,
  clarify_enabled  boolean      NOT NULL DEFAULT true,
  memory_summary   text,
  memory_entities  jsonb        NOT NULL DEFAULT '[]'::jsonb,
  memorized_until  int          NOT NULL DEFAULT 0,
  pending          jsonb,
  turn_count       int          NOT NULL DEFAULT 0,
  deleted          boolean      NOT NULL DEFAULT false,
  created_at       timestamptz  NOT NULL DEFAULT now(),
  updated_at       timestamptz  NOT NULL DEFAULT now()
);
CREATE INDEX idx_translation_session_user_time ON biz.translation_session (user_id, updated_at DESC) WHERE deleted = false;

COMMENT ON TABLE biz.translation_session IS '翻译会话（会话级默认参数、会话记忆与等待回答的追问）';
COMMENT ON COLUMN biz.translation_session.title IS '标题，为空时取首轮原文前 20 个字符';
COMMENT ON COLUMN biz.translation_session.source_lang IS '会话默认源语言，可能为 auto';
COMMENT ON COLUMN biz.translation_session.clarify_enabled IS '是否允许歧义追问';
COMMENT ON COLUMN biz.translation_session.memory_summary IS '早期轮次的摘要（不超过 300 字，由 Python memorize 节点生成）';
COMMENT ON COLUMN biz.translation_session.memory_entities IS '会话实体表 [{source, target, note}]，最多 30 条';
COMMENT ON COLUMN biz.translation_session.memorized_until IS '已压缩进摘要的最大轮次号';
COMMENT ON COLUMN biz.translation_session.pending IS '等待回答的追问 {threadId, question, options, span, reason, source, ...恢复所需的请求与中断前轨迹}';
COMMENT ON COLUMN biz.translation_session.turn_count IS '轮次数（会话内 revision_of 为空的记录数，含已从历史删除的记录，保证轮次号稳定）';

-- ---------------------------------------------------------------------
-- 翻译记录：会话、修订版本链、采用版本与追问问答
-- ---------------------------------------------------------------------
ALTER TABLE biz.translation_record
  ADD COLUMN session_id          bigint REFERENCES biz.translation_session (id),
  ADD COLUMN revision_of         bigint REFERENCES biz.translation_record (id),
  ADD COLUMN revise_instruction  varchar(500),
  ADD COLUMN adopted             boolean NOT NULL DEFAULT true,
  ADD COLUMN clarification       jsonb;
CREATE INDEX idx_translation_record_session ON biz.translation_record (session_id, created_at) WHERE session_id IS NOT NULL;

COMMENT ON COLUMN biz.translation_record.path IS '实际路径 fast / standard / revise';
COMMENT ON COLUMN biz.translation_record.mode IS '模式 auto / fast / standard / revise';
COMMENT ON COLUMN biz.translation_record.session_id IS '所属会话（会话删除后保持不变）';
COMMENT ON COLUMN biz.translation_record.revision_of IS '修订来源记录 id；为空表示一轮的原始翻译';
COMMENT ON COLUMN biz.translation_record.revise_instruction IS '修订要求';
COMMENT ON COLUMN biz.translation_record.adopted IS '是否为该轮（分支）的采用版本，同一分支只有一条为 true';
COMMENT ON COLUMN biz.translation_record.clarification IS '追问问答 {question, options, span, answer}';

-- ---------------------------------------------------------------------
-- 文档段落：该段命中的翻译记忆（chunk_done.segments[i].tmHits）
-- ---------------------------------------------------------------------
ALTER TABLE biz.doc_segment ADD COLUMN tm_hits jsonb NOT NULL DEFAULT '[]'::jsonb;

COMMENT ON COLUMN biz.doc_segment.tm_hits IS '翻译记忆命中 [{id, source, target, fuzzy, semantic, origin, originRef}]（0–1 条）';
COMMENT ON COLUMN biz.doc_task.options IS '实验选项 {contextWindow, globalSummary, termExtraction, review, translationMemory}';

-- ---------------------------------------------------------------------
-- 翻译记忆（ai schema，Python 写入与检索；Spring 只经 Python 内部接口访问）
--   Flyway 的 search_path 只有 biz：vector 类型与操作符类显式限定 public
-- ---------------------------------------------------------------------
CREATE TABLE ai.translation_memory (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id      bigint              NOT NULL,
  source_lang  varchar(8)          NOT NULL,
  target_lang  varchar(8)          NOT NULL,
  source_text  text                NOT NULL,
  target_text  text                NOT NULL,
  source_norm  text                NOT NULL,
  source_hash  char(32)            NOT NULL,
  embedding    public.vector(384)  NOT NULL,
  origin       varchar(16)         NOT NULL CHECK (origin IN ('workbench','document')),
  origin_ref   varchar(64),
  hit_count    int                 NOT NULL DEFAULT 0,
  last_hit_at  timestamptz,
  created_at   timestamptz         NOT NULL DEFAULT now(),
  updated_at   timestamptz         NOT NULL DEFAULT now(),
  -- 同一用户、同一语言对、规范化后相同的原文只保留一条，再次写入时覆盖译文
  CONSTRAINT uk_translation_memory_source UNIQUE (user_id, source_lang, target_lang, source_hash)
);
-- 向量路召回：余弦距离
CREATE INDEX idx_translation_memory_embedding ON ai.translation_memory USING hnsw (embedding public.vector_cosine_ops);
-- 字面路召回：三元组相似度
CREATE INDEX idx_translation_memory_norm_trgm ON ai.translation_memory USING gin (source_norm public.gin_trgm_ops);
CREATE INDEX idx_translation_memory_user_pair ON ai.translation_memory (user_id, source_lang, target_lang);

COMMENT ON TABLE ai.translation_memory IS '翻译记忆（每个用户独立；只经 Python 内部接口写入与检索）';
COMMENT ON COLUMN ai.translation_memory.source_norm IS '规范化原文：去首尾空白、合并空白、拉丁字母小写化';
COMMENT ON COLUMN ai.translation_memory.source_hash IS 'source_norm 的 md5';
COMMENT ON COLUMN ai.translation_memory.embedding IS '原文语义向量（paraphrase-multilingual-MiniLM-L12-v2，384 维）';
COMMENT ON COLUMN ai.translation_memory.origin IS '来源 workbench 工作台 / document 文档段落';
COMMENT ON COLUMN ai.translation_memory.origin_ref IS '来源引用：翻译记录 id，或 "taskId:seq"';

-- ai schema 已有默认权限，这里显式授权以免依赖执行顺序
GRANT ALL ON ai.translation_memory TO ${ai_role};
-- tl_app 是建表者（属主），收回其写权限：翻译记忆只由 Python（tl_ai）写入
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON ai.translation_memory FROM CURRENT_USER;
