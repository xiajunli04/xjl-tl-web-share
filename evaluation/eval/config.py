"""评测配置：合并 evaluation/config.toml 与仓库根目录 .env。"""

from __future__ import annotations

import os
import tomllib
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path

EVAL_ROOT = Path(__file__).resolve().parent.parent
REPO_ROOT = EVAL_ROOT.parent
DATA_DIR = EVAL_ROOT / "data"
RESULTS_DIR = EVAL_ROOT / "results"
FIGURES_DIR = REPO_ROOT / "docs" / "experiments" / "figures"


def _load_dotenv(path: Path) -> dict[str, str]:
    values: dict[str, str] = {}
    if not path.exists():
        return values
    for raw in path.read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        values[key.strip()] = value.strip()
    return values


@dataclass(frozen=True)
class EvalConfig:
    base_url: str
    request_timeout: float
    poll_interval: float
    task_timeout: float
    username: str
    password: str
    translator_model_id: int | None
    judge_model: str
    judge_temperature: float
    judge_timeout: float
    llm_base_url: str
    llm_api_key: str
    ablation_concurrency: int
    ablation_max_retries: int
    improve_review_model_id: int | None = None
    improve_runs: int = 2
    context_username: str = "eval_tm"
    context_password: str = "EvalTm123456"
    context_session_mode: str = "standard"

    def env(self, key: str, default: str = "") -> str:
        return os.environ.get(key) or _dotenv().get(key, default)


@lru_cache
def _dotenv() -> dict[str, str]:
    return _load_dotenv(REPO_ROOT / ".env")


@lru_cache
def get_config() -> EvalConfig:
    toml = tomllib.loads((EVAL_ROOT / "config.toml").read_text(encoding="utf-8"))
    env = {**_dotenv(), **os.environ}
    p, t, j, a = toml["platform"], toml["translator"], toml["judge"], toml["ablation"]
    model_id = t.get("model_config_id")
    imp = toml.get("improve", {})
    ctx = toml.get("context", {})
    review_id = imp.get("review_model_config_id")
    return EvalConfig(
        base_url=env.get("EVAL_BASE_URL", p["base_url"]).rstrip("/"),
        request_timeout=float(p["request_timeout_seconds"]),
        poll_interval=float(p["poll_interval_seconds"]),
        task_timeout=float(p["task_timeout_seconds"]),
        username=env.get("EVAL_USERNAME", env.get("ADMIN_USERNAME", "admin")),
        password=env.get("EVAL_PASSWORD", env.get("ADMIN_PASSWORD", "")),
        translator_model_id=int(model_id) if model_id not in (None, "") else None,
        judge_model=env.get("EVAL_JUDGE_MODEL", j["model"]),
        judge_temperature=float(j["temperature"]),
        judge_timeout=float(j["timeout_seconds"]),
        llm_base_url=env.get("TEST_LLM_BASE_URL", ""),
        llm_api_key=env.get("TEST_LLM_API_KEY", ""),
        ablation_concurrency=int(a["concurrency"]),
        ablation_max_retries=int(a["max_retries"]),
        improve_review_model_id=int(review_id) if review_id not in (None, "") else None,
        improve_runs=int(imp.get("runs", 2)),
        context_username=env.get("EVAL_TM_USERNAME", ctx.get("username", "eval_tm")),
        context_password=env.get("EVAL_TM_PASSWORD", "EvalTm123456"),
        context_session_mode=ctx.get("session_mode", "standard"),
    )
