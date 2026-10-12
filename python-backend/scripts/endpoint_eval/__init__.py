"""E6 停顿鲁棒性评测（improve-speech-endpointing-and-live-ux D10 / tasks 7.1–7.3）。

在 python-backend 目录下执行（直接驱动 app.speech.endpointing，真实 VAD / SenseVoice / Smart Turn，不调用 LLM）：
    uv run python -m scripts.endpoint_eval data       # 派生 V0–V3 到 evaluation/data/speech_pause/
    uv run python -m scripts.endpoint_eval run        # 离线断句评测，结果写 evaluation/results/multimodal/e6_runs.jsonl
    uv run python -m scripts.endpoint_eval summary    # e6_summary.csv 与 e6_latency.png
"""

from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[3]
SPEECH_DIR = REPO_ROOT / "evaluation" / "data" / "speech"
PAUSE_DIR = REPO_ROOT / "evaluation" / "data" / "speech_pause"
RESULTS_DIR = REPO_ROOT / "evaluation" / "results" / "multimodal"
SAMPLE_RATE = 16000
