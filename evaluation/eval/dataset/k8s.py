"""篇章级测试集：Kubernetes 概念文档（design D2）。

从 kubernetes/website 的固定 commit 下载 5 篇概念文档的英文原文与官方简体中文译文，按统一规则清洗，
中英文按相同的二级标题边界截取，写入 `data/k8s/{doc}.en.md`、`{doc}.zh.md`，来源信息写入 manifest。

清洗规则（`clean_markdown`，两种语言共用，逐条有单测）：
  1. 去掉 YAML front matter，并把其中的 title 作为一级标题放在开头
  2. 删除全部 `<!-- ... -->` 注释（中文页中是英文原文与审阅元数据；英文页中只有 overview/body 等版式标记）
  3. `{{< glossary_tooltip text="X" ... >}}` → `X`；没有 text 时按术语 id 查表（查不到用 term_id 本身）
  4. 容器类短代码（note、caution、warning、tabs、tab）删除标签、保留内容
  5. 整行类短代码（feature-state、code_sample、codenew、heading、api-reference、glossary_definition、figure、
     thirdparty-content）删除所在整行；若嵌在句子中则只删短代码本身
  6. 取值类短代码（param、skew）在网页上会渲染为版本号，这里直接删除
  7. 标题末尾的 Hugo 锚点 `{#anchor}` 删除；连续空行压缩为一个；仍残留未知短代码时报错，避免静默漏清洗

截取（`cut_en` / `cut_zh`）：以英文二级标题 `end_heading` 为界（该节及之后全部丢弃）。中文页中每个标题之前
都有包含英文原标题的注释，因此在中文原文里找到该英文标题所在注释的起点处截断，保证两边内容对应。
"""

from __future__ import annotations

import argparse
import json
import re
from dataclasses import dataclass
from pathlib import Path

from eval.config import DATA_DIR
from eval.dataset.common import CACHE_DIR, fetch_cached, sha256_bytes, update_manifest

REPO = "kubernetes/website"
# 2026-10-02 查询到的 main 分支最新提交，固定下来保证可复现
COMMIT = "192e45e734c55f41d7691d965ccf567dea9cbd0e"
RAW_BASE = f"https://raw.githubusercontent.com/{REPO}/{COMMIT}/content"
K8S_DIR = DATA_DIR / "k8s"
MAX_EN_CHARS = 8000
MIN_EN_CHARS = 2000


@dataclass(frozen=True)
class DocSpec:
    doc_id: str
    path: str  # content/{lang}/docs/concepts/ 下的相对路径
    end_heading: str  # 第一个被丢弃的英文二级标题（不含 "## " 与锚点）


DOCS: tuple[DocSpec, ...] = (
    DocSpec("pods", "workloads/pods/_index.md", "Working with Pods"),
    DocSpec("deployment", "workloads/controllers/deployment.md", "Updating a Deployment"),
    DocSpec("service", "services-networking/service.md", "Defining a Service"),
    DocSpec("configmap", "configuration/configmap.md", "Using ConfigMaps"),
    DocSpec("volumes", "storage/volumes.md", "Types of volumes"),
)

# glossary_tooltip 缺少 text 时 Hugo 显示术语表中的名称；这里只收录测试集里用到的几个
GLOSSARY_NAMES: dict[str, dict[str, str]] = {
    "deployment": {"en": "Deployment", "zh": "Deployment"},
    "namespace": {"en": "namespace", "zh": "名字空间"},
    "kube-proxy": {"en": "kube-proxy", "zh": "kube-proxy"},
    "controller": {"en": "controller", "zh": "控制器"},
    "node": {"en": "node", "zh": "节点"},
    "kubelet": {"en": "kubelet", "zh": "kubelet"},
    "pod": {"en": "Pod", "zh": "Pod"},
    "service": {"en": "Service", "zh": "Service"},
}

