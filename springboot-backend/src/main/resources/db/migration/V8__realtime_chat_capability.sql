-- improve-speech-playback-latency：模型能力新增 REALTIME_CHAT（AI 对话的实时语音模型），同传会话选项新增 latencyMode

ALTER TABLE biz.model_config DROP CONSTRAINT model_config_capability_check;
ALTER TABLE biz.model_config ADD CONSTRAINT model_config_capability_check
  CHECK (capability IN ('CHAT','ASR','TTS','REALTIME_TRANSLATE','REALTIME_CHAT','IMAGE_TRANSLATE'));

COMMENT ON COLUMN biz.model_config.capability IS '能力类型：CHAT 对话 / ASR 语音识别 / TTS 语音合成 / REALTIME_TRANSLATE 实时同传 / REALTIME_CHAT 实时语音对话 / IMAGE_TRANSLATE 图片翻译';
COMMENT ON COLUMN biz.interpret_session.options IS '{glossaryIds, domainHint, voice, tts, headphone, asrEngine, ttsEngine, modelConfigId, chatScenario, latencyMode}';
