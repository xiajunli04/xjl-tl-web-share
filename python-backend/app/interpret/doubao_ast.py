"""豆包同声传译 2.0（Seed LiveInterpret 2.0）语音到语音同传引擎（可选，design D6，tasks 12.3）。

协议依据（2026-10-04 查阅；暂无密钥，未真实联调）：
- 火山引擎文档《同声传译2.0-API接入文档》https://www.volcengine.com/docs/6561/1756902
- 官方 proto（文档附件 protos.tar.gz）与 Python Demo（ast_python_client.zip / ast_demo.py），
  生成的类见 app/interpret/vendor/doubao_pb/

要点：
- 地址 wss://openspeech.bytedance.com/api/v4/ast/v2/translate（base_url 可覆盖）；
  Header X-Api-Resource-Id: volc.service_type.10053、X-Api-Connect-Id；鉴权两种：
  模型配置 extra.appId 存在时用旧版控制台方式：X-Api-App-Key（Demo）/ X-Api-App-Id（文档）= appId、
  X-Api-Access-Key = 密钥；否则用新版控制台方式 X-Api-Key = 密钥
- 帧为 protobuf 二进制：上行 TranslateRequest（event: StartSession=100 / TaskRequest=200 / FinishSession=102），
  下行 TranslateResponse（event + text + data + start_time / end_time + response_meta）
- StartSession：request_meta.SessionID（UUID）、mode=s2s、source_language / target_language、
  source_audio{wav, raw, 16000, 16, 1}、target_audio{pcm, 16000}（避开默认 24 kHz float32）；
  术语库写入 request.corpus.glossary_list；收到 SessionStarted(150) 后才发音频
- TaskRequest：source_audio.binary_data 为 PCM16 16 kHz（与官方 Demo 一致），约 100 ms 一包；
  结束 FinishSession → SessionFinished(152)
- 每句话：SourceSubtitleStart(650) → SourceSubtitleResponse(651)… → SourceSubtitleEnd(652，含全文)；
  TranslationSubtitleStart(653) → TranslationSubtitleResponse(654)… → TranslationSubtitleEnd(655，含全文)；
  TTSSentenceStart(350) → TTSResponse(352，data 为音频)… → TTSSentenceEnd(351)。第 k 个译文 / TTS 句对应第 k 个原文句
- SessionFailed(153) / SessionCanceled(151)：发非致命 C0174 并断开，按"重建一次"处理；
  UsageResponse(154)、AudioMuted(250) 忽略
- 语种约束：S2S 声音复刻模式仅 zh/en/ja/pt/es/id/de/fr，源或目标之一须为 zh/en，且必须指定源语种（不支持自动识别）
"""

import contextlib
import logging
import uuid
from typing import Any

from google.protobuf.message import DecodeError
from websockets.asyncio.client import ClientConnection

from app.core.config import get_settings
from app.interpret.vendor.doubao_pb.common.events_pb2 import Type
from app.interpret.vendor.doubao_pb.products.understanding.ast.ast_service_pb2 import (
    TranslateRequest,
    TranslateResponse,
)
from app.repositories.model_config import ModelConfig
from app.speech.engines import DOUBAO_AST, DOUBAO_AST_LANGS, VOLCENGINE

from .s2s import S2SEngine, S2SSession, UpstreamError, Utt, open_ws, probe_ws

log = logging.getLogger("app.interpret.doubao")

LABEL = "豆包同传"
DEFAULT_URL = "wss://openspeech.bytedance.com/api/v4/ast/v2/translate"
RESOURCE_ID = "volc.service_type.10053"
OUTPUT_RATE = 16000
STATUS_OK = (0, 20000000)
USER_ID = "xjl-tl-ai"
MAX_CORPUS = 1000  # 热词 + 术语总数上限


