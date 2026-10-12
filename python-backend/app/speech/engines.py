"""引擎清单与解析（契约 §0.1 / §0.2 / §1.1）。

- list_engines：组装 asr / tts / interpret / image / chat 五类 EngineInfo（chat 为 AI 对话可用引擎）。
  config 型引擎读取 biz.model_config（每次实时读取），
  内置引擎的可用性（本地模型文件、Edge 在线语音可达性）探测结果缓存 speech_engine_probe_ttl_seconds（默认 10 分钟）
- resolve_asr / resolve_tts：按引擎 id（缺省时按"有启用配置则用远程，否则用内置"）构造适配器
- 可选 S2S 同传引擎（openai-realtime、gemini-live-translate、doubao-ast）按 provider 读取 REALTIME_TRANSLATE 配置，
  未配置时显示为不可用（"需配置"）
"""

import asyncio
import logging
import time
from dataclasses import dataclass
from typing import Any

from app.core.config import get_settings
from app.core.errors import BizException, ErrorCode
from app.lang.languages import CODES
from app.repositories.model_config import (
    ASR,
    CHAT,
    IMAGE_TRANSLATE,
    REALTIME_CHAT,
    REALTIME_TRANSLATE,
    TTS,
    ModelConfig,
    ModelConfigRepository,
)
from app.speech.asr import (
    LOCAL_LANGS,
    LOCAL_SENSEVOICE,
    OPENAI_TRANSCRIBE,
    ASREngine,
    LocalSenseVoiceASR,
    OpenAITranscribeASR,
    lingua_detect_fn,
)
from app.speech.models import local_model_paths
from app.speech.tts import BROWSER, EDGE_TTS, OPENAI_SPEECH, EdgeTTS, OpenAISpeechTTS, TtsEngine, probe_edge_tts

log = logging.getLogger("app.speech.engines")

ALL_LANGS = list(CODES)
DASHSCOPE = "DASHSCOPE"
OPENAI_COMPATIBLE = "OPENAI_COMPATIBLE"
GOOGLE = "GOOGLE"
VOLCENGINE = "VOLCENGINE"

CASCADE = "cascade"
QWEN_LIVETRANSLATE = "qwen-livetranslate"
OPENAI_REALTIME = "openai-realtime"
GEMINI_LIVE_TRANSLATE = "gemini-live-translate"
DOUBAO_AST = "doubao-ast"
VISION = "vision"
QWEN_MT_IMAGE = "qwen-mt-image"
REALTIME_CHAT_ENGINE = "realtime-chat"
REALTIME_CHAT_PROVIDERS = (DASHSCOPE, OPENAI_COMPATIBLE)
REALTIME_CHAT_TESTED = (DASHSCOPE,)  # 经过真实联调的提供方

CASCADE_MAX_TARGETS = 5
S2S_MAX_TARGETS = 3

# OpenAI gpt-realtime-translate 13 种输出语言与平台 15 语种的交集（hi 不在平台内）
OPENAI_REALTIME_LANGS = ("zh", "en", "ja", "ko", "fr", "de", "es", "ru", "pt", "it", "vi", "id")
# 豆包同声传译 2.0 语音到语音（声音复刻模式）支持的 8 种语言，源或目标之一须为 zh/en
DOUBAO_AST_LANGS = ("zh", "en", "ja", "fr", "de", "es", "pt", "id")
DOUBAO_AST_CONSTRAINT = "需指定发言语言；源语言或目标语言须为中文/英文"


def engine_info(
    id: str,
    type: str,
    name: str,
    vendor: str,
    kind: str,
    available: bool,
    reason: str | None,
    languages: list[str],
    model_config_id: int | None = None,
    *,
    s2s: bool | None = None,
    max_targets: int | None = None,
    auto_converse: bool | None = None,
    constraint: str | None = None,
    provider: str | None = None,
    tested: bool | None = None,
) -> dict[str, Any]:
    info = {
        "id": id,
        "type": type,
        "name": name,
        "vendor": vendor,
        "kind": kind,
        "available": available,
        "reason": None if available else reason,
        "languages": languages,
        "modelConfigId": model_config_id,
        "s2s": s2s,
        "maxTargets": max_targets,
        "autoConverse": auto_converse,
        "constraint": constraint,
    }
    if provider is not None:
        info["provider"] = provider
    if tested is not None:
        info["tested"] = tested
    return info


