# ruff: noqa: E501  （报告模板以长中文表格行为主，换行会降低可读性）
"""汇总三端测试结果与覆盖率，生成 docs/test/测试报告.md（design D8）。

数据来源（先在各工程执行带覆盖率的测试，见 --help 或报告「复现方式」一节）：
- Spring：target/surefire-reports/TEST-*.xml、target/site/jacoco/jacoco.csv
- Python：python-backend/.reports/junit.xml、python-backend/coverage.xml
- Web：web/.reports/vitest.json、web/coverage/coverage-summary.json
"""

from __future__ import annotations

import argparse
import csv
import json
import platform
import subprocess
import xml.etree.ElementTree as ET
from collections import defaultdict
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path

from eval.config import REPO_ROOT

SPRING = REPO_ROOT / "springboot-backend"
PYTHON = REPO_ROOT / "python-backend"
WEB = REPO_ROOT / "web"
OUT = REPO_ROOT / "docs" / "test" / "测试报告.md"

# 规格能力 → 自动化测试证据与冒烟记录（相对仓库根目录）
CAPABILITY_EVIDENCE: dict[str, tuple[str, str]] = {
    "user-auth": ("Spring `AuthTest`（17）", "docs/test/bootstrap-smoke/README.md"),
    "user-management": ("Spring `UserManagementTest`（13）", "docs/test/bootstrap-smoke/README.md"),
    "api-conventions": ("Spring `ApiConventionsTest`、`CommonUnitTest`、`LogTest`", "docs/test/bootstrap-smoke/README.md"),
    "model-config": ("Spring `ModelConfigTest`、`AesGcmCipherTest`；Python `test_llm_*`", "docs/test/bootstrap-smoke/README.md"),
    "ai-service-foundation": (
        "Python `test_security`、`test_health`、`test_llm_clients`、`test_registry`；Spring `AiServiceClientTest`、"
        "`SchemaAndPrivilegeTest`",
        "docs/test/bootstrap-smoke/README.md",
    ),
    "ui-design-system": ("Web 截图验收（亮/暗、reduced-motion）", "docs/test/text-translation-smoke/README.md"),
    "language-detection": ("Python `test_lang`；Spring 语种与 A0420 测试", "docs/test/text-translation-smoke/README.md"),
    "glossary": ("Spring `module/glossary` 集成测试；Python `test_glossary`", "docs/test/text-translation-smoke/README.md"),
    "text-translation-agent": ("Python `test_agent`", "docs/test/text-translation-smoke/README.md"),
    "translation-streaming": (
        "Spring `TranslateStreamTest`（17）；Python `test_translate_stream`；Web `sse` 测试",
        "docs/test/text-translation-smoke/README.md",
    ),
    "translation-history": ("Spring 历史接口测试", "docs/test/text-translation-smoke/README.md"),
    "document-task": (
        "Spring `DocTaskApiTest`、`DocExportTest`、`DocSseTest`、`DocAssemblerTest`",
        "docs/test/document-translation-smoke/README.md",
    ),
    "document-agent": ("Python `test_doc_parse`、`test_doc_graph`", "docs/test/document-translation-smoke/README.md"),
    "document-pipeline": (
        "Spring `DocEventConsumerTest`；Python `test_doc_worker`",
        "docs/test/document-translation-smoke/README.md",
    ),
    "document-workspace": ("Web `doc-task` 与 `sse` 测试；截图验收", "docs/test/document-translation-smoke/README.md"),
    "translation-session": (
        "Spring `SessionApiTest`、`SessionStreamTest`、`SessionTurnsTest`；Python `test_session`；Web `session-memory` 测试",
        "docs/test/session-memory-smoke/README.md",
    ),
    "translation-memory": (
        "Spring `TmApiTest`、`DocMemoryTest`；Python `test_tm`、`test_doc_tm`；Web `session-memory` 测试",
        "docs/test/session-memory-smoke/README.md",
    ),
    "live-interpretation": (
        "Spring `InterpretSessionApiTest`、`InterpretStreamTest`；Python `test_interpret_*`（引擎、级联、百炼回放、OpenAI/Gemini/豆包模拟、WS 端点）；"
        "Web `interpret` reducer/connection/setup 测试",
        "docs/test/interpret-smoke/README.md",
    ),
    "speech-services": (
        "Spring `module/speech` 测试；Python `test_speech`、`test_speech_api`；Web `audio` 测试",
        "docs/test/interpret-smoke/README.md",
    ),
    "image-translation": (
        "Spring `module/image` 测试；Python `test_image_preprocess`、`test_image_pipeline`、`test_qwen_mt_image`；Web `image-render`、`image-run` 测试",
        "docs/test/interpret-smoke/README.md",
    ),
    "translation-insights": (
        "Spring `module/insight` 测试；Python `test_insights`；Web 解读标签页截图验收",
        "docs/test/speech-image-ui/",
    ),
    "multimodal-evaluation": ("evaluation `test_multimodal`；E4/E5 结果见实验报告第 11 节", "docs/实验报告.md"),
}