CONTAINER_SHORTCODES = ("note", "caution", "warning", "tabs", "tab")
LINE_SHORTCODES = (
    "feature-state",
    "code_sample",
    "codenew",
    "heading",
    "api-reference",
    "glossary_definition",
    "figure",
    "thirdparty-content",
)
VALUE_SHORTCODES = ("param", "skew")

_ATTR = re.compile(r'(\w+)\s*=\s*"([^"]*)"')
_FRONT = re.compile(r"\A---\r?\n(.*?)\r?\n---[ \t]*\r?\n", re.S)
_COMMENT = re.compile(r"<!--.*?-->", re.S)
_TOOLTIP = re.compile(r"\{\{[<%]\s*glossary_tooltip\s+(.*?)\s*[>%]\}\}", re.S)
_ANCHOR = re.compile(r"^(#{1,6} .*?)[ \t]*\{#[\w.-]+\}[ \t]*$", re.M)


def _shortcode(names: tuple[str, ...], closing: bool = True) -> re.Pattern[str]:
    alt = "|".join(re.escape(n) for n in names)
    slash = "/?" if closing else ""
    return re.compile(r"\{\{[<%]\s*" + slash + r"(?:" + alt + r")(?:\s[^}]*?)?\s*[>%]\}\}")


_CONTAINER = _shortcode(CONTAINER_SHORTCODES)
_LINE = _shortcode(LINE_SHORTCODES, closing=False)
_VALUE = _shortcode(VALUE_SHORTCODES, closing=False)


def strip_front_matter(text: str) -> tuple[str, str | None]:
    """去掉 YAML front matter，返回 (正文, title)。"""
    m = _FRONT.match(text)
    if not m:
        return text, None
    title = None
    for line in m.group(1).splitlines():
        if line.startswith("title:"):
            title = line.partition(":")[2].strip().strip("\"'")
            break
    return text[m.end() :], title


def strip_comments(text: str) -> str:
    return _COMMENT.sub("", text)


def replace_tooltips(text: str, lang: str) -> str:
    def repl(m: re.Match[str]) -> str:
        attrs = dict(_ATTR.findall(m.group(1)))
        if attrs.get("text"):
            return attrs["text"]
        term = attrs.get("term_id", "")
        return GLOSSARY_NAMES.get(term, {}).get(lang, term)

    return _TOOLTIP.sub(repl, text)


def _drop_shortcodes(text: str, pattern: re.Pattern[str]) -> str:
    """单独成行的短代码删除整行；嵌在句子里的只删短代码本身。"""
    out = []
    for line in text.split("\n"):
        if pattern.search(line):
            rest = pattern.sub("", line)
            if not rest.strip():
                continue
            line = rest
        out.append(line)
    return "\n".join(out)


def remove_container_shortcodes(text: str) -> str:
    return _drop_shortcodes(text, _CONTAINER)


def remove_line_shortcodes(text: str) -> str:
    return _drop_shortcodes(text, _LINE)


def remove_value_shortcodes(text: str) -> str:
    return _VALUE.sub("", text)


def normalize_whitespace(text: str) -> str:
    text = _ANCHOR.sub(r"\1", text)
    lines = [ln.rstrip() for ln in text.replace("\r\n", "\n").split("\n")]
    out: list[str] = []
    for ln in lines:
        if ln == "" and (not out or out[-1] == ""):
            continue
        out.append(ln)
    return "\n".join(out).strip() + "\n"


def clean_markdown(raw: str, lang: str) -> str:
    body, title = strip_front_matter(raw)
    body = strip_comments(body)
    body = replace_tooltips(body, lang)
    body = remove_container_shortcodes(body)
    body = remove_line_shortcodes(body)
    body = remove_value_shortcodes(body)
    if title:
        body = f"# {title}\n\n{body}"
    body = normalize_whitespace(body)
    leftover = re.search(r"\{\{[<%].*?[>%]\}\}", body)
    if leftover:
        raise ValueError(f"残留未处理的短代码：{leftover.group(0)}")
    return body


# ---------------------------------------------------------------- 截取


