-- =====================================================================
-- V6：语音与图片翻译（见 openspec/changes/add-speech-and-image-translation design D12 / D13）
--   模型配置：能力类型、视觉标记、新提供方；默认模型改为按能力唯一（存量配置归为 CHAT，行为不变）
--   新表：同传会话 / 转写段、图片翻译记录（仅 Spring 读写，tl_ai 无权访问）
-- =====================================================================

-- ---------------------------------------------------------------------
-- 模型配置
-- ---------------------------------------------------------------------
ALTER TABLE biz.model_config
  ADD COLUMN capability      varchar(24) NOT NULL DEFAULT 'CHAT'
    CHECK (capability IN ('CHAT','ASR','TTS','REALTIME_TRANSLATE','IMAGE_TRANSLATE')),
  ADD COLUMN supports_vision boolean     NOT NULL DEFAULT false;

ALTER TABLE biz.model_config DROP CONSTRAINT model_config_provider_check;
ALTER TABLE biz.model_config ADD CONSTRAINT model_config_provider_check
  CHECK (provider IN ('OPENAI_COMPATIBLE','ANTHROPIC','DASHSCOPE','VOLCENGINE','GOOGLE'));

DROP INDEX biz.uk_model_config_default;
CREATE UNIQUE INDEX uk_model_config_default ON biz.model_config (capability) WHERE is_default AND NOT deleted;

COMMENT ON COLUMN biz.model_config.capability IS '能力类型：CHAT 对话 / ASR 语音识别 / TTS 语音合成 / REALTIME_TRANSLATE 实时同传 / IMAGE_TRANSLATE 图片翻译';
COMMENT ON COLUMN biz.model_config.supports_vision IS '是否支持图片输入（仅 CHAT 有意义，图片翻译的视觉 OCR 只用标记为 true 的配置）';
COMMENT ON COLUMN biz.model_config.is_default IS '是否该能力的默认模型，每种能力在未删除的配置中最多一个';

-- ---------------------------------------------------------------------
-- 同传会话
-- ---------------------------------------------------------------------
CREATE TABLE biz.interpret_session (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id      bigint       NOT NULL REFERENCES biz.sys_user (id),
  mode         varchar(16)  NOT NULL CHECK (mode IN ('LISTEN','CONVERSE','ROOM')),
  engine       varchar(32)  NOT NULL,
  languages    jsonb        NOT NULL DEFAULT '[]'::jsonb,
  room_code    varchar(8),
  options      jsonb        NOT NULL DEFAULT '{}'::jsonb,
  status       varchar(16)  NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','ENDED')),
  title        varchar(200),
  started_at   timestamptz  NOT NULL DEFAULT now(),
  ended_at     timestamptz,
  duration_ms  int,
  stats        jsonb,
  favorite     boolean      NOT NULL DEFAULT false,
  deleted      boolean      NOT NULL DEFAULT false,
  created_at   timestamptz  NOT NULL DEFAULT now()
);
CREATE INDEX idx_interpret_session_user_time ON biz.interpret_session (user_id, created_at DESC);
-- 每个用户最多一个进行中的会话
CREATE UNIQUE INDEX uk_interpret_session_active ON biz.interpret_session (user_id) WHERE status = 'ACTIVE' AND NOT deleted;
CREATE UNIQUE INDEX uk_interpret_session_room ON biz.interpret_session (room_code) WHERE status = 'ACTIVE' AND room_code IS NOT NULL;
CREATE INDEX idx_interpret_session_title_trgm ON biz.interpret_session USING gin (title public.gin_trgm_ops);

COMMENT ON TABLE biz.interpret_session IS '同传会话（会议室只记主持人一条）';
COMMENT ON COLUMN biz.interpret_session.languages IS 'LISTEN: [目标]；CONVERSE: [A, B]；ROOM: [主持人语言]（成员语言见转写段）';
COMMENT ON COLUMN biz.interpret_session.options IS '{glossaryIds, domainHint, voice, tts, headphone, asrEngine, ttsEngine, modelConfigId}';
COMMENT ON COLUMN biz.interpret_session.stats IS '{utterances, avgE2eMs, p50E2eMs, participants}';

CREATE TABLE biz.interpret_segment (
  id                  bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  session_id          bigint       NOT NULL REFERENCES biz.interpret_session (id),
  seq                 int          NOT NULL,
  speaker_participant varchar(32)  NOT NULL,
  speaker_name        varchar(64),
  speaker_user_id     bigint,
  source_lang         varchar(8),
  source_text         text         NOT NULL,
  translations        jsonb        NOT NULL DEFAULT '{}'::jsonb,
  metrics             jsonb,
  started_ms          int,
  ended_ms            int,
  created_at          timestamptz  NOT NULL DEFAULT now(),
  UNIQUE (session_id, seq)
);
CREATE INDEX idx_interpret_segment_source_trgm ON biz.interpret_segment USING gin (source_text public.gin_trgm_ops);

COMMENT ON TABLE biz.interpret_segment IS '同传转写段：一句话的原文与各语种译文';
COMMENT ON COLUMN biz.interpret_segment.translations IS '{"en":"...","ja":"..."}';
COMMENT ON COLUMN biz.interpret_segment.metrics IS '{asrMs, mtFirstMs, mtMs, ttsFirstMs, e2eMs}';
COMMENT ON COLUMN biz.interpret_segment.started_ms IS '相对会话开始的毫秒偏移';

-- ---------------------------------------------------------------------
-- 图片翻译记录
-- ---------------------------------------------------------------------
CREATE TABLE biz.image_translation (
  id                 bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id            bigint       NOT NULL REFERENCES biz.sys_user (id),
  engine             varchar(32)  NOT NULL,
  model_config_id    bigint,
  image_path         varchar(255) NOT NULL,
  result_image_path  varchar(255),
  mime               varchar(32)  NOT NULL,
  width              int          NOT NULL,
  height             int          NOT NULL,
  size_bytes         int          NOT NULL,
  source_lang        varchar(8)   NOT NULL,
  detected_lang      varchar(8),
  target_lang        varchar(8)   NOT NULL,
  blocks             jsonb        NOT NULL DEFAULT '[]'::jsonb,
  search_text        text         NOT NULL DEFAULT '',
  glossary_ids       bigint[]     NOT NULL DEFAULT '{}',
  term_hits          jsonb        NOT NULL DEFAULT '[]'::jsonb,
  trace              jsonb        NOT NULL DEFAULT '[]'::jsonb,
  prompt_tokens      int,
  completion_tokens  int,
  duration_ms        int,
  favorite           boolean      NOT NULL DEFAULT false,
  deleted            boolean      NOT NULL DEFAULT false,
  created_at         timestamptz  NOT NULL DEFAULT now()
);
CREATE INDEX idx_image_translation_user_time ON biz.image_translation (user_id, created_at DESC);
CREATE INDEX idx_image_translation_search_trgm ON biz.image_translation USING gin (search_text public.gin_trgm_ops);

COMMENT ON TABLE biz.image_translation IS '图片翻译记录';
COMMENT ON COLUMN biz.image_translation.image_path IS '原图相对 STORAGE_DIR 的路径';
COMMENT ON COLUMN biz.image_translation.blocks IS '[{id, text, translation, bbox:[x0,y0,x1,y1] 归一化 0–1, lang}]';
COMMENT ON COLUMN biz.image_translation.search_text IS '全部块原文与译文拼接，用于关键词检索（写入 blocks 时同步维护）';
COMMENT ON COLUMN biz.image_translation.trace IS '[{node, status, summary, durationMs}]';
