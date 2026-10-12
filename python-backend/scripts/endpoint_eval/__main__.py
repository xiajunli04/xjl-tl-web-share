"""命令行：uv run python -m scripts.endpoint_eval <命令> [选项]（在 python-backend 目录下执行）

- data                                   生成 V0–V3 数据与 manifest（语气词音频缺失时用 edge-tts 合成）
- run [--groups ...] [--profiles ...]    离线断句评测，追加写入 e6_runs.jsonl（已完成的样本跳过）
      [--label 名称] [--limit N]          label 用于参数对照（如改环境变量后以 smart-sil300 运行）
- summary                                输出 e6_summary.csv / e6_summary.md 与达标判定
"""

import argparse
import asyncio
import logging

from . import data, run, summary


def main() -> int:
    parser = argparse.ArgumentParser(prog="scripts.endpoint_eval")
    sub = parser.add_subparsers(dest="cmd", required=True)
    sub.add_parser("data")
    p = sub.add_parser("run")
    p.add_argument("--groups", nargs="+", default=list(run.GROUPS), choices=run.GROUPS)
    p.add_argument("--profiles", nargs="+", default=list(run.PROFILES), choices=list(run.PROFILES))
    p.add_argument("--label")
    p.add_argument("--limit", type=int)
    sub.add_parser("summary")
    args = parser.parse_args()
    logging.basicConfig(level=logging.WARNING)

    if args.cmd == "data":
        manifest = data.build()
        by = {}
        for m in manifest:
            by[m["variant"]] = by.get(m["variant"], 0) + 1
        print(f"生成 {len(manifest)} 条：{by}")
        return 0
    if args.cmd == "run":
        n = asyncio.run(run.run(args.groups, args.profiles, args.label, args.limit))
        print(f"新增 {n} 条结果：{run.RUNS}")
        return 0
    rows = summary.summarize()
    print(summary.REPORT_MD.read_text(encoding="utf-8"))
    print(f"写入 {summary.SUMMARY}")
    return 0 if rows else 1


if __name__ == "__main__":
    raise SystemExit(main())
