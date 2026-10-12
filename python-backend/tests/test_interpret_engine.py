"""同传引擎公共部分（tasks 5.1）：发言流配置校验、音频顺序发射器、逐句计时。"""

import base64

import pytest

from app.interpret.engine import AudioSequencer, ConfigError, StreamConfig, UtteranceMetrics, room_targets
from tests.speech_fakes import Collector


def _audio(events):
    return [(e["utteranceId"], e["lang"], e["seq"], e["last"], base64.b64decode(e["data"])) for e in events]


def _segs(events):
    return [(e["seq"], e["seg"], e["segLast"], e["last"], base64.b64decode(e["data"])) for e in events]


def test_sequencer_emits_out_of_order_utterances_in_order():
    """第 2 句先合成完也要等第 1 句的音频全部发出；分包到达即发，结束时补空终止包。"""
    out = Collector()
    done = []
    seq = AudioSequencer(out)
    seq.open(1, ["en"], on_done=lambda t: done.append(1))
    seq.open(2, ["en"], on_done=lambda t: done.append(2))
    seq.push(2, "en", b"b1")
    seq.push(2, "en", b"b2")
    seq.end(2, "en")
    assert out.events == [] and done == []
    seq.push(1, "en", b"a1")
    assert _audio(out.events) == [(1, "en", 0, False, b"a1")]  # 首包不等第二包
    seq.push(1, "en", b"a2")
    seq.end(1, "en")
    assert _audio(out.events) == [
        (1, "en", 0, False, b"a1"),
        (1, "en", 1, False, b"a2"),
        (1, "en", 2, True, b""),
        (2, "en", 0, False, b"b1"),
        (2, "en", 1, False, b"b2"),
        (2, "en", 2, True, b""),
    ]
    assert done == [1, 2]
    assert seq.pending == 0


def test_sequencer_segments():
    """seg 随段尾递增；段尾可以标在数据包上，也可以是空标记；空段不占段号。"""
    out = Collector()
    seq = AudioSequencer(out)
    seq.open(1, ["en"])
    seq.push(1, "en", b"x1")
    seq.push(1, "en", b"x2", seg_last=True)
    seq.end_segment(1, "en")  # 段 1 合成失败：没有数据的段尾标记被丢弃
    seq.push(1, "en", b"y1")
    seq.end_segment(1, "en")  # 合成方缓冲已空：空的段尾标记
    seq.end(1, "en")
    assert _segs(out.events) == [
        (0, 0, False, False, b"x1"),
        (1, 0, True, False, b"x2"),
        (2, 1, False, False, b"y1"),
        (3, 1, True, False, b""),
        (4, 2, False, True, b""),
    ]


def test_sequencer_abort_and_silent_tracks_have_no_terminator():
    out = Collector()
    done = []
    seq = AudioSequencer(out)
    seq.open(1, ["en"], on_done=lambda t: done.append(t))
    seq.end(1, "en")  # 没有任何音频（合成失败）
    seq.open(2, ["en"])
    seq.push(2, "en", b"a")
    seq.abort(2, "en")  # 打断：此后不再发出该句任何 audio
    seq.push(2, "en", b"late")
    assert _audio(out.events) == [(2, "en", 0, False, b"a")]
    assert done == [None] and seq.pending == 0


def test_sequencer_languages_are_independent_and_done_waits_all():
    out = Collector()
    done = []
    seq = AudioSequencer(out)
    seq.open(1, ["en", "ja"], fmt="pcm16", sample_rate=24000, on_done=lambda t: done.append((1, t is not None)))
    seq.open(2, ["ja"], on_done=lambda t: done.append((2, t is not None)))
    seq.push(1, "ja", b"j")
    seq.end(1, "ja")
    seq.push(2, "ja", b"k")
    seq.end(2, "ja")  # 日语队列不受英语未完成影响
    assert [(e["utteranceId"], e["lang"], e["last"]) for e in out.events] == [
        (1, "ja", False),
        (1, "ja", True),
        (2, "ja", False),
        (2, "ja", True),
    ]
    assert done == [(2, True)]
    seq.end(1, "en")  # 英语合成失败、没有音频
    assert done == [(2, True), (1, True)]
    assert out.events[0]["format"] == "pcm16" and out.events[0]["sampleRate"] == 24000


def test_sequencer_without_languages_completes_immediately():
    done = []
    AudioSequencer(Collector()).open(3, [], on_done=lambda t: done.append(t))
    assert done == [None]


