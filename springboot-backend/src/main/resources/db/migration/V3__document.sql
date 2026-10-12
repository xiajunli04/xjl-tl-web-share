-- =====================================================================
-- V3：文档翻译 Agent（见 openspec/changes/add-document-translation-agent design D6 / D9）
--   biz：文档任务、段落、任务术语、执行轨迹（仅 Spring 读写，tl_ai 无权访问）
--   ai ：分块结果缓存（Python 读写；DDL 统一由 Flyway 维护）
-- =====================================================================

-- ---------------------------------------------------------------------
-- 文档任务
-- ---------------------------------------------------------------------
CREATE TABLE biz.doc_task (
  id                  bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id             bigint        NOT NULL REFERENCES biz.sys_user (id),
  title               varchar(200)  NOT NULL,
  format              varchar(8)    NOT NULL CHECK (format IN ('md','txt')),
  source_text         text          NOT NULL,
  char_count          int           NOT NULL,
  source_lang         varchar(8)    NOT NULL,
  detected_lang       varchar(8),
  target_lang         varchar(8)    NOT NULL,
  style               varchar(16)   NOT NULL,
  domain              varchar(32),
  genre               varchar(32),
  glossary_ids        bigint[]      NOT NULL DEFAULT '{}',
  model_config_id     bigint,
  strategy            varchar(16)   NOT NULL CHECK (strategy IN ('serial','parallel','hybrid')),
  confirm_terms       boolean       NOT NULL DEFAULT false,
  options             jsonb         NOT NULL DEFAULT '{}'::jsonb,
  status              varchar(24)   NOT NULL DEFAULT 'PENDING' CHECK (status IN (
                        'PENDING','PARSING','ANALYZING','AWAITING_CONFIRM','TRANSLATING','CONSISTENCY',
                        'COMPLETED','FAILED','CANCELLING','CANCELLED')),
  phase               varchar(24),
  progress_done       int           NOT NULL DEFAULT 0,
  progress_total      int           NOT NULL DEFAULT 0,
  summary             text,
  consistency_report  jsonb,
  stats               jsonb,
  error_code          varchar(8),
  error_message       varchar(500),
  retryable           boolean       NOT NULL DEFAULT false,
  last_event_seq      int           NOT NULL DEFAULT 0,
  last_event_at       timestamptz,
  prompt_tokens       int,
  completion_tokens   int,
  latency_ms          int,
  deleted             boolean       NOT NULL DEFAULT false,
  created_at          timestamptz   NOT NULL DEFAULT now(),
  started_at          timestamptz,
  finished_at         timestamptz
);
CREATE INDEX idx_doc_task_user_time ON biz.doc_task (user_id, created_at DESC) WHERE deleted = false;
-- 并发限制与失联检测按状态筛选
CREATE INDEX idx_doc_task_status ON biz.doc_task (status) WHERE deleted = false;

COMMENT ON TABLE biz.doc_task IS '文档翻译任务（Python 不可读，原文随 start/retry 命令写入任务流）';
COMMENT ON COLUMN biz.doc_task.char_count IS '原文字符数（按 Unicode 码点计）';
COMMENT ON COLUMN biz.doc_task.options IS '实验选项 {contextWindow, globalSummary, termExtraction, review}';
COMMENT ON COLUMN biz.doc_task.status IS 'PENDING→PARSING→ANALYZING→(AWAITING_CONFIRM)→TRANSLATING→CONSISTENCY→COMPLETED；FAILED；CANCELLING→CANCELLED';
COMMENT ON COLUMN biz.doc_task.phase IS '执行端上报的最近阶段（parsing/analyzing/awaiting_confirm/translating/consistency/assembling）';
COMMENT ON COLUMN biz.doc_task.progress_done IS '已完成的分块数（按段落表去重统计，重复投递不会重复计数）';
COMMENT ON COLUMN biz.doc_task.consistency_report IS '一致性报告 {issues:[{term, variants, chosen, fixedSegs, unresolvedSegs}]}';
COMMENT ON COLUMN biz.doc_task.last_event_seq IS '已处理的最大 eventSeq（事件幂等）';
COMMENT ON COLUMN biz.doc_task.last_event_at IS '最近一次收到事件的时间（失联检测）';