def headers_of(cfg: ModelConfig, api_key: str) -> dict[str, str]:
    headers = {"X-Api-Resource-Id": RESOURCE_ID, "X-Api-Connect-Id": str(uuid.uuid4())}
    app_id = cfg.extra.get("appId")
    if app_id:
        headers.update({"X-Api-App-Key": app_id, "X-Api-App-Id": app_id, "X-Api-Access-Key": api_key})
    else:
        headers["X-Api-Key"] = api_key
    return headers


def ast_url(cfg: ModelConfig) -> str:
    base = (cfg.base_url or DEFAULT_URL).rstrip("/")
    if base.startswith("https://"):
        return "wss://" + base[len("https://") :]
    return base


def start_request(session_id: str, source: str, target: str, glossary: dict[str, str] | None = None) -> bytes:
    req = TranslateRequest()
    req.request_meta.SessionID = session_id
    req.event = Type.StartSession
    req.user.uid = USER_ID
    req.user.did = USER_ID
    req.source_audio.format = "wav"
    req.source_audio.codec = "raw"
    req.source_audio.rate = 16000
    req.source_audio.bits = 16
    req.source_audio.channel = 1
    req.target_audio.format = "pcm"
    req.target_audio.rate = OUTPUT_RATE
    req.request.mode = "s2s"
    req.request.source_language = source
    req.request.target_language = target
    if glossary:
        req.request.corpus.glossary_list.update(dict(list(glossary.items())[:MAX_CORPUS]))
    return req.SerializeToString()


def task_request(session_id: str, pcm: bytes) -> bytes:
    req = TranslateRequest()
    req.request_meta.SessionID = session_id
    req.event = Type.TaskRequest
    req.source_audio.binary_data = pcm
    return req.SerializeToString()


def finish_request(session_id: str) -> bytes:
    req = TranslateRequest()
    req.request_meta.SessionID = session_id
    req.event = Type.FinishSession
    return req.SerializeToString()


def parse_response(raw: str | bytes) -> TranslateResponse | None:
    if not isinstance(raw, bytes | bytearray):
        return None
    resp = TranslateResponse()
    try:
        resp.ParseFromString(bytes(raw))
    except DecodeError:
        log.debug("豆包同传响应解析失败（%s 字节）", len(raw))
        return None
    return resp


def _failure(resp: TranslateResponse) -> str | None:
    """会话失败 / 取消或错误状态码时返回错误信息。"""
    meta = resp.response_meta if resp.HasField("response_meta") else None
    status = meta.StatusCode if meta is not None else 0
    if resp.event in (Type.SessionFailed, Type.SessionCanceled) or status not in STATUS_OK:
        message = meta.Message if meta is not None and meta.Message else Type.Name(resp.event)
        return f"{message}（{status}）" if status not in STATUS_OK else message
    return None


def _ready(raw: str | bytes) -> bool:
    resp = parse_response(raw)
    if resp is None:
        return False
    failure = _failure(resp)
    if failure:
        raise UpstreamError(failure)
    return resp.event == Type.SessionStarted


def _error_of(raw: str | bytes) -> str | None:
    resp = parse_response(raw)
    return _failure(resp) if resp is not None else None


async def probe(cfg: ModelConfig, api_key: str) -> str:
    """连通性测试：StartSession（zh→en）收到 SessionStarted 后关闭。"""
    retries = get_settings().interpret_upstream_retries
    setup = start_request(str(uuid.uuid4()), "zh", "en")
    return await probe_ws(LABEL, ast_url(cfg), headers_of(cfg, api_key), setup, _ready, _error_of, retries)


