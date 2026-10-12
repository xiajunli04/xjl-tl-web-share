"""Google Gemini 3.5 Live Translate 语音到语音同传引擎（可选，design D6，tasks 12.2）。

协议依据（官方文档，2026-10-04 查阅；暂无密钥，未真实联调）：
- https://ai.google.dev/gemini-api/docs/live-api/live-translate（模型、setup 示例、上下行消息、语种代码表）
- https://ai.google.dev/api/live（BidiGenerateContentSetup / RealtimeInput / ServerContent / SetupComplete / GoAway）

要点：
- 地址 wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent
  ?key=<api_key>；base_url 可覆盖（只给出主机或 REST 路径时补上 WS 路径）
- 首帧 setup：model=models/<model_name>；generationConfig.responseModalities=[AUDIO]、
  generationConfig.translationConfig{targetLanguageCode, echoTargetLanguage:false}；
  inputAudioTranscription / outputAudioTranscription 为 setup 顶层字段（API 参考的字段位置）；
  收到 setupComplete 视为就绪
- 语种代码为 BCP-47：平台 zh → zh-Hans、pt → pt-BR，其余同名
- 上行 realtimeInput.audio{data: base64 PCM16 16 kHz, mimeType: "audio/pcm;rate=16000"}（无需重采样），
  结束 realtimeInput.audioStreamEnd=true；没有会话结束事件，结束时以上游静默判定输出完毕
- 下行 serverContent.inputTranscription.text（原文增量，带 languageCode）、outputTranscription.text（译文增量）、
  modelTurn.parts[].inlineData（audio/pcm;rate=24000）、turnComplete；配置非法时服务端以关闭帧（1007/1008）拒绝
- 以 turnComplete 或输入转写静默 1.2 s（及句末标点）作为句子边界（SegmentedSession）；不支持术语热词
"""

import base64
import binascii
import json
import logging
from typing import Any
from urllib.parse import quote, urlsplit, urlunsplit

from websockets.asyncio.client import ClientConnection

from app.core.config import get_settings
from app.lang import languages
from app.repositories.model_config import ModelConfig
from app.speech.engines import ALL_LANGS, GEMINI_LIVE_TRANSLATE, GOOGLE

from .s2s import (
    S2SEngine,
    SegmentedSession,
    UpstreamError,
    b64,
    json_message,
    open_ws,
    probe_ws,
    to_ws_url,
    with_query,
)

log = logging.getLogger("app.interpret.gemini")

LABEL = "Gemini 同传"
DEFAULT_URL = "wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent"
WS_PATH = urlsplit(DEFAULT_URL).path
INPUT_MIME = "audio/pcm;rate=16000"
LANGUAGE_CODES = {"zh": "zh-Hans", "pt": "pt-BR"}


def live_url(cfg: ModelConfig, api_key: str) -> str:
    parts = urlsplit(to_ws_url(cfg.base_url or DEFAULT_URL))
    path = parts.path if "BidiGenerateContent" in parts.path else WS_PATH
    url = urlunsplit((parts.scheme, parts.netloc, path, parts.query, ""))
    return with_query(url, key=quote(api_key, safe=""))


def gemini_code(lang: str) -> str:
    return LANGUAGE_CODES.get(lang, lang)


def platform_code(code: str | None) -> str | None:
    """厂商 BCP-47 代码 → 平台语种（zh-Hans / zh-Hant → zh，pt-BR → pt）；不在平台内返回 None。"""
    if not code:
        return None
    primary = code.split("-")[0].lower()
    return primary if languages.is_supported(primary) else None


def build_setup(model_name: str, target: str) -> dict[str, Any]:
    model = model_name if model_name.startswith("models/") else f"models/{model_name}"
    return {
        "setup": {
            "model": model,
            "generationConfig": {
                "responseModalities": ["AUDIO"],
                "translationConfig": {"targetLanguageCode": gemini_code(target), "echoTargetLanguage": False},
            },
            "inputAudioTranscription": {},
            "outputAudioTranscription": {},
        }
    }


def _error_message(msg: dict[str, Any]) -> str:
    err = msg.get("error") or {}
    if isinstance(err, dict):
        return str(err.get("message") or err.get("status") or err.get("code") or "未知错误")
    return str(err)


def _ready(raw: str | bytes) -> bool:
    msg = json_message(raw) or {}
    if "error" in msg:
        raise UpstreamError(_error_message(msg))
    return "setupComplete" in msg


def _error_of(raw: str | bytes) -> str | None:
    msg = json_message(raw) or {}
    return _error_message(msg) if "error" in msg else None


async def probe(cfg: ModelConfig, api_key: str) -> str:
    """连通性测试：建立 Live 会话、完成 setup 后关闭。"""
    setup = json.dumps(build_setup(cfg.model_name, "en"))
    retries = get_settings().interpret_upstream_retries
    return await probe_ws(LABEL, live_url(cfg, api_key), {}, setup, _ready, _error_of, retries)


class _GeminiSession(SegmentedSession):
    finish_on_quiet = True

    async def open(self) -> ClientConnection:
        eng = self.engine
        return await open_ws(
            live_url(eng.model_cfg, eng.api_key),
            {},
            json.dumps(build_setup(eng.model_cfg.model_name, self.target)),
            _ready,
            eng.deps.settings.interpret_upstream_retries,
            eng.label,
        )

    def audio_message(self, pcm: bytes) -> str:
        return json.dumps({"realtimeInput": {"audio": {"data": b64(pcm), "mimeType": INPUT_MIME}}})

    def finish_message(self) -> str:
        return json.dumps({"realtimeInput": {"audioStreamEnd": True}})

    async def handle(self, raw: str | bytes) -> None:
        msg = json_message(raw)
        if msg is None:
            return
        content = msg.get("serverContent")
        if isinstance(content, dict):
            await self._content(content)
        elif "goAway" in msg:
            log.info("Gemini 通知即将断开 target=%s timeLeft=%s", self.target, (msg["goAway"] or {}).get("timeLeft"))
        elif "error" in msg:
            self.engine.emit_error_upstream(_error_message(msg))

    async def _content(self, content: dict[str, Any]) -> None:
        source = content.get("inputTranscription")
        if isinstance(source, dict):
            await self.input_text(source.get("text") or "", lang=platform_code(source.get("languageCode")))
        output = content.get("outputTranscription")
        if isinstance(output, dict):
            self.output_text(output.get("text") or "")
        for part in (content.get("modelTurn") or {}).get("parts") or []:
            inline = part.get("inlineData") if isinstance(part, dict) else None
            if not isinstance(inline, dict) or not str(inline.get("mimeType") or "audio/pcm").startswith("audio/pcm"):
                continue
            try:
                data = base64.b64decode(inline.get("data") or "")
            except (ValueError, binascii.Error):
                continue
            self.output_audio(data)
        if content.get("turnComplete"):
            await self.turn_complete()


class GeminiLiveTranslateEngine(S2SEngine):
    id = GEMINI_LIVE_TRANSLATE
    provider = GOOGLE
    label = LABEL
    languages = tuple(ALL_LANGS)
    session_cls = _GeminiSession