@dataclass
class Suite:
    tests: int = 0
    failures: int = 0
    errors: int = 0
    skipped: int = 0

    @property
    def passed(self) -> int:
        return self.tests - self.failures - self.errors - self.skipped

    def add(self, other: Suite) -> None:
        self.tests += other.tests
        self.failures += other.failures
        self.errors += other.errors
        self.skipped += other.skipped


def _junit_suite(path: Path) -> Suite:
    root = ET.parse(path).getroot()
    suites = [root] if root.tag == "testsuite" else list(root.iter("testsuite"))
    total = Suite()
    for s in suites:
        total.add(
            Suite(
                int(s.get("tests", 0)),
                int(s.get("failures", 0)),
                int(s.get("errors", 0)),
                int(s.get("skipped", 0)),
            )
        )
    return total


# ---------------------------------------------------------------------- Spring


def spring_results() -> tuple[Suite, dict[str, Suite]]:
    total, by_class = Suite(), {}
    for f in sorted((SPRING / "target" / "surefire-reports").glob("TEST-*.xml")):
        s = _junit_suite(f)
        by_class[f.stem.removeprefix("TEST-").removeprefix("com.xjl.tl.")] = s
        total.add(s)
    return total, by_class


def spring_coverage() -> tuple[float, dict[str, tuple[int, int]]]:
    """按模块（module.xxx / security / common / infra）汇总行覆盖。"""
    agg: dict[str, list[int]] = defaultdict(lambda: [0, 0])
    with open(SPRING / "target" / "site" / "jacoco" / "jacoco.csv", encoding="utf-8") as fh:
        for row in csv.DictReader(fh):
            pkg = row["PACKAGE"].removeprefix("com.xjl.tl").lstrip(".") or "(root)"
            parts = pkg.split(".")
            key = ".".join(parts[:2]) if parts[0] == "module" else parts[0]
            agg[key][0] += int(row["LINE_COVERED"])
            agg[key][1] += int(row["LINE_MISSED"])
    covered = sum(c for c, _ in agg.values())
    total = sum(c + m for c, m in agg.values())
    return 100 * covered / total, {k: (c, c + m) for k, (c, m) in sorted(agg.items())}


# ---------------------------------------------------------------------- Python


def python_results() -> Suite:
    return _junit_suite(PYTHON / ".reports" / "junit.xml")


def python_coverage() -> tuple[float, dict[str, tuple[int, int]]]:
    root = ET.parse(PYTHON / "coverage.xml").getroot()
    agg: dict[str, list[int]] = defaultdict(lambda: [0, 0])
    for cls in root.iter("class"):
        filename = cls.get("filename", "").replace("\\", "/")
        parts = filename.removeprefix("app/").split("/")
        key = f"app/{parts[0]}" if len(parts) > 1 else "app"
        lines = cls.find("lines")
        if lines is None:
            continue
        for line in lines.iter("line"):
            agg[key][1] += 1
            if int(line.get("hits", 0)) > 0:
                agg[key][0] += 1
    covered = sum(c for c, _ in agg.values())
    total = sum(t for _, t in agg.values())
    return 100 * covered / total, {k: (c, t) for k, (c, t) in sorted(agg.items())}


