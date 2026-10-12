-- add-ai-avatar-and-landing：同传新增 CHAT（AI 对话）模式
-- AI 的发言人身份记录在 interpret_segment.speaker_participant = 'ai'，不新增表

ALTER TABLE biz.interpret_session DROP CONSTRAINT interpret_session_mode_check;
ALTER TABLE biz.interpret_session ADD CONSTRAINT interpret_session_mode_check
  CHECK (mode IN ('LISTEN','CONVERSE','ROOM','CHAT'));

COMMENT ON COLUMN biz.interpret_session.languages IS 'LISTEN: [目标]；CONVERSE: [A, B]；ROOM: [主持人语言]（成员语言见转写段）；CHAT: [我的语言, 对话语言]';
COMMENT ON COLUMN biz.interpret_session.options IS '{glossaryIds, domainHint, voice, tts, headphone, asrEngine, ttsEngine, modelConfigId, chatScenario}';
