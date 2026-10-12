"""参考指标（chrF / BLEU）与成本统计。"""

import json
import subprocess
import sys

import pytest

from eval.metrics.chrf_bleu import corpus_bleu, corpus_chrf, doc_bleu, doc_chrf
from eval.metrics.cost import task_cost, wall_ms


def test_identical_gives_100():
    text = "Pod 是可以在 Kubernetes 中创建和管理的、最小的可部署的计算单元。\n\n## 使用 Pod"
    assert doc_chrf(text, text) == pytest.approx(100.0)
    assert doc_bleu(text, text) == pytest.approx(100.0)
    sents = ["你好，世界。", "这是一个测试。"]
    assert corpus_chrf(sents, sents) == pytest.approx(100.0)
    assert corpus_bleu(sents, sents) == pytest.approx(100.0)


def test_matches_sacrebleu_cli(tmp_path):
    hyps = ["他补充说：我们现在有四个月大的老鼠。", "研究仍处于早期阶段。", "容器共享网络。"]
    refs = ["他补充道：“我们现在有 4 个月大的老鼠。”", "这项研究仍处于初期。", "这些容器共享存储和网络。"]
    (tmp_path / "hyp.txt").write_text("\n".join(hyps) + "\n", encoding="utf-8")
    (tmp_path / "ref.txt").write_text("\n".join(refs) + "\n", encoding="utf-8")
    out = subprocess.run(
        [sys.executable, "-m", "sacrebleu", str(tmp_path / "ref.txt"), "-i", str(tmp_path / "hyp.txt"),
         "-m", "bleu", "chrf", "-tok", "zh", "-b", "-w", "4"],
        capture_output=True, text=True, check=True, encoding="utf-8",
    ).stdout
    bleu_cli, chrf_cli = json.loads(out)  # 多指标时 -b 输出为 JSON 数组
    assert corpus_bleu(hyps, refs) == pytest.approx(bleu_cli, abs=1e-3)
    assert corpus_chrf(hyps, refs) == pytest.approx(chrf_cli, abs=1e-3)


def test_doc_level_ignores_line_breaks():
    a = "第一行\n第二行"
    assert doc_chrf(a, "第一行 第二行") == pytest.approx(100.0)


def test_cost_excludes_waiting_time():
    """规格场景"排除等待时间"：失败后 10 分钟才重试，逐块耗时之和只含实际执行时间。"""
    task = {
        "promptTokens": 1200,
        "completionTokens": 300,
        "startedAt": "2026-10-03T10:00:00+08:00",
        "finishedAt": "2026-10-03T10:12:00+08:00",
    }
    traces = [
        {"node": "analyze", "chunkIndex": None, "latencyMs": 4000},
        {"node": "translate_chunk", "chunkIndex": 0, "latencyMs": 20000},
        {"node": "translate_chunk", "chunkIndex": 1, "status": "failed", "latencyMs": None},
        # —— 10 分钟后继续：块 0 以缓存方式上报，块 1 重新执行 ——
        {"node": "translate_chunk", "chunkIndex": 0, "status": "skipped", "latencyMs": None},
        {"node": "translate_chunk", "chunkIndex": 1, "latencyMs": 25000},
        {"node": "consistency", "chunkIndex": None, "latencyMs": 1000},
    ]
    cost = task_cost(task, traces)
    assert cost.node_latency_ms == 50000
    assert cost.chunk_latency_ms == 45000
    assert cost.wall_ms == 12 * 60 * 1000
    assert cost.total_tokens == 1500


def test_cost_falls_back_to_trace_tokens():
    traces = [{"latencyMs": 10, "promptTokens": 5, "completionTokens": 2, "chunkIndex": 0}]
    cost = task_cost({}, traces)
    assert (cost.prompt_tokens, cost.completion_tokens, cost.wall_ms) == (5, 2, None)


def test_wall_ms_handles_z_suffix():
    assert wall_ms("2026-10-03T00:00:00Z", "2026-10-03T00:00:01.500Z") == 1500