# ---------------- 内置引擎探测（带缓存） ----------------


@dataclass
class BuiltinProbe:
    local_ready: bool
    local_reason: str | None
    vad_ready: bool
    edge_ok: bool
    edge_reason: str | None
    at: float


_probe: BuiltinProbe | None = None
_probe_lock = asyncio.Lock()


async def probe_builtin(refresh: bool = False) -> BuiltinProbe:
    global _probe
    ttl = get_settings().speech_engine_probe_ttl_seconds
    async with _probe_lock:
        if not refresh and _probe is not None and time.monotonic() - _probe.at < ttl:
            return _probe
        local_ok, local_reason = LocalSenseVoiceASR.availability()
        edge_ok, edge_reason = await probe_edge_tts()
        _probe = BuiltinProbe(
            local_ready=local_ok,
            local_reason=local_reason,
            vad_ready=local_model_paths().vad.is_file(),
            edge_ok=edge_ok,
            edge_reason=edge_reason,
            at=time.monotonic(),
        )
        return _probe


def reset_probe_cache() -> None:
    global _probe
    _probe = None


# ---------------- 引擎清单 ----------------


def _first_id(configs: list[ModelConfig]) -> int | None:
    return configs[0].id if configs else None


async def list_engines(repo: ModelConfigRepository, refresh: bool = False) -> dict[str, list[dict[str, Any]]]:
    probe = await probe_builtin(refresh)
    asr_cfgs = [c for c in await repo.find_enabled(ASR) if c.provider == OPENAI_COMPATIBLE]
    tts_cfgs = [c for c in await repo.find_enabled(TTS) if c.provider == OPENAI_COMPATIBLE]
    chat_cfgs = await repo.find_enabled(CHAT)
    rt_all = await repo.find_enabled(REALTIME_TRANSLATE)
    rt_cfgs = [c for c in rt_all if c.provider == DASHSCOPE]
    openai_rt_cfgs = [c for c in rt_all if c.provider == OPENAI_COMPATIBLE]
    gemini_cfgs = [c for c in rt_all if c.provider == GOOGLE]
    doubao_cfgs = [c for c in rt_all if c.provider == VOLCENGINE]
    img_cfgs = [c for c in await repo.find_enabled(IMAGE_TRANSLATE) if c.provider == DASHSCOPE]
    rc_cfgs = [c for c in await repo.find_enabled(REALTIME_CHAT) if c.provider in REALTIME_CHAT_PROVIDERS]
    vision_cfgs = [c for c in chat_cfgs if c.supports_vision]

    asr = [
        engine_info(
            LOCAL_SENSEVOICE,
            "asr",
            "本地 SenseVoice",
            "本地",
            "builtin",
            probe.local_ready,
            probe.local_reason,
            list(LOCAL_LANGS),
        ),
        engine_info(
            OPENAI_TRANSCRIBE,
            "asr",
            "远程转写",
            "OpenAI 兼容",
            "config",
            bool(asr_cfgs),
            "未配置启用的语音识别（ASR）模型",
            ALL_LANGS,
            _first_id(asr_cfgs),
        ),
    ]
    tts = [
        engine_info(EDGE_TTS, "tts", "Edge 在线语音", "微软", "builtin", probe.edge_ok, probe.edge_reason, ALL_LANGS),
        engine_info(
            OPENAI_SPEECH,
            "tts",
            "远程合成",
            "OpenAI 兼容",
            "config",
            bool(tts_cfgs),
            "未配置启用的语音合成（TTS）模型",
            ALL_LANGS,
            _first_id(tts_cfgs),
        ),
        engine_info(BROWSER, "tts", "浏览器朗读", "浏览器", "builtin", True, None, ALL_LANGS),
    ]

    # 级联：需要可用的识别引擎（本地需模型 + VAD；远程需配置且本地 VAD 仍用于切句）与启用的对话模型
    asr_ok = probe.vad_ready and (probe.local_ready or bool(asr_cfgs))
    if not probe.vad_ready:
        cascade_reason = "本地 VAD 模型未下载（运行 uv run python -m app.speech.download）"
    elif not asr_ok:
        cascade_reason = "没有可用的语音识别引擎"
    else:
        cascade_reason = "未配置启用的对话模型"
    cascade_langs = ALL_LANGS if asr_cfgs else list(LOCAL_LANGS)
    cascade_constraint = None if asr_cfgs else "本地识别仅支持中/英/日/韩发言；配置远程转写后支持全部语种"
    default_chat = next((c for c in chat_cfgs if c.is_default), None)
    interpret = [
        engine_info(
            CASCADE,
            "interpret",
            "平台级联同传",
            "本平台",
            "builtin",
            asr_ok and default_chat is not None,
            cascade_reason,
            cascade_langs,
            default_chat.id if default_chat else None,
            s2s=False,
            max_targets=CASCADE_MAX_TARGETS,
            auto_converse=True,
            constraint=cascade_constraint,
        ),
        engine_info(
            QWEN_LIVETRANSLATE,
            "interpret",
            "千问同传",
            "阿里百炼",
            "config",
            bool(rt_cfgs),
            "未配置启用的百炼实时同传（REALTIME_TRANSLATE + DASHSCOPE）模型",
            ALL_LANGS,
            _first_id(rt_cfgs),
            s2s=True,
            max_targets=S2S_MAX_TARGETS,
            auto_converse=False,
        ),
        engine_info(
            OPENAI_REALTIME,
            "interpret",
            "OpenAI 实时翻译",
            "OpenAI",
            "config",
            bool(openai_rt_cfgs),
            "未配置 OpenAI 实时翻译密钥（REALTIME_TRANSLATE + OPENAI_COMPATIBLE）",
            list(OPENAI_REALTIME_LANGS),
            _first_id(openai_rt_cfgs),
            s2s=True,
            max_targets=S2S_MAX_TARGETS,
            auto_converse=False,
        ),
        engine_info(
            GEMINI_LIVE_TRANSLATE,
            "interpret",
            "Gemini 同传",
            "Google",
            "config",
            bool(gemini_cfgs),
            "未配置 Gemini 密钥（REALTIME_TRANSLATE + GOOGLE）",
            ALL_LANGS,
            _first_id(gemini_cfgs),
            s2s=True,
            max_targets=S2S_MAX_TARGETS,
            auto_converse=False,
        ),
        engine_info(
            DOUBAO_AST,
            "interpret",
            "豆包同传",
            "字节火山引擎",
            "config",
            bool(doubao_cfgs),
            "未配置豆包同声传译密钥（REALTIME_TRANSLATE + VOLCENGINE）",
            list(DOUBAO_AST_LANGS),
            _first_id(doubao_cfgs),
            s2s=True,
            max_targets=S2S_MAX_TARGETS,
            auto_converse=False,
            constraint=DOUBAO_AST_CONSTRAINT,
        ),
    ]
    image = [
        engine_info(
            VISION,
            "image",
            "视觉模型识别翻译",
            "本平台",
            "config",
            bool(vision_cfgs),
            "未配置启用且支持图片输入的对话模型",
            ALL_LANGS,
            _first_id(vision_cfgs),
        ),
        engine_info(
            QWEN_MT_IMAGE,
            "image",
            "千问图片翻译",
            "阿里百炼",
            "config",
            bool(img_cfgs),
            "未配置启用的百炼图片翻译（IMAGE_TRANSLATE + DASHSCOPE）模型",
            ALL_LANGS,
            _first_id(img_cfgs),
            constraint="源语言或目标语言须为中文/英文",
        ),
    ]
    rc = rc_cfgs[0] if rc_cfgs else None
    chat = [
        engine_info(
            CASCADE,
            "chat",
            "平台级联",
            "本平台",
            "builtin",
            asr_ok and default_chat is not None,
            cascade_reason,
            cascade_langs,
            default_chat.id if default_chat else None,
            constraint=cascade_constraint,
        ),
        engine_info(
            REALTIME_CHAT_ENGINE,
            "chat",
            "实时语音模型",
            "阿里百炼" if rc is None or rc.provider == DASHSCOPE else "OpenAI 兼容",
            "config",
            rc is not None,
            "未配置实时语音对话模型（REALTIME_CHAT）",
            ALL_LANGS,
            rc.id if rc else None,
            provider=rc.provider if rc else None,
            tested=(rc.provider in REALTIME_CHAT_TESTED) if rc else None,
        ),
    ]
    return {"asr": asr, "tts": tts, "interpret": interpret, "image": image, "chat": chat}