class _DoubaoSession(S2SSession):
    output_rate = OUTPUT_RATE

    def __init__(self, *args: Any, **kwargs: Any):
        super().__init__(*args, **kwargs)
        self._session_id = ""
        self._by_k: dict[int, Utt] = {}
        self._src_k = 0
        self._tx_k = 0
        self._tts_k = 0

    async def open(self) -> ClientConnection:
        eng = self.engine
        self._session_id = str(uuid.uuid4())
        self._by_k.clear()
        self._src_k = self._tx_k = self._tts_k = 0
        glossary = None if self.transcribe_only else eng.phrases(self.target)
        return await open_ws(
            ast_url(eng.model_cfg),
            headers_of(eng.model_cfg, eng.api_key),
            start_request(self._session_id, self.source or "", self.target, glossary),
            _ready,
            eng.deps.settings.interpret_upstream_retries,
            eng.label,
        )

    def audio_message(self, pcm: bytes) -> bytes:
        return task_request(self._session_id, pcm)

    def finish_message(self) -> bytes:
        return finish_request(self._session_id)

    def _nth(self, k: int) -> Utt:
        utt = self._by_k.get(k)
        if utt is None:
            utt = self._by_k[k] = self.new_utt()
        return utt

    def _maybe_complete(self, utt: Utt) -> None:
        if utt.source_closed and utt.translation_closed and utt.audio_ended:
            self.complete(utt)

    async def handle(self, raw: str | bytes) -> None:
        resp = parse_response(raw)
        if resp is None:
            return
        ev = resp.event
        if ev in (Type.SessionFailed, Type.SessionCanceled):
            self.engine.emit_error_upstream(_failure(resp) or Type.Name(ev))
            if self._ws is not None:
                with contextlib.suppress(Exception):
                    await self._ws.close()  # 读循环结束后按会话中断处理（重建一次）
            return
        if ev == Type.SessionFinished:
            self._finished.set()
        elif ev == Type.SourceSubtitleStart:
            self._src_k += 1
            utt = self._nth(self._src_k)
            utt.started_ms = resp.start_time
        elif ev == Type.SourceSubtitleResponse:
            utt = self._nth(max(self._src_k, 1))
            utt.source += resp.text
            self.source_partial(utt)
        elif ev == Type.SourceSubtitleEnd:
            utt = self._nth(max(self._src_k, 1))
            utt.ended_ms = resp.end_time
            if resp.HasField("detected_language"):
                utt.lang = resp.detected_language or None
            await self.source_final(utt, resp.text or utt.source)
            self._maybe_complete(utt)
        elif self.transcribe_only:
            return  # 单人会议室：丢弃译文与译音
        elif ev == Type.TranslationSubtitleStart:
            self._tx_k += 1
            self._nth(self._tx_k)
        elif ev == Type.TranslationSubtitleResponse:
            self.translation_delta(self._nth(max(self._tx_k, 1)), resp.text)
        elif ev == Type.TranslationSubtitleEnd:
            utt = self._nth(max(self._tx_k, 1))
            self.translation_final(utt, resp.text or utt.translation)
            self._maybe_complete(utt)
        elif ev == Type.TTSSentenceStart:
            self._tts_k += 1
            self._nth(self._tts_k)
        elif ev == Type.TTSResponse:
            self.audio(self._nth(max(self._tts_k, 1)), resp.data)
        elif ev == Type.TTSSentenceEnd:
            utt = self._nth(max(self._tts_k, 1))
            self.audio(utt, resp.data)
            self.audio_end(utt)
            self._maybe_complete(utt)
        elif ev not in (Type.UsageResponse, Type.AudioMuted):
            failure = _failure(resp)
            if failure:
                self.engine.emit_error_upstream(failure)


class DoubaoAstEngine(S2SEngine):
    id = DOUBAO_AST
    provider = VOLCENGINE
    label = LABEL
    languages = DOUBAO_AST_LANGS

    session_cls = _DoubaoSession

    def check_pair(self, source: str | None, target: str) -> str | None:
        if not source:
            return f"{LABEL}需要指定发言语言（不支持自动识别）"
        if source not in self.languages or target not in self.languages:
            return f"{LABEL}语音到语音仅支持 {'/'.join(self.languages)}（{source}→{target}）"
        if "zh" not in (source, target) and "en" not in (source, target):
            return f"{LABEL}要求源语言或目标语言为中文或英文（{source}→{target}）"
        return None