def test_metrics_event():
    m = UtteranceMetrics(t0=10.0, asr_ms=120)
    m.mt_first += [300, 250]
    m.mt_total += [900, 1200]
    m.tts_first.append(400)
    m.final_emitted(11.0)
    ev = m.to_event(4, first_audio_at=11.5)
    assert ev == {
        "type": "metrics",
        "utteranceId": 4,
        "asrMs": 120,
        "mtFirstMs": 250,
        "mtMs": 1200,
        "ttsFirstMs": 400,
        "e2eMs": 1500,
    }
    assert m.to_event(4, None)["e2eMs"] == 1000  # 没有音频时终点为首个译文定稿
    assert UtteranceMetrics(t0=1.0).to_event(5, None)["e2eMs"] is None


@pytest.mark.parametrize(
    ("data", "fragment"),
    [
        ({"mode": "LISTEN", "targetLangs": []}, "一种目标语言"),
        ({"mode": "LISTEN", "targetLangs": ["xx"]}, "不支持的语种"),
        ({"mode": "CONVERSE", "sourceLangs": ["en", "en"]}, "不能相同"),
        ({"mode": "CONVERSE", "sourceLangs": ["auto"], "targetLangs": ["zh"]}, "两种语言"),
        ({"mode": "ROOM", "sourceLangs": ["zh"], "targetLangs": ["en", "ja", "ko", "fr"]}, "最多 3 种"),
    ],
)
def test_stream_config_invalid(data, fragment):
    with pytest.raises(ConfigError) as ei:
        StreamConfig.model_validate({"type": "config", **data}).check(3)
    assert fragment in str(ei.value)


def test_stream_config_defaults_and_helpers():
    cfg = StreamConfig.model_validate(
        {
            "type": "config",
            "mode": "CONVERSE",
            "sourceLangs": ["zh", "en"],
            "targetLangs": ["zh", "en"],
            "voices": None,
            "gender": None,
            "glossaryIds": None,
        }
    )
    cfg.check(5)
    assert cfg.pair == ("zh", "en") and cfg.side_lang("A") == "zh" and cfg.side_lang("B") == "en"
    assert cfg.declared_source is None and cfg.voices == {} and cfg.gender == "female"
    listen = StreamConfig.model_validate({"type": "config", "mode": "LISTEN", "targetLangs": ["zh"]})
    assert listen.source_langs == ["auto"] and listen.declared_source is None and listen.tts is True
    room = StreamConfig.model_validate({"mode": "ROOM", "sourceLangs": ["ja"], "targetLangs": ["en", "ja", "en"]})
    assert room.declared_source == "ja"
    assert room_targets("ja", room.target_langs) == ["en"]


def test_stream_config_accepts_spring_nulls():
    """Spring 对非 CONVERSE 模式传 converseRouting=null，其余可选字段也可能为 null（联调发现）。"""
    cfg = StreamConfig.model_validate(
        {
            "type": "config",
            "mode": "LISTEN",
            "engine": "cascade",
            "sourceLangs": ["auto"],
            "targetLangs": ["en"],
            "converseRouting": None,
            "voices": None,
            "gender": None,
            "glossaryIds": None,
            "asrEngine": None,
            "ttsEngine": None,
            "modelConfigId": None,
            "domainHint": None,
        }
    )
    assert cfg.converse_routing == "auto" and cfg.voices == {} and cfg.gender == "female" and cfg.glossary_ids == []


def test_stream_config_history_and_chat_memory():
    """improve-prompts-and-context-memory 5.1：发言流重建恢复上下文的字段（Spring 已截断，这里兜底）。"""
    items = [{"role": "assistant", "lang": "en", "text": "hi", "translations": {"zh": "你好", "ja": ""}}]
    items += [{"text": ""}, {"lang": "zh"}, {"role": None, "text": "x" * 600}]
    items += [{"text": f"t{i}"} for i in range(30)]
    chat = {"myLang": "zh", "aiLang": "en", "memory": " 摘要 "}
    cfg = StreamConfig.model_validate({"type": "config", "mode": "CHAT", "chat": chat, "history": items})
    assert len(cfg.history) == 24 and cfg.history[-1].text == "t29" and cfg.history[0].role == "user"
    assert cfg.chat.memory == "摘要"
    head = StreamConfig.model_validate({"type": "config", "history": items[:4]}).history
    assert [(h.role, h.text[:2], h.translations) for h in head] == [
        ("assistant", "hi", {"zh": "你好"}),
        ("user", "xx", {}),
    ]
    assert len(head[1].text) == 500
    assert StreamConfig.model_validate({"type": "config", "history": None}).history == []
    assert StreamConfig.model_validate({"type": "config"}).history == []
    long_memory = {"myLang": "zh", "aiLang": "en", "memory": "m" * 3000}
    assert len(StreamConfig.model_validate({"type": "config", "chat": long_memory}).chat.memory) == 2000
    assert StreamConfig.model_validate({"type": "config", "chat": {"myLang": "zh", "aiLang": "en"}}).chat.memory is None