# ---------------- 适配器解析 ----------------


async def _config_or_unavailable(registry: Any, capability: str, model_config_id: int | None, label: str):
    """未指定配置时取该能力启用的配置（默认配置优先，没有默认时取第一个）。"""
    if model_config_id is None:
        enabled = await _enabled(registry, capability)
        model_config_id = enabled[0].id if enabled else None
        if model_config_id is None:
            raise BizException(ErrorCode.SPEECH_ENGINE_UNAVAILABLE, f"未配置启用的{label}模型")
    try:
        return await registry.config_with_key(capability, model_config_id)
    except BizException as e:
        if e.error is ErrorCode.MODEL_CONFIG_UNAVAILABLE:
            raise BizException(ErrorCode.SPEECH_ENGINE_UNAVAILABLE, f"未配置启用的{label}模型") from None
        raise


async def _enabled(registry: Any, capability: str) -> list[ModelConfig]:
    return [c for c in await registry.repo.find_enabled(capability) if c.provider == OPENAI_COMPATIBLE]


async def _has_enabled(registry: Any, capability: str) -> bool:
    return bool(await _enabled(registry, capability))


async def resolve_asr(
    engine_id: str | None, model_config_id: int | None, registry: Any, detector: Any = None
) -> ASREngine:
    """engine 缺省：有启用的 ASR 配置时用 openai-transcribe，否则 local-sensevoice。"""
    detect = lingua_detect_fn(detector)
    if not engine_id:
        engine_id = OPENAI_TRANSCRIBE if (model_config_id or await _has_enabled(registry, ASR)) else LOCAL_SENSEVOICE
    if engine_id == LOCAL_SENSEVOICE:
        ok, reason = LocalSenseVoiceASR.availability()
        if not ok:
            raise BizException(ErrorCode.SPEECH_ENGINE_UNAVAILABLE, reason)
        return LocalSenseVoiceASR(detect)
    if engine_id == OPENAI_TRANSCRIBE:
        cfg, key = await _config_or_unavailable(registry, ASR, model_config_id, "语音识别（ASR）")
        return OpenAITranscribeASR(cfg, key, detect)
    raise BizException(ErrorCode.PARAM_INVALID, f"不支持的识别引擎: {engine_id}")


async def resolve_tts(engine_id: str | None, model_config_id: int | None, registry: Any) -> TtsEngine:
    """engine 缺省：有启用的 TTS 配置时用 openai-speech，否则 edge-tts；browser 不经过服务端（A0410）。"""
    if not engine_id:
        engine_id = OPENAI_SPEECH if (model_config_id or await _has_enabled(registry, TTS)) else EDGE_TTS
    if engine_id == EDGE_TTS:
        return EdgeTTS()
    if engine_id == OPENAI_SPEECH:
        cfg, key = await _config_or_unavailable(registry, TTS, model_config_id, "语音合成（TTS）")
        return OpenAISpeechTTS(cfg, key)
    if engine_id == BROWSER:
        raise BizException(ErrorCode.PARAM_INVALID, "浏览器朗读不经过服务端")
    raise BizException(ErrorCode.PARAM_INVALID, f"不支持的合成引擎: {engine_id}")