-- ---------------------------------------------------------------------
-- 段落（prefix + (target ?? source) + suffix 拼回全文）
-- ---------------------------------------------------------------------
CREATE TABLE biz.doc_segment (
  id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  task_id        bigint       NOT NULL REFERENCES biz.doc_task (id),
  seq            int          NOT NULL,
  block_type     varchar(16)  NOT NULL,
  level          smallint,
  prefix         text         NOT NULL DEFAULT '',
  source_text    text         NOT NULL DEFAULT '',
  suffix         text         NOT NULL DEFAULT '',
  translatable   boolean      NOT NULL DEFAULT true,
  chunk_index    int,
  target_text    text,
  status         varchar(16)  NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','DONE')),
  review_score   int,
  review_rounds  int,
  compliance     jsonb        NOT NULL DEFAULT '[]'::jsonb,
  edited         boolean      NOT NULL DEFAULT false,
  updated_at     timestamptz  NOT NULL DEFAULT now(),
  CONSTRAINT uk_doc_segment_seq UNIQUE (task_id, seq)
);
CREATE INDEX idx_doc_segment_chunk ON biz.doc_segment (task_id, chunk_index);

COMMENT ON TABLE biz.doc_segment IS '文档段落';
COMMENT ON COLUMN biz.doc_segment.level IS '标题级别（仅 heading）';
COMMENT ON COLUMN biz.doc_segment.status IS 'PENDING / DONE（所属分块完成后置为 DONE，含不可翻译段）';
COMMENT ON COLUMN biz.doc_segment.edited IS '是否被用户后编辑（已编辑的段落不会被执行端事件覆盖）';

-- ---------------------------------------------------------------------
-- 任务术语（候选 / 确认）
-- ---------------------------------------------------------------------
CREATE TABLE biz.doc_task_term (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  task_id      bigint        NOT NULL REFERENCES biz.doc_task (id),
  source_term  varchar(200)  NOT NULL,
  target_term  varchar(200)  NOT NULL,
  origin       varchar(16)   NOT NULL,
  frequency    int           NOT NULL DEFAULT 0,
  status       varchar(16)   NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','CONFIRMED','REJECTED')),
  created_at   timestamptz   NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX uk_doc_task_term_source ON biz.doc_task_term (task_id, lower(source_term));

COMMENT ON TABLE biz.doc_task_term IS '文档任务术语表';
COMMENT ON COLUMN biz.doc_task_term.origin IS 'glossary 术语库 / extracted 抽取 / user 用户在确认时新增';

-- ---------------------------------------------------------------------
-- 执行轨迹
-- ---------------------------------------------------------------------
CREATE TABLE biz.doc_task_trace (
  id                 bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  task_id            bigint       NOT NULL REFERENCES biz.doc_task (id),
  seq                int          NOT NULL,
  node               varchar(32)  NOT NULL,
  chunk_index        int,
  status             varchar(16)  NOT NULL,
  summary            text,
  latency_ms         int,
  prompt_tokens      int,
  completion_tokens  int,
  created_at         timestamptz  NOT NULL DEFAULT now()
);
CREATE INDEX idx_doc_task_trace_task ON biz.doc_task_trace (task_id, id);

COMMENT ON TABLE biz.doc_task_trace IS '文档任务节点执行轨迹';

-- ---------------------------------------------------------------------
-- 分块结果缓存（ai schema，Python 写入；Spring 不读写）
-- ---------------------------------------------------------------------
CREATE TABLE ai.doc_chunk_result (
  task_id      bigint       NOT NULL,
  chunk_index  int          NOT NULL,
  result       jsonb        NOT NULL,
  usage        jsonb,
  created_at   timestamptz  NOT NULL DEFAULT now(),
  PRIMARY KEY (task_id, chunk_index)
);
COMMENT ON TABLE ai.doc_chunk_result IS '文档分块翻译结果缓存（断点续译的分块级恢复，任务删除后由 Python 清理）';

-- ai schema 已有默认权限，这里显式授权以免依赖执行顺序
GRANT ALL ON ai.doc_chunk_result TO ${ai_role};
