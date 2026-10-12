"""提示词回归评测（improve-prompts-and-context-memory D7）。

直接调用 app 中真实的提示词构造与对话记忆代码，通过测试中转（仓库根目录 .env 的 TEST_LLM_*）调用模型，
用评审模型逐条判定，输出改造前后的对比报告。数据见 evaluation/data/prompt/，结果写入 evaluation/results/prompt/。
"""

from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[3]
DATA_DIR = REPO_ROOT / "evaluation" / "data" / "prompt"
RESULTS_DIR = REPO_ROOT / "evaluation" / "results" / "prompt"