# ---------------------------------------------------------------------- Web


def web_results() -> Suite:
    data = json.loads((WEB / ".reports" / "vitest.json").read_text(encoding="utf-8"))
    return Suite(
        tests=data["numTotalTests"],
        failures=data["numFailedTests"],
        errors=0,
        skipped=data.get("numPendingTests", 0) + data.get("numTodoTests", 0),
    )


def web_coverage() -> tuple[float, dict[str, tuple[int, int]]]:
    data = json.loads((WEB / "coverage" / "coverage-summary.json").read_text(encoding="utf-8"))
    agg: dict[str, list[int]] = defaultdict(lambda: [0, 0])
    for path, entry in data.items():
        if path == "total":
            continue
        rel = path.replace("\\", "/").split("/src/", 1)[-1]
        key = "src/" + "/".join(rel.split("/")[:2]) if rel.count("/") >= 2 else "src/" + rel.split("/")[0]
        agg[key][0] += entry["lines"]["covered"]
        agg[key][1] += entry["lines"]["total"]
    return data["total"]["lines"]["pct"], {k: (c, t) for k, (c, t) in sorted(agg.items())}


# ---------------------------------------------------------------------- 报告


def _git_commit() -> str:
    try:
        return subprocess.check_output(["git", "rev-parse", "--short", "HEAD"], cwd=REPO_ROOT, text=True).strip()
    except (OSError, subprocess.CalledProcessError):
        return "unknown"


def _pct(c: int, t: int) -> str:
    return f"{100 * c / t:.1f}%" if t else "—"


def _cov_table(rows: dict[str, tuple[int, int]]) -> list[str]:
    out = ["| 模块 | 覆盖行 / 总行 | 行覆盖率 |", "|---|---|---|"]
    out += [f"| `{k}` | {c} / {t} | {_pct(c, t)} |" for k, (c, t) in rows.items()]
    return out


