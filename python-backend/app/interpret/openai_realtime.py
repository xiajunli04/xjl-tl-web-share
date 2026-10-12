"""OpenAI gpt-realtime-translate 语音到语音同传引擎（可选，design D6，tasks 12.1）。

协议依据（官方文档，2026-10-04 查阅；暂无密钥，未真实联调）：
- https://developers.openai.com/api/docs/guides/realtime-translation
- https://developers.openai.com/api/reference/resources/realtime/translation-server-events
- https://developers.openai.com/cookbook/examples/voice_solutions/realtime_translation_guide

要点：
- 地址由模型配置 base_url 推导：https→wss，路径 /realtime/translations?model=<model_name>（base_url 只有主机时补 /v1），
  Header Authorization: Bearer <key>
- session.update：audio.output.language 为目标语言；audio.input.transcription（gpt-realtime-whisper）获取原文，
  源语种已知时附 language 提示；noise_reduction=near_field。等到 session.updated 视为就绪
- 上行 session.input_audio_buffer.append：base64 PCM16 24 kHz（16 kHz 线性插值重采样，字节数为 1.5 倍）；
  结束 session.close → 服务端冲刷剩余输出后 session.closed
- 下行 session.input_transcript.delta（原文增量）、session.output_transcript.delta（译文增量，追加式）、
  session.output_audio.delta（delta 为 base64 PCM16 24 kHz，200 ms 一包），三者都带 elapsed_ms（200 ms 步进的对齐信息）
- 没有显式句子边界：按输入转写静默 1.2 s 或句末标点切句（SegmentedSession），译音按 elapsed_ms 归属到译文定稿的句子
- 每个目标语言一个会话（官方建议双向通话每个方向一个会话），最多 3 个目标；双向对话仅按键；不支持术语热词
"""

import base64
import binascii
import json
import logging
from typing import Any
from urllib.parse import urlsplit, urlunsplit

from websockets.asyncio.client import ClientConnection

from app.core.config import get_settings
from app.repositories.model_config import ModelConfig
from app.speech.engines import OPENAI_COMPATIBLE, OPENAI_REALTIME, OPENAI_REALTIME_LANGS
from app.speech.vad import resample_pcm16

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

log = logging.getLogger("app.interpret.openai")

LABEL = "OpenAI 实时翻译"
DEFAULT_BASE_URL = "https://api.openai.com/v1"
TRANSLATIONS_PATH = "/realtime/translations"
TRANSCRIPTION_MODEL = "gpt-realtime-whisper"
INPUT_RATE = 24000


def realtime_url(cfg: ModelConfig) -> str:
    parts = urlsplit(to_ws_url(cfg.base_url or DEFAULT_BASE_URL))
    path = parts.path.rstrip("/")
    if not path.endswith(TRANSLATIONS_PATH):
        path = (path or "/v1") + TRANSLATIONS_PATH
    return with_query(urlunsplit((parts.scheme, parts.netloc, path, parts.query, "")), model=cfg.model_name)


def headers_of(api_key: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {api_key}"}


def transcription_model_of(cfg: ModelConfig) -> str:
    return cfg.extra.get("transcriptionModel") or TRANSCRIPTION_MODEL


def build_session(target: str, source: str | None = None, transcription_model: str = TRANSCRIPTION_MODEL) -> dict:
    transcription: dict[str, Any] = {"model": transcription_model}
    if source:
        transcription["language"] = source
    return {
        "audio": {
            "input": {"transcription": transcription, "noise_reduction": {"type": "near_field"}},
            "output": {"language": target},
        }
    }


def session_update(cfg: ModelConfig, target: str, source: str | None = None) -> str:
    session = build_session(target, source, transcription_model_of(cfg))
    return json.dumps({"type": "session.update", "session": session}, ensure_ascii=False)


def _error_message(ev: dict[str, Any]) -> str:
    err = ev.get("error") or {}
    if isinstance(err, dict):
        return str(err.get("message") or err.get("code") or "未知错误")
    return str(err)


def _ready(raw: str | bytes) -> bool:
    ev = json_message(raw) or {}
    if ev.get("type") == "error":
        raise UpstreamError(_error_message(ev))
    return ev.get("type") == "session.updated"


def _error_of(raw: str | bytes) -> str | None:
    ev = json_message(raw) or {}
    return _error_message(ev) if ev.get("type") == "error" else None


def _elapsed(ev: dict[str, Any]) -> int | None:
    value = ev.get("elapsed_ms")
    return value if isinstance(value, int) else None


async def probe(cfg: ModelConfig, api_key: str) -> str:
    """连通性测试：建立翻译会话、完成 session.update 后关闭。"""
    retries = get_settings().interpret_upstream_retries
    return await probe_ws(
        LABEL, realtime_url(cfg), headers_of(api_key), session_update(cfg, "en"), _ready, _error_of, retries
    )


class _OpenAISession(SegmentedSession):
    async def open(self) -> ClientConnection:
        eng = self.engine
        return await open_ws(
            realtime_url(eng.model_cfg),
            headers_of(eng.api_key),
            session_update(eng.model_cfg, self.target, self.source),
            _ready,
            eng.deps.settings.interpret_upstream_retries,
            eng.label,
        )

    def audio_message(self, pcm: bytes) -> str:
        audio = b64(resample_pcm16(pcm, 16000, INPUT_RATE))
        return json.dumps({"type": "session.input_audio_buffer.append", "audio": audio})

    def finish_message(self) -> str:
        return json.dumps({"type": "session.close"})

    async def handle(self, raw: str | bytes) -> None:
        ev = json_message(raw)
        if ev is None:
            return
        kind = ev.get("type")
        if kind == "session.input_transcript.delta":
            await self.input_text(ev.get("delta") or "", _elapsed(ev))
        elif kind == "session.output_transcript.delta":
            self.output_text(ev.get("delta") or "", _elapsed(ev))
        elif kind == "session.output_audio.delta":
            try:
                data = base64.b64decode(ev.get("delta") or "")
            except (ValueError, binascii.Error):
                return
            self.output_audio(data, _elapsed(ev))
        elif kind == "error":
            self.engine.emit_error_upstream(_error_message(ev))
        elif kind == "session.closed":
            self._finished.set()


class OpenAIRealtimeTranslateEngine(S2SEngine):
    id = OPENAI_REALTIME
    provider = OPENAI_COMPATIBLE
    label = LABEL
    languages = OPENAI_REALTIME_LANGS
    session_cls = _OpenAISession