def _heading_key(line: str) -> str:
    """'## Service type  {#publishing...}' → 'service type'。"""
    text = re.sub(r"\{#[\w.-]+\}", "", line[3:])
    return re.sub(r"\s+", " ", text).strip().lower()


def cut_en(raw: str, end_heading: str) -> str:
    key = end_heading.strip().lower()
    lines = raw.split("\n")
    in_fence = False
    for i, line in enumerate(lines):
        if line.lstrip().startswith("```"):
            in_fence = not in_fence
        if not in_fence and line.startswith("## ") and _heading_key(line) == key:
            return "\n".join(lines[:i])
    raise ValueError(f"英文原文中找不到二级标题：{end_heading}")


def cut_zh(raw: str, end_heading: str) -> str:
    """在中文原文中定位注释里的英文原标题，从该注释的起点截断。"""
    key = end_heading.strip().lower()
    lines = raw.split("\n")
    open_at: int | None = None  # 当前未闭合注释的起始行
    for i, line in enumerate(lines):
        if open_at is None and "<!--" in line:
            open_at = i
        if open_at is not None and line.startswith("## ") and _heading_key(line) == key:
            return "\n".join(lines[:open_at])
        if open_at is not None and "-->" in line[line.find("<!--") + 4 if i == open_at else 0 :]:
            open_at = None
    raise ValueError(f"中文原文中找不到英文二级标题注释：{end_heading}")


def h2_count(text: str) -> int:
    in_fence = False
    n = 0
    for line in text.split("\n"):
        if line.lstrip().startswith("```"):
            in_fence = not in_fence
        elif not in_fence and line.startswith("## "):
            n += 1
    return n


# ---------------------------------------------------------------- 构建


def source_url(lang: str, path: str) -> str:
    return f"{RAW_BASE}/{lang}/docs/concepts/{path}"


def fetch_raw(lang: str, path: str) -> str:
    dest = CACHE_DIR / "k8s" / COMMIT[:12] / f"{lang}.{path.replace('/', '_')}"
    return fetch_cached(source_url(lang, path), dest).decode("utf-8-sig")


def build_doc(spec: DocSpec) -> tuple[str, str]:
    en = clean_markdown(cut_en(fetch_raw("en", spec.path), spec.end_heading), "en")
    zh = clean_markdown(cut_zh(fetch_raw("zh-cn", spec.path), spec.end_heading), "zh")
    if not MIN_EN_CHARS <= len(en) <= MAX_EN_CHARS:
        raise ValueError(f"{spec.doc_id} 英文长度 {len(en)} 不在 [{MIN_EN_CHARS}, {MAX_EN_CHARS}] 内")
    return en, zh


def build_all(out_dir: Path = K8S_DIR) -> dict:
    out_dir.mkdir(parents=True, exist_ok=True)
    files = []
    for spec in DOCS:
        en, zh = build_doc(spec)
        for lang, src_lang, text in (("en", "en", en), ("zh", "zh-cn", zh)):
            target = out_dir / f"{spec.doc_id}.{lang}.md"
            data = text.encode("utf-8")
            target.write_bytes(data)
            files.append(
                {
                    "file": target.relative_to(DATA_DIR).as_posix(),
                    "doc": spec.doc_id,
                    "lang": lang,
                    "url": source_url(src_lang, spec.path),
                    "commit": COMMIT,
                    "cutBeforeHeading": spec.end_heading,
                    "chars": len(text),
                    "h2": h2_count(text),
                    "sha256": sha256_bytes(data),
                }
            )
    section = {"repo": REPO, "commit": COMMIT, "files": files}
    update_manifest("k8s", section)
    return section


def main() -> None:
    parser = argparse.ArgumentParser(description="下载并清洗 Kubernetes 篇章级测试集")
    parser.parse_args()
    section = build_all()
    for f in section["files"]:
        print(f"{f['file']:<28} {f['chars']:>6} 字符  {f['h2']} 个二级标题")
    print(json.dumps({"commit": COMMIT}, ensure_ascii=False))


if __name__ == "__main__":
    main()