def build_report() -> str:
    s_total, s_classes = spring_results()
    s_cov, s_mods = spring_coverage()
    p_total = python_results()
    p_cov, p_mods = python_coverage()
    w_total = web_results()
    w_cov, w_mods = web_coverage()
    specs = sorted(p.parent.name for p in (REPO_ROOT / "openspec" / "specs").glob("*/spec.md"))

    lines = [
        "# 测试报告",
        "",
        f"> 生成时间：{datetime.now():%Y-%m-%d %H:%M} · 代码版本：`{_git_commit()}` · 由 `evaluation/eval/report_tests.py` 自动生成",
        "",
        "## 1. 测试环境",
        "",
        f"- 操作系统：{platform.system()} {platform.release()}",
        "- 后端：Java 25 · Spring Boot 4.1 · JUnit 5 · Testcontainers（PostgreSQL 17 + pgvector、Redis 7）",
        "- AI 服务：Python 3.12 · FastAPI · LangGraph · pytest（PostgreSQL 测试库 + Redis）",
        "- 前端：Node 24 · Next.js 16 · vitest",
        "- 覆盖率工具：JaCoCo、pytest-cov、vitest（v8）；不设构建门槛",
        "",
        "## 2. 自动化测试结果",
        "",
        "| 工程 | 测试数 | 通过 | 失败 | 错误 | 跳过 | 通过率 | 行覆盖率 |",
        "|---|---|---|---|---|---|---|---|",
    ]
    for name, suite, cov in (
        ("springboot-backend", s_total, s_cov),
        ("python-backend", p_total, p_cov),
        ("web（逻辑层）", w_total, w_cov),
    ):
        rate = _pct(suite.passed, suite.tests)
        lines.append(
            f"| {name} | {suite.tests} | {suite.passed} | {suite.failures} | {suite.errors} | {suite.skipped} "
            f"| {rate} | {cov:.1f}% |"
        )
    total = Suite()
    for s in (s_total, p_total, w_total):
        total.add(s)
    lines += [
        f"| **合计** | **{total.tests}** | **{total.passed}** | {total.failures} | {total.errors} | {total.skipped} "
        f"| {_pct(total.passed, total.tests)} | — |",
        "",
        "说明：Web 的覆盖率只统计 `src/lib` 与 `src/hooks`（数据访问、SSE 解析、状态归约），"
        "页面组件通过各阶段冒烟测试中的截图与人工走查验证（亮色 / 暗色 / reduced-motion）。",
        "",
        "## 3. 覆盖率明细",
        "",
        "### 3.1 springboot-backend（JaCoCo）",
        "",
        *_cov_table(s_mods),
        "",
        "### 3.2 python-backend（pytest-cov）",
        "",
        *_cov_table(p_mods),
        "",
        "### 3.3 web（vitest v8）",
        "",
        *_cov_table(w_mods),
        "",
        "### 3.4 Spring 测试类",
        "",
        "| 测试类 | 测试数 | 通过 |",
        "|---|---|---|",
        *[f"| `{k}` | {v.tests} | {v.passed} |" for k, v in s_classes.items()],
        "",
        "## 4. 规格能力与测试对照",
        "",
        f"主规格共 {len(specs)} 个能力（`openspec/specs/`），每个能力都有对应的自动化测试或冒烟测试记录：",
        "",
        "| 能力 | 自动化测试 | 冒烟 / 联调记录 |",
        "|---|---|---|",
    ]
    for cap in specs:
        auto, smoke = CAPABILITY_EVIDENCE.get(cap, ("—", ""))
        link = f"[{Path(smoke).parent.name}](../../{smoke})" if smoke else "—"
        lines.append(f"| `{cap}` | {auto} | {link} |")
    lines += [
        "",
        "## 5. 冒烟与联调测试",
        "",
        "| 阶段 | 内容 | 记录 |",
        "|---|---|---|",
        "| ① 平台基础 | 注册登录、RBAC、模型连通性、强制下线、日志与系统状态 | [bootstrap-smoke](bootstrap-smoke/README.md) |",
        "| ② 短文本翻译 | 浏览器逐字流式、停止不落库、AI 服务停机、术语遵循、暗色模式 | "
        "[text-translation-smoke](text-translation-smoke/README.md) |",
        "| ③ 长文档翻译 | 人工确认术语、进程重启续译、取消后继续、三种策略、Spring 停机补处理、结构保持 | "
        "[document-translation-smoke](document-translation-smoke/README.md) |",
        "",
        "## 6. 已知局限",
        "",
        "- `module.system`（系统状态汇总接口）的自动化覆盖较低，依赖 AI 服务真实在线，已在 ① 冒烟测试中手工验证 UP / DOWN 两种状态",
        "- 平台的术语遵循校验按子串匹配，中文存在误判（见 ③ 冒烟记录）；评测工程中的术语指标改为按出现次数比对",
        "- Web 页面组件未做自动化 UI 测试，依赖截图走查；`src/hooks` 只是 React 订阅的薄封装（0%），其状态逻辑在 `src/lib/doc-task.ts` 等纯函数中直接测试；`src/lib/api` 为按接口封装的请求函数，覆盖率低（约 15%），已在三端联调中逐个实际调用",
        "",
        "## 7. 复现方式",
        "",
        "```bash",
        "# Spring（JaCoCo 报告：springboot-backend/target/site/jacoco/）",
        "cd springboot-backend && JAVA_HOME=/path/to/jdk-25 ./mvnw verify",
        "# Python",
        "cd python-backend && uv run pytest --junitxml=.reports/junit.xml --cov=app --cov-report=xml",
        "# Web",
        "cd web && pnpm vitest run --coverage --reporter=default --reporter=json --outputFile.json=.reports/vitest.json",
        "# 生成本报告",
        "cd evaluation && uv run python -m eval.report_tests",
        "```",
        "",
    ]
    return "\n".join(lines)


def main() -> None:
    parser = argparse.ArgumentParser(description="生成 docs/test/测试报告.md")
    parser.add_argument("--out", type=Path, default=OUT)
    args = parser.parse_args()
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(build_report(), encoding="utf-8")
    print(f"已生成 {args.out}")


if __name__ == "__main__":
    main()
